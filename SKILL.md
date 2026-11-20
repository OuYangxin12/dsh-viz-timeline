---
name: camodel-viz
description: 把 Ascend camodel（A6 ESL/STARS_VENUS）仿真日志变成可交互时序图。输入两种格式之一：(1) evidence 目录下的 per-pipe issue-queue dump（*mte2_issque.dump / *mte3_issque.dump / *vec_issque.dump / *.bmu.dump，多 launch 段、多目录 A/B 对照都支持）→ 生成多 pipe 泳道图（MTE2/VEC/MTE3/BMU/事件，load/store 按执行区间重叠自动分行、条上文字随缩放碰撞避让）；(2) 驱动级日志（TASK_BEGIN/DONE + block_start/early_end/block_end）→ 生成 per-core 块调度甘特图。当用户说"画泳道图 / 仿真日志可视化 / issque dump 出图 / BMU 静态对比图 / block 调度甘特"时使用。零第三方依赖（python3 标准库 + 浏览器）。
---

# camodel 仿真日志可视化

工作流两步：**parse_dumps.py（日志 → JSON）→ build.py（JSON + 模板 → 自包含 HTML）**。
原则：**日志里有什么就画什么**，每个图形 tooltip 标注来源 dump；无推断数据。

## 1. pipe 模式（issue-queue dump → 泳道图）

输入：一个或多个 evidence 目录（每目录一套 `core*.veccore*.ccu.*.dump`）。传多个目录 = 多面板 A/B 对比（如静态 vs BMU）。

```bash
SKILL=~/.kimi-code/skills/camodel-viz
python3 $SKILL/scripts/parse_dumps.py <evidence_dir> [more_dir ...] -o segs.json
python3 $SKILL/scripts/build.py segs.json -t $SKILL/templates/timeline.html -o timeline.html \
    --title "标题" --h1 "大标题" --note "说明段落（可省略）"
```

打开 `timeline.html`（浏览器直接开 file:// 即可，数据已内嵌）。

- 自动识别：trailer 分段（多 launch）、静态/BMU 分类（有 BUF_ALLOC/BUF_FREE/vec alloc → bmu）、load/store 按 `MOV_SRC_TO_DST*` 前缀、WAIT/SET_FLAG、BAR release、bmu.dump 的 `alloc_addr`（带 UB 地址）、vec_issque 全部事件。
- 轮结构自动推断：load 数整除 store 数时按每轮分组，否则每 load 自成一轮。
- 兼容旧格式：silu-mul 系 dump 里 `bmu.dump` 与 `mte2_issque` 同内容（自动回退）；RETIRE 行的 `instr.name=` 前缀；`early_end` 行无 `full_task_id` 字段（仅 driver 模式）。

## 2. driver 模式（驱动日志 → 块调度甘特图）

```bash
python3 $SKILL/scripts/parse_dumps.py <real_*.log> --mode driver -o blocks.json
python3 $SKILL/scripts/build.py blocks.json -t $SKILL/templates/blocks.html -o blocks.html --title "标题"
```

## 输出页面交互

- 每个面板**独立缩放**：滚轮以光标为锚、面板内滑块、"整段适配/单轮特写"按钮；各面板独立平移（滚动条/小地图拖动）。
- 悬停任意图形显示数值详情（push/pop/retire、排队/执行时长、UB 分配地址、来源文件），点击固定。
- load/store 执行条按 [pop,retire] 重叠自动分行（互不重叠）；条上文字按碰撞避让随缩放自适应显隐。

## 口径与限制（出图后必须保留的说明）

- 执行时长 = RETIRE − pop；排队 = pop − push；所有数字为**仿真 cycle，不外推硬件**。
- 未画出的 dump 内容：MOV_SPR_XN、END_LABEL、scalar/dcache/ifu/instr_log 等（粒度更细，非主线）；需要时可扩展 parse_dumps.py 的分类表。
- driver 模式与 pipe 模式是两种粒度，不可互比；驱动日志被截断时（task BEGIN 后无 block 事件）图会如实缺失。
- 单次 launch、单核 trace 是常见口径；跨核对比需对每个 core 目录分别跑或扩展 parser（当前一个目录集 = 一个段组）。
- 解析自检输出在 stderr（每段 T/轮周期/各类事件计数），与预期不符时先查它。

## 目录结构

```
camodel-viz/
├── SKILL.md                  本文件
├── scripts/
│   ├── parse_dumps.py        pipe/driver 双模式解析器（纯标准库）
│   ├── build.py              JSON 注入模板 + node --check 校验
│   ├── bridge_server.py      agent 桥接服务器（页面 <-> agent，127.0.0.1，长轮询）
│   └── viz_client.py         桥接 CLI 客户端（stats/at/view/highlight/...）
└── templates/
    ├── timeline.html         泳道图模板（__SEGS__/__TITLE__/__H1__/__NOTE__ 占位；内建 agent 桥）
    └── blocks.html           块甘特图模板
```

## 3. Agent 桥接（原生 web-agent 控制，类比 dsh-excalidraw-bridge）

页面以 `?bridge=PORT`（默认 47131）打开后，自动长轮询本地桥、接收命令并回传结果；
agent（DSH / 任意脚本）经 `viz_client.py` 或 HTTP 直接下发命令。只绑 127.0.0.1，`--token` 可选。

```bash
python3 $SKILL/scripts/bridge_server.py --port 47131 &          # 1. 起桥
# 2. 打开页面（file:// 或静态服务均可）：timeline.html?bridge=47131
python3 $SKILL/scripts/viz_client.py --port 47131 hello          # 3. 命令
python3 $SKILL/scripts/viz_client.py --port 47131 stats --seg 2
python3 $SKILL/scripts/viz_client.py --port 47131 at --seg 2 --cycle 8500
python3 $SKILL/scripts/viz_client.py --port 47131 view --seg 2 --range 8000 9000
python3 $SKILL/scripts/viz_client.py --port 47131 highlight --seg 2 --round 5
python3 $SKILL/scripts/viz_client.py --port 47131 load --json segs2.json   # 运行时换数据
```

命令集（返回 JSON）：`hello`（段概览）、`stats`（T/周期/Δ/行数/执行与排队中位/busy%/等待和）、
`at`（指定 cycle 谁在执行 + 邻近事件）、`rounds`（逐轮表）、`view`（fit/scale/range/round 视图控制）、
`highlight` / `clear-highlight`（半透明标记带，截图可见）、`load`（替换 SEGS 重渲染，无需重新 build）。
DSH 插件化时把这几个 op 包成工具即可（与 dsh-excalidraw-bridge 的 plugin/ 同思路，但页面侧零注入成本）。

排障：页面迭代重建后浏览器可能缓存旧 HTML——打开页面时给 URL 加缓存戳（如 `?v=N&bridge=PORT`）；
页面右上角状态文本（ bridgestate ）显示连接/处理/等待与 since，命令无响应时先看它。

## 已验证样例

- `A6triton-ops/cases/fbgemm/jagged_to_dense/bmu-sim/`（no-bmu-evidence vs evidence：T 24956 vs 12180，store 1 行→8 行）。
- silu-mul 五段 dump（.tmp-bmu-evidence/runs/20261110-silu-mul-pure-bmu/，旧 bmu.dump≡mte2 格式）。
- real_bmu.log（grid=36 块调度，driver 模式）。
