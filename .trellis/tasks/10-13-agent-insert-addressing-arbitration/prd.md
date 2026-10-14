# Agent 插入链路接通与终端前台仲裁归一

> 前置：`.trellis/tasks/10-12-terminal-insert-workspace-scope`（terminal 寻址已迁完，本任务承接它
> 有意推迟的两件事：agent 事件零订阅（其 R3）+ 前台仲裁归一（其审查 S1/S3））。
> 本 PRD 的每条问题都有实测命令可复现（见「取证」段），不接受「看起来应该」。

## 背景：一条声明了却从没人实现的能力

`INSERT_TO_AGENT_INPUT_EVENT`（`src/shared/events.ts:59`，注释明写「ProjectView dispatch，
agent 输入组件**可监听**」）有三个派发点、**零个监听者**：

| 派发点 | 场景 |
| --- | --- |
| `ProjectView.tsx:186` | `TerminalInsertApi.insertToAgentInput`（dock 面板经 Context 调用） |
| `ProjectView.tsx:220` | 命令面板 / Action Menu 的 `paletteCtx.insertToAgentInput` |
| `useFileDrop.ts:51` | 文件拖拽时焦点在 textarea/contenteditable → 走 agent 输入 |

**关键事实（不是回归，是从未实现）**：

```bash
git log --all -S"addEventListener(INSERT_TO_AGENT_INPUT_EVENT" --oneline   # → 0 条
```

所以这不是「迁移弄丢了订阅」，是**能力被声明、被三处调用、被写进注释，但消费侧一行代码都没有**。
用户可见症状：prompts 的默认 target 就是 `'agent'`（`PromptInsertDialog.tsx:49,67` —— 纯 Enter 走
agent、Shift+Enter 才走 terminal；`PromptListSection` 三处 `onInsert?.(prompt, 'agent')`），
而 `useInsertPromptToWorkspace.ts:29-34` 的判定是
`if (api.insertToAgentInput) { 调用 } else { clipboard 兜底 }` —— 函数**存在但什么都不做**，
于是连 clipboard 兜底都进不去，也没有 toast。**用户按下 Enter，什么也没发生。**

这与红线 14 的原文判据同型（「声明了却没人实现 = 静默功能缺失」），只是发生在
DOM CustomEvent 而非 LSP capability 上；合规落点仍是红线 5（事件名单源）+ 红线 12（寻址身份）。

### 连带 defect（design 阶段新取证，比上述更严重一层）

xterm 的输入载体就是 `<textarea class="xterm-helper-textarea">`（实测
`node_modules/@xterm/xterm/lib/xterm.js` 命中该类名，且 `TerminalViewBase` 的 `attach()` 调
`entry.term.focus()`），而 `useFileDrop.ts:48` 的 `isTextInputElement` 判据是「tag === TEXTAREA → true」。
⇒ **终端正被聚焦时 Priority 1 恒命中** → 文本投给零监听者的事件 →
**Priority 2（terminal 分支）在最主要场景下永不执行**。

即「拖文件到 agent 输入」和「拖文件到终端」**两端都是静默 no-op**，不是只有 agent 端。

由此得出一条必须先承认的事实：**「焦点在文本元素」不能用来区分 agent composer 与终端** ——
任何以它为依据的实现都在赌一个不成立的代理指标。仲裁必须走身份（见 R2 与 design §1）。
取证：`grep -n "helper-textarea" node_modules/@xterm/xterm/lib/xterm.js`。

## 背景：同一「该往哪个 tab 插」的问题有 5 个答案

10-12 把 R2 写成「仿写第 3 次即漂移，本次事故就是漂移结果」，但只归一了两处
（`ProjectView` + `useBrowserPanelEvents`）。实测同类实现共 **7 处**（下表前 5 为 PRD 首轮清点，
后 2 为 design 阶段补），且**口径互不相同**：

| 位置 | 「首个」的口径 |
| --- | --- |
| `terminalRouting.ts:29-38` `foregroundTerminalTab` | tab **order 升序**首个 |
| `terminalCache.ts:305` `firstTerminalKeyOfSession` | **Map 插入顺序**首个（= 10-12 审查 S1） |
| `pickerUtils.ts:67-73` `findAgentCliTab` | order **降序**（最近新增） |
| `useEditorAgentActions.ts:21-31` `findAgentTab` | **数组顺序**首个（不排序） |
| `PromptsStatusSection.tsx:38-49` `revealTerminalTab` | 自己 `WorkspaceSession.of(pid, selectActiveCheckoutPath(...))` 重拼身份 + 数组 `find` |
| `useTerminalTabs.ts:52-79` `getActiveTab` / `getActiveTabId` | 数组 `terminalTabs[0]`（**实测零消费者** → 按 10-12 R5 纪律删） |
| `useTerminalTabs.ts:89-101` `ensureDefaultTab` | 数组 `terminalTabs[0]`（在用） |

