# Agent Chat 输入框：slash 命令与 @ 文件提及补全

## Goal

在 Agent Chat 的输入框里实现两种补全弹层：

| 触发 | 数据源 | 选中后的效果 |
| --- | --- | --- |
| `/`（行首或空白后） | agent 自己的命令列表 | 插入 `/命令名 ` |
| `@`（行首或空白后） | 项目文件树（扁平化） | 插入 `@路径 ` 并附加该文件 |

两者共用一套「锚点定位 + 键盘导航 + 过滤」的弹层骨架。

## 现状

`/` 与 `@` 在 agent-chat 域**完全没有实现**（`grep` 零命中）。输入框只有
`onKeyDown` 处理 Enter 发送 / Shift+Enter 换行。

同时，两个数据源都已就绪：

| 需要 | 已有 |
| --- | --- |
| 命令列表 | Pi 的 `get_commands` 返回 **157 条**（`source ∈ prompt(3) / skill(98) / extension(56)`，字段 `{name, description, source, sourceInfo}`） |
| 文件列表 | `readDirTree(workspace, null, depth)` 已在附件选择里用过 |

## 一手取证

### `get_commands` 的真实形状（pi 1.3.0 实测）

```json
{"type":"response","command":"get_commands","success":true,
 "data":{"commands":[
   {"name":"vision-handoff",
    "description":"Configure vision handoff — pick a vision model …",
    "source":"extension",
    "sourceInfo":{"path":"/Users/…/pi-vision-handoff/vision-handoff.ts",
                  "source":"npm:pi-vision-handoff","scope":"user","origin":"package"}},
   {"name":"trellis-continue","description":"# Continue Current Task","source":"prompt"},
   {"name":"skill:code-walkthrough","description":"与用户共同阅读 Neeko 代码…","source":"skill"}
 ]}}
```

三个 `source` 的差别只在**来源说明**，对插入文本而言都只是 `/name`。

**执行不需要新机制**：`prompt` 里带 `/trellis-start` 会被 pi 自己展开（实测触发）。
所以「选中命令」只是把 `/name ` 写进输入框，**不新增后端命令**。

### 文件的插入语义

`@path` 需要两层效果：
1. 输入框里出现 `@src/foo.ts `（用户可见、可再编辑）
2. 该文件进入 `attachments`（现有链路：随 prompt 的 `files` 字段发送）

第 2 步复用已有的 `addAttachment(path, name)`。

## 与 `pi-rpc-adapter` 任务的关系

该任务已实现 `PiSession` 的完整 rpc 通道。这里**唯一需要的后端增量**是
一条把 `get_commands` 结果送到前端的通路（见下）。其余全在前端。

## Requirements

### R1 命令列表来自 agent，不来自前端常量

**禁止**在前端硬编码命令清单。列表必须来自 agent 的 `get_commands`。

这与 `10-21-pi-rpc-adapter` 里刚修的两个缺陷同源（`AGENT_MODES` /
`THINKING_LEVELS` 硬编码 → 界面正常但后端没变）。命令列表尤其危险：
不同 agent 的命令集完全不同，硬编码一份等于只支持 pi。

### R2 能力位判定 + 一条数据查询通路（两件事分开）

> 现状注记（2026-10-24 修订）：adapter 已从方案写作时的 1 个（pi_rpc）扩到 4 个
> （pi_rpc / acp / opencode / deepseek）；`ChatCapabilities` 能力位体系也已落地。

**能不能弹 `/`** 由能力位判定，不靠「试查询报不报错」：`ChatCapabilities` 已预留
`commands: bool`（`src-tauri/src/agent/chat/capabilities.rs`），pi_rpc/adapter.rs
注释已写明契约——`get_commands` 存在但本仓无实现，故现为 `false`，本任务在
**同一 diff 内**对 PiRpcAdapter 改 `true`，并投影到 `session_start.capabilities`
（`events.rs::from_chat_capabilities` + 前端 `src/shared/types/agentChat.ts` 的
`Capabilities` 镜像同步）。前端按该位门控 `/` 入口。这是 spec
`agent-chat-transports.md` §10.1「能力位是唯一判据」的同源要求——历史上靠
`configOptions` 非空推断能力正是修掉的 P1 缺陷形态。

**取数据**走一条新查询（命令名待定，形如 `list_agent_commands`），内部转发
`get_commands` 的 `data.commands`：

- 能力位为 false 的传输 → 查询也返回 `Err(Unsupported)`（声明与实现一致，
  用契约测试钉住「`commands` 位为 true ⇔ 不返回 Unsupported」）
