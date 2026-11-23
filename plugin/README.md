# DSH 插件：dsh-viz-timeline

给 DSH 会话一条从「case 目录」到「能看的泳道图」的通路：`viz_ingest` 解析不规范的仿真 dump，
`viz_open` 打开插件自己托管的页面，页面与桥同源、不用再拼 `?bridge=端口`；
`viz_*` 工具让 agent 查统计、定位 cycle、控视图、画高亮。

## 安装

1. 把 `plugin/` 目录装成 DSH bundle（`plugin_manager install_bundle`，target 传目录绝对路径）。
2. 装完 `application: applied` 即可用，不需要重启会话。
3. 页面地址：`<宿主 Web 源>/viz-timeline`（工具回执里的 `page_url` 就是它）。

## 工具

| 工具 | 作用 |
|---|---|
| `viz_ingest` | 接 case 目录（可多个 = 多面板 A/B），出 `segs.json` + `receipt.json`，并把数据装进托管页面 |
| `viz_open` | 打开/刷新托管页面；可传 `segs.json` 直接载入，缺省用最近一次 ingest 的结果 |
| `viz_status` | 桥状态：有没有页面连着、队列深度、端口 |
| `viz_stats` | 段统计：T/轮周期/Δ中位/行数/执行与排队中位/busy%/等待和 |
| `viz_at` | 指定 cycle 谁在执行（`[pop,retire]` 命中）+ 邻近事件 |
| `viz_rounds` | 逐轮表（load/store 的 push/pop/retire、vec alloc、BMU 地址） |
| `viz_view` | 视图控制：fit / scale / range / round |
| `viz_highlight` | 半透明标记带（range 或 round），可清除 |
| `viz_load` | 把一份已有的 `segs.json` 推给页面重渲染 |

## 数据接入的硬约束（回执里逐条有数）

- **未知行型不中断**：进 `receipt.unknown`（模式 + 条数），不 `SystemExit`；没有语义归类的事件名进 `receipt.other_event_names`。
- **同内容异名文件按 md5 去重**：只解析一次，`receipt.dedupe` 记录谁和谁重复。
- **debug 回声跳过并计数**：`push_instr_to_prefetch_que` / `pop_prefetch_payload` 计入 `receipt.lines.skipped_debug_echo`。
- **段界靠 `done+++` trailer**：某段没有 trailer 时回执给 warning，start/tick 用事件区间代替。
- **截断不出半张图**：驱动日志最后一个 `TASK_BEGIN` 没有 `TASK_DONE` 时返回 `status: blocked`，`reason` 写明文件和行号，不生成任何数据。
- **时间单位只声明不换算**：`receipt.units` 写明是仿真 cycle（dump-global counter），执行 = retire − pop，排队 = pop − push；不换算 wall 时间、不外推硬件。
- **空泳道不出**：解析出段但所有段都没有 load/store 事件时返回 `blocked`。

## 目录约定

- 输入：case/evidence 目录（含 `*mte2_issque.dump` / `*mte3_issque.dump` / `*vec_issque.dump` / `*bmu.dump` / 驱动日志）。
- 输出：`viz_ingest` 的 `out`（缺省 `$DSH_HOME/viz-timeline/<时间戳>/`）下的 `segs.json`、`receipt.json`。
- 模板：优先用包内 `templates/timeline.html`；本地 link 安装时回落到仓库根目录的 `templates/timeline.html`。

## 排障

- 工具报「没有页面连接到桥」→ 先把 `/viz-timeline` 页面打开（`viz_open` 会回地址），再看 `viz_status`。
- `/viz-timeline` 打不开 → 该 profile 没有 `webServer` 服务；此时只能用 `viz_load` 推数据给已有页面，`viz_open` 会直接报错说明。
- 页面显示的是旧数据 → 重新 `viz_ingest` 或 `viz_open`，页面是服务端拼的，刷新即时生效。
- 端口冲突（loopback 兼容桥）→ 设 `DSH_VIZ_BRIDGE_PORT`；同源页面路由不受影响。
