# 技术设计：LSP 失败诊断归属重构

> 任务：`.trellis/tasks/10-10-lsp-failure-diagnostics-ownership`
> 目标：**不再让「启动失败」这一事实与其原因分离**。本文件从第一性原理推导结构，
> 不从「最小改动」倒推。

---

## 0. 第一性原理：两条被违反的原则

### P1（归属原则）诊断证据的宿主必须是「必有」的身份键，不能是「成功后才有」的对象

形式化：设 `K` = 会话身份键 `(project_path, language_id)`，`S` = 进程对象。
`S` 的存在性是 `K` 的**子集**（可能从未诞生）。诊断证据的价值在 `¬S` 时达到最大。
若证据宿主取 `S`，则「证据可得」与「证据最需要」两个集合**不相交** —— 这是结构性矛盾，
不是实现疏漏。

**推论 P1a**：失败原因必须**随错误内联**（短证据），因为错误是唯一必然送达调用方的东西。
**推论 P1b**：长证据（可达 10MB 的 stderr）必须**按键可查询**（不能内联，见红线 4）。
二者互补，缺一即失败不可解释。

### P2（环境一致性原则）判据与消费点必须在同一环境、同一语义下执行

形式化：判据回答的问题必须与消费点提出的问题**同义**。
`presence(bin) ∈ PATH` ≠ `runnable(bin, target, cwd=workspace_root, env)`。

**推论 P2a**：探测与启动必须共享同一个**执行上下文**（target + cwd + env）；「不带 cwd 的探测」应**不可表达**。
**推论 P2b**：判据的失败是一等信号，必须进入诊断通道（P1），不得降级为「未知元数据」。

---

## 1. 证据：两条原则的三个表现 + 两处既有正例

### 1.1 违反 P1 的三处

| # | 位置 | 违反形态 |
|---|---|---|
| V1 | `instance.rs:57` + `:190` | `log_buffer` 是 `LspSession` 字段、在 `new()` 内创建；`manager.rs:577` 仅在 `build` 成功后 `insert` → **证据随失败蒸发** |
| V2 | `instance.rs:439` | 握手失败文案 = `"LSP initialization: no response received"` —— 传输层**症状**，把已采集的真因（`instance.rs:226` 泵入的 stderr）留在不可达缓冲里 |
| V3 | `lifecycle.rs:117` | `crash_message()` = `"{server} exited unexpectedly"` —— 崩溃文案**主动丢弃** stderr |

### 1.2 违反 P2 的三处

| # | 位置 | 违反形态 |
|---|---|---|
| V4 | `installer.rs:96` → `core/exec.rs` → `exec_env.rs:68` `command_exists_on_path` | 「已安装」判据 = PATH 存在性。`~/.cargo/bin/rust-analyzer` 是 rustup 代理 → 恒真 → **自动安装被跳过** |
| V5 | `instance.rs:139-157` → `process.rs:630` `run_command_blocking`（**签名无 cwd/env**，`process.rs:561` 用 `core::exec::spawn` 三参形态） | version 探测在**应用默认 cwd** 执行：实测绿灯 `rust-analyzer 1.99.0`，而真实启动（cwd = 项目根）必失败 |
| V6 | `instance.rs:143` `Ok((_code, ...))` + `Err(e) => LspServerInfo::unknown()` | 探测的**退出码被丢弃**、失败被静默降级为「未知元数据」→ 判据失效且无痕 |

> V4 与 V5 是同一缺陷的两个实例，且**互相掩护**：探测在错误环境拿到绿灯，
> 反证了「存在性判据」的结论，于是自动安装连触发的机会都没有。

### 1.3 既有正例（原则在仓库中已存在，只是未覆盖 LSP）

