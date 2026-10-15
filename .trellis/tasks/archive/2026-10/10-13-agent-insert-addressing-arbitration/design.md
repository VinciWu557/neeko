# 技术设计：Agent 投递接通 + 前台仲裁归一

> 任务：`.trellis/tasks/10-13-agent-insert-addressing-arbitration`（PRD 见 `prd.md`）
> 结论先行：**「投递到某个 tab 的输入框」在本仓已有两次正解（注册表 + 返回 boolean），
> agent 目标却用了第三种形态（DOM 广播，无接收者 = 静默丢弃）**。本设计把它并到既有正解上，
> 并让「该往哪个 tab」在全仓只剩一个答案。

---

## 0. 第一性原理：投递必须能回答「有人接住了吗」

一条投递链路的正确形态由**唯一一个问题**决定：发送方能否知道结果？

| 形态 | 返回成败 | 身份精确 | 仓内先例 |
| --- | --- | --- | --- |
| **A · 身份注册表**（handler per identity，未命中 → false） | ✅ 结构性 | ✅ 键即身份 | `editor/api/aiActionRegistry.ts`、`editor/api/editorViews.ts`（**两处**，同构：Map + 引用计数 + 卸载不摘存活页） |
| B · DOM CustomEvent + `detail.handled` 回写 | ⚠️ 依赖同步派发（`dispatchEvent` 确实同步，但任一监听方改 async 即破） | ⚠️ 载荷需扩 | 无 |
| C · DOM CustomEvent 单向广播（**现状**） | ❌ `dispatchEvent` 的返回值只表示「有无 preventDefault」，**不表示有无接收者** | ❌ 载荷只有 `{text}` | —— |

**关键结论（比 PRD R2 的写法更硬）**：R2 要求「必须返回成败」，而形态 C 在机制上做不到 ——
不是没写，是写不出来。所以本设计**删除 `INSERT_TO_AGENT_INPUT_EVENT`**，改为形态 A。

这不是「顺手扩大范围」，而是 Q3「直接改载荷不留兼容」与 R2「必须返回成败」两条决议的**唯一同时满足解**：
扩了载荷的 DOM 事件仍然返回不了成败，仍然会重演「函数存在但 no-op」。

### Q5（**已定案 = A**，2026-10-13）· 是否删事件、改注册表

> 标题原为「需确认」；PRD 决议索引已把 Q5 记为 ✅ 已决（A），本小节同步。下方「推荐/不建议」
> 是定案前的对比留档，不是开放项。

- **推荐**：删。收益 = R2 硬要求结构性满足 + 消灭「声明了没人实现」这一整类（事件名常量都没了，
  无从声明）；代价 = 动红线 5 的一个条目（**事件名退出**，不是新增硬编码，红线 5 不违反）。
- **否决路径（保留事件）**：则必须用形态 B（`detail` 带可变 `handled` 标记），并在 design 里
  钉一条「所有监听者必须同步处理」的纪律 —— 这条纪律**没有任何护栏能守**，等于把 R2 的验收
  变成口头承诺。**不建议。**

> 取证（形态 C 为何是「从未实现」而非「回归」）：
> `git log --all -S"addEventListener(INSERT_TO_AGENT_INPUT_EVENT" --oneline` → **0 条**。

## 1. 取证：投递与仲裁的实际形状

### 1.1 三个派发点、零个监听者（全历史）

| 派发点 | 场景 | 现载荷 |
| --- | --- | --- |
| `ProjectView.tsx:186` | `TerminalInsertApi.insertToAgentInput`（dock 面板） | `{ text }` |
| `ProjectView.tsx:220` | 命令面板 / Action Menu `paletteCtx.insertToAgentInput` | `{ text }` |
| `useFileDrop.ts:51` | 文件拖拽且焦点在 textarea/contenteditable | `{ text: path + ' ' }` |

**连带 defect（本设计新发现，PRD 未记）**：xterm 的输入载体就是
`<textarea class="xterm-helper-textarea">`（`node_modules/@xterm/xterm/lib/xterm.js` 实测命中该类名；
`TerminalViewBase` 的 `attach()` 里 `entry.term.focus()`），而 `useFileDrop.isTextInputElement`
判据是「tag === TEXTAREA → true」。⇒ **终端正被聚焦时 Priority 1 恒命中**，
文本被投给一个没有监听者的事件，**Priority 2（terminal 分支）在最主要的使用场景下永不执行**。
即「拖文件到终端」与「拖文件到 agent 输入」两端都失效，不是只有 agent 端。

这条同时说明：**「焦点在文本元素」不能用来区分「agent composer」和「终端」** ——
任何以它为依据的实现都在赌一个不成立的代理指标。仲裁必须走身份。

### 1.2 「首个」口径实测 7 处（PRD 记 5 处，此处补 2 处）

