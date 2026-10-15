# 领域模型：App → Project → Workspace

> **本文是领域分层术语的唯一定义处。** 其它 spec / 代码注释只引用、不复述定义
> （复述会让同一条术语在不同文件里各自漂移）。
>
> 与 `docs/ARCHITECTURE.md`（技术架构）互补：本文只回答「这些名词各指什么、谁拥有谁」。

---

## 分层

```text
App
 └ Project                                  （environment、agent/ide 配置、主仓登记路径）
      └ Workspace   kind: Main | Worktree     ← 能力容器 / 隔离与寻址单位
           ├ checkout : { path, kind, branch, HEAD }   ← 仓库信息是属性
           ├ root     : 目录（scope 基准）
           └ ide / agent / editor / debug / lsp / terminal
```

## 术语表

| 术语 | 含义 | 基数 | 归属 |
| --- | --- | --- | --- |
| **`App`** | 应用进程/窗口；持有当前打开的全部 project（`SessionStore` 持久化其集合与激活态） | 1 | 顶层 |
| **`Project`** | 用户添加的一个**逻辑产品**；属性：`environment`(Local/WSL/SSH)、agent/ide 配置、主仓登记路径 | 1..N | — |
| **`Workspace`** | Project 下的一个**独立工作空间**：承载 IDE / Agent / editor / debug / LSP / terminal 的状态；是这些功能状态的**隔离与寻址单位** | 1..N per Project | 中间层 |
| **`workspace.checkout`** | 该 workspace 对应的 git 工作副本（**属性**）：`{ path, kind: Main \| Worktree, branch, HEAD }` | 1 per Workspace | Workspace 属性 |
| **`workspace.root`** | 该 workspace 的根目录 = scope 基准 = `${workspaceFolder}` = LSP workspace root | 1 per Workspace | Workspace 属性 |

## 等价关系（跨栈契约）

- `workspace.root` ≡ DAP launch 的 `${workspaceFolder}` ≡ LSP `workspace/workspaceFolders` 的项。
- `WorkspaceKey`（TS）/ `WorkspaceRef::key()`（Rust）≡ `workspace.checkout` 的**身份**（属性，不是容器名）。
  它**保留现名不改**：改 wire 契约（`workspace_key`）零功能价值、高迁移风险。
- `WorkspaceRef` / `CheckoutPath`（`src-tauri/src/common/git/`）是 `workspace.checkout` 的引用与其路径值对象。
- LSP 的 `WorkspaceEdit` / `workspace/workspaceFolders` 是**协议名词**，与本领域对象 `Workspace`
  处于不同命名空间，二者**不冲突**；不需要（也不允许）为规避而改协议名。

## 判据：该用哪个词

| 问题 | 用 |
| --- | --- |
| 这是哪个应用/窗口？ | `App` |
| 这是哪个逻辑产品（环境、agent/ide 偏好）？ | `Project` |
| 这是哪个可独立打开/编辑/运行的工作空间？ | `Workspace` |
| 这个 workspace 对应的 git 工作副本在哪、什么分支？ | `workspace.checkout` |
| 文件读写 / cwd / 适配器 workspace 的基准目录？ | `workspace.root` |

## 不变量

1. **一个概念一个名字；属性不进容器名。** 「仓库」是 `Workspace` 的属性（`checkout`），不单独成层。
2. **功能状态的隔离边界 = `Workspace`。** editor / terminal / status / watcher 已按 `Workspace` 分槽；
   agent / debug / LSP 的目标态亦如此（当前部分仍按 `Project`，属待补缺口）。
3. **`repo = 一个完整业务逻辑` 是经验规律，不是不变量。** worktree 常对应一个 feature/branch，
   但主仓也是一个 checkout；不要把它写进类型或命名。

## 命名边界规则（判定新符号的唯一判据）

一个词只命名一类事物：

