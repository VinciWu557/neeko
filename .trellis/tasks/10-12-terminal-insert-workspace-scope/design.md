# 技术设计：终端寻址 env-blind 迁移

> 任务：`.trellis/tasks/10-12-terminal-insert-workspace-scope`（PRD 见 `prd.md`）
> 结论先行：**地址（env-blind 公共身份）与物理键（存储层）分层**；session 是唯一身份输入；
> 物理 Map 三分保留但键内不再编码环境；部分寻址（前缀/裸 projectId）与精确寻址同源。

---

## 0. 第一性原理：三层，不是两层

设 project→env 为单值函数 E（一个项目只属一种环境，`activeProject.environment` 为证），
身份 I = (projectId, worktreePath) = `WorkspaceSession`。终端条目地址本应是纯函数：

> **A(session, tabId, paneId) → entry**，其中 session 唯一确定 E，无需 env 参数。

现状违反 A：三套手搓前缀（`''` / `wsl:` / `remote:`）+ 两套后缀 scheme（`tab:p1` / `wt:path:tab:p1`
+ wsl 的 `btoa(path)` 变体）+ 两套读扫描（prefix 首命中 / 分段首命中）。"找不到时拿第一个"不是
fallback，是**寻址函数在未定义输入上返回了定义外的值**——本次事故的精确机制。

推论（决定手段）：

- **L1 · 地址与物理键分层**：公共 API 只认 `session`（env-blind，Q4）；**物理键也不再编码 env**
  （Q6）。依据：Remote 的 `Environment` 不含 entryId（`src/shared/types/project.ts:21`），
  env 段无法从 session 派生，是「第二身份表示」。环境归属由 **Map 身份**（三个后端）承接——
  键在三个 Map 间唯一，地址层按键/前缀直接命中（§8.5，不读 projectStore）。
  **代价与处置**：`resolveBackendForKey(key)` 的键串分派失效 → 它只被两个零消费者导出使用
  （`launchAgentInAnyTerminal` / `switchAgentInAnyTerminal`），**删除而非改造**（R5）。
  仍在用的键串分派只剩 `TerminalViewBase.tsx:350-352`，改为按 strategy 已知的 backend 分派（批 3）。
- **L2 · 段分隔符唯一（Q7）**：`session.key` + `TERMINAL_KEY_SEP` + `tabId` + SEP + `paneId`。
  **不用 `:` 作段界**：editor tabId 本身含 `:`（如 `proj:src/a.ts`），`:tab:` 前缀与含 `:` 的
  tabId 同形 —— `...SEP A :p1`（tab=A, pane=p1）与 `...SEP A:p1 :p2`（tab=`A:p1`）前缀重合，
  `cleanupTerminalsForTab` 会过度命中。统一 SEP 后 tab 前缀是 `…SEP A SEP`，两者不可混淆。
- **L3 · 部分寻址同源**：前缀扫描必须 `startsWith(session.key + SEP)`（**整串 + 分隔符**，
  非分段匹配）。worktreePath 原样内嵌不再造成歧义，且对嵌套路径天然精确：
  session `/wt/a` 的前缀 `P\0/wt/a\u0001` 不匹配 session `/wt/a-b` 的键 `P\0/wt/a-b\u0001…`
  （末位是 `-` 不是 SEP）。由此**跨 session 串写在 API 层面不可表达**（C3 保留）。
- **C1 · 不合并三个物理 Map**：entries 永不跨 env 迁移（env 随项目终身不变），合并零功能收益，
  却要动 ~75 处引用 + 三套 callbacks/wrapperRefs + destroy 路径的 env 恢复。YAGNI。

## 1. 取证（三类寻址面全家福，实测）

**① 写侧（mint）**

| 环境 | 构造点 | 键形态 |
| --- | --- | --- |
| local 主仓 | `strategies/index.ts:101`、`local.ts:41` | `P:T:p1`（`terminalCacheKey`） |
| local worktree | `strategies/index.ts:99`、`local.ts:39` | `P:wt:path:T:p1`（手搓模板） |
| wsl | `strategies/index.ts:155`、`wsl.ts:44` | `wsl:distro:P(:wt:btoa(path)):T:pN` |
| remote | `strategies/index.ts:190`、`remote.ts:57` | `remote:entry:P(:suffix):T:pN` |

