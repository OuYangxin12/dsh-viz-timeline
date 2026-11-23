/**
 * DSH × camodel-viz timeline — Host half (Cordis plugin).
 *
 * What it does:
 *  1. Runs a loopback HTTP bridge (default 127.0.0.1:47131) speaking the same
 *     protocol as scripts/bridge_server.py: visualization pages opened with
 *     `?bridge=PORT` long-poll /next for commands and POST results to /event.
 *  2. Registers viz_* tools on every Session so the agent can query the live
 *     chart (stats / at / rounds), drive the view (view), annotate it
 *     (highlight) and swap datasets at runtime (load).
 *
 * Everything is local: the bridge binds 127.0.0.1 only. Optional shared token
 * via DSH_VIZ_TOKEN env (page URL ?bridge=PORT&token=...).
 *
 * Like dsh-excalidraw-bridge, this plugin imports nothing from shipped
 * `@deepseek-ai/*` packages: the local `defineTool` below compiles the same
 * authoring DSL into the raw JSON Schema the Host tool registry expects.
 */
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ingest } from './ingest.js'

export const name = 'dsh-viz-timeline'
export const inject = ['tools']

const DEFAULT_PORT = 47131
const PORT_ATTEMPTS = 20
const LONG_POLL_MS = 25_000
const PAGE_STALE_MS = 45_000
const PAGE_PATH = '/viz-timeline'
const BRIDGE_PATH = '/viz-timeline/bridge'


/* ------------------------------------------------------------------ *
 * Bridge（协议与 scripts/bridge_server.py 完全一致）
 * ------------------------------------------------------------------ */

class Bridge {
  constructor(ctx) {
    this.ctx = ctx
    this.port = Number(process.env.DSH_VIZ_BRIDGE_PORT ?? 0) || DEFAULT_PORT
    this.token = process.env.DSH_VIZ_TOKEN ?? null
    this.server = undefined
    this.q = []        // 给页面的命令 [{seq, kind:'cmd', body}]
    this.ev = []       // 页面/桥产生的事件 [{seq, kind:'ev', body}]
    this.seq = 0
    this.waiters = new Set()      // /next 长轮询等待者
    this.resolvers = new Map()    // id -> {resolve, reject, timer}
    this.pageSeenAt = 0           // 最近一次页面 /next 或 /event 的时间
  }