| 词 | 只允许命名 | 例 |
| --- | --- | --- |
| `Workspace` | **容器**（承载 IDE/Agent/editor/debug/LSP/terminal 的状态） | `workspaceStore` / `WorkspaceRef` / `useWorkspaceState` / `activeWorkspaceRoot` |
| `checkout` | 容器的 **git 属性**（路径 / 分支 / kind） | `Checkout` / `CheckoutPath` / `activeCheckoutPath` / `openedCheckouts` |
| `worktree` | **仅 git 原生** | `create/remove/rename_worktree`、`WorktreeList`、`isWorktreeDirty`、`canonicalWorktreePath`、linked-vs-main 类型谓词 `isActiveWorktree` |
| `RepoKey`/`repo_key` | （已退役）→ `WorkspaceKey` / `workspace_key` | — |

**勿与历史已删除符号混淆**：`activeWorktreePath` 曾是一个已删除的 store 镜像字段名；注释/历史文档里保留它是为了记录
「为什么删」，**不得**把它当当前字段用（护栏 `check_workspace_identity` 按符号拦截）。

**持久化例外**（改名需迁移，登记为不动）：`worktree_state`（sessions.json 字段）、`repo_key_prefix`（git 缓存键前缀）。

## 寻址根 vs 展示根（文件 IO + git 契约）

文件读写与 **git 命令**的**地址 = `WorkspaceSession`**（`{ projectId, worktreePath }`，`worktreePath === null` = 主 checkout）；
后端由 `AppStateWrapper::resolve_workspace_target` **唯一解析**出**寻址根**（= `workspace.root`，宿主形态）。

- **寻址根**：`workspace` 地址对象 → 后端解析（`read_file` 的 `InProject` scope、watcher/gitignore 根、git 的 `-C` 同源）。
  前端**不**传任意 root 路径（那会把同一份身份变成散参，且在 worktree 下默认值恒错）。
- **展示根**：`workspaceRootOf(workspaceKey, projectRoot)`（前端主机绝对路径），只用于路径相对化 / 同文件判定；
  与寻址根**不得**混用为同一个 `rootPath`。

**git 域（10-09 落地）**：`git/commands/**` 与 `agent/commands_commit.rs` 中**凡需表达「在哪个
Workspace」的命令**（含 branch / PR 两个子域）一律收首参 `workspace: WorkspaceSession`，内部只经
`resolve_workspace_target(&workspace)` 解析（不得直调更底层的 `resolve_workspace(&str, Option<&str>)`
—— 后者是 DAP / watcher 等域仍在用的内部实现）。
无需地址的命令（`create/remove/rename_worktree`、`is_worktree_dirty`：`worktree_path` 是被操作的**目标**；
`is_git_repo` / `canonical_worktree_path` / `is_gh_*` / `get_remote_home_dir` / `cancel_git_sync`：
只需 project 环境或 run id）仍用各自参数，逐个登记于
`.trellis/spec/backend/git-domain.md`「git 命令寻址契约」。

**search 域（本次落地）**：`search_run` 同样收首参 `workspace: WorkspaceSession`，根 = `WorkspaceRef::root()`。
此前它只收 `project_id` 并直取 `project.path` ⇒ 三重基准错位：worktree 视图**扫主仓**；结果路径相对
**项目根**而点击打开时相对**单元根**（`openFile.ts`）⇒ 点开错文件；同一结果列表里文件名匹配（走
`fileStore`，已按单元）与内容匹配（走项目根）**两种基准**。`SearchPage.project_id` 仍保留但降为
**元数据**（前端不参与寻址）。前端同理：`activeWorkspaceSession` / `useActiveWorkspaceSession` 派生地址，
`SearchPanel` 内点击打开与搜索根**同源**。

**编辑 tab 组键 = checkout 的身份 `WorkspaceKey`**（唯一编码；`:wt:` 已退役）。