后果不是风格问题：**同一时刻「插入落到哪个 tab」按 order 升序，「刷新/切 agent 落到哪个 PTY」
按 Map 插入顺序** —— 两个口径两个答案。而 `revealTerminalTab` 是 `insertToTerminal` 的**直接下游**
（成功后把它推前台），它自己重新拼了一遍 session 身份，正是 R2 要消灭的形态。

## Goal

把「选哪个 tab」收敛成**唯一一处、order 升序**的决策；agent 目标从「静默 no-op」变成
**接通或显式失败**；顺带清掉 10-12 审查留下的两处 API 冗余（`sendToTerminal` 的隐式 fallback、
零消费者的 `pasteToTerminal`）。

## Requirements

**R1 · 前台仲裁唯一入口（order 升序，用户决议 2026-10-13）**
`foregroundTerminalTab(session)`（现 `order` 升序口径）成为全仓**唯一**的「该往哪个 tab」决策点。
- `firstTerminalKeyOfSession` / `firstTerminalEntryOfSession` 退出公共 API（降为 `terminalCache.ts`
  模块私有，只服务内部键→条目查找），外部一律先 `foregroundTerminalTab` 再传精确 tabId；
- `findAgentCliTab` / `findAgentTab` 改为**在 `foregroundTerminalTab` 的有序序列上过滤**
  （Q2 已决：统一 order 升序 —— 「要 agent tab」这层语义保留，但不再自带 sort）；
- `PromptsStatusSection.revealTerminalTab` 删除自建 session 拼装 + 自建 find，改调
  `insertToSessionTerminal` 的返回值（它已带 `landedTabTitle` + `isFallback`，落点信息就在手）；
- `useTerminalTabs.getActiveTab` / `getActiveTabId`（第 6 处，**实测零消费者**）按 10-12 R5 纪律删除；
- 护栏口径：`tools/guards/checks/` 新增 `check_terminal_foreground_arbitration` + 台账（照抄
  `path_identity_scope` 的台账形态 —— A1 的 sort 形态在全域有 4 处合法非 tab 命中，纯正则必误报）；
  另扩 `check_terminal_key_mint` 一条 G3（`TERMINAL_KEY_SEP` / `\u0001` 材质出 mint 文件即违规，
  补 10-12 R6 的纸面不变量）。判据下限见 design §3。

**R2 · agent 目标接通（本任务主体，Q1=(a) composer 优先）**
新增 agent 输入的**唯一接收端**，落 `agent-chat` feature（composer 所在处）。
- **目标优先级（Q1 决议）**：agent-chat composer（`ChatComposer.tsx` 的 textarea，08-17 落地）优先
  → 降级到 Agent CLI 终端 tab（terminal kind + `agentId`，走 PTY）→ 都没有则**显式 false**；
- **必须返回成败**：`insertToAgentInput` 从 `(text) => void` 改为返回 boolean，
  使 `useInsertPromptToWorkspace` 的降级链（agent → clipboard）重新可达；
- **无接收者 = 显式失败**：不允许再出现「函数存在但 no-op」；
- **机制（Q5 定案 = A）**：R2 的「返回成败」与「保留 DOM CustomEvent」在机制上冲突 ——
  `dispatchEvent` 的返回值只表示「有无 preventDefault」，**不表示有无接收者**。
  同仓对同型问题已有两处正解（`editor/api/aiActionRegistry.ts`、`editor/api/editorViews.ts`：
  按身份登记 handler + 返回 boolean + 引用计数卸载）。故 Q5 定案：**删除事件、改身份注册表**；
  载荷需带 `WorkspaceSession` 身份（红线 12），两个 agent-chat tab（主仓 + worktree）并存时必须精确。
- **`useFileDrop` 的 `isTextInputElement` 判据随之删除**（见上方连带 defect：它对终端恒为 true）。

**R3 · tabId 可选性退出公共签名（10-12 审查 S1，design §1.3 扩展）**
`sendToTerminal` 四个生产调用方本来就全部显式传 tabId（`useFileDrop.ts:63`、`useBrowserTab.ts:183`、
`useBrowserPanelEvents.ts:167`、`useEditorAgentActions.ts:39`），可选性只喂养了
「Map 插入顺序首个」这条第二口径。**同一族第二口径的另一半在 `refreshTerminalForSession` /
`switchAgentInSessionTerminal` 上**（实测 `useAgentActions.ts:79` 就传了裸 session 吃 Map 顺序；
`useKeyboardShortcuts.ts:160` 的 tabId 来自 store **顶层** `activeTabId`——与 10-12 已判定为 defect
的「全局 activeTabId 配 session 内 tabs」完全同形）。三个签名的 tabId 均改必填；
`useAgentActions` 那处改为先仲裁再刷新。改必填即编译期清单。