| 正例 | 位置 | 说明 |
|---|---|---|
| 证据内联（P1a） | `dap/session.rs:238-247` | `Err(AppError::Dap(format!("{base} | adapter stderr: {detail}")))` —— DAP 已在做，LSP 没做 |
| 键控投影状态（P1） | `manager.rs:121` `profiles: HashMap<String, ProjectLanguageProfile>`、`:869-879` 生成计数器 | 已按 `project_path` 承载跨会话状态；**日志是唯一的例外** |
| 装配前先取通道（P1a） | `session_factory.rs` 注释 | 「装配失败时 manager 仍需要一条通道把 error 送到前端」—— 同一道理对 transport 做了，对日志漏了 |
| 形态判据而非语言判据 | `lsp-domain.md` §6 | `code` 形态（数字 vs 字符串）决定展示策略，不看 `languageId` —— §6.3 采用同一手法 |

---

## 2. 目标结构

### 2.1 P1 → 键控诊断存储（与 `profiles` 平级，不挂在会话上）

新文件 `src-tauri/src/lsp/attempt_diagnostics.rs`（同级，`mod.rs` 只加 `mod` + `pub use`，红线 9）：

```rust
/// 一次「启动尝试」的诊断记录（= 一个**生代**）。与进程生命周期**无关**：锚定会话身份键。
/// 键的类型是 `String`（非 LSP 类型）→ 将来可整体提升到 `common/`（见 §8）。
#[derive(Debug)]
pub(crate) struct AttemptDiagnostics {
    /// 本条目所属的项目路径：驱逐按它**精确匹配**（不经键字符串前缀，路径含 `:` 也不误伤）。
    project_path: String,
    /// 有界 stderr 环（复用既有 `LogRingBuffer`，10MB 上限）。
    log: Arc<Mutex<LogRingBuffer>>,
    /// 本次尝试的终态（`None` = 尝试仍在进行中）。
    outcome: Mutex<Option<LspAttemptOutcome>>,
}

impl AttemptDiagnostics {
    // 写路径**只走句柄**（该次尝试的全部参与者各持一份 `Arc`，见下方「生代隔离」）：
    fn push_log(&self, entry: LspServerLogEntry);
    fn record_failure(&self, message: &str); // 同时把 message 追加进 log（消息与日志同源）
    fn record_success(&self);
    fn tail_inline(&self, max_bytes: usize) -> Option<String>; // 内联证据唯一读取点，上限必填
}

/// 按身份键承载诊断证据的注册表。**语义上与 `session_store` 正交**：
/// `session_store` 管「活着的进程」，本 store 管「发生过什么」。
pub(crate) struct AttemptDiagnosticsStore {
    entries: Mutex<HashMap<String, Arc<AttemptDiagnostics>>>,
}
```

终态记录类型（定义落点：**`types.rs`** —— IPC 类型单一来源，`LspServerInfo` 要引用它，
避免两文件互引）：

```rust
/// 终态记录：失败原因**已内联证据尾部**（P1a）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspAttemptOutcome {
    /// 与 `LspSessionStatus::as_str()` 同词表：`ready` | `error`。
    pub status: String,
    /// 失败原因（含 stderr 尾部 / 插件安装提示）。
    pub message: Option<String>,
    /// ISO-8601，最近一次尝试的终态时刻。
    pub finished_at: String,
}
```

API（最小面）：

| 方法 | 语义 |
|---|---|
| `begin(&self, key, project_path) -> Arc<AttemptDiagnostics>` | **新一次尝试**：**铸造新条目**（新 `Arc`，不是原地清空），装入 map 并返回句柄。唯一创建键的入口；有界性由「一键一条」保证 |
| `with(&self, key, f) -> Option<R>` | 读路径唯一入口：取句柄快照后**松开 map 锁**再执行 `f`（10MB 环路快照不占 map 锁）；键不存在 → `None`，不创建 |
| `evict_project(&self, project_path)` | 确定性驱逐（§4）：按条目自持的 `project_path` 精确相等匹配 |