**editor tab 已按 `Workspace` 隔离**（10-10 落地）：`Tab` 携带 `TabScope`（`{ workspace, session }` |
`{ app }`），身份是 `WorkspaceSession` 值对象而非裸 `projectId`；store 键由 `tabSpaceKeyOf(tab.scope)`
推导（构造律，调用方无权指定）。键的散件拼装/反解函数（`workspaceKeyOf` / `parseWorkspaceKey`）已退役，
唯一铸造点是 `WorkspaceSession#key`（≡ Rust `WorkspaceRef::key()`）。

**terminal 插入链路 = 地址由 `WorkspaceSession` 派生**（10-12 落地）：terminal 域唯一的地址铸造点是
`terminalAddress(session, tabId, paneId)`（10-13 S4 起落 `src/features/terminal/components/terminalAddress.ts`，
`terminalCache.ts` 只消费不再铸造），
物理键 = `session.key` + `TERMINAL_KEY_SEP` + `tabId` + SEP + `paneId`。**env（local / wsl / remote）
不进键** —— 物理 Map 三分是存储/传输归属；键在三个 Map 间**唯一**，地址层按键/前缀直接命中，
**不读 projectStore**（无 env 查表、无 env 缺失 fail-closed；见 10-12 实现注记）；
旧的手搓 `wt:` / `wsl:` / `remote:` 键与 `terminalCacheKey` / `findSessionIdForProject` / 前缀销毁
`destroy*CachesByPrefix` 已退役（护栏 `check_terminal_key_mint` 防回潮）。其他模块不得从 terminal key
反解身份：分量解析走 `decodeTerminalKey`，日志/提示走 `terminalKeyLabel`。

**「该往哪个 tab 插」= 全仓只有一处答案**（10-13 落地）：`terminalRouting.foregroundTerminalTab(session)`
是唯一的 foreground 仲裁入口，口径 = **tab `order` 升序**（前台终端置顶），无前台终端则落同 session
首个终端（`isFallback: true`，由调用方 toast 告知实际落点）；session 内一个终端都没有 → `null`（显式失败）。
**禁跨 session**（`tabs` 的键就是 `session.key`，跨单元串写在构造上不可表达）。

需要「某一类 tab」（Agent CLI 终端 / agent-chat composer）时，**在同一有序序列上 filter**
（`foregroundAgentCliTab`），不自带 `sort`、不取 `tabs[0]`、不依赖 Map 插入顺序。历史病根：同一问题
曾有 7 个答案（order 升序 / order 降序 / 数组顺序 / **Map 插入顺序**），导致「插入落哪个 tab」与
「刷新 / 切 agent 落哪个 PTY」不同解。`firstTerminalKeyOfSession` / `firstTerminalEntryOfSession`
（Map 插入顺序那条）已**整体删除**而非降为私有；`sendToTerminal` / `refreshTerminalForSession` /
`switchAgentInSessionTerminal` 的 `tabId` 改**必填**（可选性对现有调用方在 TS 上完全合法、编译期无声，
却会让「缺省取首个」复活 —— 所以除类型外另有护栏）。护栏
`tools/guards/checks/check_terminal_foreground_arbitration.py`（A1 口径唯一 + 台账、A2 第二口径退出、
A3 tabId 必填不回退、A4 声明的 DOM 事件必须有消费点）。