- 支持但返回空的 → 空列表，前端显示「无命令」而不是假装没有该功能

**不塞进 `StreamEvent`**：命令查询是与会话生命周期解耦的独立查询（同
`list_agent_models` 一类），不是会话内操作。⚠️ pi_rpc/adapter.rs 现有注释预期
「get_commands → 事件 → slash 面板」，与本决策矛盾——实现时同 diff 改写该注释，
不留第二份指向另一方案的真相。

其余三个 adapter 维持 `commands: false`（默认全关由契约测试覆盖）。acp.rs 注释
「ACP 没有列命令方法」待复核——ACP 协议有 `available_commands_update` 通告；
若属实属后续增量，不在本次范围，但命令数据结构（`name`/`description`）与 ACP
形状保持对齐。

### R3 触发条件精确

- `/` 只在**行首**或**空白之后**触发（避免 `src/foo` 误触发）
- `@` 同理
- 触发后继续输入的字符成为过滤词；`Esc` 关闭；再次输入触发符重置

### R4 键盘导航

上下移动、`Enter`/`Tab` 选中、`Esc` 关闭。**`Enter` 在弹层打开时必须选中候选**，
不能同时触发发送 —— 这是输入框类补全最容易出的双触发缺陷。

### R5 锚点定位

弹层贴着**光标位置**而不是输入框左上角。实现方式二选一（实现时按可行性定）：
- 用 `textarea` 的镜像 div 计算光标坐标（无依赖，但要处理换行与滚动）
- 贴输入框顶部（简单，但长文本时光标在下方会显得脱节）

### R6 不破坏现有输入行为

- Enter 发送、Shift+Enter 换行保持不变
- 已附加的附件 chips 与移除按钮不受影响
- `Ime`（中文输入法）组合期间不触发补全

## Acceptance Criteria

- [ ] **AC1** 输入 `/` 弹出该 agent 的命令列表；`capabilities.commands` 为 false 的传输不弹（能力位判定，非试查询报错）
- [ ] **AC2** 命令列表来自 `get_commands`，不是前端常量（有静态护栏）
- [ ] **AC3** 选中命令 → 输入框出现 `/name `，发送后被 agent 执行（真机）
- [ ] **AC4** 输入 `@` 弹出项目文件列表；继续输入按路径过滤
- [ ] **AC5** 选中文件 → 输入框出现 `@path ` **且**该文件进入 attachments
- [ ] **AC6** 键盘：上下移动 / Enter 选中 / Tab 选中 / Esc 关闭
- [ ] **AC7** 弹层打开时 Enter **不**触发发送（双触发缺陷有测试）
- [ ] **AC8** 中文输入法组合期间不触发补全
- [ ] **AC9** 弹层位置跟随光标（或明确记录为何选择贴输入框）
- [ ] **AC10** Enter 发送 / Shift+Enter 换行 / 附件 chips 行为零回归

## Non-Goals

- 不做命令的**参数补全**（`/cmd --flag`）—— 各 agent 的参数语义无法统一
- 不做 `@` 的目录级提及（只提文件）
- 不做 slash 命令的管理界面（增删改）—— Pi 自己的 `/config` 已覆盖
- 不接 `library/prompt` 域（那是 Neeko 的 DB 记录，与 agent 命令不是一回事；
  理由见 `10-21-pi-rpc-adapter` 的阶段 7 结论）

## 关键风险

| 风险 | 缓解 |
| --- | --- |
| 光标坐标计算在换行/滚动下出错 | 先做贴输入框的简单版，把「跟随光标」列为独立可验证项 |
| `get_commands` 在部分 agent 上不存在 | 能力位 `commands: false` → 前端不显示 `/` 入口（R2），查询本身不承担能力判定 |
| Enter 双触发（选中 vs 发送） | 弹层打开时输入框的 `onKeyDown` 必须先给弹层处理机会（AC7） |
| 中文输入法组合期误触发 | `compositionstart/compositionend` 门控（AC8） |

## 参考

- `src/features/agent-chat/components/ChatComposer.tsx` —— 输入框与工具条
- `src/features/agent-chat/components/AttachFilePicker.tsx` —— 已实现的扁平文件列表（`@` 可复用其摊平与过滤逻辑）
- `src-tauri/src/agent/chat/adapter/pi_rpc/` —— `get_commands` 的发送方
- `.trellis/spec/backend/agent-chat-transports.md` §9.4 —— slash 命令的取证结论