  async start() {
    let lastError
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
      const port = this.port + attempt
      const server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          try { sendJson(res, 500, { error: String(error?.message ?? error) }) } catch { /* socket gone */ }
        })
      })
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
        })
        this.server = server
        this.port = port
        return () => this.stop()
      } catch (error) {
        lastError = error
        server.close()
      }
    }
    throw new Error(`dsh-viz-timeline: cannot bind loopback port ${DEFAULT_PORT}..${DEFAULT_PORT + PORT_ATTEMPTS - 1}: ${String(lastError?.message ?? lastError)}`)
  }

  stop() {
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
    for (const { reject, timer } of this.resolvers.values()) { clearTimeout(timer); reject(new Error('bridge stopped')) }
    this.resolvers.clear()
    if (this.server !== undefined) { this.server.close(); this.server = undefined }
  }

  push(kind, obj) {
    this.seq += 1
    const rec = { seq: this.seq, kind, body: obj }
    ;(kind === 'cmd' ? this.q : this.ev).push(rec)
    for (const waiter of this.waiters) waiter()
    this.waiters.clear()
    return this.seq
  }

  /** Agent/工具侧：下发命令并等待页面结果。 */
  requestOp(body, timeoutMs = 20_000) {
    if (!this.hasPage()) {
      return Promise.reject(new Error(`没有页面连接到桥。打开托管页面 ${PAGE_PATH} 后重试（页面自己连桥）。`))
    }
    const id = this.push('cmd', body)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.q.findIndex((r) => r.seq === id)
        if (at !== -1) this.q.splice(at, 1)
        this.resolvers.delete(id)
        reject(new Error(`页面在 ${Math.round(timeoutMs / 1000)}s 内没有响应命令 "${body.op}"`))
      }, timeoutMs)
      this.resolvers.set(id, { resolve, reject, timer })
    })
  }

  settle(body) {
    const id = Number(body?.id ?? 0)
    const rec = this.resolvers.get(id)
    if (rec === undefined) return false
    clearTimeout(rec.timer)
    this.resolvers.delete(id)
    if (body.ok === false) rec.reject(new Error(String(body.data?.error ?? body.error ?? 'page command failed')))
    else rec.resolve(body.data)
    return true
  }

  hasPage() {
    return Date.now() - this.pageSeenAt <= PAGE_STALE_MS
  }

  /** 经 webServer 的同源路由进来时，把前缀剥掉再走原协议。 */
  async handleRoute(req, res, prefix) {
    if (typeof req.url === 'string' && req.url.startsWith(prefix)) {
      req.url = req.url.slice(prefix.length) || '/'
    }
    return this.handle(req, res)
  }

  async handle(req, res) {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type,x-viz-token')
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (this.token !== null) {
      const qt = url.searchParams.get('token') ?? ''
      if (qt !== this.token && req.headers['x-viz-token'] !== this.token) {
        return sendJson(res, 403, { error: 'token mismatch' })
      }
    }

    if (req.method === 'GET' && url.pathname === '/hello') {
      return sendJson(res, 200, {
        app: 'dsh-viz-timeline-bridge', version: '0.1.0', port: this.port,
        queued: this.q.length, events: this.ev.length,
        page: this.hasPage(), token_required: this.token !== null,
      })
    }

    if (req.method === 'GET' && url.pathname === '/next') { // 页面长轮询取命令（取出即出队）
      this.pageSeenAt = Date.now()
      const rawSince = Number(url.searchParams.get('since') ?? 0) || 0
      // 桥重启后 seq 会归零；页面还带着上一代更大的 since，必须归零否则永远收不到命令
      const since = rawSince > this.seq ? 0 : rawSince
      const deadline = Date.now() + LONG_POLL_MS
      for (;;) {
        const idx = this.q.findIndex((r) => r.seq > since)
        if (idx !== -1) {
          const rec = this.q.splice(idx, 1)[0]
          return sendJson(res, 200, { since: this.seq, cmd: rec })
        }
        if (Date.now() > deadline) return sendJson(res, 200, { since: this.seq })
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve() }
          const timer = setTimeout(done, 2000)
          this.waiters.add(done)
        })
      }
    }

    if (req.method === 'POST' && url.pathname === '/cmd') {
      const body = await readJson(req)
      const id = this.push('cmd', body)
      return sendJson(res, 200, { id })
    }

    if (req.method === 'POST' && url.pathname === '/event') { // 页面回传结果
      this.pageSeenAt = Date.now()
      const body = await readJson(req)
      this.push('ev', body)
      const settled = body?.type === 'result' ? this.settle(body) : false
      return sendJson(res, 200, { seq: this.seq, settled })
    }

    if (req.method === 'GET' && url.pathname === '/events') { // 工具/agent 取页面结果
      const since = Number(url.searchParams.get('since') ?? 0) || 0
      return sendJson(res, 200, { since: this.seq, events: this.ev.filter((r) => r.seq > since) })
    }

    return sendJson(res, 404, { error: `unknown bridge route ${url.pathname}` })
  }
}

/* ------------------------------------------------------------------ *
 * 托管页面：插件自己出页面，页面用相对地址连桥，不再手拼 ?bridge=PORT
 * ------------------------------------------------------------------ */

class VizPage {
  constructor() {
    this.segs = null
    this.meta = { title: 'camodel 泳道图', h1: null, note: '' }
    this.template = null
    this.updatedAt = 0
    this.receipt = null
  }

  async templateText() {
    if (this.template !== null) return this.template
    for (const url of [
      new URL('./templates/timeline.html', import.meta.url),
      new URL('../templates/timeline.html', import.meta.url),
    ]) {
      try {
        this.template = await readFile(url, 'utf8')
        return this.template
      } catch { /* 试下一个位置 */ }
    }
    throw new Error('找不到 timeline.html 模板：插件目录 templates/ 与仓库 templates/ 都没有。')
  }

