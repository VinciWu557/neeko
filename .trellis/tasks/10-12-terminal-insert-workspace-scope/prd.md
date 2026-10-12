# 终端插入链路 WorkspaceSession 寻址迁移

## 背景：WorkspaceSession 统一寻址的漏网之鱼

Workspace 身份已统一为 `WorkspaceSession(projectId, worktreePath)`（`src/shared/utils/workspaceRef.ts`，
key 唯一 mint = `session.key`，与 Rust `WorkspaceRef::key()` 双端钉住）。编辑器 tab 空间、git 命令
（护栏 `check_workspace_session_addressing`）、文件 IO 已迁移；**terminal 插入链路没迁**：

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `terminal/strategies/index.ts:95-102`（`local.ts:35-41` 同构） | worktree 缓存键手搓 `` `${projectId}:wt:${path}:${tabId}:${paneId}` `` | 违反"key 是投影不是拼装"；session 护栏口径只认 git 命令形态，扫不到 |
| `terminalCommands.ts:20-46` `sendToTerminal` / `:84-117` `pasteToTerminal` | 签名只有 `(projectId, text, tabId)`，无 worktree 维度 | worktree 精确查找恒 miss，掉进 prefix 兜底 |
| prefix 兜底 `key.startsWith(`${projectId}:`)` | `P:T:p1` 与 `P:wt:…` 都匹配，取 Map 插入顺序第一个 | **恒落首个 tab**（本任务用户可见症状的直接机制） |
| `ProjectView.tsx:196` `insertToTerminal` | 读全局 `editorStore.activeTabId`（任何 tab 激活都覆盖） | 点过文件/agent-tab 后精确键 `P:fileTab:p1` 恒 miss → 同样掉进兜底 |
| `useBrowserPanelEvents.ts:163,167` | 同样用全局 `editorState.activeTabId` 配 session 内 tabs | 同一 defect 家族的第二个落点 |
| `INSERT_TO_AGENT_INPUT_EVENT` | 载荷只有 `{ text }`，**零监听者**（全仓 grep 确认） | 对话框 Enter（默认 target='agent'）在任何 tab 都是静默 no-op |

用户可见症状：prompts 插入恒落 local 首个 tab；切 tab 后插不到当前 tab；worktree tab 插不进去；
agent 目标点了没反应。

### 寻址面全景（**三类，缺一不可** —— 只做前两类是本任务的主要风险）

派生的终端地址不只有"写"和"精确读"两个消费者，还有第三类**部分寻址（前缀/裸 projectId）**，
它们全走 `:wt:` / `wsl:` / `remote:` 冒号前缀语义。键形态一改，第三类会**静默**（非编译期）失效：

| 维度 | 形态 | 代表位置 |
| --- | --- | --- |
| ① mint（写） | 模板拼接 + `wslCacheKey/remoteCacheKey` | `strategies/*`、`terminalCacheKey/wslCacheKey/remoteCacheKey` |
| ② resolve（精确读） | 精确键 + 跨 session prefix 兜底 | `terminalCommands.ts:25,37,93,105` |
| ③ 部分寻址（生命周期） | 前缀销毁 / 裸 projectId 刷新 / 按 tab 清理 / 键串分派 backend | `useLocalProjects.ts:178`、`useConnectionProjects.ts:144,147,169,172,209,219`、`useProjectActions.ts:253,268,273,279`、`useAgentActions.ts:90`、`terminalTabCleanup.ts:23,65,86`、`TerminalViewBase.tsx:350-352`、`terminalCache.ts:52,60,433,505,529` |

第 ③ 类若漏迁，后果不是"插错 tab"而是 **PTY 泄漏**（清理前缀恒不命中）与 **agent 切换静默 no-op**
——`terminalTabCleanup.ts:20-22` 的注释已明确写过这个失败模式。

## Goal

终端插入链路的寻址与全仓统一：**读写同键、路由按当前 workspace session、无目标时显式失败**。
"地址"（env-blind 的公共身份）与"物理键"（存储层）分层，`prefix` 语义随之收敛到 session 内。

