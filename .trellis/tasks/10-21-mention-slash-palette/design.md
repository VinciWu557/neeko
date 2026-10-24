# 设计：slash 与 @ 补全

> 前置：`prd.md`（职责边界与 10 条 AC）。本文只写**结构与取舍**。

## 1. 落点

```
src/features/agent-chat/components/
├── ChatComposer.tsx          现有输入框（接入补全，保持 <300 行 ratchet）
├── ComposerPalette.tsx       新增：弹层骨架（锚点 + 键盘 + 过滤），数据无关
├── AttachFilePicker.tsx      现有：@ 复用它的 flattenFiles + 过滤逻辑
└── paletteSources.ts         新增：两个数据源适配（commands / files）
```

**为什么弹层要做成「骨架 + 数据源」两件套**：`/` 与 `@` 的差异只有「数据从哪来」
与「选中后做什么」，其余（定位、键盘、过滤、滚动）逐行相同。做成两份实现后
任何一处交互修复都要改两遍 —— 这是 `AgentModeSelector` / `ThinkingLevelSelector`
合并时同一个教训（见 `ParamSelectors.tsx` 的文档）。

`ChatComposer.tsx` 已贴着 300 行的 ratchet 线，弹层必须独立成文件。

## 2. 触发与状态机

```
idle
 ├─ 输入 '/' 且光标前是行首或空白 ──> slash({"query": ""})
 └─ 输入 '@' 且同上             ──> mention({"query": ""})
slash/mention
 ├─ 输入普通字符 ──> query += c
 ├─ Backspace 到触发符之前 ──> idle
 ├─ Esc ──> idle（保留已输入文本）
 ├─ Enter/Tab ──> 选中 → 写回文本 +（mention 还要 addAttachment）+ idle
 └─ ↑/↓ ──> 移动高亮
```

**触发判据是「光标前一个字符」而不是「整个输入里出现过 `/`」**：
后者会让 `src/foo.ts` 里的 `/` 误触发。

**状态里必须记 `triggerIndex`**（触发符在字符串中的位置）—— 写回时要替换
`[triggerIndex, cursor)` 这一段，而不是整段文本。

## 3. 后端：一条新命令，还是复用 StreamRequest？

**决策：新命令 `list_agent_commands`。**

理由：它不是「会话内的一次操作」，而是「查一下这个 agent 有哪些命令」——
与会话生命周期无关（不需要先 create 会话），与 `list_agent_models` 是同一类
查询（那个已经是独立命令）。

```rust
#[tauri::command]
pub async fn list_agent_commands(
    agent_id: String,
    state: State<'_, AppStateWrapper>,
) -> Result<Vec<AgentCommand>, AppError>;
```

**问题**：`get_commands` 是 rpc 命令，需要一条活着的进程。而 `list_agent_models`
走的是 `model_list_args`（一次性 CLI 调用）。两者机制不同。

两条路：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A | 加 `command_list_args`（CLI 参数，形如 `pi --list-commands`） | 需要 agent 提供 CLI 等价命令；pi **没有**（实测 `--help` 无此项） |
| B | 短暂 spawn 一个 rpc 进程，`get_commands` 后即弃 | 一次 ~1s；但对不支持 rpc 的传输无解 |

**决策：B + 能力位**：`AgentAdapter::list_commands(&self, config)` 默认
`Err(Unsupported)`；`PiRpcAdapter` 覆写为「spawn → 查 → 关」。

这与 `list_models` 的形状一致（默认 Unsupported，各适配器 opt-in）。但
**「是否显示 `/` 入口」的判据不是试查询报错，而是能力位**（2026-10 后固化的
`ChatCapabilities` 体系，spec `agent-chat-transports.md` §10.1「能力位是唯一判据」；
靠「行为推断能力」正是模型选择控件修掉的 P1 缺陷形态）：

- `ChatCapabilities.commands` 已预留（`capabilities.rs:81`），pi_rpc/adapter.rs:36-42
  注释写明契约：本任务**同一 diff 内**对 PiRpcAdapter 改 `true`
- 投影链：`events.rs::Capabilities::from_chat_capabilities` 加 `commands` 字段 →
  `session_start.capabilities` → 前端 `agentChat.ts` 的 `Capabilities` 镜像同步 →
  `useMockEventSchedule` 的 mock capabilities 同步
- 契约测试钉住「`commands` 位为 true ⇔ `list_commands` 不返回 Unsupported」，
  防止声明与实现分家（`capabilities.rs` 文档批评的「散装 default-impl 静默降级」）