**② 读侧（精确 + 越界兜底）**

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `terminalCommands.ts:25,93` | `terminalCacheKey(projectId, tabId)` 精确 | worktree 恒 miss（写侧 `wt:` 形态） |
| `terminalCommands.ts:37,105` | ``key.startsWith(`${projectId}:`)`` 取首命中 | **恒落首个 tab**，跨 session |
| `ProjectView.tsx:196` | 全局 `editorStore.activeTabId` | 非终端 tab 激活即恒 miss |
| `ProjectView.tsx:205-217` | wsl/remote 分支 `findSessionIdForProject` | tabId 来自全局 activeTabId，同病 |
| `useBrowserPanelEvents.ts:163,167` | 全局 `editorState.activeTabId` 配 session 内 tabs | 同一 defect 家族第二落点 |

**③ 部分寻址（生命周期 / 键串分派）—— 本次审查新增，原设计未清点**

| 位置 | 形态 | 漏迁后果 |
| --- | --- | --- |
| `useLocalProjects.ts:178` | `destroyTerminalCachesByPrefix(projectId)` | 关项目后 PTY 泄漏 |
| `useConnectionProjects.ts:144,147,169,172,209,219` | `destroy{Wsl,Remote}CachesByPrefix(wslCacheKey/remoteCacheKey(...))` | 关/删 entry、关项目后 PTY 泄漏 |
| `useProjectActions.ts:253,268,273,279` | `wslCacheKey/remoteCacheKey(distro/entryId, projectId)` 作**前缀键**传 switch/refresh | agent 切换恒 miss |
| `useAgentActions.ts:90` | `refreshTerminal(currentActiveProject.id)`（裸 projectId） | agent 切换后刷新静默 no-op |
| `useKeyboardShortcuts.ts:158-159` | `terminalCacheKey(...)` + `refreshTerminal(key)` | 刷新快捷键失效（typecheck 会抓） |
| `terminalTabCleanup.ts:23,34,65,86` | `terminalSpacePrefix` / `keyHasTabSegment` / `destroyCachesByPrefix` | PTY 泄漏（该文件注释已警告） |
| `TerminalViewBase.tsx:350-352` | `key.startsWith('wsl:')/('remote:')` 分派 refresh | 重建自愈错 backend |
| `terminalCache.ts:52,60,433,505,529` | `resolveCacheKey` / `destroyCachesByPrefix` / `resolveBackendForKey` / `hasCacheKeySegment` / `findSessionIdForProject` | 前缀语义不匹配新键 |
| `terminalCommands.ts:150` | `key.startsWith(`${cacheKey}:`)` 前缀消解 | agent 切换恒 miss |

**零消费者（死代码，随迁移删除，不迁移）**：`launchAgentInAnyTerminal` / `switchAgentInAnyTerminal`
（+ 其唯一依赖 `resolveBackendForKey`）、`getWslOpenProjectIds` / `getAllWslOpenProjectIds`、
`strategies/local.ts`（`useLocalTerminalStrategy` 零调用方）、`TerminalView` 的
`worktreePathOverride`（`PaneContent.tsx:115-121` 从不传 `worktreePath`）。

**R2 路由的仓内先例**：`useFileDrop.ts:57-62` 已是正确模式
（`tabs[activeWorkspaceSession(projectId).key]` → 前台 tab → `kind === 'terminal'` 才发）——
R2 把该模式提为 terminal 域共享 helper，而非各处仿写。

## 2. 落点与形态