**写入不经 store、只经句柄**：`begin` 返回的 `Arc` 交给该次尝试的全部参与者
（instance / stderr 泵 / reader / manager 的 Err 分支）。三条不变量由结构保证，不靠调用方守规矩：

1. **生代隔离**：迟到写入（旧会话的泵 / 旧 reader）落进孤儿 `Arc` —— 不混进新一次尝试（AC7），
   被驱逐的键**不可能被复活**（AC8）；
2. **驱逐无前缀歧义**：`project_path` 精确匹配，路径含 `:` 也不误伤（键拼接只用于查表）；
3. **锁分层**：map 锁只覆盖查 / 插 / 摘；环快照在条目锁下进行。

> 读侧允许读到「上一代」（读取与 `begin` 之间发生生代切换）—— 读是提示性的，可接受。
> 术语：**一次尝试 = 一个条目（生代）**，`begin` 是唯一的生代切换点。

**写入点矩阵（覆盖 R2 全部失败模式；这是本设计的核心不变量）**

「终态」= 句柄上的 `record_failure` / `record_success`；「证据」= 泵与写者往 `log` 的写入。

| 失败模式 | 证据来源 | 终态单写者 | log 证据 |
|---|---|---|---|
| ① 插件未注册 | `AppError::Lsp("No LSP plugin registered …")` | manager（`begin` 之后） | manager（message 同源入 log） |
| ② `ExecTarget` 缺失 | `require_project_exec_target` 的 `Err` | manager | manager |
| ③ `AppHandle` 缺失 | `session_factory.transport` 的 `Err` | manager | manager |
| ④ `spawn` 直接失败 | `spawn_lsp_process` 的 `Err`（无子进程、**无 stderr**） | manager（合成条目 = message 本身） | manager（`record_failure` 同时写 log） |
| ⑤ 子进程启动后立即退出 | reader 线程 EOF + stderr 泵 | reader 线程（用它捕获的同一句柄） | stderr 泵 |
| ⑥ 握手返回错误 / 无响应 | `parse_initialize_response` / `blocking_recv` 的 `Err` + 泵已采集的 stderr | manager（文案由 instance 合成并内联 tail） | stderr 泵 |

> 模式 ④ 是本设计**最容易漏**的一格：没有子进程就没有 stderr，必须由 manager 用 message
> **合成**一条 error 记录（`record_failure` 同时写 outcome 与 log）。若只做 stderr 泵，
> 则「二进制完全不存在」这一类仍然无法自我解释 —— 等于换个地方重犯 V1。

**实施期发现（2026-10-11，已补修）：mode ⑤/⑥ 的真实形态是「永久挂死」而非报错**

`LspSession::new` 的 `init_rx.blocking_recv()` 等的是 `pending` map 里的 oneshot sender；
「子进程秒退」时 sender 仍被**调用方的本地 `pending` Arc** 持有 → `blocking_recv` 永不返回
（实验证实：兄弟 `Arc` 克隆释放不影响 recv，sender 存活即永久阻塞）。也就是说 V2 的
「no response received」在补修前**不可达**：会话创建卡死，证据与原因都没有机会产生。

补修（两条互补，关闭全部时序窗口）：

1. reader 线程出口（含 panic 分支）`drain_pending(pending_clone)`：摘除全部在途发送端；
2. 插入 `init_tx` 之后、`blocking_recv` 之前检查 `reader_handle.is_finished()`，
   已完成则再 drain 一次（`await_init_response`）。

于是握手以「无响应」快速失败 → 走既定的 kill → join 泵 → 读 `tail_inline` → 内联证据路径。
这同时让稳态下 reader 崩溃时的在途请求快速失败，而不是挂到会话销毁。

**单写者与 `begin` 落点（防双写、防误重置）**

- **终态单写者**：装配期失败（①②③④⑥）由 manager 在 `build` 的 `Err` 分支用**本次尝试的句柄**
  单写；运行期崩溃（⑤）由 reader 线程用它捕获的同一句柄单写。session 内部只写 `log` 证据，
  **不**重复写终态（两处都写会让同一条消息进 log 两次、outcome 被覆盖）。
