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

## 10. 输入框内的高亮层（2026-10-24 补充，用户反馈）

**需求**：已插入的 `/命令` 与 `@文件` 在输入框里以高亮 token 呈现（当前是普通文字，
体验差）。业界参照：Slack / Discord 的 mention 在富文本编辑器里渲染成高亮 chip；
VS Code / Claude Code 的 composer 把 `/命令` 与 `@文件` 渲染成带色 token —— 它们
全部基于 contenteditable / 富文本编辑器。

**决策：镜像高亮层，不换富文本编辑器。** 本仓 composer 是 textarea，键盘契约
（`handleKeyDown → boolean`）、IME 门控、双触发防御、AC7/AC8 的全部测试都钉在
它上面；换 contenteditable = 重写整个补全交互层，且 IME 行为重新洗牌，风险与
收益不成比例。textarea 场景的标准做法是：

- textarea 文字**透明**（`color: transparent`），`caret-color` 保留可见；
- 下方（同 padding、同字体、同 `white-space: pre-wrap`）放一个同排版 div，
  按 trigger 语法把 token 区间渲染成高亮 `<mark>` 风格 span。

**高亮判据与触发判据同源**：token 扫描复用 `findTrigger` 的同一套语法
（行首/空白后的 `@token` 与 `/token`）产出全部区间 —— 弹层能触发什么就高亮什么，
**禁止写第二套正则**（两套判据漂移后会出现「高亮了但弹层不认」的矛盾形态）。
配套护栏：对 `findTrigger` 可触发的每个位置，tokenize 必须产出覆盖区间。

**三个同步点**（镜像层的老三样）：
1. 字体 / 行高 / padding 逐字一致 —— 直接复用 textarea 的同一组 CSS 类；
2. 换行与折行：`white-space: pre-wrap` + 同宽度（100%）+ 同 `word-break`；
3. 滚动同步：composer 自增高正常无滚动，但 textarea 若出现 scrollTop 必须
   同步给镜像层（scroll 事件一行同步）。

**IME 组合期的特殊处理**：组合中的文字由 IME 渲染下划线与候选，若 textarea
文字透明，WebKit 下组合文本会不可见 —— 这是 AC8 的邻近回归。处理：
`composing` 置位时给容器加类，**恢复 textarea 文字不透明、隐藏镜像层**；
`compositionend` 后复位。既有 `compositionProps` 已维护该状态，零新增门控。

**无障碍与性能**：镜像层 `aria-hidden` + `pointer-events: none`；tokenize
只在 text 变化时重算（useMemo），不逐渲染扫描。

### WebKit IME 腐坏的三层加固（2026-10-24 真机冒烟）

真机（WKWebView）中文输入法组合期间按方向键，输入框出现豆腐块（tofu）。键盘链路
（`useComposerPalette.handleKeyDown` → `ChatComposer` → `AgentChatTabView` → 全局
快捷键 capture）与弹层状态机均已排查排除（只读不写）。根因判断：**WebKit 对
「`color: transparent` 的受控 textarea + IME 组合文本（marked text）」的组合期
绘制腐坏** —— 与 react-simple-code-editor 在 Safari/WKWebView 上的中文 IME
乱码同类。三层互为冗余的加固，各自独立成立、各自缓解同一症状类：

1. **CSS**：`-webkit-text-fill-color: transparent` 替代 `color: transparent`
   （WebKit 的 IME marked text 绘制走 text-fill-color 路径，社区标准修法）；
   `.composing` 期间恢复 `currentColor`；`::placeholder` 显式补 fill-color
   （否则被继承隐藏）。
2. **组合结束重同步**（`ComposerPalette` 的 `onCompositionEnd`）：WebKit 上末次
   input 与 compositionend 的顺序可能颠倒 —— 受控值丢 change、与 DOM 值分叉。
   组合结束后以 DOM 值为准经 `onReplaceText` 写回并保留光标位（走既有
   `pendingCursorRef` 通道；`compositionProps` 依赖为 `[]`，用每次渲染同步的
   ref 转发 `input` 与回调避免闭包过期）。
3. **镜像层组合期 `visibility: hidden` 而非卸载**（`ComposerMirror`）：
   unmount/remount 本身是组合期 DOM 抖动源，且重挂载后 scrollTop 归零
   （原重组补偿 effect 就是在擦这个屁股）—— 常驻后滚动同步天然连续，补偿
   effect 连同其测试一并删除。

任一层失效（1 只治绘制路径、2 只治受控值分叉、3 只治 DOM 结构抖动），其余两层
仍能兜住。变异验证：去 2 → 重同步用例红；去 3（恢复卸载）→ 组合期镜像两用例红。

---

## 归档记录（2026-10-26）：本任务已被 10-24 取代

**归档性质：非「完成」，是「被取代」。** 这一点必须写清楚，否则后来者会把
未勾选项当成待办。

### 发生了什么

本任务交付了 textarea + **镜像高亮层**（`ComposerMirror.tsx` / `paletteHighlight.ts` /
`paletteTrigger.ts`）。该架构有原理性上限：镜像渲染必须与透明文字逐像素对齐，
因此 chip 里不可能内嵌图标。`10-24-composer-token-editor` 用 Tiptap contenteditable
**整体替换**了编辑面：

| 本任务交付物 | 现状 |
| --- | --- |
| `ComposerMirror.tsx`（镜像层） | **已删除**（`461d2e24`） |
| `paletteHighlight.ts`（高亮着色） | **已删除** |
| `paletteTrigger.ts`（`findTrigger`/`applySelection`） | **已删除**，触发改由 Tiptap Suggestion 承担 |
| `.composer-mirror` / `.composer-token*` CSS | **已删除** |
| 三层 WebKit IME 加固 | **已删除**（ProseMirror 原生组合处理取代） |
| `paletteSources.ts` / `ComposerPalette.tsx` | **保留并复用**（分组 + 分词搜索） |
| 后端 `list_commands` / 能力位 / 契约测试 | **保留**（`4f163ddd` 又补了 opencode 的 `/api/command`） |

### AC 判定

- **AC1–AC8、AC10**：功能在 `10-24` 中全部重建且更强（chip 化、分组、分词搜索）。
- **AC11（镜像层高亮 token）**：**判据已失效** —— 镜像层不存在了。
  它的需求由 `10-24` 的 AC1（chip 一等 token）以更强形式满足。
- **AC3 真机 pi 展开 `/命令`**：已由 `10-24` 的真机验证关闭（2026-10-26 用户手工确认）。

`implement.md` 中十余条未勾项全部指向镜像层实现，**没有一条是可继续执行的工作**。

### 结论

本任务不应作为「未完成」留在活跃列表。`10-24-composer-token-editor` 是其直接后继，
且已归档完成。若将来要验 composer，验的是 `10-24` 的 chip 架构，不要再验镜像层对齐。