```
terminalCache.ts（唯一寻址模块；判据与构造同处，护栏只认本文件之外的手搓）
├── TERMINAL_KEY_SEP = '\u0001'                              【新，唯一段分隔符（Q7）】
├── terminalAddress(session, tabId, paneId='p1'): string      【新，唯一 mint】
│       `${session.key}${SEP}${tabId}${SEP}${paneId}`
├── terminalAddressPrefix(session): string                    【新】`${session.key}${SEP}`
├── terminalAddressPrefixOfTab(session, tabId): string        【新】`${session.key}${SEP}${tabId}${SEP}`
├── decodeTerminalKey(key): { session, tabId, paneId } | null  【新，唯一 codec】
│       WorkspaceSession.fromKey 的反解口径不同（见 §4）——不得复用 fromKey
├── terminalKeyLabel(key): string                             【新，日志/提示，对照 workspaceKeyLabel】
├── terminalEnvOf(session): 'local'|'wsl'|'remote'            【新，模块私有，projectStore 查表】
│       env 缺失 / 项目不在 map → null（fail-closed，由调用方转 fail）——**§8 已移除**：改为跨 Map 按键查找
├── resolveTerminalEntry(session, tabId?, paneId?): { entry, via: 'exact' | 'fallback' } | null
│       【新，唯一 resolve】内部按 terminalEnvOf(session) 选物理 Map；
│       精确键命中 → via:'exact'；tabId 缺省 → terminalAddressPrefix(session) 内枚举首个 →
│       via:'fallback'；跨 session 前缀不可表达（L3）
├── destroyTerminalsForSession(session) / destroyTerminalsForTab(session, tabId)  【新，③ 面收口】
├── refreshTerminalForSession(session, tabId?)                【新，③ 面收口】
│       （取代 refreshTerminal 的 "projectIdOrKey" 重载，语义由 session 决定，不再靠前缀猜）
│       注：`refreshTerminal(key)` / `destroyTerminalCache(key)` **保留**但语义收敛为**精确键**
│       （删掉内部的 resolveCacheKey 前缀猜）—— TerminalViewBase 自愈传的就是 strategy 的完整键
├── pasteToTerminal(session, text, tabId?) / sendToTerminal(session, …) / launchAgentInTerminal(session, …)
│       【改：首参收敛，内部统一 resolveTerminalEntry】
└── obsolete 删除：terminalCacheKey / wslCacheKey / remoteCacheKey / parseProjectIdFromWslKey /
        findSessionIdForProject / hasCacheKeySegment / resolveCacheKey / resolveBackendForKey /
        launchAgentInAnyTerminal / switchAgentInAnyTerminal / getWslOpenProjectIds /
        getAllWslOpenProjectIds / destroyCachesByPrefix（backend 冒号前缀版）及其三个公开包装
        destroyTerminalCachesByPrefix / destroyWslCachesByPrefix / destroyRemoteCachesByPrefix
        —— 同步清两个桶文件 re-export：`components/index.ts`、`features/terminal/index.ts`
terminalRouting.ts（新，terminal 域内）
├── foregroundTerminalTab(session): { tab, isFallback } | null
│       tabs[session.key] 内找前台 terminal kind tab；无 → 同 session 首个 terminal（isFallback:true）；
│       无终端 → null
└── insertToSessionTerminal(session, text): { ok: boolean, landedTabTitle?: string, isFallback?: boolean }
        【新，唯一编排】route → resolve → paste；**低层 resolveTerminalEntry 参数必填、无隐式 fallback**
        （避免同一 fallback 出现两处实现而漂移）；toast 由调用方按返回值渲染
```

**重命名说明**：名字从 `terminalSessionKey` 改为 `terminalAddress` —— 它与 `WorkspaceKey` 是
两个命名空间（不是 `session.key` 的同义名），"Address" 明示「地址 vs 物理键」分层（L1）。

- **依赖方向**：`strategies/*`、`terminalCommands/*`、调用方 → `terminalCache.ts`（mint/resolve/³ 面）、
  `terminalRouting.ts`（前台仲裁）。判据（护栏）在外，构造在内。
- **调用方迁移**（首参 `projectId` → `session`）：
  `ProjectView.insertToTerminal`（+ R2 路由改写）、`useFileDrop` P2、`useBrowserTab:183`、
  `useBrowserPanelEvents:167`（并入 routing helper）、`useEditorAgentActions:39`、
  `useKeyboardShortcuts:158`、`useAgentActions:90`（→ `refreshTerminalForSession`）、
  `useLocalProjects:178`（→ `destroyTerminalsForSession`）、`useConnectionProjects:*`（→ 同上）、
  `useProjectActions:253-279`（→ session 首参 + `refreshTerminalForSession`）、
  `TerminalViewBase:350-352`（→ 按 strategy backend 分派）、`terminalTabCleanup`（→
  `destroyTerminalsForTab` / `destroyTerminalsForSession`，`terminalSpacePrefix` 与
  `keyHasTabSegment` 删除）。
- **红线归属**：不新增红线。映射红线 10（平台差异集中化：三环境同一寻址接口即"差异落适配器、
  接口一致"）+ 红线 12（地址身份唯一化：session 首参 + 地址/物理键分层是 FileRef 思想在寻址域的落实）。