- **`begin` 只允许出现在慢路径**：fast path（`is_alive` 命中）与并发输家的二次 recheck
  **都不得**切换生代，否则每一次 hover / didOpen / didChange 都会清空日志
  （`ensure_session_async` 在每条命令上都先调它）——「成功：全部 stderr」（§3.2）当场失效。
  精确落点：`gate.lock()` + 二次 recheck 之后、`resolve_by_language` 之前（既覆盖模式①，
  又不误伤 fast path）。

**终态文案与内联证据（P1a 的落实方式）**

- **上限**：`tail_inline(max_bytes)` 是内联证据的唯一读取点，上限必填（建议默认 2KB 或最后 N 行）。
  不做上限 = 10MB 环进 `LspSessionInfo.status_message` / `AppError` 文案，直接触碰红线 4。
- **时序**：stderr 泵与 reader 退出是并行线程，失败文案的合成**不得与泵赛跑**。契约：合成前先
  确保泵已终止 —— 子进程先 `kill()`（既有 `kill_tree` 保证进程组清理），再 `join` 泵线程
  （EOF 必然到达），然后读 `tail_inline`。AC3 的确定性断言依赖此顺序。
- **capture-at-transition（写者一次合成，读者只投影）**：`crash_message(server_name, tail)` 是
  崩溃文案的唯一构造函数；**进入终态的写者**（reader 线程 / 握手失败路径）调用它，并把结果
  **存入 lifecycle**；事件与快照都投影同一份字符串 —— 读者不得各自重建（那会让两者在泵的
  竞态窗口内拼出不同文案）。`Lifecycle` 因此不必访问环，依赖方向保持 session → lifecycle。

### 2.2 P2 → 单一执行上下文 + 类型级消除错误环境

新文件 `src-tauri/src/lsp/spawn_spec.rs`（文件名沿用，类型名以语义为准）：

```rust
/// 「在哪执行」：一次 LSP 动作（探测 / 启动 / 安装）共用的执行环境。
/// 只要拿到它，「在什么环境里执行」就不再有第二个答案（P2a）。
pub(crate) struct LspExecContext {
    pub target: ExecTarget,
    pub cwd: String,          // = workspace_root，**必有**
    pub env: Vec<(String, String)>,
}
```

「执行什么」（命令与 argv）是**动作的数据**，与上下文分离：
`probe(ctx, cmd, args, timeout)` / `spawn(ctx, cmd, args)` / `run_streaming(ctx, cmd, args, on_line)`。
理由：探测要 `args_override`、安装命令的 cmd/args 与服务器完全不同 —— 若把 cmd/args 揉进
上下文，这两处都会退化成「拿同一个值再改」。非表达性目标只关于**环境**：签名要求
`&LspExecContext` 后，「不带 cwd 的探测」在类型层面不可表达 —— 用类型消除可能性，
而不是加一条容易被忽略的护栏（与仓库口味一致：能编译期 dispatch 就不运行期判断）。

`process.rs` 内部仍走 `core::exec`（红线 1）；`cwd`/`env` 经 `SpawnOptions::with_current_dir_if` /
`with_env` 落到既有 `spawn_with`（`process.rs:297-345` 已是正例，探测函数只是补齐同一上下文）。

**探测失败的形态判据（P2b + 红线 15；不按语言分支；方案 A「分形」，已确认）**

第一性原理：探测只负责回答「在这个环境里这个命令能不能应答」，**不是**第二道启动门禁。
判据按「是否根本执行不了」分形：不可执行 = 硬失败（不白跑一次 spawn）；执行了但拒绝应答
= 记证据、继续启动，由真实 spawn + 握手兜底（事故场景里子进程本来就立即退出，失败同样快，
且证据就是同一份 stderr）。