| # | 位置 | 口径 |
| --- | --- | --- |
| 1 | `terminalRouting.ts:29-38` `foregroundTerminalTab` | **order 升序**首个（本设计的唯一口径，Q2） |
| 2 | `terminalCache.ts:305` `firstTerminalKeyOfSession` | Map 插入顺序（10-12 审查 S1） |
| 3 | `pickerUtils.ts:67-76` `findAgentCliTab` | order **降序**（注释称刻意）→ Q2 已决：统一升序 |
| 4 | `useEditorAgentActions.ts:21-31` `findAgentTab` | 数组顺序首个（不排序） |
| 5 | `PromptsStatusSection.tsx:38-49` `revealTerminalTab` | 自建 session 拼装 + 数组 `find` |
| 6 | `useTerminalTabs.ts:52-79` `getActiveTab` / `getActiveTabId` | 数组顺序 `terminalTabs[0]` —— **实测零消费者**（`ensureDefaultTab` 同样无外部调用方） |
| 7 | `useTerminalTabs.ts:84-131` `ensureDefaultTab` | 数组顺序 `terminalTabs[0]` —— **实施期更正：也是零生产消费者**（`addTab` 不调它；ProjectView 用的是 `src/app/hooks/useTerminalTabs.ts` 这个**同名不同文件**）。首稿误记为「在用」，代价见 §8.1 注记 9 |

第 6/7 处不是风格问题：`getActiveTabId` 的注释明写「Otherwise, return the first terminal tab's ID」
—— 与 ②④⑤ 一起构成「刷新/激活/投递」各自的第一个。**零消费者的 #6 按 10-12 R5 纪律直接删**
（`getActiveTab` 同样零消费者 → 删；`updateTabStatus` 实测有消费者 → 保留。
**注意两个同名 `useTerminalTabs`**：`app/hooks/`（`handleAddTerminalTab`，在用）与
`features/terminal/hooks/`（本次清理对象）—— 判「零消费者」时必须按文件路径分开数，
混在一起会把活功能误判成死代码，或反之。

### 1.3 `refreshTerminalForSession` 的 tabId 可选性有真实消费者

```bash
grep -rn "refreshTerminalForSession(" src --include="*.ts*" | grep -v __tests__
#   useAgentActions.ts:79      refreshTerminalForSession(session)          ← 无 tabId，吃 Map 顺序
#   useKeyboardShortcuts.ts:160  refreshTerminalForSession(session, activeTabIdRef.current)
#                              ← tabId 来自 store **顶层** activeTabId（跨 tab 空间的全局态）
#   useProjectActions.ts:256   refreshTerminalForSession(session, tabId)   ← tabId 来自 #1
```

R3 只把 `sendToTerminal` 的 tabId 改必填是**不够的**：同一族第二口径的另一半在
`refreshTerminalForSession` 上。且 `useKeyboardShortcuts` 用的是 **store 顶层 `activeTabId`**
（`editorStore.ts:303`，全仓唯一「跨 tab 空间」的激活态），与 10-12 已判定为 defect 的
「全局 `editorStore.activeTabId` 配 session 内 tabs」**完全同形**。本任务把它一并收敛。

## 2. 落点与形态