## Requirements

**R1 · 寻址唯一入口（env-blind，session 首参，覆盖三类寻址面）**
新增 terminal 寻址唯一 mint `terminalAddress(session: WorkspaceSession, tabId, paneId='p1')`
（落 `terminalCache.ts`，内部以 `session.key` 为前缀派生）。**签名不收环境参数**
（Q4 决议 2026-10-12：参数值可以不同，接口方法必须相同；`session.key` 已含完整身份，
寻址层无需区分 local/wsl/remote——环境是传输维度，不是寻址维度，且 project→env 是单值函数）。

- `strategies/*` 全部手搓构造（`terminalCacheKey` / `wslCacheKey` / `remoteCacheKey` / `wt:` 模板 /
  `wsl:`+`btoa(path)` 后缀 / `remote:` + `entryId`）一律改调它；terminal 域内禁模板字符串手搓缓存键。
- **读侧同源**：`pasteToTerminal` / `sendToTerminal` / `launchAgentInTerminal` / `switchAgentIn*Terminal` 同迁。
- **③ 部分寻址同源（新增，本次审查补）**：前缀销毁、裸 projectId 刷新、按 tab 清理一律改由
  session 派生的前缀承担（`terminalAddressPrefix(session)` = `session.key` + 分隔符）。
  现有 `resolveCacheKey` / `destroyCachesByPrefix` / `terminalSpacePrefix` / `keyHasTabSegment` /
  `hasCacheKeySegment` 的冒号语义随之退役。
- 物理 Map 三分（local/wsl/remote）保留（传输归属），但调用方不可见——统一
  `resolveTerminalEntry(session, tabId?, paneId?)` 内部按键在三个物理 Map 中唯一命中（不读 projectStore）。
- **不**把 tabId/paneId 并入 `WorkspaceSession`（Q2 决议；session 保持纯粹，terminal 地址由其派生）。

**R2 · 插入路由按 workspace session**
`insertToTerminal` 不再读全局 `activeTabId`；以 `activeWorkspaceSession(projectId)` 确定当前 session，
在 `tabs[session.key]` 内找前台 terminal kind tab，用其 id 构造精确键。无前台终端 → **fallback 到该
session 内的首个终端 tab**（Q1 决议：保留便利，禁止跨 session；fallback 命中时 toast 告知实际落点）。
该 session 内一个终端都没有 → 返回 false（显式失败，调用方 toast/降级）。**删除跨 session 的
"取第一个" prefix 兜底**。`useBrowserPanelEvents`（`sendToTerminal` + 全局 activeTabId）与
`ProjectView` 走**同一个** routing 编排 helper，不各自仿写（仿写第 3 次即漂移，本次事故就是漂移结果）。

**R3 · 范围边界（agent 链路）**：`INSERT_TO_AGENT_INPUT_EVENT` 零订阅问题**不在本任务**（Q3 决议）。
本任务不碰 `insertToAgentInput`、事件载荷与 composer；验收不含 agent 目标。

**R4 · 护栏口径**：新护栏 `check_terminal_key_mint` 覆盖 terminal 缓存键手搓。判据下限：
**G1**（符号级）已退役的键构造符号（`terminalCacheKey(` / `wslCacheKey(` / `remoteCacheKey(` /
`findSessionIdForProject(` / `terminalSpacePrefix(` / `parseProjectIdFromWslKey(`）在
`terminalCache.ts` 外零命中；**G2**（形态级）`src/features/terminal/**` 内禁止模板字符串拼接
`wt:` / `wsl:` / `remote:` 形态的键。护栏文件必须配 `tools/guards/tests/test_check_terminal_key_mint.py`
（注册表按 `checks/` 目录自动接入，见 `tools/guards/core/registry.py`）。

