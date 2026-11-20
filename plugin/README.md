# DSH 插件：dsh-viz-timeline

让 DSH 会话获得 7 个原生泳道图工具（`viz_*`），桥跑在 DSH Host 进程内，协议与
`scripts/bridge_server.py` 完全一致——同一份 `templates/timeline.html` 无需任何改动。

## 安装

与 dsh-excalidraw-bridge 相同的方式：

1. 把整个 `plugin/` 目录安装为 DSH bundle（设置 → 插件，或按 DSH 的 bundle 安装流程）；
2. 启用后 DSH Host 内监听 `127.0.0.1:47131`（占用则 +1 顺试 20 个）；
3. 用 `?bridge=端口` 打开泳道图页面（file:// 或静态服务均可），页面右上角出现
   「bridge：已连接」状态文本；
4. 会话工具列表出现 `viz_status / viz_stats / viz_at / viz_rounds / viz_view /
   viz_highlight / viz_load`。

环境变量：`DSH_VIZ_BRIDGE_PORT`（起始端口）、`DSH_VIZ_TOKEN`（可选共享 token，
页面 URL 加 `&token=...`）。

## 工具一览

| 工具 | 作用 |
|---|---|
| `viz_status` | 桥状态：是否有页面连接、队列深度、端口 |
| `viz_stats` | 段统计：T/轮周期/Δ/行数/执行与排队中位/busy%/等待和 |
| `viz_at` | 指定 cycle 谁在执行 + 邻近事件 |
| `viz_rounds` | 逐轮表（push/pop/retire、vec alloc、BMU 地址） |
| `viz_view` | 视图控制：fit / scale / range / round |
| `viz_highlight` | 半透明标记带（range 或 round），clear 清除 |
| `viz_load` | 运行时替换数据（读 parse_dumps.py 的 segs.json 绝对路径） |

## 排障

- 工具报「没有可视化页面连接到桥」→ 页面没带 `?bridge=` 或没刷新；先看 `viz_status`。
- 端口冲突 → 设 `DSH_VIZ_BRIDGE_PORT` 并同步页面 URL。
- 页面缓存旧版本 → URL 加缓存戳 `?v=N&bridge=PORT`。

## 调试

`node plugin/index.js` 以独立模式直接起桥（不带 DSH 也能用页面 + viz_client.py 联调）。