```
agent-chat/api/agentInputRegistry.ts（新，形态 A；与 aiActionRegistry / editorViews 同构）
├── type AgentInputHandler = (text: string) => boolean
├── 存储形态 = **嵌套 Map**：`Map<WorkspaceKey, Map<tabId, {handler, count}>>`
│       ← 外层键直接就是 `session.key`（已是品牌类型），**不拼第二个键命名空间**。
│       两个不能这么做的理由（design 首稿写的是 `identityOf(session, tabId?): string`，已推翻）：
│       ① 拼串需要保留分隔符 → 批 4 的 **G3 自己会拦这里**（地址 mint 文件外材质化；
│       `terminalAddress.ts`，S4 前为 `terminalCache.ts`）；
│       ② 用 `:` 拼 → 撞上 10-12 Q7 已判死的「tabId 含 `:` ⇒ 前缀同形」同一缺陷。
│       结枛上嵌套 Map 无需反解（红线 12「不从字符串反解身份」自然成立）。
├── registerAgentInput(session, tabId, handler): void   （引用计数，卸载不摘存活页）
├── unregisterAgentInput(session, tabId): void
└── insertAgentInput(session, tabId: string, text): boolean
        （**不**预留 `hasAgentInput` 这类探测 API —— 本任务 R4 刚刚因为零消费者删了
         `pasteToTerminal`，新造一个同类只是换名字的同一件事）
        **tabId 必填**（本任务自己的 R3 精祘：可选性 = 喂养第二口径）。
        registry **不回答「该选哪个 tab」** —— 那是 `terminalRouting` 的唯一职责（§5.3）；
        未命中 → false（显式失败）

terminal/components/terminalRouting.ts（R1 唯一仲裁入口，扩两类目标）
├── foregroundTerminalTab(session)            【已有，order 升序 —— 全仓唯一 `sort` 实现处】
├── foregroundTerminalTabs(session)           【新】有序 **全量**终端序列（前台优先，同序无重复）
│       —— 上面两者共用同一个有序基底；本模块以外不得再 `sort`。
├── foregroundAgentCliTab(session)            【新】= 在 foregroundTerminalTabs 上
│       过滤 `agentId !== null`（顺序口径复用，不再 sort）
├── foregroundAgentChatTab(session)           【新】= 在 tab 有序序列上过滤 `kind === 'agent-chat'`
│       （同样是「在有序序列上过滤」，Q2）
├── insertToSessionTerminal(session, text)    【已有，返回 landedTabTitle/isFallback】
└── insertToSessionAgent(session, text)       【新】唯一编排：composer 优先（Q1）→ 降级 Agent CLI
        先仲裁拿精确 tabId → 再调 registry / 精确发送（registry 不参与选 tab）
        返回 { ok, landedTabTitle?, isFallback? }
        （**注**：首稿此处含 `landed: 'composer' | 'agentCli'`；实施后实测零生产消费者，
          按本任务自己的 R4 纪律删除 —— 见 §8.1 注记 12）

terminalCache.ts（第二口径退出）
├── firstTerminalKeyOfSession / firstTerminalEntryOfSession → **降为模块私有**（去掉 export）
├── refreshTerminalForSession(session, tabId) → tabId 改必填（内部不再有「缺省取首个」分支）
└── switchAgentInSessionTerminal(session, tabId, …) → tabId 改必填

terminalCommands.ts
├── sendToTerminal(session, text, tabId)      → tabId 必填（R3；四调用方本就全传）
└── pasteToTerminal                            → **删除**（R4，实测零生产消费者）
        保留 pasteToTerminalSession（terminalRouting 在用）+ wrapBracketedPaste / BRACKETED_PASTE_*

调用方收敛
├── ProjectView:186/220  insertToAgentInput(text): boolean —— **签名保持只收 text**（首稿写的
│                        是 `(session, tabId|null, text)`，见 §8.1 注记 10）：两个派发点本就是同一个
│                        `useCallback`，session 在其内部由 `activeWorkspaceSession(activeProject.id)`
│                        现取（红线 12 + Store 快照模式），比让派发方各自拼身份更少一份重复、
│                        也无从传错单元
├── TerminalInsertContext.tsx  接口签名改带身份 + 返回 boolean；注释「best-effort 事件桥接」删除
├── useInsertPromptToWorkspace.ts:29  降级链重新可达（false → clipboard 兜底 + toast）
├── useFileDrop.ts:44-64  **删除 isTextInputElement 启发式**：
│        Priority 1 = insertToSessionAgent（composer 命中则用）；Priority 2 = insertToSessionTerminal
│        （两条都走仲裁，不再有「焦点在 textarea」这个不成立的代理判据 —— 见 §1.1 连带 defect）
├── pickerUtils.findAgentCliTab → 委托 foregroundAgentCliTab（Q2：升序）
├── useEditorAgentActions.findAgentTab → 委托 foregroundAgentCliTab（#4 口径消失）
├── PromptsStatusSection.revealTerminalTab → 用 insertToSessionTerminal 的返回 tabId 直接 activateTab
│        （删自建 session 拼装 + 自建 find —— R1 的直接下游不该第二次决策）
├── useAgentActions.ts:79 / useKeyboardShortcuts.ts:160 → 先 foregroundTerminalTab 再传精确 tabId
└── useTerminalTabs.getActiveTab / getActiveTabId（#6，零消费者）→ 删除
```

**红线归属**：红线 12（投递目标必须走 `WorkspaceSession` 身份，注册表键即身份，
消费侧不从字符串反解）+ 红线 5（`INSERT_TO_AGENT_INPUT_EVENT` 常量**退出**，
`shared/events.ts` 只允许来自后端的 Tauri 事件名留存 —— 删条目不是新增硬编码）。

## 3. 护栏（R1 的可执行性；沿用本仓两套既有机制）

文件：`tools/guards/checks/check_terminal_foreground_arbitration.py`
（`checks/` 目录即注册表；框架**强制**同名测试 `tools/guards/tests/test_check_terminal_foreground_arbitration.py`，
`registry.py::_validate`）+ 台账 `tools/guards/ledger/terminal_foreground_arbitration.json`
（形态照抄 `path_identity_scope.json`：`manifest{file:{counts,kind,note}}` + `owner` + `valid_kinds`）。