## 3. 写侧身份源（Q8，原设计的隐含假设显式化）

现状 `strategies/*` 用 `activeProject.id` + `activeCheckoutPath` 两步旁路造 session，
与 `activeWorkspaceSession(projectId)`（`workspaceStore.ts:158`）**等价但绕过单点**。
本任务统一改调后者（`grep -rn "activeCheckoutPath" src/features/terminal` 清零）。

**边界声明（不做的部分）**：把 `tabSpaceKey` 线程化进 `TerminalView`→`useTerminalStrategy`，
使写侧按 **tab 自身 scope**（而非当前视图）取身份 —— 这更彻底，但会牵动 `TerminalView` props、
`SplitLayout`、strategy 签名。当前不做的**前提不变量**：`EditorGroupPane` 只渲染当前 tabKey 的
tabs ⇒ 只有当前 workspace 空间的 pane 被挂载 ⇒ 写侧用当前视图态与 tab scope 一致。
**批 1 必须以一次实测确认该不变量**（打开 worktree 终端 → 切回主仓 → 检查 worktree 键仍在 Map 中、
未被主仓键覆盖）；不成立则报停并回写本节，改走 tabSpaceKey 线程化。

## 4. 键语法与 codec（R6）

```
<session.key>              = <projectId> \0 <worktreePath|''>            （WorkspaceSession#key，双端钉住）
<terminal address>         = <session.key> \u0001 <tabId> \u0001 <paneId>
<session 前缀>             = <session.key> \u0001                        （③ 面唯一扫描前缀）
<tab 前缀>                 = <session.key> \u0001 <tabId> \u0001        （按 tab 清理）
```

- **不得用 `WorkspaceSession.fromKey(terminalAddress)`**：它会把 `\u0001tabId\u0001p1` 当成
  `worktreePath`（非 null）⇒ 伪 worktree session。需要分量时只用 `decodeTerminalKey`。
- **日志/提示**一律走 `terminalKeyLabel`（NUL 与 `\u0001` 进日志会让日志被 `file(1)` 判成 data，
  同 `workspaceKeyLabel` 的既有理由）。
- **paneId 只支持 p1 级精度**：与现状一致（`terminalCacheKey(projectId, tabId)` 默认 `'p1'`）；
  分屏 p2+ 的插入目标不在本任务范围，需在 PRD 的 AC 之外显式留白（不假装支持）。
- **golden 测试钉住**：主仓 / worktree 两态键形；嵌套 worktree 前缀不互串；tabId 含 `:` 不产生歧义。

## 5. 迁移纪律

1. **键空间切换是原子**：旧键写、新键读（或反之）的混合态 = 全 miss。按 implement 批 1→3 顺序：
   先加新 API（旧不动）→ 写侧切新键 → 读侧 + ③ 面切新键并删旧构造；每批 `pnpm lint` + 相关单测。
   terminalCache 是模块级 Map，不进 session restore（批 1 若发现持久化键，先报停）。
2. **只改寻址，不改传输**：create/resize/close/agentDelay/outputFilter 逐字节不动；
   `setupTerminalLinks` 的 workspace 用法不动。
3. **可观测**：fallback 命中由 `insertToSessionTerminal` 返回落点（`landedTabTitle` + `isFallback`），
   调用方 toast。**低层 `resolveTerminalEntry` 不再自带隐式 fallback**（参数必填），
   避免 fallback 语义两处实现。
4. **③ 面的验收是"无泄漏"而非"能编译"**：这条面上的入口形参都是 `string`（裸 projectId 或
   已铸键）——改键形态后它们**仍然编译通过**，只是静默不命中（如 `refreshTerminal(string)`
   传裸 projectId、三个 `destroy*ByPrefix(prefix: string)`）。故必须逐点核对 + 真机验证
   （见 implement 批 3b/批 5），不能指望 typecheck 给清单。
5. **删除清单以 grep 为据**（含两个桶文件的 re-export），不留 "deprecate"。