  setData(segs, meta = {}, receipt = null) {
    this.segs = segs
    this.meta = { ...this.meta, ...meta }
    this.receipt = receipt
    this.updatedAt = Date.now()
  }

  async html() {
    if (this.segs === null) {
      return `<!doctype html><meta charset="utf-8"><title>camodel 泳道图</title>
<style>body{font:14px/1.6 system-ui;margin:40px;color:#333}code{background:#f3f3f3;padding:1px 5px;border-radius:3px}</style>
<p>还没有数据。让会话跑一次 <code>viz_ingest</code>，页面会自动刷新。</p>
<script>setTimeout(()=>location.reload(),3000)</script>`
    }
    const tpl = await this.templateText()
    const title = this.meta.title ?? 'camodel 泳道图'
    const replaced = tpl.replace('const SEGS = __SEGS__;', () =>
      `window.__VIZ_BRIDGE_BASE__=${JSON.stringify(BRIDGE_PATH)};\nconst SEGS = ${JSON.stringify(this.segs)};`)
    let html = replaced
      .replace(/__TITLE__/g, () => title)
      .replace(/__H1__/g, () => this.meta.h1 ?? title)
    html = this.meta.note
      ? html.replace(/__NOTE__/g, () => this.meta.note)
      : html.replace(/<p class="desc" id="note">__NOTE__<\/p>\n?/, '')
    return html
  }
}

/* ------------------------------------------------------------------ *
 * Tool DSL（本地 defineTool，与 dsh-excalidraw-bridge 同款思路）
 * ------------------------------------------------------------------ */

const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])

function compileValueSchema(spec) {
  const node = {}
  if (spec.description !== undefined) node.description = spec.description
  if (!VALUE_TYPES.has(spec.type)) throw new Error(`unsupported schema type: ${String(spec.type)}`)
  node.type = spec.type
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  if (spec.type === 'array') node.items = compileValueSchema(spec.items ?? { type: 'object', additionalProperties: true })
  if (spec.type === 'object') {
    const properties = {}
    const required = []
    for (const [key, value] of Object.entries(spec.properties ?? {})) {
      properties[key] = compileValueSchema(value)
      if (value.required === true) required.push(key)
    }
    node.properties = properties
    if (required.length > 0) node.required = required
    node.additionalProperties = spec.additionalProperties ?? false
  }
  return node
}

function compileParameterMap(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec ?? {})) {
    properties[key] = compileValueSchema(value)
    if (value.required === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false }
}

function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: compileParameterMap(options.parameters),
    output: { schema: compileValueSchema(options.output.schema), render: options.output.render },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    execute: options.execute,
  }
}

const textRender = (fn) => (_args, value) => [{ type: 'text', text: fn(value) }]

function jsonSafe(value) {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(jsonSafe).filter((item) => item !== undefined)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item)
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

/* ------------------------------------------------------------------ *
 * viz_* 工具
 * ------------------------------------------------------------------ */

function segParam() {
  return { type: 'integer', description: '面板段号（从 1 开始；缺省为第 1 段）' }
}

