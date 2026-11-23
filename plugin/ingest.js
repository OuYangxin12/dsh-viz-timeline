/**
 * camodel-viz ingest：把 case 目录里的仿真 dump / 日志，解析成 SEGS（泳道图直接可用的数据），
 * 同时产出对账回执。设计约束（来自需求验收）：
 *
 *  - 日志里有什么就画什么；不认识的行不许让进程死（不 SystemExit），进未知行回执。
 *  - 同内容异名文件按 md5 去重，只解析一次。
 *  - push_instr_to_prefetch_que / pop_prefetch_payload 是 debug 回声，跳过但计数。
 *  - 段界靠 done+++ trailer；认不出段界要报，不静默。
 *  - 时间单位不换算，只声明口径（dump-global counter / 仿真 cycle）。
 *  - 截断的日志不出半张图：driver 日志最后一个 TASK_BEGIN 没有 TASK_DONE 时 status=blocked。
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/* ------------------------------ 行语法 ------------------------------ */

const PIPE_LINE = /^\[info\] (\d+) \[([^\]]+)\](?:\s+(.*))?$/
const TRAILER = /start: (\d+), tick: (\d+).*?taskId: (\d+)/
const TRAILER_FULL = /core: (-?\d+), subcore: (-?\d+), start: (\d+), tick: (\d+), kernelId: (-?\d+), blkID: (-?\d+), blkDim: (-?\d+), rtsqId: (-?\d+), streamId: (-?\d+), taskId: (-?\d+)/

const DEBUG_ECHO = ['push_instr_to_prefetch_que', 'pop_prefetch_payload']

/* 事件名 → 语义角色。只做语义归类，不假定上游一定有某个名字：
 * 没见过的名字进 'other' 并计数，回执里列出来。 */
const ROLE = {
  MOV_SRC_TO_DST_ALIGNv2: 'dma',
  MOV_SRC_TO_DST: 'dma',
  MOV_SPR_XN: 'spr',
  WAIT_FLAG: 'wait',
  SET_FLAG: 'set',
  BUF_ALLOC: 'alloc',
  BUF_FREE: 'free',
  BAR: 'bar',
  END_LABEL: 'end',
}

function tagKind(tag) {
  const t = tag.toLowerCase()
  if (t.includes('push set instr')) return 'push'
  if (t.includes('push instr')) return 'push'
  if (t.includes('pop instr')) return 'pop'
  if (t.includes('retire')) return 'retire'
  if (t.includes('release wait_flag')) return 'rel_wait'
  if (t.includes('release set_flag')) return 'rel_set'
  if (t.includes('release bar')) return 'rel_bar'
  return null
}

function field(text, key) {
  const m = new RegExp(`(?:instr\\.)?${key}=(\\S+)`).exec(text)
  return m ? m[1] : null
}

/* 未知行折叠成可计数的模式：数字、地址抹掉，避免一条一个模式。 */
function normalizeSignature(line) {
  return line
    .replace(/0x[0-9a-fA-F]+/g, '0x…')
    .replace(/\b\d+\b/g, 'N')
    .slice(0, 120)
}

/* ------------------------------ 文件收集 ------------------------------ */

async function walk(root, out = [], depth = 0) {
  if (depth > 6) return out
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(root, e.name)
    if (e.isDirectory()) { await walk(p, out, depth + 1); continue }
    if (!e.isFile()) continue
    if (/\.(dump|log|txt)$/i.test(e.name) || /issque|bmu/i.test(e.name)) out.push(p)
  }
  return out
}

async function md5(path) {
  return createHash('md5').update(await readFile(path)).digest('hex')
}

/* ------------------------------ 解析 ------------------------------ */

function streamOf(name, fingerprint) {
  if (/mte3/i.test(name)) return 'mte3'
  if (/vec/i.test(name)) return 'vec'
  if (/mte2/i.test(name)) return 'mte2'
  if (/bmu/i.test(name)) return fingerprint.has('BUF_ALLOC') ? 'mte2' : 'bmu'
  return fingerprint.has('BUF_ALLOC') ? 'mte2' : 'unknown'
}

