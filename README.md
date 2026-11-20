# dsh-viz-timeline

把 Ascend camodel（A6 ESL / STARS_VENUS）仿真日志变成**可交互时序泳道图**，并让 agent（DSH 等）通过本地桥原生操控图表。

灵感与桥接模式来自 [dsh-excalidraw-bridge](https://github.com/OuYangxin12/dsh-excalidraw-bridge)；不同之处在于本项目的页面是自家产物，桥直接内置在页面里，无需浏览器扩展。

## 能做什么

- **pipe 模式**：解析 evidence 目录下的 per-pipe issue-queue dump（`*mte2_issque.dump` / `*mte3_issque.dump` / `*vec_issque.dump` / `*.bmu.dump`），生成多 pipe 泳道图：MTE2 load / VEC pipe / MTE3 store / BMU alloc(带 UB 地址)·free / WAIT·SET·BAR 事件。多 launch 段、多目录 A/B 对照（如静态 vs BMU）都支持。
- **driver 模式**：解析驱动级日志（`TASK_BEGIN/DONE` + `block_start/early_end/block_end`），生成 per-core 块调度甘特图。
- **原则：日志里有什么就画什么**——每个图形的 tooltip 标注来源 dump，无任何推断数据。
- **交互**：每面板独立缩放（滚轮锚点/滑块/按钮）、小地图、悬停数值、点击固定；执行条按 [pop,retire] 重叠自动分行（互不重叠）；条上文字随缩放按碰撞避让自适应显隐。
- **agent 桥**：页面以 `?bridge=PORT` 打开后，agent 经 HTTP 桥下发命令（stats / at / rounds / view / highlight / load），拿到页面回传的 JSON 结果——"cycle 8500 时谁在执行"、"高亮 r5-r10"、"运行时换数据"都是一条命令。

## 快速开始

```bash
# 1) 日志 → JSON（pipe 模式；多个目录 = 多面板 A/B）
python3 scripts/parse_dumps.py no-bmu-evidence evidence -o segs.json

# 2) JSON → 自包含 HTML
python3 scripts/build.py segs.json -t templates/timeline.html -o timeline.html \
    --title "jagged_to_dense 静态 vs BMU" --note "仿真口径"

# 3) 浏览器打开 timeline.html（数据已内嵌，file:// 亦可）
```

driver 模式（块调度甘特图）：

```bash
python3 scripts/parse_dumps.py real_bmu.log --mode driver -o blocks.json
python3 scripts/build.py blocks.json -t templates/blocks.html -o blocks.html --title "block 调度"
```

agent 桥（可选）：

```bash
python3 scripts/bridge_server.py --port 47131 &          # 起桥（只绑 127.0.0.1）
# 打开页面时带参数：timeline.html?bridge=47131
python3 scripts/viz_client.py --port 47131 stats --seg 2
python3 scripts/viz_client.py --port 47131 at --cycle 8500
python3 scripts/viz_client.py --port 47131 highlight --range 8000 9000
```

DSH 用户：把本仓注册为 Kimi Code skill（复制 `SKILL.md` + `scripts/` + `templates/` 到 skills 目录），或安装 `plugin/` 作为 DSH 插件获得原生 `viz_*` 工具（见 plugin/README）。

## 数据口径（所有图必须保留的声明）

- 执行时长 = `RETIRE − pop`；排队 = `pop − push`；所有数字为**仿真 cycle，不外推硬件**。
- 未画出的 dump 内容（`MOV_SPR_XN`、`END_LABEL`、`scalar/dcache/ifu/instr_log` 等）粒度更细，非本图主线；需要时扩展 `scripts/parse_dumps.py` 的分类表。
- driver 模式与 pipe 模式是两种粒度，不可互比。

## 仓库结构

```
├── SKILL.md            agent 使用说明（Kimi Code skill 入口）
├── README.md           本文件
├── scripts/
│   ├── parse_dumps.py  pipe/driver 双模式解析器（纯标准库，stderr 自检）
│   ├── build.py        JSON 注入模板 + node --check 校验
│   ├── bridge_server.py  agent 桥（HTTP 长轮询，可选 token）
│   └── viz_client.py   桥接 CLI
├── templates/
│   ├── timeline.html   泳道图模板（内建 agent 桥，?bridge=PORT 启用）
│   └── blocks.html     块甘特图模板
├── plugin/             DSH Cordis 插件（viz_* 原生工具，桥跑在 DSH Host 内）
└── examples/           样例数据（jagged_to_dense 静态 vs BMU）
```

## 已验证样例

- `jagged_to_dense`（FBGEMM）：静态 T=24956 cyc / store 1 行串行 vs BMU T=12180 / store 8 行并发，约 2.05×（仿真口径）。
- `real_bmu.log`：grid=36 块调度甘特图（36 block / 36 core）。
- agent 桥端到端：`hello/stats/at/view/highlight/load` 全部经桥回传验证。