| 探测结果形态 | 归类 | 处置 |
|---|---|---|
| `Err`（无法启动：ENOENT / EACCES / target 不可达） | 该环境下**不可运行**（真实启动会以同一错误失败，不必白跑） | 记入诊断（含内联 tail 若有）；**直接失败**，失败消息附插件 `install` 数据的提示 |
| `Ok(code≠0)` 且 stderr 非空 | **可执行但拒绝应答**（= 本项目 rustup 代理形态） | 记入诊断（stderr 即真因）并**内联进失败消息**；**继续启动**，由 spawn + 握手兜底 |
| `Ok(code≠0)` 且 stderr 为空 | `--version` 语义不被支持（弱信号） | 仅记录，**不**判定任何失败 |
| 超时 | 慢启动 / `--version` 挂起（弱信号） | 仅记录，**不**判定任何失败 |
| `Ok(0)` | 正常 | 解析元数据（保留既有 `parse_server_version_output`） |

> 决策记录（2026-10-11）：经任务方确认采用分形方案。为什么不是「非零 + stderr 直接拒绝
> 启动」：那会把「不支持 `--version`、usage 打到 stderr」的服务器从「今天能起」变成「被拒」；
> 分形方案下这类误杀**不可达**（拒绝只发生在执行不了）。`tuning.version_probe=false` 仍然
> 可用，但它现在只是元数据取舍（跳过探测），不再是拒绝开关。判据是**形态**的，因此
> 新增语言服务器零逻辑改动（`lsp-domain.md` 语言差异表不动）。

**判据与自安装触发的关系（R4 的取舍）**

`check_plugin_installed`（PATH 存在性）**保留为自安装的触发门控**（回答「需不需要装」）；
probe（同一 `LspExecContext`）回答「在该项目环境里能不能应答」（诊断 + 内联证据 + 对 `Err`
硬失败）。即 R4 走「或其失败能被诊断通道解释」这一支：rustup 代理形态（PATH 有、
toolchain 无组件）不自动重装，但原因可达、修法可见（失败消息附插件 `install` 提示）。
不把门控改成 probe 的理由：`version_probe=false` 的插件（如 jdtls）不会被探测，改成 probe
触发会让安装语义依赖探测意愿，且把「存在但不可执行」误判为「未安装」。将来若要切换，
需给插件数据加显式字段，不在本任务。

**接缝与可测性（AC1b / AC5 的落点）**

三层，各层可独立测试、均不依赖 `tauri::AppHandle`（测试环境无法常驻，见
`session_factory.rs` 模块注释）：

| 层 | 落点 | 职责 |
|---|---|---|
| 采集 | `process.rs` `probe(ctx, cmd, args, timeout) -> CommandRun` | 只运行、只回填 `exit_code/stdout/stderr`；不做判据、不记账 |
| 判据 | `process.rs` 纯函数 `classify_probe_run(&CommandRun) -> ProbeVerdict` | 形态表分流；无 LSP / 无 AppHandle 依赖 |
| 记账 | `attempt_diagnostics.rs` 句柄方法 `record_failure(message)` | 只落账（同时写 log）；message 由**失败写者**用判据证据 + `install` 提示合成后传入 |

AC1b（stderr 行进证据）与 AC5（判定语义）用 `tempdir()` 脚本在这三层组合测试；
AC4 只在采集层（脚本输出 `pwd` 断言等于 ctx 的 `cwd`）。

---

## 3. 契约

### 3.1 IPC（向后兼容，只增不改语义）

| 命令 | 变更 | 兼容性 |
|---|---|---|
| `lsp_get_server_logs(projectPath, languageId, limit)` | **不再因缺会话返回 `Err`**：未尝试 → 空数组；失败过 → 该次证据 | 返回类型不变；`Err` 分支消失 = 调用点更简单 |
| `lsp_get_server_info(projectPath, languageId)` | **不再因缺会话返回 `Err`**；新增 `outcome: Option<LspAttemptOutcome>`（`#[serde(default)]`） | 加字段；前端 `types.ts` 同步为可选字段 |