- **A1（口径唯一，符号级）**：`foregroundTerminalTab(` 与 `foregroundAgentCliTab(` 之外，
  `src/features/terminal|browser|status-bar/**` 内不得出现
  ①`sort((a, b) => a.order - b.order)` / ②`(tabs|terminalTabs|agentTabs|terminals)[0]` 这两个仲裁形态。
  ①的**全域基线实测**：仅 `terminalRouting.ts:38`（唯一口径）、`pickerUtils.ts:75`（本次删除）、
  `UseDockBarButtons.tsx:18`、`StatusBarCluster.tsx:21`、`dockStore.ts:63,81`、`gutter/registry.ts:178`（后四条与 tab 无关）
  ⇒ 判据必须**限定 tab 语境的相邻 token**，否则误报 4 处。台账逐文件登记计数与 `kind`，
  未登记命中 / 登记失效 / 计数漂移 / 扫描集为空四种情况均判失败（同 `check_path_identity_scope`）。
  **实施期更正（§8.1 注记 11）**：判据作用域按首稿写死为 terminal/browser/status-bar 三域后，
  A1 实际基线是 **3 处**（`terminalRouting.ts` owner + `StatusBarCluster.tsx` + `status-bar/registry.ts`），
  不是这里说的 4 处 —— `UseDockBarButtons.tsx` / `dockStore.ts` / `gutter/registry.ts` 落在作用域之外，
  `pickerUtils.ts:75` 本次已删。上面那段是「为什么必须台账式」的取证，保留原文；
  当前台账计数以 `pnpm guards list check_terminal_foreground_arbitration` 输出为准。
- **A2（第二口径退出）**：`firstTerminalKeyOfSession(` / `firstTerminalEntryOfSession(` 在
  `terminalCache.ts` 外零命中（它们变 private 后引用即编译错，护栏防**新造同类**）。
- **A3（tabId 必填不回退）**：`src/features/terminal/**` 内 `tabId` 不得以可选 / 可空形态出现
  （`tabId?:` / `tabId: string | null`）—— **判据是签名形态，不是调用实参个数**（首稿写的是
  「实参个数 == 形参个数」，实现推翻，理由见 §8.1 注记 11）。
  拦的是「把已必填的 `tabId: string` 改回 `tabId?: string`」这一步：那对现有调用方在 TS 上
  **完全合法**（它们本来就全传），编译期一声不响，而「缺省取 Map 首个」那条第二口径就此复活。
  作用域刻意限定 terminal 域：别域的 `tabId?:` / `tabId: string | null`
  （`app/utils/layoutId.ts`、`editorStore`、`useFileViewTabOps.saveFile`）是另一套合法含义。
- **A4（声明必须有消费点，R2 的同类防回潮）**：`shared/events.ts` 导出的每个
  `neeko:*` DOM 事件常量必须在 `src` 内至少一次 `addEventListener(` 命中（零命中 = 违规）。
  **当前唯一命中即本次要删的 `INSERT_TO_AGENT_INPUT_EVENT`**，故删完自然归零。
  这条把红线 14 的判据（「声明了却没人实现 = 静默功能缺失」）从 LSP capability 扩到 DOM 事件，
  是本次事故的**根因形态**；不新增红线，只在护栏里落实既有红线。

**G3（10-12 R6 遗留，同批做）**：扩 `check_terminal_key_mint`。材质分层**必须照抄
`check_workspace_identity` 判据 6 的双档形态**（它是本仓已验证的同类判据），不能一刀切：

| 档 | 判据 | 基线（实测） |
| --- | --- | --- |
| 强材质 | `TERMINAL_KEY_SEP` **标识符**在 `terminalCache.ts` 外零命中（该标识符无第二种合法用途） | ✅ **0**（仅 `terminalAddress.test.ts`，测试豁免） |
| 语境材质 | `\u0001` **转义** 且同行命中 terminal 语境词（`cacheKey` / `terminalKey` / `tabId` / `paneId` / `TerminalCache`）才拦 | ⚠️ **非 0**：`src/shared/utils/fileTree.ts:115,116,137` 用 `\u0001` 做**子树指纹分隔**（合法无关命名空间，与判据 6 注释里 runner 的 `${projectId}\0${filePath}` 同型） |

这条把 10-12 R6「所有段用同一保留分隔符」从纸面变成判据；同时在护栏 docstring 写明
G1 对 `MINT_FILE` 整文件放行的边界与代价。

> **取证教训（写进 docstring）**：首轮只 grep 了 `TERMINAL_KEY_SEP` 就写下「基线为 0」，
> 漏了 `\u0001` 字面量形态 —— 按那版实现会得到 3 条误报，而它拦的正是它自己依赖的那个假设。
> 材质类判据必须**逐形态实测**（标识符 / 转义 / 不同引号），不能只测一种。

## 4. 分屏 p2+ = 非目标（Q6，三处落地）

实测不对称：写侧 `terminalAddress(session, tabId, paneId)` 携带 paneId
（`strategies/index.ts:70`，`SplitLayout` 最多 4 pane，`paneSeq` 只增不复用），
读侧 `resolveTerminalEntry` / `switchAgentInSessionTerminal` / `refreshTerminalForSession`
一律缺省 `'p1'`。