## 6. 决策表

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| mint 是否收 env | **不收（env-blind）** | project→env 单值；session.key 已完备；用户决议：接口方法相同 |
| 物理键是否含 env 段 | **不含（Q6）** | Remote `Environment` 无 entryId，不可派生；env 段是第二身份表示 |
| 物理 Map 三分 | **保留** | entries 永不跨 env；合并零收益、大改动（YAGNI）；调用方不可见即等价统一 |
| 段分隔符 | **统一 SEP（Q7）** | tabId 含 `:`，`:tab:` 前缀会过度命中 |
| tabId/paneId 进 session | **不进** | 身份层污染 + 后端对等破坏 + 与 `tabs[WorkspaceKey]` 容器循环（Q2） |
| 写侧 session 来源 | **activeWorkspaceSession（Q8）** | 唯一身份源单点；tabSpaceKey 线程化留作边界（§3） |
| 旧 key 工具函数 | **删，不 deprecate** | 内部函数，无外部包消费；留着就是下一个手搓的诱惑 |
| 零消费者导出 | **删（R5）** | 死代码迁移 = 把债务搬到新形态；`resolveBackendForKey` 分派随 Q6 失效 |
| fallback | **同 session 首个 + toast** | Q1；跨 session 不可表达；编排只一处（§5.3） |
| 无终端 | **返回 false → toast「无活动终端」** | 与 status-bar 既有文案一致 |

## 7. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| R1 | 键切换混合态全 miss | §5.1：写侧先切、读侧后切；内存态无持久化；每批验证 |
| R2 | ③ 面漏迁（静默 PTY 泄漏） | §5.4 + 批 3 定点清单 + 批 5 真机泄漏核验（原设计最大缺口） |
| R3 | NUL/SEP 键调试不可读 | `terminalKeyLabel`；键形态仅活在 Map 内部（§4） |
| R4 | terminalEnvOf 成隐藏依赖 | **已消除（§8.5）**：地址层不读 projectStore，改为跨 Map 按键/前缀查找 |
| R5 | wsl/remote 无本地复现环境 | 精确键 + 前缀扫描纯函数单测；local 真机；三环境同一函数（env-blind 红利：测一处即测三处） |
| R6 | 写侧身份源假设（§3 不变量）不成立 | 批 1 实测确认；不成立则报停并回写 design §3，改 tabSpaceKey 线程化 |
| R7 | 调用方漏改 | TS 签名改 session 首参即编译期清单；批 3 附 grep 清零（见 implement 命令速查） |

## 附录：R4 护栏判据（给批 4）

文件：`tools/guards/checks/check_terminal_key_mint.py`（`checks/` 目录即注册表，自动接入；
`tools/guards/core/registry.py`）。**必须**配 `tools/guards/tests/test_check_terminal_key_mint.py`
（框架要求每条 check 有同名测试）。

- **G1（符号级，零命中）**：`terminalCacheKey(` / `wslCacheKey(` / `remoteCacheKey(` /
  `findSessionIdForProject(` / `terminalSpacePrefix(` / `parseProjectIdFromWslKey(` /
  `resolveBackendForKey(` / `resolveCacheKey(` / `destroyCachesByPrefix(` /
  `destroyTerminalCachesByPrefix(` / `destroyWslCachesByPrefix(` / `destroyRemoteCachesByPrefix(` /
  在 `src/features/terminal/components/terminalCache.ts` 之外零命中（届时这些符号已删，引用即编译错；
  护栏防的是**新造同类**）。注意 `destroyCachesByPrefix` 不是 `destroyTerminalCachesByPrefix` 的子串，
  四个名字必须逐一登记。
- **G2（形态级，仅 terminal 域）**：`src/features/terminal/**` 内不得出现「模板字符串内插 `${`
  且字面量含 `wt:` / `wsl:` / `remote:`」的键拼接。**作用域刻意收窄**：与
  `check_workspace_identity` 判据 6 的既有边界对齐（该文件已声明"冒号式只在流入 repo-key 消费点的
  同形判据下拦截；终端缓存有自己的合法 `:` 命名空间"）——避免两条护栏对同一形态给出相反结论。
- 伴随单测：允许（走 mint）/ 违规（`wt:` 模板、`wsl:` 前缀、`remoteCacheKey(` 调用）/ scope 外放行。
- 跨文件边界：**不**拦 `session.key` / `terminalAddress` 的合法使用；不拦测试文件。

## 8. 实现注记（落地后回写，与 §2 的偏差）

实现与 §2 草案的差异（均为收敛而非放松，代码为准）：