**`AppError::Lsp("No LSP session for: …")` 从读路径彻底消失**（`manager.rs:1012` 与 `:1030` 两处）。
该文案保留给**写路径**（对未登记会话发 `didOpen` / 请求）—— 那里它语义正确。

### 3.2 失败矩阵（前端可见行为）

| 场景 | 状态栏 chip | View logs | 子菜单信息 |
|---|---|---|---|
| 未尝试 | 不渲染 | 空（既有「(no log output yet)」） | unknown |
| 尝试中 | `starting` / `initializing` | 实时 stderr | 元数据（若有） |
| 成功 | `ready` | 全部 stderr | 版本 / commit / 内存 |
| **失败（V1 现场）** | `error` + **真因** | **stderr 真因** | `outcome.message` |

> chip 的 `error` 态来自事件路径（`emit_session_error`）；`list_sessions` 只投影活会话，
> 项目切换重同步后「无会话但失败过」的键不会回到 chip。本任务只承诺 **View logs 与子菜单
> 信息**（`outcome.message`）在任何时候可达 —— 不把失败尝试塞进 `list_sessions`
> （那会重演备选 A 的语义污染；合并方案见 §6 G）。

### 3.3 前端最小改动

- `src/features/lsp/types.ts`：`LspServerInfo` 加 `outcome?: LspAttemptOutcome`。
- `src/features/status-bar/lspStatusFormat.ts` `formatInfoFooter`（纯函数，单一展示点）：
  失败态且有 `outcome.message` 时优先展示真因（而非「Error — v? — —」）；
  `useLspStatusMenus.ts` 只负责取数，不再新增展示分支。
- `src/shared/store/taskStore.ts:648`：`[Failed to load LSP logs: …]` 分支保留为**兜底**
  （真出现即说明契约被破，应可告警），但正常路径下不再触发。
- **不新增控件、不改入口可见性**：「View logs」在 `error` 态必须可用且打出原因 —— 这正是本任务的目标。

---

## 4. 生命周期、界与驱逐

| 事件 | 诊断记录 |
|---|---|
| 新一次尝试（`get_or_create_session` 慢路径） | `begin(key, project_path)` **铸造新条目**（新 `Arc`，旧代句柄写入从此不可见 —— 不混两次运行的输出） |
| 尝试成功 / 失败 | 写 `outcome`，`log` 保留 |
| `close_session`（用户停止服务器） | **保留**（用户可能正想看它为什么崩）；会话落 `Stopped` 终态（`lifecycle.close()`），诊断与日志不删 |
| 项目关闭 / 移除 | `evict_project(project_path)` —— **与 `profiles.remove(project_path)`（`manager.rs:857`）同一调用点**，单点驱逐 |
| 应用退出 | 进程结束，无需处理 |

**界**：单键 `LOG_RING_MAX_BYTES`（10MB，既有不变）× 键数；内联 tail 另有独立上限（§2.1）。
键数 = `begin` 次数（只在慢路径发生）− 驱逐数，由「用户触碰过的 (项目, 语言) 对」上界；
**迟到写入不能复活被驱逐的键**（生代隔离，§2.1）。有界且可解释，AC8 要求对此有断言。

---

## 5. 触发根因收敛（R6）

`rust-toolchain.toml` 自述为「Rust 工具链的唯一定义点」。当前 `components = ["clippy",
"rustfmt", "llvm-tools-preview"]` —— **未声明该项目自身 LSP 消费点所需的 `rust-analyzer`**。
「唯一来源」未覆盖消费点，这是配置层的不自洽（P2 在配置层的同构：声明与消费不一致）。