后果（用户可见）：分屏后 `switchAgentInTerminal` 只把 `tab.agentId` 落身份 + 只清 p1 的 PTY，
**p2 内旧 agent 进程继续跑** —— 一个 tab 两个 agent。本任务不修。

落地要求（R5 的三处，缺一不可）：
1. 本 design §7 风险表 T3；
2. 本 PRD「非目标」；
3. `10-12` 的 design §7 追加一行（该任务已声明「paneId 只支持 p1 级精度」，但**没写不对称的用户可见后果**）。

正解留给后续任务（此处只记方向，不实现）：`SplitLayout` 已有 `activePaneId`
且预留 `onActivePaneChange`（实测全仓零消费者）→ 落 tab 身份（`updateTab(..., { activePaneId })`）
即可让读侧精确到 pane，同时把 R1 的「前台」从 tab 级补到 pane 级。

## 5. 迁移纪律

1. **每批 Red 先行**：`useInsertPromptToWorkspace` 的「无 agent 目标 → clipboard 被走到」这条
   测试**在实现前必须先失败**（它就是当前 defect 的显式反证，R6）。
2. **投递形态只允许一种**：删事件与建注册表在**同一批**内完成，禁止「事件 + 注册表」双轨
   （那是第二个投递口径，与 §1.2 的第二个 tab 口径同罪）。
3. **顺序口径只允许一处实现**：`foregroundTerminalTab` 内那一次 `sort`。
   任何新需求要「另一个第一个」时，走台账登记 + design 命名，不在消费侧再 sort 一次。
4. **`isTextInputElement` 不保留**：它作为「agent 输入」的代理判据已被证伪（§1.1）。
   删；`useFileDrop.test.ts` 的 Priority 1 两条测试改为断言「composer 注册表命中」
   （原测试断言的是「派发了事件」—— 那正是缺陷的一部分，不是保护网）。
5. **台账不许放宽**：A1 若出现新的合法豁免（如某面板确需自定义顺序），
   必须带 `note` 且在本 design §6 决策表登记理由，不接受只改台账。

## 6. 决策表

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 投递机制 | **身份注册表（形态 A），删 DOM 事件** | R2「返回成败」在单向广播上机制性不可达；仓内两处同构先例 |
| agent 目标优先级 | **composer → Agent CLI 终端 → 显式 false** | Q1=(a) 优先；Agent CLI 仍是可达目标，不做二次丢弃 |
| tab 顺序 | **order 升序唯一**（`foregroundTerminalTab`） | Q2；两处反向/无序口径降为「在有序序列上过滤」 |
| Agent CLI tab 顺序 | **同上（升序）** | Q2；放弃「最近新增优先」，避免两套并存 |
| 载荷/事件兼容 | **不留**（事件直接退出） | Q3；删条目比维护一个恒零监听者的契约诚实 |
| `useEditorAgentActions.pending` | **只记账，本任务不动** | Q4；属「派发队列」非「寻址」，见 §8 遗留 |
| 零消费者仲裁（#6） | **删** | 10-12 R5 纪律：死导出随迁移删除，不迁移 |
| `pasteToTerminal` | **删** | Q7；实测零生产消费者 |
| 分屏 p2+ | **非目标 + 三处文档落地** | Q6；禁止以「未声明」形式留给下一个人 |
| 新护栏形态 | **台账式（照抄 path_identity_scope）** | A1 的①在全域有合法非-tab 命中（实测三域内 3 处，见 §3 更正与 §8.1 注记 11），纯正则必误报 |