/** 一个 pipe dump → 段数组：{meta, events[]}，段界是 done+++ trailer。 */
function parsePipe(text) {
  const lines = text.split('\n')
  const segments = []
  let cur = { meta: null, events: [] }
  const unknown = new Map()
  let skipped = 0
  let blank = 0
  let trailersSeen = 0

  const pushUnknown = (sig) => unknown.set(sig, (unknown.get(sig) ?? 0) + 1)

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') { blank++; continue }
    if (line.includes('done+++')) {
      trailersSeen++
      const full = TRAILER_FULL.exec(line)
      const short = TRAILER.exec(line)
      const meta = full
        ? {
            core: +full[1], subcore: +full[2], start: +full[3], tick: +full[4],
            kernelId: +full[5], blkID: +full[6], blkDim: +full[7], rtsqId: +full[8],
            streamId: +full[9], taskId: +full[10],
          }
        : short
          ? { start: +short[1], tick: +short[2], taskId: +short[3] }
          : null
      if (meta === null) pushUnknown(normalizeSignature(line))
      cur.meta = meta
      segments.push(cur)
      cur = { meta: null, events: [] }
      continue
    }
    if (DEBUG_ECHO.some((s) => line.includes(s))) { skipped++; continue }
    const m = PIPE_LINE.exec(line)
    if (m === null) { pushUnknown(normalizeSignature(line)); continue }
    const kind = tagKind(m[2])
    if (kind === null) { pushUnknown(normalizeSignature(line)); continue }
    const rest = m[3] ?? ''
    cur.events.push({
      cycle: +m[1], kind, tag: m[2],
      name: field(rest, 'name'),
      pc: field(rest, 'pc'),
      id: field(rest, 'id') === null ? null : +field(rest, 'id'),
      addr: /addr:\s*(0x[0-9a-fA-F]+)/.exec(rest)?.[1] ?? null,
      otsd: field(rest, 'otsd') === null ? null : +field(rest, 'otsd'),
      raw: rest.slice(0, 200),
    })
  }
  if (cur.events.length > 0) segments.push(cur) // 末尾没有 trailer 的那段
  return { segments, unknown, skipped, blank, trailersSeen }
}

/** 段内事件 → 指令记录（一次 push/pop/retire/release 归并成一条）。 */
function instructions(events, stream, stats) {
  const byId = new Map()
  for (const e of events) {
    const key = `${stream}:${e.id ?? `pc${e.pc}`}`
    let rec = byId.get(key)
    if (rec === undefined) {
      const role = ROLE[e.name] ?? 'other'
      if (role === 'other') stats.otherNames.set(e.name ?? '(无 name)', (stats.otherNames.get(e.name ?? '(无 name)') ?? 0) + 1)
      rec = { id: e.id, name: e.name, role, stream, pc: e.pc, push: null, pop: null, retire: null, release: null, addr: null, otsd: null }
      byId.set(key, rec)
    }
    if (e.addr !== null) rec.addr = e.addr
    if (e.otsd !== null) rec.otsd = e.otsd
    switch (e.kind) {
      case 'push': rec.push = e.cycle; break
      case 'pop': rec.pop = e.cycle; break
      case 'retire': rec.retire = e.cycle; break
      case 'rel_wait': case 'rel_set': case 'rel_bar': rec.release = e.cycle; break
    }
  }
  return [...byId.values()]
}