**R4 · 死导出随迁移删除（10-12 审查 S10 + 决议 Q7）**
实测 `pasteToTerminal` **零生产消费者**（只有 `pasteToTerminal.test.ts` + 两个桶 re-export）。
按 10-12 的 R5 纪律执行。`pasteToTerminalSession`（`terminalRouting` 在用）**保留**。

**R5 · 分屏 p2+ 精度 = 显式非目标（决议 Q6）**
写侧 `terminalAddress(session, tabId, paneId)` 携带 paneId，读侧
（`resolveTerminalEntry` / `switchAgentInSessionTerminal` / `refreshTerminalForSession`）
一律缺省 `'p1'`。实测后果：分屏后 `switchAgentInTerminal` 只清 p1 的 PTY，
**p2 里跑的旧 agent 进程继续在跑**（用户可见「一个 tab 两个 agent」）。
本任务**不修**，但必须：design 风险表 + PRD 非目标 + 10-12 的 design §7 各记一条，
禁止以「未声明」形式留给下一个人。

**R6 · 回归护栏**
新接收端（`agentInputRegistry`，Q5=A）的单测必须覆盖：两个 agent-chat tab 并存时按
session 精确投递、无匹配时返回 false、StrictMode 双挂载下卸载不摘存活页（照抄
`aiActionRegistry` 的同构风险，design T2）、clipboard 兜底在「无 agent 目标」时确实被走到
（这条正是当前 defect 的显式反证，**必须先 Red**）。

## Acceptance Criteria

- [x] **agent 目标端到端可用**：prompts 面板按 Enter（默认 target='agent'）→ 文本出现在**当前
  workspace 的** agent-chat 输入框；无 agent-chat tab 时 → clipboard 兜底 + toast（不再是静默）；
- [x] 接收点与派发点**同时存在**（当前 3 派发 / 0 接收）：`grep -rn "insertAgentInput\|registerAgentInput" src`
  非空，且 `INSERT_TO_AGENT_INPUT_EVENT` **全仓零命中**（Q5=A 已删该常量）；
- [x] **拖文件到终端不再静默**：终端聚焦时拖拽文件 → 文本确实进入该终端 PTY
  （当前是投给零监听者事件后丢弃。这条同时反证 `isTextInputElement` 判据已移除）；
- [x] 仲裁唯一：`firstTerminalKeyOfSession` / `firstTerminalEntryOfSession` 不再是导出符号；
  `findAgentCliTab` / `findAgentTab` / `revealTerminalTab` / `useTerminalTabs.getActiveTab(Id)` 四处
  grep 不再自带 order/find 口径（前者已删或已委托）；
- [x] `sendToTerminal` / `refreshTerminalForSession` / `switchAgentInSessionTerminal` 的
  `tabId?:` 从签名消失（R3 扩展）；
- [x] `pasteToTerminal` 全仓零命中（含 `src/features/terminal/index.ts`、`components/index.ts` 两个
  桶文件与 `pasteToTerminal.test.ts` 的改名/迁移）；
- [x] ③ 面无回归：10-12 的 `destroyTerminalsFor*` 全部测试保持绿，且不新增「按 Map 顺序」依赖；
- [x] `pnpm check` 全绿；`pnpm lint` 含新护栏且新护栏有同名测试（框架硬要求，
  `registry.py::_validate`）；
- [x] 分屏 p2+ 的非目标在三处文档落地（10-12 design §7 追加行 + 本任务 design + 非目标）。

## 非目标

- 不修分屏 p2+ 的 refresh / agent 切换（Q6：记为非目标，后果与正解见 design §4）；
- 不收敛 `useEditorAgentActions.pending` 队列（Q4：只记账，见 design §8）；
- 不动 `agent-chat` 的会话协议 / StreamEvent / adapter 层（属 08-17 已收敛的范围）；
- 不把 `tabId` / `paneId` 并入 `WorkspaceSession`（10-12 Q2 决议仍然有效）；
- 不合并三个物理 Map、不动传输层（10-12 C1 仍然有效）；
- 不新增红线（映射红线 5 + 12；R2 的「声明必须有消费点」是红线 14 的**同型**而非其适用范围）。

## 决议索引（单一编号；本表是这些决议的**唯一**命名处）