修法（**不是**绕过）：`components` 追加 `rust-analyzer`，并追加一行注释说明
「LSP 消费点要求该组件随 toolchain 一并安装」。本机已有 toolchain 需
`rustup component add rust-analyzer --toolchain 1.99.0-aarch64-apple-darwin` 补齐
（**已有** toolchain 的机器不会因声明自动补装组件；新装机 / 首次由 `rust-toolchain.toml`
触发的安装会自动带上）。

> 此项**不替代** §2 —— 它修掉本次触发源，§2 修掉「同类失败在任何环境下都能自我解释」。
> 两者都要；只有前者就是「修完这台机器，下一个人照样瞎」。

---

## 6. 备选方案与否决理由

| 备选 | 否决理由 |
|---|---|
| **A. 把失败的会话也 `insert` 进 `session_store`**（占位对象） | 让 `session_store` 同时容纳「活会话」与「死会话」→ `is_alive` / `list_sessions` / `close_session` / `reopen_documents` 全部要区分两种语义，错误状态渗进所有既有消费点。根因是「证据挂错宿主」，不是「会话没建」；用 A 是拿全局语义污染换局部方便 |
| **B. 只把 stderr 内联进错误（照抄 DAP），不建键控存储** | stderr 环上限 10MB，内联触碰红线 4（IPC ≤2MB）；且用户诉求是「失败时**查看日志**」= 查询式读取。内联是必要（P1a）但不充分（P1b）。DAP 是短证据的快失败路径，LSP 需要长证据 |
| **C. 前端兜底：捕获错误后展示 `statusMessage`** | 把「证据丢失」推给展示层：后端仍旧丢证据，而 `String(e)` 里根本没有原因可展示 —— 这就是事故现场的思维 |
| **D. 探测时注入 `RUSTUP_TOOLCHAIN` / `PATH` 修补** | rustup 专属知识硬编码进通用模块，违反红线 15；且掩盖根因（P2），下一个版本管理器（fnm / asdf / volta）会重犯 |
| **E. 把 `AttemptDiagnosticsStore` 直接放进 `common/`** | 单一消费点时的抽象是投机，且让 diff 触及无关域（YAGNI）。§8 给出结构预留与晋升条件 |
| **F. View logs 直接读应用日志（按 key 过滤）** | 应用日志无键、无界、格式不受控；证据必须按身份锚定且可界定 |
| **G. 合并 `session_store` 与诊断为 per-key cell（`KeyState`）** | 语义上更「单一」，但 diff 面巨大、锁粒度退化，且与 `10-07` 有交界 —— **暂缓**，触发条件并入 §8 |

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `begin()` 生代切换与「保留上次失败原因」冲突（用户可能想看上上次） | 明确取舍：**看最近一次**是对齐「View logs = 看这次为什么没起来」。历史留痕交给应用日志（`log::warn!` 已写） |
| 探测判定「前置失败」过强，导致误杀 | 方案 A 分形：拒绝只发生在 `Err`（执行不了 —— 真实启动必以同一错误失败，不误杀）；「非零 + stderr」仅记账并继续启动；超时 / 无 stderr 一律不判定 |
| `instance.rs` 存量已胖（`lsp-domain.md` F-台账：`instance.rs` 1365 行、已知豁免不扩范围） | 目标净行数不增：删 dead `snapshot_logs`（`:617`）与自建缓冲作对冲；AC3 的 tail 传参属必要增量，若仍净增须在同一提交更新 F-台账该行 |
| 失败消息内联 tail 与 stderr 泵赛跑（快速退出恰是证据最需要的时刻） | §2.1 时序契约：kill → join 泵 → 读 `tail_inline` 后才合成文案；AC3 的确定性断言依赖该顺序 |
| 自安装命令带 `ctx` 后，`rustup component add` 会按项目 `rust-toolchain.toml` 选 toolchain（行为变化） | 这是修正而非副作用（安装必须落在会话环境）；S10 的复验覆盖 |
| `Lifecycle` 新增终态文案槽位（capture-at-transition） | 改动面 = lifecycle 测试断言机械更新；换来事件与快照文案在结构上不可能漂移（§2.1） |
| 新增 `LspExecContext` 与既有多处 `(cmd, args, cwd, env)` 散参并存 | 只新增值对象并让**探测 / 启动 / 安装**三个消费点共用一个上下文；不做全量收敛（避免与 `10-07-unify-command-execution` 撞车） |