function vizTools(bridge, page, urlOf) {
  const run = async (body, exec, timeoutMs) => {
    exec.signal.throwIfAborted()
    return jsonSafe(await bridge.requestOp(body, timeoutMs))
  }

  const status = defineTool({
    name: 'viz_status',
    description: '检查 camodel-viz 桥状态：是否有可视化页面连接、队列深度、桥监听端口。桥或页面没连上时其它 viz_* 工具会失败，先调它排障。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          bridge: { type: 'string', required: true },
          port: { type: 'number', required: true },
          page_connected: { type: 'boolean', required: true },
          queued: { type: 'number', required: true },
          token_required: { type: 'boolean', required: true },
          page_url: { type: 'string' },
        },
      },
      render: textRender((v) => v.page_connected
        ? `桥已连接页面（127.0.0.1:${v.port}，队列 ${v.queued}）。页面：${v.page_url || '(未托管)'}`
        : `桥在运行，但还没有页面连上。打开 ${v.page_url || '托管页面'} 即可（页面自己连桥，不用拼端口）。`),
    },
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted()
      return {
        bridge: 'up', port: bridge.port, page_connected: bridge.hasPage(),
        queued: bridge.q.length, token_required: bridge.token !== null,
        page_url: urlOf() ?? '',
      }
    },
  })

  const stats = defineTool({
    name: 'viz_stats',
    description: '读取泳道图某一段的统计：T/跨度/轮周期/Δ中位、load/store/alloc/free/WAIT 计数、MTE2/MTE3 并发行数、执行与排队时长中位、busy%、等待总和。用来回答"这段整体表现如何"。',
    parameters: { seg: segParam() },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: textRender((v) => `seg${v.seg}（${v.kind}）T=${v.T}cyc 轮周期中位=${v.period} Δ中位=${v.dmed} 行数 M2/M3=${v.rows.m2}/${v.rows.m3} exec中位 load=${v.execMed.load} store=${v.execMed.store} busy M2=${v.busy.m2}% M3=${v.busy.m3}%`),
    },
    execute: (args, exec) => run({ op: 'stats', seg: args.seg ?? 1 }, exec),
  })

  const at = defineTool({
    name: 'viz_at',
    description: '查询指定 cycle 时刻泳道图上哪些指令正在执行（[pop,retire] 命中），以及附近的 VEC/alloc/free 事件。用来回答"这一刻在跑什么"。',
    parameters: { seg: segParam(), cycle: { type: 'integer', required: true, description: '仿真 cycle' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: textRender((v) => `cycle ${v.cycle}：${v.executing.length} 条在执行（${v.executing.map((x) => x.lane + '#' + x.idx).join(', ')}）`),
    },
    execute: (args, exec) => run({ op: 'at', seg: args.seg ?? 1, cycle: args.cycle }, exec),
  })

  const rounds = defineTool({
    name: 'viz_rounds',
    description: '取泳道图某一段的逐轮表（轮号、load/store 的 push/pop/retire、vec alloc、BMU 地址），可按 from/to 截取。',
    parameters: {
      seg: segParam(),
      from: { type: 'integer', description: '起始轮（含）' },
      to: { type: 'integer', description: '结束轮（含）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: textRender((v) => `seg${v.seg} 第 ${v.from}..${v.to} 轮共 ${v.rows.length} 行。\n${v.rows.map((r) => `r${r.r} load[${r.load?.push},${r.load?.pop},${r.load?.retire}] store[${r.store?.push},${r.store?.pop},${r.store?.retire}]${r.allocAddr ? ' ' + r.allocAddr : ''}`).join('\n')}`),
    },
    execute: (args, exec) => run({ op: 'rounds', seg: args.seg ?? 1, from: args.from, to: args.to }, exec),
  })

  const view = defineTool({
    name: 'viz_view',
    description: '控制泳道图某面板的视图：整段适配、按缩放比例、缩放到 cycle 区间、或居中到某一轮。',
    parameters: {
      seg: segParam(),
      scale: { type: 'number', description: 'px/cyc 缩放比例' },
      range: { type: 'array', items: { type: 'integer' }, description: '[c0, c1] cycle 区间' },
      round: { type: 'integer', description: '居中到该轮' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: textRender((v) => `seg${v.seg} 视图已更新：${JSON.stringify(v)}`),
    },
    execute: (args, exec) => {
      const body = { op: 'view', seg: args.seg ?? 1 }
      if (args.scale !== undefined) body.scale = args.scale
      if (Array.isArray(args.range) && args.range.length === 2) { body.c0 = args.range[0]; body.c1 = args.range[1] }
      if (args.round !== undefined) body.round = args.round
      return run(body, exec)
    },
  })

  const highlight = defineTool({
    name: 'viz_highlight',
    description: '在泳道图某面板上画半透明标记带（截图可见）：指定 cycle 区间或某一轮；clear=true 清除。用来向用户指出"看这里"。',
    parameters: {
      seg: segParam(),
      range: { type: 'array', items: { type: 'integer' }, description: '[c0, c1] cycle 区间' },
      round: { type: 'integer', description: '高亮该轮' },
      clear: { type: 'boolean', description: '清除高亮（true 时忽略 range/round）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: textRender((v) => v.cleared ? `seg${v.seg} 高亮已清除。` : `seg${v.seg} 已高亮 [${v.highlight?.[0]}, ${v.highlight?.[1]}]。`),
    },
    execute: (args, exec) => {
      const body = { op: args.clear === true ? 'clear-highlight' : 'highlight', seg: args.seg ?? 1 }
      if (Array.isArray(args.range) && args.range.length === 2) { body.c0 = args.range[0]; body.c1 = args.range[1] }
      if (args.round !== undefined) body.round = args.round
      return run(body, exec)
    },
  })

  const load = defineTool({
    name: 'viz_load',
    description: '运行时替换泳道图数据：读取 parse_dumps.py 生成的 segs.json（绝对路径），页面整体重渲染，无需重新 build。',
    parameters: {
      path: { type: 'string', required: true, description: 'segs.json 绝对路径' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { loaded: { type: 'number', required: true } } },
      render: textRender((v) => `已加载 ${v.loaded} 段数据并重渲染。`),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const raw = await readFile(String(args.path), 'utf8')
      const segs = JSON.parse(raw)
      if (!Array.isArray(segs)) throw new Error('segs.json 必须是数组')
      return run({ op: 'load', segs }, exec, 30_000)
    },
    timeoutMs: 30_000,
  })

  const ingestTool = defineTool({
    name: 'viz_ingest',
    description: '接 case 目录出泳道图数据：读目录里的 issue-queue dump 与驱动日志，按 done+++ 分段识别事件，产出 segs.json 和对账回执（识别/未识别行数、md5 去重、跳过的 debug 回声、段界、截断告警、时间单位口径）。未知行型进回执不中断；日志截断时返回 blocked 不生成图。',
    parameters: {
      dirs: { type: 'array', items: { type: 'string' }, required: true, description: 'case 目录绝对路径，可传多个（多目录 = 多面板 A/B 对照）' },
      title: { type: 'string', description: '页面标题' },
      note: { type: 'string', description: '页面说明段落（口径、样例来源等）' },
      out: { type: 'string', description: 'segs.json 与 receipt.json 的输出目录（缺省为系统临时目录）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          status: { type: 'string', required: true },
          segs: { type: 'number' },
          segs_path: { type: 'string' },
          receipt_path: { type: 'string' },
          page_url: { type: 'string' },
        },
      },
      render: textRender((v) => {
        if (v.status !== 'ok') return `没出图：${v.reason ?? '未知原因'}`
        const l = v.receipt?.lines ?? {}
        const segs = (v.receipt?.segments ?? []).map((s) => `seg${s.i} ${s.kind} T=${s.T} load ${s.counts.load}/store ${s.counts.store}/alloc ${s.counts.alloc}/free ${s.counts.free}/bar ${s.counts.bar}`).join('\n')
        return `已出 ${v.segs} 段。识别 ${l.events_recognized ?? '?'} 行事件，未识别 ${l.unrecognized ?? '?'} 行，跳过 debug 回声 ${l.skipped_debug_echo ?? '?'} 行。\n${segs}\n页面：${v.page_url ?? '(未托管)'}\nsegs: ${v.segs_path}\n回执: ${v.receipt_path}`
      }),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const dirs = (args.dirs ?? []).map(String)
      if (dirs.length === 0) throw new Error('dirs 不能为空')
      const result = await ingest({ dirs })
      const outDir = args.out === undefined
        ? join(process.env.DSH_HOME ?? homedir(), 'viz-timeline', String(Date.now()))
        : String(args.out)
      await mkdir(outDir, { recursive: true })
      const receiptPath = join(outDir, 'receipt.json')
      await writeFile(receiptPath, JSON.stringify(result.receipt ?? {}, null, 2))
      if (result.status !== 'ok' || !Array.isArray(result.segs)) {
        return {
          status: result.status ?? 'blocked',
          reason: result.reason ?? result.detail ?? '没有可出图的数据',
          detail: result.detail ?? null,
          receipt: result.receipt ?? null,
          segs: 0, segs_path: '', receipt_path: receiptPath, page_url: '',
        }
      }
      const segsPath = join(outDir, 'segs.json')
      await writeFile(segsPath, JSON.stringify(result.segs))
      const title = args.title ?? `camodel 泳道图（${dirs.map((d) => basename(d)).join(' / ')}）`
      page.setData(result.segs, { title, h1: title, note: args.note ?? '' }, result.receipt)
      return {
        status: 'ok',
        segs: result.segs.length,
        segs_path: segsPath,
        receipt_path: receiptPath,
        page_url: urlOf() ?? '',
        receipt: result.receipt,
      }
    },
    timeoutMs: 120_000,
  })

  const openTool = defineTool({
    name: 'viz_open',
    description: '打开插件托管的泳道图页面（页面自己连桥，不需要拼 ?bridge=端口）。可传 segs.json 载入数据，缺省用最近一次 viz_ingest 的结果。',
    parameters: {
      path: { type: 'string', description: 'segs.json 绝对路径（可选）' },
      title: { type: 'string', description: '页面标题' },
      note: { type: 'string', description: '页面说明段落' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          segs: { type: 'number', required: true },
          ready: { type: 'boolean', required: true },
        },
      },
      render: textRender((v) => (v.ready ? `页面已就绪（${v.segs} 段）：${v.url}` : `页面已托管但还没有数据：${v.url}`)),
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      if (args.path !== undefined) {
        const raw = await readFile(String(args.path), 'utf8')
        const segs = JSON.parse(raw)
        if (!Array.isArray(segs)) throw new Error('segs.json 必须是数组')
        page.setData(segs, { title: args.title, note: args.note })
      }
      const url = urlOf()
      if (url === null) throw new Error('当前 profile 没有 webServer，页面托管不可用；用 viz_load 把数据推给已有页面。')
      return { url, segs: page.segs?.length ?? 0, ready: page.segs !== null }
    },
  })

  return { status, stats, at, rounds, view, highlight, load, ingest: ingestTool, open: openTool }
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJson(req, limit = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const bridge = new Bridge(ctx)
  const page = new VizPage()
  ctx.effect(() => bridge.start().then((dispose) => {
    try { ctx.logger?.('dsh-viz-timeline')?.info?.(`bridge listening on http://127.0.0.1:${bridge.port}`) } catch { /* best effort */ }
    return dispose
  }), 'viz-timeline: bridge server')

  // 页面托管：挂在宿主 Web server 上，页面与桥同源，浏览器不用再拼 ?bridge=PORT
  const webServer = ctx.get('webServer')
  const webApp = ctx.get('webApp')
  let origin = null
  if (webServer !== undefined) {
    try { origin = webApp?.getAdvertisedUrl?.() ?? webServer.getOrigin() } catch { origin = null }
  }
  const urlOf = () => (origin === null ? null : `${String(origin).replace(/\/+$/, '')}${PAGE_PATH}`)

  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: PAGE_PATH,
      handler: async (_req, res) => {
        const html = await page.html()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
      },
    }), 'viz-timeline: hosted page route')

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: BRIDGE_PATH,
      handler: (req, res) => bridge.handleRoute(req, res, BRIDGE_PATH),
    }), 'viz-timeline: same-origin bridge route')
  }

  const tools = vizTools(bridge, page, urlOf)
  for (const tool of Object.values(tools)) {
    ctx.effect(() => ctx.tools.register(tool), `viz-timeline: tool ${tool.name}`)
  }
}

/* Standalone 模式：node plugin/index.js 直接起桥（调试用，等价 bridge_server.py）。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bridge = new Bridge({})
  await bridge.start()
  console.log(`[standalone] bridge listening on http://127.0.0.1:${bridge.port} token=${bridge.token ?? '(none)'}`)
}
