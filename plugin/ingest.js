/**
 * camodel-viz ingest：把 case 目录里的仿真 dump / 日志，解析成 SEGS（泳道图直接可用的数据），
 * 同时产出对账回执。设计约束（来自需求验收）：
 *
 *  - 日志里有什么就画什么；不认识的行不许让进程死（不 SystemExit），进未知行回执。
 *  - 同内容异名文件按 md5 去重，只解析一次。
 *  - push_instr_to_prefetch_que / pop_prefetch_payload 是 debug 回声，跳过但计数。
 *  - 段界靠 done+++ trailer；认不出段界要报，不静默。
 *  - 时间单位不换算，只声明口径（dump-global counter / 仿真 cycle）。
 *  - 截断的日志不出半张图：driver 日志按 stream 判完整性，完整 stream 照常出块调度图，
 *    缺 TASK_DONE 的 stream 标 incomplete 进回执，不整体拒绝。
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

/* ------------------------------ driver（ESL 日志） ------------------------------ */

const DRIVER_EVENT = /^\[info\] \[(\d+)\]\s+\[([A-Za-z_]+)\]\s*(.*)$/
const LAUNCH_GRID = /\[bmu\] launch grid=(\d+)/
const DRIVER_TAGS = new Set(['TASK_BEGIN', 'TASK_DONE', 'block_start', 'early_end', 'block_end'])

function driverFields(rest) {
  const out = {}
  for (const m of rest.matchAll(/([A-Za-z_]+)\s*[=:]\s*(\d+)/g)) out[m[1].toLowerCase()] = Number(m[2])
  return out
}

/**
 * driver 日志 → 按 stream 的块调度段。
 * 每个 stream 单独判完整性：缺 TASK_DONE、block 少于 grid 声明、有 block 没 block_end
 * 都标 incomplete，但只影响该 stream，其它完整 stream 照常出图。
 */
function parseDriver(text, file) {
  const lines = text.split('\n')
  const streams = []
  const open = new Map()     // full_task_id -> stream
  const blocks = new Map()   // full_task_id -> Map(bid -> block)
  const grids = []           // 按行号排好的 launch grid 声明
  const unknown = new Map()
  const tasks = []
  let blockLines = 0
  let orphanBlockLines = 0
  let eventLines = 0
  const blankLines = lines.filter((l) => l.trim() === '').length

  lines.forEach((raw, idx) => {
    const line = raw.replace(/\r$/, '')
    const g = LAUNCH_GRID.exec(line)
    if (g !== null) { grids.push({ line: idx + 1, grid: Number(g[1]) }); return }
    const m = DRIVER_EVENT.exec(line)
    if (m === null) return
    eventLines++
    const cycle = Number(m[1])
    const tag = m[2]
    if (!DRIVER_TAGS.has(tag)) { unknown.set(tag, (unknown.get(tag) ?? 0) + 1); return }
    const f = driverFields(m[3] ?? '')
    const ftid = f.full_task_id ?? f.task_id ?? 0

    if (tag === 'TASK_BEGIN' || tag === 'TASK_DONE') {
      const streamId = f.stream_id ?? 0
      tasks.push({ cycle, kind: tag, stream: streamId, task: f.task_id ?? 0, ftid })
      if (tag === 'TASK_BEGIN') {
        const decl = grids.shift() ?? null // 启动声明归到随后这笔 task
        const s = {
          stream: streamId, task_id: f.task_id ?? 0, full_task_id: ftid,
          begin: cycle, begin_line: idx + 1, done: null, done_line: null,
          grid_declared: decl?.grid ?? null, grid_line: decl?.line ?? null,
          blocks: [], incomplete: false, incomplete_reasons: [],
        }
        streams.push(s)
        open.set(ftid, s)
        blocks.set(ftid, new Map())
      } else {
        const s = open.get(ftid)
        if (s !== undefined) { s.done = cycle; s.done_line = idx + 1; open.delete(ftid) }
      }
      return
    }

    // block_start / early_end / block_end
    blockLines++
    const map = blocks.get(ftid)
    const bid = f.block_id
    if (map === undefined || bid === undefined) { orphanBlockLines++; return }
    let b = map.get(bid)
    if (tag === 'block_start') {
      if (b === undefined) {
        b = { bid, core: f.core_id ?? null, start: cycle, early: null, end: null }
        map.set(bid, b)
      }
      return
    }
    if (b === undefined) { orphanBlockLines++; return } // 没有 start 的收尾行，不算进图
    if (tag === 'early_end') { if (b.early === null) b.early = cycle }
    else if (b.end === null) b.end = cycle
  })

  const exit = /EXIT=(\d+)/.exec(text)

  for (const s of streams) {
    const started = blocks.get(s.full_task_id) ?? new Map()
    const finished = [...started.values()].filter((b) => b.end !== null).sort((a, b) => a.bid - b.bid)
    const unfinished = started.size - finished.length
    s.blocks = finished.map((b) => ({ bid: b.bid, core: b.core, start: b.start, early: b.early ?? b.start, end: b.end }))
    s.block_start_count = started.size
    s.block_finished = finished.length
    const reasons = []
    if (s.done === null) reasons.push(`第 ${s.begin_line} 行的 TASK_BEGIN 没有对应 TASK_DONE`)
    if (s.grid_declared !== null && s.block_start_count < s.grid_declared) {
      reasons.push(`block 事件 ${s.block_start_count} 少于 grid 声明 ${s.grid_declared}`)
    }
    if (unfinished > 0) reasons.push(`${unfinished} 个 block 没有 block_end`)
    s.incomplete = reasons.length > 0
    s.incomplete_reasons = reasons
    s.T = s.done !== null ? s.done - s.begin : null
    s.cores = [...new Set(s.blocks.map((b) => b.core))].filter((c) => c !== null).sort((a, b) => a - b)
  }

  return {
    file,
    streams,
    tasks,
    summary: {
      task_begin: tasks.filter((t) => t.kind === 'TASK_BEGIN').length,
      task_done: tasks.filter((t) => t.kind === 'TASK_DONE').length,
      block_lines: blockLines,
      orphan_block_lines: orphanBlockLines,
      unknown_tags: [...unknown].map(([tag, count]) => ({ tag, count })),
      exit_code: exit ? +exit[1] : null,
      grid_declarations: grids.length + streams.filter((s) => s.grid_declared !== null).length,
      lines_total: lines.length,
      lines_events: eventLines,
      lines_blank: blankLines,
    },
  }
}