**agent 投递目标 = 身份注册表，不是 DOM 广播**（10-13 落地，决议 Q1/Q5）：投递链路的正确形态由
「发送方能否知道结果」决定 —— `dispatchEvent(CustomEvent)` 的返回值只表示「有无 preventDefault」，
**不表示有无接收者**，因此旧的 `INSERT_TO_AGENT_INPUT_EVENT`（三个派发点、全历史零个监听者，见
`git log --all -S"addEventListener(INSERT_TO_AGENT_INPUT_EVENT"` → 0 条）是机制性不可达，已**删除常量**。
现由 `src/features/agent-chat/api/agentInputRegistry.ts` 承接：`Map<session.key, Map<tabId, {handler, count}>>`
（外层键直接是 `WorkspaceKey` 投影，**不拼第二个键命名空间**，因此无需反解 —— 红线 12 自然成立），
引用计数与 `editor/api/aiActionRegistry.ts` / `editorViews.ts` 同构。投递优先级：
**agent-chat composer → Agent CLI 终端 tab → 显式 false**；返回 false 时调用方降级 clipboard + toast。
**「焦点在文本元素」不能用来区分 agent composer 与终端**：xterm 的输入载体本身就是
`<textarea class="xterm-helper-textarea">`，所以旧的 `isTextInputElement` 启发式在终端聚焦时恒为 true，
使两端都静默失效；该判据已删除，投递目标一律由身份仲裁给出。

**terminal / task 运行根（cwd）= 由 Workspace 身份派生**（10-12 落地）：进程启动的 cwd 是 Workspace 的
纯函数 `cwd(session) = session.worktreePath ?? project.path ≡ WorkspaceRef::root()`。`create_terminal_session`
首参收 `workspace: WorkspaceSession`，后端唯一经 `resolve_workspace_target` 解析出 `repo.root()` 作缺省；
Local/WSL/Remote 三环境承接同一 `cwd`（环境是传输维度），项目级产物（主题）另收 `workspace_root`；
可选的 `working_dir` 覆盖须落在根之内（越界 → `InvalidInput`）。前端不再自算终端 cwd（任务侧经
`workspaceRootOf` 唯一 mint）。任务配置**存储**口径仍为项目根（`<project>/.neeko/tasks.json`），仅
发现/展示/执行路径 Workspace 化。契约与判据：`.trellis/spec/backend/git-domain.md` §15.3、护栏
`check_terminal_run_root`。

## git 冲突读路径（三态寻址 + 区域）

冲突文件不属于单文件 diff 的三种合法形态（干净 / 有改动 / 未跟踪），它的真值是 **index 的
unmerged stages（1/2/3）**，不是工作区里的 `<<<<<<<` marker 字节。marker 是合并尝试的**渲染
产物**：modify/delete、binary、rename/rename 三类根本没有 marker，rename/rename 的三侧连路径
都不同 —— 任何「读工作区找 marker」的实现都会在这些类型上静默失真。因此冲突视图的入口是
`DiffRevision` 的 `{ type: 'conflict' }` 变体（修订维度天然容纳「对 index unmerged 状态做 diff」），
读命令 `get_conflict_stages(workspace, file_path)` 只从 stages 组装 `ConflictStages`。

| 概念 | 含义 | 归属 |
| --- | --- | --- |
| `ConflictKind` | 冲突类型（`both_modified` / `both_added` / `modify_delete` / `rename_rename` / `binary`），由 **stage 存在性 + 路径是否分歧 + binary** 纯函数判定 | `common/git/conflict/classify.rs` |
| `ConflictSide.content` | `Option<String>`：`null` = **该 stage 不存在**（合法状态）；`''` = 该侧确实是空文件 | `types.rs` |
| `ConflictStages.regions` | 仅 `both_modified` / `both_added` 有值（`is_region_mergeable()`） | `regions.rs` |
| `ConflictStages.region_mergeable` | = `kind.is_region_mergeable()`，在**唯一构造点**派生一次并上 wire；前端只消费不重算 | `probe::assemble_stages` |

**`is_region_mergeable()` 只对 `both_modified` / `both_added` 为真**。这不是实现能力限制，而是
决议语义：`modify_delete` 的一侧内容是「这个文件不存在」，对它做区域合并后选「删除侧」只能写出
一个**空文件**，而用户的意图是**删除** —— 空文件 ≠ 删除。故 modify/delete 只给整文件二选一。