**R5 · 执行路径与死代码边界**：
`sendToTerminal` / `pasteToTerminal` / `launchAgentInTerminal` / `switchAgentInTerminal` /
`switchAgentInWslTerminal` / `switchAgentInRemoteTerminal` 同迁（Q5 决议：同一 lookup/同一 Map，并入 R1）。
本次审查新增：**零消费者的死导出随迁移删除**，不迁移——`launchAgentInAnyTerminal` /
`switchAgentInAnyTerminal`（含其依赖 `resolveBackendForKey` 的键串分派）、`getWslOpenProjectIds` /
`getAllWslOpenProjectIds`、`strategies/local.ts`（`useLocalTerminalStrategy` 零调用方）、
`TerminalView.tsx:36` 的 `worktreePathOverride` 死管道（`PaneContent.tsx:115-121` 从不传 `worktreePath`）。

**R6 · 物理键语法与 codec（本次审查新增）**
所有段用**同一保留分隔符** `TERMINAL_KEY_SEP`（`\u0001`）连接：`session.key` + SEP + `tabId` + SEP + `paneId`。
不用 `:` 作段界：editor tabId 本身含 `:`（如 `proj:src/a.ts`），`:tab:` 前缀会与 `tab` 内含 `:` 的键混淆
（`A` + `:p1` 与 `A:p1` + `:p2` 前缀同形）。`terminalCache.ts` 提供 `decodeTerminalKey` /
`terminalKeyLabel`（对照 `workspaceKeyLabel`）供日志与 env 判定复用，**其他模块不得从 terminal key 反解**
（`WorkspaceSession.fromKey` 会把 `\u0001tabId\u0001p1` 误判成 worktreePath）。

## Acceptance Criteria

- [x] 主仓多终端 tab：插入落到**当前前台**终端 tab，切 tab 后目的地跟着走（`terminalRouting` 单测）；
- [x] worktree 终端 tab：插入落到 worktree 的前台终端，不再串到主仓（session 前缀隔离单测）；
- [x] 无前台终端时：fallback 到**同一 session 内**首个终端（跨 session 不串写）并 toast 告知落点；
  session 内无终端时显式失败（`insertToSessionTerminal` 返回 `{ ok: false }`，`ProjectView` toast）；
- [x] **③ 部分寻址不回归**：`useLocalProjects` / `useConnectionProjects` / `useProjectActions` / `useAgentActions`
  / `useKeyboardShortcuts` / `terminalTabCleanup` / `TerminalViewBase` 全部改用 session/project 前缀 API；
  `grep` 退役前缀函数归零。（PTY 实际回收待 `pnpm tauri dev` 真机核验，见下）；
- [x] 写侧与读侧同源：`grep -rn "activeCheckoutPath" src/features/terminal` 为空；
- [x] 退役符号零残留：`terminalCacheKey|wslCacheKey|remoteCacheKey|findSessionIdForProject|parseProjectIdFromWslKey|`
  `terminalSpacePrefix|resolveCacheKey|resolveBackendForKey|destroyCachesByPrefix|destroyTerminalCachesByPrefix|`
  `destroyWslCachesByPrefix|destroyRemoteCachesByPrefix|launchAgentInAnyTerminal|switchAgentInAnyTerminal|`
  `getWslOpenProjectIds|getAllWslOpenProjectIds|switchAgentInWslTerminal|switchAgentInRemoteTerminal|`
  `launchAgentInWslTerminal|launchAgentInRemoteTerminal|createTerminalForProject|getAgentById`
  全仓零命中（含两个 index 桶文件）；
- [x] agent 切换只有**一套 env-blind 能力** `switchAgentInTerminal(session, tabId, agentId, overrides?)`
  （local/WSL/Remote 同一入口；调用方不感知环境）；旧的两套语义（local imperative / 远端 rebuild）已合一；
- [x] agent 目标保持现状（事件零订阅另起任务）；
- [x] 新护栏 `check_terminal_key_mint` 拦截 terminal 键手搓；`pnpm check` 全绿（26/26）；
- [x] `pnpm test:rust` 与前端单测全绿（`test_fe` 533 文件 / 4689 用例）。

### 待真机确认（需 `pnpm tauri dev`，本会话无 GUI 未执行）