/** 完整 stream 的 block/task → blocks.html 直接消费的 DATA。 */
function toBlocksData(streams, fileOf) {
  const complete = streams.filter((s) => !s.incomplete && s.blocks.length > 0)
  return {
    blocks: complete.flatMap((s) => s.blocks),
    tasks: complete.flatMap((s) => [
      { cycle: s.begin, kind: 'TASK_BEGIN', stream: s.stream, task: s.task_id, ftid: s.full_task_id },
      { cycle: s.done, kind: 'TASK_DONE', stream: s.stream, task: s.task_id, ftid: s.full_task_id },
    ]),
    streams: streams.map((s) => ({
      stream: s.stream, task_id: s.task_id, full_task_id: s.full_task_id,
      file: fileOf(s),
      begin: s.begin, done: s.done, T: s.T,
      grid_declared: s.grid_declared, block_finished: s.block_finished,
      cores: s.cores.length,
      incomplete: s.incomplete, incomplete_reasons: s.incomplete_reasons,
    })),
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
  const driverLineStat = { total: 0, events: 0, blank: 0 }
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

  // driver 日志：按 stream 出块调度段；不完整只影响该 stream，不整体拒绝
  let driverReport = null
  let driverStreams = []
  if (driverTexts.length > 0) {
    const parsedAll = driverTexts.map((d) => parseDriver(d.text, d.group.records[0].name))
    driverStreams = parsedAll.flatMap((p) => p.streams.map((s) => ({ ...s, file: p.file })))
    driverReport = parsedAll.map((p) => ({ file: p.file, ...p.summary }))
    for (const p of parsedAll) {
      driverLineStat.total += p.summary.lines_total
      driverLineStat.events += p.summary.lines_events
      driverLineStat.blank += p.summary.lines_blank
    }
    for (const r of driverReport) {
      if (r.task_begin > r.task_done) {
        warnings.push(`${r.file}：TASK_BEGIN ${r.task_begin} / TASK_DONE ${r.task_done}；EXIT=${r.exit_code ?? '未知'}。不完整的 stream 会标进回执，完整段照常出图。`)
      }
    }
  }
  const incompleteStreams = driverStreams.filter((s) => s.incomplete)
  for (const s of incompleteStreams) {
    const dropped = s.block_finished > 0 ? `；其中 ${s.block_finished} 个已完成 block 也不用（半段不上图）` : '（零 block）'
    warnings.push(`stream ${s.stream}（${s.file}）未跑完，未渲染${dropped}：${s.incomplete_reasons.join('；')}`)
  }

  // 只有 driver 日志（没有 issue-queue dump）：出块调度图
  if (pipeGroups.length === 0 && driverTexts.length > 0) {
    const data = toBlocksData(driverStreams, (s) => s.file)
    const complete = driverStreams.filter((s) => !s.incomplete && s.blocks.length > 0)
    if (complete.length === 0) {
      return {
        status: 'blocked',
        reason: `driver 日志里没有一个完整的 stream：${incompleteStreams.map((s) => `stream ${s.stream} ${s.incomplete_reasons.join('；')}`).join(' / ')}。`,
        detail: `TASK_BEGIN ${driverReport.reduce((a, r) => a + r.task_begin, 0)} / TASK_DONE ${driverReport.reduce((a, r) => a + r.task_done, 0)}；EXIT=${driverReport.map((r) => r.exit_code ?? '未知').join(',')}。不完整的 stream 不出图。`,
        driver: driverReport,
        segs: null,
        receipt: {
          kind: 'driver', files, dedupe, lines: { ...driverLineStat, skipped_debug_echo: 0 }, driver: driverReport,
          streams: data.streams,
          warnings: [...warnings, '所有 stream 都不完整，未生成任何图形。'],
        },
      }
    }
    const receipt = {
      kind: 'driver',
      view: 'blocks',
      files: files.map((f) => ({ file: f.name, path: f.path, md5: f.md5, bytes: f.bytes, role: f.role })),
      dedupe,
      lines: { ...driverLineStat, skipped_debug_echo: 0 },
      driver: driverReport,
      streams: data.streams,
      incomplete_streams: data.streams.filter((s) => s.incomplete),
      units: {
        cycle: '仿真 cycle（ESL 日志时间戳），按原值使用，未换算 wall、未外推硬件。',
        block: 'block 执行 = [block_start, block_end]；drain = [early_end, block_end]。',
        task: 'task 时长 = TASK_DONE − TASK_BEGIN，只对完整 stream 成立。',
      },
      warnings,
    }
    return { status: 'ok', view: 'blocks', blocks: data, receipt }
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
    view: 'timeline',
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
    driver_streams: driverStreams.map((s) => ({
      stream: s.stream, task_id: s.task_id, full_task_id: s.full_task_id, file: s.file,
      begin: s.begin, done: s.done, T: s.T,
      grid_declared: s.grid_declared, block_finished: s.block_finished, cores: s.cores.length,
      incomplete: s.incomplete, incomplete_reasons: s.incomplete_reasons,
    })),
  }

  const empty = segs.filter((s) => s.loads.length === 0 && s.stores.length === 0)
  if (empty.length === segs.length) {
    return {
      status: 'blocked',
      reason: '解析出段结构，但所有段都没有 load/store 事件；不生成空泳道。',
      segs: null, receipt,
    }
  }

  return { status: 'ok', view: 'timeline', segs, receipt }
}

/* ------------------------------ CLI（调试用） ------------------------------ */

if (process.argv[1] !== undefined && /ingest\.js$/.test(process.argv[1]) && process.argv[2] !== undefined) {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('-o')
  const outPath = outIdx === -1 ? null : args[outIdx + 1]
  const dirs = args.filter((a, i) => a !== '-o' && (outIdx === -1 || i !== outIdx + 1))
  const r = await ingest({ dirs })
  console.log(JSON.stringify(r.receipt, null, 2))
  const data = r.segs ?? r.blocks ?? null
  if (outPath !== null && data !== null) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(outPath, JSON.stringify(data))
    const n = Array.isArray(data) ? `${data.length} segs` : `${data.blocks.length} blocks / ${data.streams.length} streams`
    console.error(`wrote ${outPath} (${n})`)
  }
  console.error('status:', r.status, r.view ?? '', r.reason ?? '')
}