**与 adapter.rs 现有注释的矛盾必须消除**：注释预期「get_commands → 事件 →
slash 面板」，本设计选独立查询（理由见上）。实现时同 diff 改写该注释。

**4 个 adapter 的现状**（方案写作时只有 pi_rpc）：pi_rpc / acp / opencode /
deepseek，其余三个维持 `commands: false`（默认全关由契约测试覆盖）。acp.rs
注释「ACP 没有列命令方法」待复核——ACP 协议有 `available_commands_update`
通告；若属实属后续增量，但本任务的命令结构（`name`/`description`）与 ACP 形状对齐。

**缓存**：命令列表在会话期内不变，前端按 `agentId` 缓存一次即可（不落盘）。

## 4. `@` 的数据源

复用 `readDirTree(workspace, null, 3)`（与 `AttachFilePicker` 相同），
摊平后按路径子串过滤。

**为什么不用 `search` 域**：那是全文搜索（要建索引、返回命中片段），
而这里要的是「文件名/路径匹配」。`readDirTree` + 子串过滤足够，且已缓存。

**深度 3 的取舍**：`AttachFilePicker` 也用 3。更深的树会让一次读取变慢，
而 `@` 场景下用户通常会继续输入过滤词。若实测不够用，改为「深 1 层 + 按需展开」。

## 5. 键盘：Enter 双触发是首要风险

`ChatComposer` 现有的 `onKeyDown` 直接处理 Enter 发送。弹层打开时必须是
**弹层先消费**，否则一次 Enter 既选中候选又发送消息。

```tsx
onKeyDown={(e) => {
  // 弹层打开 → 它优先，返回 true 表示已消费
  if (palette.handleKeyDown(e)) {
    e.preventDefault();
    return;
  }
  // 否则维持现有行为（Enter 发送 / Shift+Enter 换行）
  ...
}}
```

`handleKeyDown` 返回 `boolean` 而不是 void —— 让「有没有消费」成为类型契约，
而不是靠调用方猜。这是 AC7 的实现基础。

## 6. 中文输入法

`compositionstart` → 置 `composing=true`；`compositionend` → 复位。
组合期间**不触发**补全、也不允许 Enter 选中（否则拼音的 Enter 上屏会被吞）。

`e.nativeEvent.isComposing` 也能判断，但 React 的合成事件在某些浏览器上
该字段滞后一帧；用显式的 `compositionstart/end` 更可靠。

## 7. 弹层定位

**先做「贴输入框顶部」**，把「跟随光标」列为后续可验证项。

理由：textarea 内光标坐标没有原生 API，镜像 div 方案要处理换行、滚动、
字体度量三件事，且随字体设置变化。贴输入框顶部在单行输入时几乎等价，
而多行长文本时弹层固定在上方反而更稳定（不会随滚动跳）。

**若最终要跟随光标**：镜像 div（`white-space: pre-wrap` + 同宽度字体 +
在光标位置插一个 `<span>` 读 `getBoundingClientRect`）。这是标准做法，
但属于独立改动 —— 不在本次实现里混进来。

PRD 的 AC9 因此写成「跟随光标**或**明确记录为何选择贴输入框」——避免为了
一个视觉细节把整个弹层做复杂。

## 8. 测试策略

| 层 | 做法 |
| --- | --- |
| 触发判据（纯函数） | `shouldTriggerAt(text, cursor, trigger)` —— 行首/空白后/`src/x` 不触发 |
| 过滤（纯函数） | 子串匹配、大小写、空 query 返回前 N 条 |
| 写回（纯函数） | `replaceTrigger(text, cursor, triggerIndex, value)` 只替换标记段 |
| 组件 | `@testing-library`：输入 `/` 出现列表、↑↓ 高亮移动、Enter 写入、Esc 关闭 |
| 双触发 | 弹层打开时 Enter **不**调 `onSend`（AC7 的核心用例） |
| 后端 | `list_agent_commands` 对不支持传输返回 `Unsupported`；对 Pi 返回非空 |
| 静态护栏 | 前端不得硬编码命令清单（与 `AGENT_MODES` 同源的护栏思路） |

**变异验证清单**：
- 触发判据改成「输入里含 `/`」→ `src/foo` 用例必须红
- `handleKeyDown` 改成无条件 `return false` → Enter 双触发用例必须红
- `replaceTrigger` 改成替换整段 → 前缀被吞的用例必须红

## 9. 不做的事

- 命令参数补全（各 agent 语义无法统一）
- 目录级提及
- 光标级锚点跟随（先贴上沿，见 §7）
- `library/prompt` 域接入（理由见 `10-21-pi-rpc-adapter` 阶段 7）