/** 段 → SEGS 记录（timeline.html 直接消费的形状）。 */
function toSegs(segIndex, meta, perStream, srcNames) {
  const mte2 = perStream.mte2 ?? []
  const mte3 = perStream.mte3 ?? []
  const vec = perStream.vec ?? []
  const all = [...mte2, ...mte3, ...vec]

  const dmaM2 = mte2.filter((r) => r.role === 'dma' && r.push !== null).sort((a, b) => a.push - b.push)
  const dmaM3 = mte3.filter((r) => r.role === 'dma' && r.push !== null).sort((a, b) => a.push - b.push)
  const allocs = mte2.filter((r) => r.role === 'alloc').sort((a, b) => (a.push ?? 0) - (b.push ?? 0))
  const freeM3 = mte3.filter((r) => r.role === 'free').sort((a, b) => (a.push ?? 0) - (b.push ?? 0))
  const freeM2 = mte2.filter((r) => r.role === 'free').sort((a, b) => (a.push ?? 0) - (b.push ?? 0))
  const frees = freeM3.length > 0 ? freeM3 : freeM2
  const waitsM2 = mte2.filter((r) => r.role === 'wait').sort((a, b) => (a.push ?? 0) - (b.push ?? 0))
  const waitsM3 = mte3.filter((r) => r.role === 'wait').sort((a, b) => (a.push ?? 0) - (b.push ?? 0))
  const setsM2 = mte2.filter((r) => r.role === 'set')
  const setsM3 = mte3.filter((r) => r.role === 'set')
  const bars = all.filter((r) => r.role === 'bar')

  const kind = (allocs.length > 0 || frees.length > 0) ? 'bmu' : 'static'

  const stores = dmaM3.map((r) => [r.push, r.pop ?? r.push, r.retire ?? r.pop ?? r.push])
  // 轮结构：能和 store 对齐就按 store 数分组，否则每条 load 自成一轮
  let loads = []
  if (dmaM3.length > 0 && dmaM2.length % dmaM3.length === 0) {
    const per = dmaM2.length / dmaM3.length
    for (let r = 0; r < dmaM2.length; r += per) {
      loads.push(dmaM2.slice(r, r + per).map((x) => [x.push, x.pop ?? x.push, x.retire ?? x.pop ?? x.push]))
    }
  } else {
    loads = dmaM2.map((x) => [[x.push, x.pop ?? x.push, x.retire ?? x.pop ?? x.push]])
  }

  const cycles = all.map((r) => r.retire ?? r.pop ?? r.push ?? r.release).filter((c) => c !== null)
  const span = cycles.length > 0 ? [Math.min(...cycles), Math.max(...cycles)] : [0, 1]
  const T = meta && meta.tick !== undefined ? meta.tick - meta.start : span[1] - span[0]
  const addrOf = (r) => (r.addr === null ? null : parseInt(r.addr, 16))

  return {
    i: segIndex,
    task: meta?.taskId ?? 0,
    kind,
    start: meta?.start ?? span[0],
    tick: meta?.tick ?? span[1],
    span,
    loads,
    stores,
    vecp: vec.filter((r) => r.role === 'alloc').map((r) => r.push).filter((c) => c !== null),
    alloc: allocs.map((r) => r.push).filter((c) => c !== null),
    alloc_addr: allocs.map(addrOf),
    free: frees.map((r) => r.push).filter((c) => c !== null),
    wait2: waitsM2.filter((r) => r.push !== null && r.release !== null).map((r) => [r.push, r.release]),
    set2: setsM2.map((r) => r.release).filter((c) => c !== null),
    wait3: waitsM3.filter((r) => r.push !== null && r.release !== null).map((r) => [r.push, r.release]),
    set3: setsM3.map((r) => r.release).filter((c) => c !== null),
    bars: bars.map((r) => r.release ?? r.push).filter((c) => c !== null),
    T,
    src: srcNames.join(','),
  }
}

function countOf(seg) {
  return {
    load: seg.loads.reduce((a, r) => a + r.length, 0),
    store: seg.stores.length,
    alloc: seg.alloc.length,
    free: seg.free.length,
    bar: seg.bars.length,
    wait_mte2: seg.wait2.length,
    wait_mte3: seg.wait3.length,
    set_mte2: seg.set2.length,
    set_mte3: seg.set3.length,
    vecp: seg.vecp.length,
  }
}