1. **`resolveTerminalEntry(session, tabId, paneId='p1')` 精确-only**，返回 `CacheEntry | null`
   （去掉了草案里的 `via`/隐式 fallback）——fallback 只由 `terminalRouting.foregroundTerminalTab`
   实现一处，避免两处 fallback 漂移。新增 `firstTerminalKeyOfSession` / `firstTerminalEntryOfSession`
   供写侧「无 tabId 时的 session 内首个」使用（session 前缀内枚举，跨 session 不可表达）。
2. **`switchAgentInSessionTerminal(session, tabId, agentId, overrides?)`** 取代
   `switchAgentInWslTerminal` / `switchAgentInRemoteTerminal`（二者逻辑同构，env 由 session 查表选
   backend）。`useProjectActions` 的 WSL/Remote 分支随之合一。
3. **`destroyTerminalsForProject(projectId)`**（新增，S1 审查补）：项目级关闭语义是**所有 workspace**
   （主仓 + 全部 worktree、全 env），前缀 = `WorkspaceSession.of(projectId, null).key`（`<projectId>\0`，
   由唯一 mint 投影，不在 terminalCache 重拼 NUL）。`destroyTerminalsForSession` 仍是单单元语义。
4. **`refreshTerminalEntry(key)`**（新增）：自愈路径按**精确键在三个物理 Map 中唯一命中**刷新，
   取代 `TerminalViewBase` 的 `key.startsWith('wsl:'/`'remote:'`)` 键串分派（避免组件规模回涨）。
5. **地址层不依赖 projectStore（S2 审查改）**：键在三个物理 Map 中唯一，`resolveTerminalEntry` /
   `firstTerminal*OfSession` / `destroyTerminalsFor*` / `refreshTerminalFor*` / `switchAgentInSessionTerminal`
   一律按**键/前缀跨 Map 查找**（`backendForKey`），删除了 `terminalEnvOf` 与 `useProjectStore` 导入。
   收益：寻址彻底成为 `(session, tabId, paneId)` + 模块级 Map 的纯函数；消除 R4 隐藏依赖；
   env 未知时销毁不再静默 no-op（旧的 fail-closed 会在 store 未水合时造成 PTY 泄漏）。
6. **额外删除（S1 审查未列的零消费者死代码）**：`WSLTerminalView.tsx` / `RemoteTerminalView.tsx`
   组件（仅桶文件 re-export，无渲染点）与其专属 `strategies/{local,wsl,remote}.ts`；`launchAgentInWslTerminal`
   / `launchAgentInRemoteTerminal` / `destroyWslCache` / `destroyRemoteCache` / `getWslSessionId` 等。
   随之成为死代码的 backend 面也一并删除：`executedAgentKeys`（`terminalFactory` 曾是唯一写入方）、
   `getSessionId`（曾供 `getWslSessionId`）、公开包装 `destroyTerminalCache` / `refreshTerminal`
   （已被 `destroyTerminalsFor*` / `refreshTerminalEntry` 取代）。
7. **agent 切换收敛为唯一 env-blind 能力（M1 审查改）**：新增 `terminalAgentSwitch.ts` 的
   `switchAgentInTerminal(session, tabId, agentId, overrides?)` —— 调用方不感知 local/WSL/Remote。
   内部：先把目标 agent 落到 tab 身份（`editorStore.updateTab(...) { agentId }`）→ 再交给底层
   物理切换 `switchAgentInSessionTerminal`（清该键 PTY + 触发 pane 重建；pane 依 tab.agentId 自动拉起）。
   删除了 local 专用的 imperative 路径（`terminalCommands.switchAgentInTerminal` + `launchAgentInTerminal`）
   及其唯一依赖 `terminalFactory.ts`（`createTerminalForProject` / `getAgentById` 无生产消费者）——
   「两套 agent 切换语义」消失。调用方 `useAgentActions` / `useProjectActions` 均只传
   `(session, tabId, agentId, overrides)`；`useAgentActions` 的 `terminal` 配置参数随之删除。

**未完成 / 待真机确认**：§3 的「只有当前 workspace 空间的 pane 被挂载」不变量需在 `pnpm tauri dev`
下实测（打开 worktree 终端 → 切回主仓 → 两键各自存活）；本会话无 GUI，未执行。