> 编号是稳定标识符，design / implement / 代码注释**只引用编号**。
> 会话审查期曾用 Q-A/Q-B/Q-C 三个临时名，已合并入本表并在括号里标注来源 ——
> **不要在新文档里继续使用旧临时名**（同一条规则的两个名字会使 grep 找不全）。

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| **Q1** | agent 目标 = composer 优先，Agent CLI 终端降级 | ✅ 已决 |
| **Q2** | 「首个」口径全仓统一为 **order 升序**（含 `foregroundTerminalTab` 与 Agent CLI tab；同时覆盖审查期 Q-A「首个按什么算」与本项原定义的「findAgentCliTab 反向口径」—— 两者是同一条决议） | ✅ 已决 |
| **Q3** | 载荷/形状直接改，不留兼容分支 | ✅ 已决 |
| **Q4** | `useEditorAgentActions.pending` 只记账，本任务不动 | ✅ 已决 |
| **Q5** | 投递机制：**A · 删 DOM 事件改身份注册表**（2026-10-13 定案，用户「开始实现」= 采纳 design 推荐；批 1–3 与决策表均按 A 书写） | ✅ 已决 |
| **Q6** | 分屏 p2+ 精度 = 显式非目标 + 三处文档落地（原审查期 Q-B） | ✅ 已决 |
| **Q7** | 删 `pasteToTerminal`（原审查期 Q-C） | ✅ 已决 |

### 逐项详情

- **Q1** ✅ agent 目标 = **(a) `agent-chat` composer 优先**，(b) Agent CLI 终端作降级；
  两者都没有 → 显式 false（走 clipboard 兜底 + toast）。
- **Q2** ✅ **统一 order 升序**（与 `foregroundTerminalTab` 一致）。`findAgentCliTab` 的
  「最近新增优先」反向口径放弃；需要它只做一次「在有序序列上过滤」，不再自带 sort。
- **Q3** ✅ 载荷/形状**直接改，不留兼容分支**（纯前端 DOM 事件，不过 IPC、不入 wire）。
- **Q4** ✅ `useEditorAgentActions.pending` **只记账**（design §8 遗留），本任务不动 ——
  它属「agent 派发队列」而非「寻址」。但它与本任务的注册表同域，下一个人接手时有现成范式。

- **Q5** ✅ **定案 A：删 DOM 事件、改身份注册表**（2026-10-13，用户确认开工 = 采纳 design 推荐）。
  保留 B 的完整对比如下（留档：下一处「单向广播投递」仍按此判据选型）：

触发原因：R2 要求「必须返回成败」，而 `dispatchEvent(CustomEvent)` **机制上给不出这个信息** ——
它的返回值只表示「有无 preventDefault」，不表示「有无接收者」。所以「保留事件 + 返回 boolean」
只能靠 `detail.handled` 回写这类约定，且依赖「所有监听者都同步处理」这条**没有护栏能守**的纪律。

| 选项 | 内容 | 代价 |
| --- | --- | --- |
| **A（推荐）** | 删 `INSERT_TO_AGENT_INPUT_EVENT`，新增 `agent-chat/api/agentInputRegistry.ts`，照抄本仓 `aiActionRegistry.ts` / `editorViews.ts` 的同构形态（身份键 + handler + 引用计数卸载 + 返回 boolean） | 红线 5 少一个条目（事件名**退出**，不是新增硬编码，不违反）；`useFileDrop.test.ts` 两条 Priority-1 测试需改写（它们断言的是「派发了事件」，而那本身就是缺陷的一部分） |
| B | 保留事件，载荷加 `session` / `tabId` 与可变 `handled` 标记，监听者同步置位 | 「同步处理」纪律不可机器校验；任一派发方或监听方漏置位即静默失败重演；R2 验收退化为口头承诺 |

**我选 A，但它删掉一个已导出的事件常量、并改变 `useFileDrop` 的行为语义，归你定。**
若否决 A，我会把 design §0/§2/§5.2/§6 与 R2 的验收形态按 B 重写，并把那条纪律写进风险表（标为「不可机器校验」）。

## 取证命令（复现本 PRD 的每一条）

```bash
git log --all -S"addEventListener(INSERT_TO_AGENT_INPUT_EVENT" --oneline     # 0 → 从未实现
grep -rn "INSERT_TO_AGENT_INPUT_EVENT" src --include="*.ts*" | grep -v __tests__   # 3 派发 / 0 监听
grep -rn "pasteToTerminal(" src --include="*.ts*" | grep -v __tests__ | grep -v terminalCommands  # 0 生产消费者
grep -rn "firstTerminalKeyOfSession\|firstTerminalEntryOfSession" src | grep -v __tests__          # 第二口径消费者
npx vitest run src/features/terminal        # 11 files / 95 tests（10-12 基线，本任务不得回归）
```