/* ------------------------------ driver 完整性校验 ------------------------------ */

function checkDriver(text) {
  const lines = text.split('\n')
  let begin = 0
  let done = 0
  let lastBeginLine = 0
  const blockEvents = { block_start: 0, block_end: 0, early_end: 0 }
  lines.forEach((line, idx) => {
    if (line.includes('[TASK_BEGIN]')) { begin++; lastBeginLine = idx + 1 }
    if (line.includes('[TASK_DONE]')) done++
    for (const k of Object.keys(blockEvents)) if (line.includes(`[${k}]`)) blockEvents[k]++
  })
  const exit = /EXIT=(\d+)/.exec(text)
  const truncated = begin > done
  return {
    task_begin: begin, task_done: done, truncated,
    last_unmatched_begin_line: truncated ? lastBeginLine : null,
    block_events: blockEvents,
    exit_code: exit ? +exit[1] : null,
  }
}

/* ------------------------------ 主流程 ------------------------------ */

export async function ingest({ dirs, maxFiles = 200, maxBytes = 256 * 1024 * 1024 }) {
  const warnings = []
  const paths = []
  for (const d of dirs) {
    const st = await stat(d).catch(() => null)
    if (st === null) throw new Error(`目录不存在：${d}`)
    if (st.isDirectory()) await walk(d, paths)
    else paths.push(d)
  }
  if (paths.length === 0) throw new Error(`这些目录里没有 .dump/.log 文件：${dirs.join(', ')}`)
  // 只留下真的像日志的文件：全文里要有 [info] 事件行，避免把 README/清单当输入
  const candidates = []
  for (const p of paths) {
    const text = await readFile(p, 'utf8')
    if (text.includes('[info]')) candidates.push(p)
    else warnings.push(`跳过非日志文件：${basename(p)}（没有 [info] 事件行）`)
  }
  if (candidates.length === 0) throw new Error(`这些目录里的文本文件都不含 [info] 事件行：${dirs.join(', ')}`)
  if (candidates.length > maxFiles) throw new Error(`文件太多（${candidates.length} > ${maxFiles}），请指定更具体的 case 目录`)
  paths.length = 0
  paths.push(...candidates)

  // md5 去重：同内容异名只解析一次
  const groups = new Map()
  const files = []
  let totalBytes = 0
  for (const p of paths.sort()) {
    const st = await stat(p)
    totalBytes += st.size
    const h = await md5(p)
    const rec = { path: p, name: basename(p), md5: h, bytes: st.size }
    files.push(rec)
    const g = groups.get(h)
    if (g === undefined) groups.set(h, { canonical: p, names: [basename(p)], records: [rec] })
    else { g.names.push(basename(p)); g.records.push(rec) }
  }
  if (totalBytes > maxBytes) throw new Error(`输入体积 ${totalBytes} 字节超过上限`)

  const dedupe = []
  const unique = []
  for (const [h, g] of groups) {
    const names = [...new Set(g.names)]
    const dup = names.length > 1
    for (const r of g.records) r.role = r.path === g.canonical ? 'canonical' : 'duplicate'
    if (dup) {
      dedupe.push({ md5: h, canonical: g.records[0].name, duplicates: g.records.slice(1).map((r) => r.name) })
      warnings.push(`按 md5 去重：${names.join(' / ')} 内容相同，只解析 ${g.records[0].name} 一次。`)
    }
    unique.push(g)
  }

  // 文件类型判定（按内容，不按文件名）
  const pipeGroups = []
  const driverTexts = []
  for (const g of unique) {
    const text = await readFile(g.canonical, 'utf8')
    const head = text.slice(0, 256 * 1024)
    const isDriver = /\[TASK_BEGIN\]|\[block_start\]/.test(head)
    const isPipe = /\[Push Instr\]|\[RETIRE INSTR\]/.test(head)
    const fingerprint = new Set([...text.matchAll(/name=(\S+)/g)].map((m) => m[1]))
    if (isPipe && !isDriver) {
      const stream = streamOf(g.records[0].name, fingerprint)
      pipeGroups.push({ group: g, text, stream })
    } else if (isDriver) {
      driverTexts.push({ group: g, text })
    } else {
      warnings.push(`跳过不认识的文本文件：${g.records[0].name}（没有 issue-queue 事件也没有 TASK_BEGIN）`)
    }
  }

  const linesStat = { total: 0, events: 0, skipped_debug_echo: 0, blank: 0 }
  const unknownAll = new Map()
  const otherNamesAll = new Map()
  const stats = { otherNames: otherNamesAll }

  // 每个 pipe 文件按段号对齐
  const bySegIndex = new Map() // idx -> {meta, perStream}
  let trailersSeen = 0
  const noTrailerFiles = []
  for (const pg of pipeGroups) {
    const parsed = parsePipe(pg.text)
    linesStat.total += pg.text.split('\n').length
    linesStat.skipped_debug_echo += parsed.skipped
    linesStat.blank += parsed.blank
    trailersSeen += parsed.trailersSeen
    if (parsed.segments.length > 0 && parsed.segments[0].meta === null) {
      warnings.push(`${pg.group.records[0].name} 的第一个段没有段尾 trailer（文件可能被截断或从中间开始）。`)
    }
    if (parsed.trailersSeen === 0 && parsed.segments.length > 0) noTrailerFiles.push(pg.group.records[0].name)
    for (const [sig, n] of parsed.unknown) unknownAll.set(sig, (unknownAll.get(sig) ?? 0) + n)
    parsed.segments.forEach((seg, idx) => {
      const slot = bySegIndex.get(idx) ?? { meta: null, perStream: {}, srcs: new Set() }
      if (seg.meta !== null && slot.meta === null) slot.meta = seg.meta
      if (seg.meta === null && seg.events.length > 0) {
        warnings.push(`段 ${idx + 1} 没有 done+++ 段尾，start/tick 用事件区间代替（${pg.group.records[0].name}，可能是截断）。`)
      }
      if (seg.meta !== null && pg.stream !== 'vec' && slot.meta && seg.meta.taskId !== slot.meta.taskId) {
        warnings.push(`段 ${idx + 1} 的 trailer taskId 不一致：${slot.meta.taskId} vs ${seg.meta.taskId}（${pg.group.records[0].name}）`)
      }
      slot.perStream[pg.stream] = instructions(seg.events, pg.stream, stats)
      slot.srcs.add(pg.group.records[0].name)
      linesStat.events += seg.events.length
      bySegIndex.set(idx, slot)
    })
  }

  // driver 日志：只做完整性判断，不出图
  let driverReport = null
  if (driverTexts.length > 0) {
    driverReport = driverTexts.map((d) => ({ file: d.group.records[0].name, ...checkDriver(d.text) }))
    for (const r of driverReport) {
      if (r.truncated) {
        return {
          status: 'blocked',
          reason: `日志没跑完：${r.file} 第 ${r.last_unmatched_begin_line} 行的 TASK_BEGIN 没有对应的 TASK_DONE。`,
          detail: `TASK_BEGIN ${r.task_begin} / TASK_DONE ${r.task_done}；block_start ${r.block_events.block_start} / block_end ${r.block_events.block_end}；EXIT=${r.exit_code ?? '未知'}。截断的日志不出图。`,
          driver: driverReport,
          segs: null,
          receipt: { files, dedupe, lines: linesStat, warnings: [...warnings, 'driver 日志截断，未生成任何图形。'] },
        }
      }
    }
    if (pipeGroups.length === 0) {
      return {
        status: 'ok',
        segs: null,
        receipt: {
          kind: 'driver', files, dedupe, driver: driverReport,
          lines: linesStat,
          warnings: [...warnings, 'driver 日志完整，但 v1 只支持 pipe 模式出泳道图；块调度甘特图未接入。'],
        },
      }
    }
  }

  if (bySegIndex.size === 0) {
    return {
      status: 'blocked',
      reason: '没有解析出任何泳道段。',
      detail: '输入里没有可识别的 issue-queue 事件或 done+++ 段尾。',
      segs: null,
      receipt: { files, dedupe, lines: linesStat, unknown: [...unknownAll].map(([pattern, count]) => ({ pattern, count })), warnings },
    }
  }

  // 组装 SEGS + 回执
  const segs = []
  const segReceipts = []
  const idxs = [...bySegIndex.keys()].sort((a, b) => a - b)
  idxs.forEach((idx, n) => {
    const slot = bySegIndex.get(idx)
    const seg = toSegs(n + 1, slot.meta, slot.perStream, [...slot.srcs])
    const counts = countOf(seg)
    if (counts.load === 0 && counts.store === 0) {
      warnings.push(`段 ${n + 1} 没有 load/store 事件，图上只会剩事件线（可能是段界识别错了）。`)
    }
    segs.push(seg)
    segReceipts.push({
      i: seg.i, task: seg.task, kind: seg.kind, start: seg.start, tick: seg.tick, T: seg.T,
      span: seg.span, counts, src: seg.src,
    })
  })

  if (noTrailerFiles.length > 0) {
    warnings.push(`这些文件里没有任何 done+++ 段尾，段界无法识别：${noTrailerFiles.join(', ')}（按整文件当一段处理）。`)
  }
  if (trailersSeen === 0) warnings.push('一个 done+++ trailer 都没有，段数不可信。')
  if (otherNamesAll.size > 0) {
    warnings.push(`有 ${otherNamesAll.size} 种事件名没有语义归类（已按 other 保留、不进图）：${[...otherNamesAll.keys()].slice(0, 8).join(', ')}`)
  }

  const receipt = {
    kind: 'pipe',
    files: files.map((f) => ({ file: f.name, path: f.path, md5: f.md5, bytes: f.bytes, role: f.role })),
    dedupe,
    lines: {
      total: linesStat.total,
      events_recognized: linesStat.events,
      skipped_debug_echo: linesStat.skipped_debug_echo,
      blank: linesStat.blank,
      unrecognized: [...unknownAll.values()].reduce((a, b) => a + b, 0),
    },
    unknown: [...unknownAll].sort((a, b) => b[1] - a[1]).map(([pattern, count]) => ({ pattern, count })),
    other_event_names: [...otherNamesAll].map(([name, count]) => ({ name, count })),
    segments: segReceipts,
    units: {
      cycle: '仿真 cycle（dump-global counter），按原值使用，未换算 wall 时间、未外推硬件。',
      execution: '执行时长 = retire − pop；排队 = pop − push。',
      tick: 'trailer.tick − trailer.start = 该段总 cycle。',
    },
    warnings,
    trailers_seen: trailersSeen,
    driver: driverReport,
  }

  const empty = segs.filter((s) => s.loads.length === 0 && s.stores.length === 0)
  if (empty.length === segs.length) {
    return {
      status: 'blocked',
      reason: '解析出段结构，但所有段都没有 load/store 事件；不生成空泳道。',
      segs: null, receipt,
    }
  }

  return { status: 'ok', segs, receipt }
}

/* ------------------------------ CLI（调试用） ------------------------------ */

if (process.argv[1] !== undefined && /ingest\.js$/.test(process.argv[1]) && process.argv[2] !== undefined) {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('-o')
  const outPath = outIdx === -1 ? null : args[outIdx + 1]
  const dirs = args.filter((a, i) => a !== '-o' && (outIdx === -1 || i !== outIdx + 1))
  const r = await ingest({ dirs })
  console.log(JSON.stringify(r.receipt, null, 2))
  if (outPath !== null && r.segs !== null) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(outPath, JSON.stringify(r.segs))
    console.error(`wrote ${outPath} (${r.segs.length} segs)`)
  }
  console.error('status:', r.status, r.reason ?? '')
}