## 7. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| T1 | 删事件后漏一个派发点 → agent 目标仍然不通 | 派发点实测 3 处（`ProjectView:186/220`、`useFileDrop:51`），逐点 grep 清零 `INSERT_TO_AGENT_INPUT_EVENT`；A4 护栏防同类回潮 |
| T2 | 注册表与 React 卸载竞态（StrictMode 双挂载） | 照抄 `aiActionRegistry` 的引用计数（同身份 count>1，卸载只减）；补一条双挂载单测 |
| T3 | 分屏 p2+ 的 agent 切换只清 p1（本任务非目标） | §4 三处文档 + design 风险行；`switchAgentInTerminal` 内加注释指向本节，禁止读者以为已支持 |
| T4 | `useFileDrop` 判据替换后，「焦点在其他 textarea（commit message、LSP 配置）」的拖拽行为变化 | 旧行为：投给零监听者事件 = 失效。新行为：composer 未命中 → 落 terminal。**新行为更可用但语义变了**，需在 PRD 变更记录里写明并跑 `useFileDrop.test.ts` 全量 |
| T5 | A1 判据误报 dock/status-bar 的合法 sort（三域作射程内实测 2 处） | 限定「tab 语境相邻 token」+ 台账登记；ERROR（扫描集为空）与 VIOLATION 分开 |
| T6 | `refreshTerminalForSession` tabId 改必填后 `useAgentActions.ts:79` 无 tabId 可传 | 该处本就应先仲裁再刷新（§2 调用方收敛）；仲裁返回 null 时不刷新（与旧的「Map 首个」等价但显式） |
| T7 | G3 语境材质档误报 `fileTree.ts` 的子树指纹分隔（实测 3 处） | 照抄判据 6 双档：标识符无条件拦、转义需 terminal 语境词同行；台账登基线（**不拉到 0、不放宽判据**） |
| T9 | **实施期行为变更（批 3）**：browser picker 的门控由 `isAgentCliTab(tabs, 顶层 activeTabId)`（要求「前台必须是 agent CLI」）改为 `foregroundAgentCliTab`（「有任一 agent CLI tab，前台优先」）。这是**有意的口径统一**：同一功能的 panel 路径要求前台、tab 路径（`useBrowserTab`）一直用「任一」，属 §1.2 的又一处口径分歧；且顶层 `activeTabId` 是跨 tab 空间状态（design §1.3）。后果：前台是文件 tab 时，picker 内容现在会落到那个 agent CLI tab（旧行为是弹「Please switch to an Agent CLI tab」）。`isAgentCliTab` 随之零消费者删除（R4）。 | toast 文案不变（仍提示切换）；AC 增一条「前台非终端时 picker 落到 session 内 agent CLI tab」；如需恢复严格门控，走台账 + 本表登记，不在消费侧另写一套 |
| T8 | spec 示例代码与新签名共存，读者拄旧形态 | `interaction-patterns.md` 实测 405-500 + 532-533 行均为**迁前形态**（`sendToTerminal(projectId, …)` 是 10-12 之前的签名）—— 批 5 整段重写，不是只改 422-441 |

## 8. 遗留（只记账，不在本任务）

- **`useEditorAgentActions.pending` 队列**（Q4）：`useState` 活在 hook 实例内，
  `useFileEditorState.ts:86` 与 `useDiffReview.ts:49` **各持一份互不可见**；`sendToAgent` 返回 false
  时写入 pending，而消费侧 `handleCreateTab` 只在 `useFileEditorState` 里读它。
  另起任务收敛为「agent 派发队列」（与 §2 的注册表同域，但语义是「等待就绪」而非「找目标」）。
- **§4 的 pane 级前台**（`activePaneId` → tab 身份）：`SplitLayout.onActivePaneChange` 零消费者，
  接入点已就位。
- **`ConversationsPanelWrapper.tsx` / `app/hooks/useTerminalTabs.ts` 的两处
  `kind === 'terminal'`**：实测为 tab 构造/过滤（非「选第一个」），不属 A1 射程，但 A1 上线时
  需确认它们不被误伤（台账基线）。
- **agent 投递失败的两条链路给出不同反馈**（批 3 实施期发现）：
  `useInsertPromptToWorkspace`（prompts 面板 / Library / 状态栏）走 **clipboard 兜底 + toast**；
  Action Palette 的 recent-prompt 项（`action-menu/providers/libraryActionProvider.ts`）
  只能走 **toast** —— 它是模块级函数，拿不到 `useCopyToClipboard`。
  两者都已消除静默 no-op（本任务的 defect），但同一失败的用户反馈不一致。
  正解：给 `ActionContext` 加一个 `insertPrompt(prompt, target)` 回调（由 ProjectView 注入
  `useInsertPromptToWorkspace` 的结果），让投递语义回到**唯一实现点**；未做的原因是
  ProjectView 自己就是 `TerminalInsertProvider` 的 register 方，在同一组件里消费它
  会引入首次渲染 `api` 为空的时序耦合（需单独验证，不应当作顺手改动）。
  另：palette 路径本来就不计 `recordUsage`（与 prompts 面板不一致），属同一「投递语义未收敛」问题。
- **`terminalCache.ts:73,100` 两处 `log(\`Cache destroyed for ${key}\`)` 送裸键** +
  `terminalCommands.ts:27,79` 把 `session.key` 喂给 `terminalKeyLabel`（恒返回
  `<invalid terminal key>`，身份信息全丢）—— 10-12 的 S10 nit，随本任务批 0 一起清。

## 8.1 实现注记（设计 → 代码的偏离）

> 编号是稳定标识符（同 PRD 的决议表纪律）。§1.2 第 7 行引用的「注记 9」就是下面首条 ——
> 它此前只在表格里有正文、没有落成条目，引用悬空；现在补齐。
> 本小节只记**实现与本文不一致**的地方及理由，不把正文删改写一遍（那会让读者无法判断
> 当初为什么那么写）。