---

## 8. 可复用性：原则沉淀 + 单一原语 + 晋升触发条件

「可复用」在本设计里有三个层次，**按此顺序落地，不跳级**：

1. **原则（真正的复用物）** —— P1 / P2 写入 `.trellis/spec/backend/lsp-domain.md`
   （LSP 域）与 `docs/best-practices/general.md`（跨域惯例）：
   > 失败证据必须随错误内联；长证据必须按键可查；证据宿主不得是「成功后才有」的对象。
   > 可用性判据必须与消费点同环境、同语义执行。
2. **原语（域内实现，结构上可提升）** —— `AttemptDiagnosticsStore` **不依赖任何 LSP 类型**
   （键 `String`，条目 `LogRingBuffer` + outcome），因此提升只需移动文件。
3. **晋升触发条件（明确写下，避免将来重复发明）** —— 出现**第二个**需要「失败后按身份查询
   长证据」的消费点时，把 `AttemptDiagnosticsStore` + `LogRingBuffer` 从 `lsp/` 提升到 `common/`：
   - 候选 1：`dap/transport.rs:44` 的 `stderr_buf: Arc<Mutex<String>>` —— **无界** `String`，
     且只在错误消息里一次性使用；若 DAP 需要「查看适配器日志」，即命中。
   - 候选 2：终端任务域（任务进程失败后的日志可达性）。
   - 候选 3：把 `session_store` 与诊断合并为 per-key cell（`KeyState`，§6 G）——
     当「失败尝试也要出现在会话列表 / chip 需重同步」成为需求时一并做，不单独提前合并。
   **未命中触发条件前不动**（YAGNI）；触发条件写进 spec，避免第三次发明同一原语。

---

## 9. 与项目红线的对齐

| 红线 | 对齐方式 |
|---|---|
| 1 统一命令执行 | 探测 / 启动均经 `core::exec`；`lsp/process.rs` 是既有正例，签名调整不改执行路径 |
| 3 阻塞 I/O 隔离 | `LspManager` 方法继续跑在 `spawn_blocking`（`get_or_create_session` 注释已声明） |
| 4 IPC ≤2MB | 证据留在后端；IPC 仍受 `limit`（默认 500）约束；长证据不上 IPC；**内联 tail 有独立上限**（`tail_inline(max_bytes)`，§2.1） |
| 5 Event 名常量 | **不新增事件名** |
| 9 `mod.rs` 极薄 | 新文件 `attempt_diagnostics.rs` / `spawn_spec.rs` 同级；`mod.rs` 只加声明与 `pub use` |
| 13 夹具路径平台无关 | AC1/AC4 的失败夹具脚本一律 `tempdir()` 推导 |
| 15 语言差异落插件数据 | 探测策略用**形态判据**（§2.2 方案 A），不新增语言分支；逃生舱复用既有 `tuning.version_probe`，`tuning` 结构不扩字段 |

---

## 10. 判定：这是代码原因还是方案原因

| 层 | 判定 |
|---|---|
| **触发源** | 配置不自洽（R6）：唯一版本源未声明消费点所需组件 |
| **主因** | **方案**：诊断证据的宿主层级判错（P1）—— 让「证据最需要的时刻」与「证据可得的时刻」不相交 |
| **次因** | **方案**：判据与消费点的环境不一致（P2），且判据失败被静默降级 |
| **代码缺陷** | 6 处（V1–V6），全部是上述两条原则的具体表现，非独立 bug |

因此本任务的重心是**结构性消除**（宿主改键、环境改类型），而非逐点打补丁。