**`null` ≠ 空串**：「我方已删除」必须渲染成 `null`（stage 缺失），不得 `unwrap_or_default()` /
`?? ''` 归一为空文件 —— 那会把删除语义画成「空文件」并丢掉决议依据。

`ConflictStages` 的唯一构造点是 `probe::assemble_stages`（**领域算法不按 transport 各写一份** ——
跨实现重复就是分叉温床），唯一对外出口在 `common/git/operations/conflict.rs` 派发缝，且必须过
`cap_conflict_payload`（红线 4：三元载荷），`local.rs` / `shell.rs` 的内部组装在封顶上游。
护栏 `check_conflict_read_contract`（A1–A6）钉住这些不变量（A5：`conflict/**` 的字符串字面量内无
`/dev/null` —— POSIX 设备名在 Windows CI 上不存在，空 blob 一律用 `--stdin` 喂零字节；A6：传输实现
不得自建 `ConflictStages` 字面量，必须经 `probe::assemble_stages`）。

## git 冲突决议（写回）

冲突决议（区域 Ours/Theirs/Both 或整文件二选一）由
`apply_conflict_resolution`（`common/git/operations/conflict.rs`）+ 命令
`resolve_conflict(workspace, file_path, resolution)` 落盘。三条原语：`write_text`（区域 splice 产物）、
`checkout_side`（采用存在侧，`git checkout --ours|--theirs` + `git add`，字节保真含 binary）、
`delete_path`（`git rm`）。

- **分派判据 = 该侧 stage 是否存在**（`side_of(take).is_some()`），不是 `ConflictSide.content` 是否存在：
  `content` 是读 API 的**解码视图**（binary 为 `None`、超预算被截断），用它会误删 binary 或写坏截断文件。
- **成功判据 = 该 path 退出 unmerged set**（`git ls-files -u` 为空），与实现细节无关。
- 区域 splice 以服务端重读的 `merged` 为准；**区域决议是全函数**（未知 / 缺失 / 重复 id 显式拒绝，不产出含 marker 却被 `git add` 标为已解决的文件）；`Regions` 对不可区域合并的 kind / 截断载荷**显式报错**。
- **rename/rename 决议 = 显式非目标**（三侧路径不同，单条决议无法闭合整组）。
- 写后调 `wait_status_fresh`；前端由 `git-status-snapshot` 驱动收敛回普通 diff（`notConflicted`，非错误态）。

机制详解与单测口径：`.trellis/spec/backend/git-domain.md` §5d。

## 未完成（登记）

- **分屏 p2+ 的终端精度（登记为显式非目标）**：写侧 `terminalAddress(session, tabId, paneId)` 携带
  paneId，而读侧（`resolveTerminalEntry` / `switchAgentInSessionTerminal` / `refreshTerminalForSession`）
  一律缺省 `'p1'` ⇒ 分屏后切 agent 只清 p1 的 PTY，**p2 内旧 agent 进程继续跑**（一个 tab 两个 agent）。
  后果与正解（`SplitLayout.activePaneId` → tab 身份）见
  `.trellis/tasks/10-13-agent-insert-addressing-arbitration/design.md` §4。
- 若某子系统的状态键仍是 `Project`（如 debug 活动会话、LSP 会话根），它尚未达到「按 `Workspace` 隔离」——
  这是能力边界缺口，与命名无关。**editor tab 已补上**（见上：`TabScope` + `WorkspaceSession`）。
- 命名迁移（`App → Project → Workspace`、`RepoKey`→`WorkspaceKey`、`RepoRef`→`WorkspaceRef`、
  `repo_key`→`workspace_key` 等）已在本任务全部落地；完整映射见
  `.trellis/tasks/10-08-workspace-naming/design.md` 的 Tier 表。
- **刻意保留**：`repo_key_prefix`（git 缓存键前缀，非单元身份）、LSP `WorkspaceEdit` /
  `${workspaceFolder}`（协议/外部约定名）。