- **注记 9（更正 §1.2 #7）**：`useTerminalTabs.ensureDefaultTab` 与 `getActiveTab` / `getActiveTabId`
  一样是**零生产消费者**（首稿误记为「在用」）。同名文件有两个（`app/hooks/useTerminalTabs.ts` 与
  `features/terminal/hooks/useTerminalTabs.ts`），判零消费者时必须按路径分开数 —— 混在一起会把
  活功能误判成死代码。
- **注记 10（§2「调用方收敛」ProjectView 行）· `TerminalInsertApi.insertToAgentInput` 最终是
  `(text) => boolean`，不是首稿写的 `(session, tabId|null, text): boolean`**。
  两个派发点（dock Context / 命令面板）共用同一个 `useCallback`，session 在它**内部**由
  `activeWorkspaceSession(activeProject.id)` 命令式现取（Store 快照模式，引用永久稳定）。
  这比让外部传身份更好：派发方拿不到也传不错「哪个单元」，少一处可传错的参数（tabId 同理 ——
  registry 的 tabId 由 `insertToSessionAgent` 内部仲裁得出，本来就不该由派发方指定）。
  `insertToTerminal` 同形。红线 12 不受影响：身份仍只有一个来源。
- **注记 11（§3 A3）· 护栏判据是「签名形态」，不是首稿正文写的「调用实参个数 == 形参个数」**。
  实参计数版有两个致命缺陷：① 它拦不住真正的回退动作（把 `tabId: string` 改回 `tabId?:` 对
  现有调用方完全合法、编译期无声，而那才是第二口径复活的入口）；② 它要解析跨文件调用链才能
  数准实参，成本与误报面都远高于扫 `tabId?:` / `tabId: string | null` 两个形态。
  ⇒ 实现改为：`src/features/terminal/**`（剔注释、剔测试）内这两个形态**零命中**。
  它仍是 TS 那条的**跨文件补强**：类型只保证当前代码可编译，护栏保证下一个人在 lint 期
  就把可选性改回去时留下名字，而不是静默地删一个 `?`。
  **同批更正 A1 基线：4 → 3**（`terminalRouting.ts` owner + `StatusBarCluster.tsx` +
  `status-bar/registry.ts` legit）；`UseDockBarButtons.tsx` / `dockStore.ts` / `gutter/registry.ts`
  在 A1 作用域（terminal/browser/status-bar 三域）之外，`pickerUtils.ts:75` 本次已删。
  现行计数以 `pnpm guards list check_terminal_foreground_arbitration` 输出为准。
- **注记 12（§2 terminalRouting 行）· `InsertToSessionTerminalResult.landed` 已删**：
  实现后实测 `landed`（`'composer' | 'agentCli'`）**零生产读者**（只有测试读它），而调用方真正
  需要的「落到哪了」已由 `ok` + `landedTabTitle` + `isFallback` 给全（composer 路径不碰 PTY，
  Agent CLI 路径必然 emit，测试因此仍分得开两类）。按本任务自己的 R4 / YAGNI 纪律删除，
  不给它造一个假的消费者来 justify 存在。
- **注记 13（`agentInputRegistry.ts` 的 `AgentInputHandler` 返回值语义）· 不留「业务门禁」的误导例**：
  首稿注释举例「例如流式进行中不许改写输入框」，但生产唯一 handler（`useAgentInputRegistration`）
  **恒返回 true** —— 该例没有任何代码实现它，等于又写下一条「声明了没人实现」的注释
  （正是本任务的根因形态，只是换到了 docstring 上）。现改为写明：返回值是给**注册表机制**的
  （「有没有人接住」），不是给接收端做业务策略的口子；写业务门禁会让投递静默落到 PTY，
  比 no-op 更难诊断。本任务不实现流式拒收（非目标）。
- **注记 14（审查 B2 的直接代价）· 新增 `agent-chat/hooks/useOpenAgentFile.ts`**：
  批 1 在 `AgentChatTabView` 里加登记调用后该文件已到 **299 行**（离 300 只差 1）；B2 改为
  下传 `session` 本体（+ 属性声明 + JSDoc + 解构）把它推到 **306 行**，踩中护栏
  `check_component_size`（≤300，ratchet：新债不登记，只能抽）。按护栏 `fix_hint` 把
  `openAgentFile`（消息里 `read_file` 路径 → 编辑器 tab）抽为同级 hook，**行为零漂移**
  （同一实现逐字迁移，依赖参数不变）；组件降到 264 行。与 `useAgentInputRegistration` 同理：
  组件的单一职责是「渲染 agent chat 页面」，不是「把路径解析成 tab」。