- 主仓多终端切换 / worktree 落点 / 无终端 toast 的**端到端**演示；
- ③ 面逐点无 PTY 泄漏（关项目、关 entry、删 worktree、清 tab 空间）；
- design §3 不变量：打开 worktree 终端 → 切回主仓 → 两键各自存活、无覆盖。

## 非目标

- 不合并三个物理 Map；不动传输层（create/resize/close/agentDelay/outputFilter）；
- 不把 `tabSpaceKey` 线程化进 `TerminalView`→strategy（见 design §3「写侧身份源」的边界声明）；
- 不搬 `INSERT_TO_AGENT_INPUT_EVENT` 的订阅（另起任务）；
- 不新增红线（映射红线 10 + 12）。

## 待决策（按价值排序，逐个确认）

- **Q1** ✅ 已决（2026-10-12）：fallback 到**该 session 的首个终端**（session 内便利保留，
  禁止跨 session；fallback 命中时 toast 告知落点）。
- **Q2** ✅ 已决（2026-10-12）：不并入 session；R1 改写为单一 mint、session 首参、
  terminal 地址由 session 派生；形态细节降为实现注记。
- **Q3** ✅ 已决（2026-10-12）：本任务只做 terminal，agent 事件另起任务。
- **Q4** ✅ 已决（2026-10-12）：env-blind——mint 签名无环境参数，三环境同一接口。
  依据：project→env 是单值函数（一个项目只属一种环境），`session.key` 已含完整身份
  （projectId 全局唯一），寻址不需要 env 输入；既有 strategy 抽象屏蔽了传输没屏蔽寻址，
  本任务把屏蔽层补到寻址。物理 Map 三分保留（传输归属），统一 resolve 内部选 Map。
  （三环境同病取证：local `P:T:p1` / `P:wt:path:T:p1`、wsl `wsl:distro:P:…` +
  `parseProjectIdFromWslKey` 两套正则、remote `remote:entry:P:…`；读侧 local prefix 首命中、
  wsl/remote `findSessionIdForProject` 分段首命中——同一 defect 家族。）
- **Q5** ✅ 已决（2026-10-12）：`sendToTerminal` 同迁，并入 R1；`launchAgentInTerminal` /
  `switchAgentIn*` 同批（同一 lookup/同一 Map，无独立决策）。
- **Q6** ✅ 新决（2026-10-12 审查补）：**env 命名空间退出物理键**。物理键不再含 `wsl:` / `remote:` /
  `entryId` / `distro`；环境由「Map 身份」承接——键在三个 Map 间唯一，地址层按键/前缀命中，
  不读 projectStore（见 design §8.5）。
  依据：`Environment` 的 Remote 变体（`src/shared/types/project.ts:21`）**不含 entryId**，
  且全仓已在别处承认 host 反查多 entry 有歧义（`ProjectView.tsx:205-209` 注释）——
  env 段既无法从 session 派生，就是"第二个身份表示"，必须删。
  代价：`resolveBackendForKey(key)` 的键串分派不可复用 → 随其两个零消费者导出一并删除（R5）。
- **Q7** ✅ 新决（2026-10-12 审查补）：**统一段分隔符**（R6）。理由：`:tab:` 前缀与含 `:` 的
  tabId 同形，`cleanupTerminalsForTab` 的前缀匹配会过度命中。SEP 需单测钉住。
- **Q8** ✅ 新决（2026-10-12 审查补）：写侧 session 来源收敛到 `activeWorkspaceSession(projectId)`
  （`workspaceStore.ts:158`）这一**唯一身份源**，替代 `activeProject.id` + `activeCheckoutPath`
  的两步旁路（两步等价但绕过单点）。当前 pane 挂载不变量：只有当前 workspace 空间的 pane 被挂载
  （`EditorGroupPane` 只渲染当前 tabKey）⇒ 写侧无需线程化 `tabSpaceKey`；批 1 需以一次实证确认，
  不成立则报停并回写 design §3。