- **注记 15（§2 terminalRouting 块）· `foregroundTerminalTabs` / `foregroundAgentChatTab` 两个【新】条目**
  **未创建**：实现把有序基底收为模块私有 `sessionTabSpace()`（一次 store 读取同时给出
  `ordered` + `activeTabId`），composer 候选收为模块私有 `agentChatTabCandidates()`（返回**全量**
  候选而非首个 —— `PaneContent` 只渲染每组激活 tab，「tab 存在于 store」≠「它的 composer
  已挂载」，因此编排层必须沿序逐个试，由 registry 回答「有没有人在」）。二者按 R4 不对外导出
  （零消费者的导出就是下一个手捼的诱饵）；对外的仲裁面只有
  `foregroundTerminalTab` / `foregroundAgentCliTab` / `insertToSessionTerminal` / `insertToSessionAgent`。
  顺序口径仍只有一处（`sessionTabSpace` 内那一次 `sort`，A1 台账 owner 因此仍是
  `terminalRouting.ts` 唯一一处）。

### 8.1.1 结构整理批（S2 → S1 → S4，行为零漂移）

> 本组为任务收尾的**纯结构重划**（不新增能力、不改行为）：三批各自的验收是「现有测试不改一行仍绿」。

- **注记 16（S2）· 两个 barrel 删除 9 个裸物理 Map 导出**：`terminalCache` / `wslTerminalCache` /
  `remoteTerminalCache` + 6 个 `*RebuildCallbacks` / `*WrapperRefs` 从 `terminal/index.ts` 与
  `terminal/components/index.ts` 移除。删除前 grep 证明**零外部消费者**：三者只被 `strategies/index.ts`
  （同域相对 import）与同域测试引用；barrel 消费者（`ProjectView` / `useFileDrop` / `browser` /
  `status-bar` / `editor` 等）只取 API 函数。内部使用者继续相对 import。
- **注记 17（S1）· `insertToSessionAgent` 迁出 terminal 域 → `agent-chat/api/insertToSessionAgent.ts`**。
  §8.1 注记 15 的「对外的仲裁面 … 含 `insertToSessionAgent`」据此**更正**：终端域现只提供
  **有序序列仲裁 + 精确写入**（`foregroundTerminalTab` / `foregroundAgentCliTab` /
  `foregroundAgentChatTabs` / `insertToTerminalTarget` / `insertToSessionTerminal`），
  「composer 优先 → Agent CLI 降级」的**编排**归 agent-chat。
  **理由＝依赖方向**：composer 是 agent-chat 的输入框，把它作为首选目标的编排留在 terminal 域
  会让 terminal 反向依赖 agent-chat（现状正是如此，唯一一处 `features/terminal → features/agent-chat`）。
  迁后单向：agent-chat（高层编排）→ terminal（低层仲裁），`terminal` 域对 `agent-chat` 零 import。
  未引入任何 `eslint-disable`：新文件 import terminal **门面**（`@/features/terminal`）与同域
  `agentInputRegistry`，两者都在防火墙允许面内（跨 feature 的 `index.ts` / `api/`）。
  `import/no-cycle` 绿（full lint 实测）。调用方（`ProjectView` / `useFileDrop`）改从新位置导入。
  **测试落点偏离**：编排用例**未**随实现迁到 agent-chat，仍留在 `terminalRouting.test.ts`。
  原因：该用例组需要 `terminalCache`（真物理 Map 夹具：`terminalCache.set(terminalAddress(...))`）
  与 `useEditorStore` 造 tab 空间 —— 迁到 `agent-chat/api/__tests__/` 会迫使跨 feature 深导
  `@/features/terminal/components/terminalCache`（**防火墙违规**，terminal 的 `components/` 非公开面）。
  故只在 terminal 域的测试里把 `insertToSessionAgent` 的 import 改成新位置（测试可合法 import
  它域公开面 `api/`），夹具与断言逐字保留。
- **注记 18（S4）· 地址层抽出 `components/terminalAddress.ts`**：`TERMINAL_KEY_SEP` /
  `terminalAddress` / `terminalAddressPrefix` / `terminalAddressPrefixOfTab` / `DecodedTerminalKey` /
  `decodeTerminalKey` / `terminalKeyLabel` 从 `terminalCache.ts` 迁到同级纯函数模块；
  `terminalCache.ts` 改为 import 消费（344 行，仍 >300 但 ratchet 只许缩小，未回涨）。
  **护栏随之收窄**：`check_terminal_key_mint` 的 `MINT_FILE` 改指 `terminalAddress.ts`，
  `terminalCache.ts` **失去** G3 豁免 —— 若分隔符材质再现在缓存层即判违规（地址层被内联回退）。
  两条 barrel 改为从 `terminalAddress` re-export 地址符号、从 `terminalCache` re-export resolve/销毁/刷新。
  测试：`terminalAddress.test.ts` 拆出地址符号 import（cache 符号仍来自 `terminalCache`），
  其余四个测试文件的 `terminalAddress` import 改指新模块；断言**零改动**（golden 键形态、
  codec 往返、前缀精确性、`terminalKeyLabel` 可读标签全部逐字保留）。
  `check_terminal_key_mint` 测试新增一条反向用例：材质出现在**缓存层**（`CACHE_FILE`）判违规。
