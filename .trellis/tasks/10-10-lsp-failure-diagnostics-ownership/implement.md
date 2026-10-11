# 执行计划：LSP 失败诊断归属重构

> 严格 TDD：每一步先 Red → Green → Refactor。步骤顺序经过设计 ——
> 先建原语与类型，再用**类型驱动的编译错误**去发现全部调用点（而非人工 grep 找漏）。
> 每步末尾的「门禁」是 review gate 自查项，不是可选建议。

---

## S0 基线与回滚点

```bash
git status --porcelain                 # 必须 clean
pnpm test:rust                         # 基线绿
git rev-parse HEAD                     # 记录为 ROLLBACK-BASE
```

**回滚点**：每个 S 步骤单独提交（Conventional Commits），任何一步红即 `git reset --hard <上一步>`。

---

## S1 Red：钉住事故复现（AC1a / AC2）

**文件**：`src-tauri/src/lsp/manager.rs`（`mod tests`，紧邻既有
`session_creation_failure_emits_error_event`）

**动作**：新增两个测试，**先确认 Red**：

1. `failed_creation_keeps_diagnostics_readable`
   - 用既有桩 `FailingSessionFactory`（`manager.rs:1493`）+ `manager_with_factory`
   - `get_or_create_session(TEST_PROJECT, TEST_LANG, None)` 断言 `Err`
   - `get_server_logs(TEST_PROJECT, TEST_LANG, None)` → 断言 **`Ok`** 且含
     `"Failed to spawn gopls"`
   - `get_server_info(TEST_PROJECT, TEST_LANG)` → 断言 **`Ok`** 且 `outcome.status == "error"`
2. `never_attempted_key_reads_empty_not_error`
   - 未尝试键：`get_server_logs` → `Ok(vec![])`；`get_server_info` → `Ok(unknown)`

```bash
cargo test --manifest-path src-tauri/Cargo.toml lsp::manager 2>&1 | tail -30
```

**预期 Red**：当前实现返回 `Err(AppError::Lsp("No LSP session for: …"))` —— 即线上事故。
**门禁**：Red 输出必须**逐字**包含 `No LSP session for`（证明测的是真事故，不是自造场景）。

---

## S2 `attempt_diagnostics.rs`：键控诊断存储（P1）

**文件**：新建 `src-tauri/src/lsp/attempt_diagnostics.rs`；`lsp/mod.rs` 只加
`mod attempt_diagnostics;` + `pub(crate) use`（红线 9）。`LspAttemptOutcome` 定义在
`types.rs`（S7），本文件引用之。

**动作**：按 `design.md` §2.1 实现 `AttemptDiagnostics`（句柄：`push_log` /
`record_failure` / `record_success` / `tail_inline`）与 `AttemptDiagnosticsStore`
（`begin` / `with` / `evict_project`）。

**关键约束**：
- 键类型是 `String`，**不引任何 LSP 类型**（保留 §8 的整文件提升可能）
- **写只走句柄、读才走 key**：`begin` **铸造新条目**（新 `Arc`，不是原地清空）；
  旧句柄的迟到写入落进孤儿条目（生代隔离，AC7/AC8 的结构保障）
- `record_failure` 同时写 `outcome` 与 `log`（消息与日志同源，避免两处文案漂移）
- `with` 取句柄快照后**松开 map 锁**再执行闭包（10MB 快照不占 map 锁）
- `evict_project` 按条目自持的 `project_path` **精确匹配**（不做键字符串前缀）
- `tail_inline(max_bytes)` 上限必填（内联证据唯一读取点）

**单测（同文件 `mod tests`）**：重置语义（AC7）、**旧生代句柄在 `begin` 后继续写入
不得出现在新条目里**（生代隔离）、项目级驱逐（AC6）、**驱逐后旧句柄写入不复活键**（AC8）、
`evict_project` 对含 `:` 的项目路径不误伤、环上限与 `tail_inline` 上限仍生效、
键类型无 LSP 依赖（编译期事实，注释说明即可）。

```bash
cargo test --manifest-path src-tauri/Cargo.toml attempt_diagnostics
```

**门禁**：全仓只有一个缓冲实现（复用 `LogRingBuffer`，不新增第二种环）。

---

## S3 `spawn_spec.rs`：单一执行上下文（P2a）

**文件**：新建 `src-tauri/src/lsp/spawn_spec.rs` + `mod.rs` 声明。

**动作**：`LspExecContext { target, cwd, env }`（「在哪执行」，cwd 必有）+ 一个构造器
（由 `plugin` + `project_path` + `workspace_root` + `target` + env 派生）。命令与 argv 是
**动作的数据**，不进上下文（探测要 `--version`、安装命令的 cmd/args 完全不同 —— 见
`design.md` §2.2）；按需要渲染成 `SpawnOptions`，复用 `process.rs:297-345` 既有路径。

**单测**：构造器把 `workspace_root` 落到 `cwd`；env 透传（`java_home_from_path` 场景）。

```bash
cargo test --manifest-path src-tauri/Cargo.toml spawn_spec
```

**门禁**：不引入第二套 cwd 派生逻辑 —— `session/root.rs::resolve_session_root` 仍是唯一
根解析点，`spawn_spec` 只持有其结果；`LspExecContext` 是**唯一**能执行 LSP 命令的入口。

---

## S4 探测签名改收 `&LspExecContext`（用编译器找全部调用点）

**文件**：`src-tauri/src/lsp/process.rs`

**动作**：把 `run_command_blocking` / `run_command_streaming` 改为接收
`(&LspExecContext, cmd, args, …)`（新增 `probe(ctx, cmd, args, timeout)` 同理）；
内部改用带 cwd/env 的 `core::exec` 形态（红线 1 不变）。

**这一步是「类型级消除」的落点**：改完签名后，编译错误会**逐一暴露**所有「不带 cwd 的探测」
调用点 —— 不靠 grep，也不可能漏。

```bash
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error" | head -20
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

**门禁**：
- `installer.rs` 的安装命令也应拿到同一 `ctx`（安装同样属于「在项目环境里执行」）
- `process.rs` 内不得残留第二处 `core::exec::spawn(&target, &cmd, &args_ref)` 三参形态（红线 1 正例保持）

---

## S5 manager 编排接入（失败矩阵 6 格）

**文件**：`src-tauri/src/lsp/manager.rs`

**动作**：
1. `LspManager` 增字段 `attempt_diag: AttemptDiagnosticsStore`（与 `profiles` 平级，
   `manager.rs:121` 位置）
2. `get_or_create_session`（`:469`）：`begin(key, project_path)` 放在
   **`gate.lock()` + 二次 recheck 之后、`resolve_by_language` 之前** —— 早于插件解析
   （覆盖 ①），且**不在 fast path / 并发输家路径上**（不得切换生代、不得清空活会话日志，
   见 `design.md` §2.1「单写者与 `begin` 落点」）
3. **终态只由 manager 单写**：装配期各 `Err` 分支（插件未注册 / `require_project_exec_target`
   / `transport` / `build`）经**本次尝试的句柄** `record_failure`（覆盖 ②③④⑥；
   `transport` 与 `exec_target` 两处现为 `?`，需改为 `match` 以便先记录）——session 内部
   不重复写终态
4. `SessionBuildRequest` 增字段 `diagnostics: Arc<AttemptDiagnostics>`（与 `transport` 同构：
   装配前先取，装配失败也要回写 —— 见 `session_factory.rs` 既有注释的同一道理）
5. `session_store.insert`（`:577`）成功后 `record_success`
6. `remove_profile` / 项目移除处（`manager.rs:857` `profiles.remove`）同点调
   `attempt_diag.evict_project(project_path)`（确定性驱逐，AC6）
7. 新增回归测试 `alive_session_fast_path_does_not_reset_diagnostics`：用
   `StubSessionFactory` 建活会话并经句柄写入一条日志，再调 `get_or_create_session` 命中
   fast path → 断言日志仍在（钉死 begin 落点）

```bash
cargo test --manifest-path src-tauri/Cargo.toml lsp::manager
```

**门禁**：失败矩阵 6 格逐格可指认（对照 `design.md` §2.1 表）——
特别是模式 ④（spawn 直接失败，**无 stderr**）必须由 manager 用 message 合成条目，
不得依赖 stderr 泵；终态单写者逐格唯一。

---

## S6 session 接管句柄（不再自建缓冲）+ 证据内联

**文件**：`src-tauri/src/lsp/session/instance.rs`、`src-tauri/src/lsp/session/testing.rs`、
`src-tauri/src/lsp/session/lifecycle.rs`

**动作**：
1. `instance.rs:190`：`log_buffer` **删除**（会话不再自建/持有缓冲）——stderr 泵与 reader
   线程各持 `begin` 返回的 `Arc<AttemptDiagnostics>` 克隆；session 结构不需要该字段
   （读路径走 key，写路径走句柄）
2. `instance.rs:226` stderr 泵：目标改为该共享句柄（采集不变）
3. `new()` 的 `Err` 路径**只做两件事**：合成失败文案时内联证据尾部（AC3；含 `:440`
   `"LSP initialization: no response received"` 处的改造），并保证合成前泵已终止：
   **kill → join 泵 → 读 `tail_inline`**（`design.md` §2.1「终态文案与内联证据」）。
   **不**在 session 内写终态 —— 装配期终态由 manager 单写（S5）
4. **握手不得挂死（实施期补修，design §2.1 补记）**：reader 出口（含 panic 分支）
   `drain_pending`；`await_init_response` 在插入 sender 后检查 `reader.is_finished()`
   再 drain 一次 —— 否则子进程秒退时 `blocking_recv` 永久阻塞，失败永不产生。
   用例：`await_init_response_fails_fast_when_reader_dead` / `..._returns_response_when_reader_alive`
5. `lifecycle.rs`：`crash_message(server_name, tail)` 保持唯一构造函数；**进入终态的写者
   一次合成并存入 lifecycle**（`on_reader_exit(message)` / `set(Error(message))`），
   `status()` 只投影该字符串（capture-at-transition）：
   - `instance.rs:691` `on_reader_exit`：reader 线程捕获本次尝试的句柄，合成文案 →
     存入 lifecycle + `record_failure`（模式⑤终态单写者）→ 发事件（同一份文案）
   - `instance.rs:631` `snapshot()`：直接投影，不再自行重建
6. 装配依赖打包：`SessionPlumbing { app_handle, diag_bus, transport, diagnostics }`
   （`LspSession::new` 收敛到 4 参数，避免 clippy too_many_arguments）；
   `session_factory` 组装该结构并透传

```bash
cargo test --manifest-path src-tauri/Cargo.toml lsp::
```

**门禁**：
- `instance.rs` 净行数不增（删 dead `snapshot_logs` `:617` 与自建缓冲作对冲；AC3 的
  tail 传参若仍净增，须在同一提交更新 `lsp-domain.md` F-台账「`instance.rs` 存量胖」一行）
- 不允许出现「第二个缓冲创建点」：全仓 `LogRingBuffer::new()` 只应出现在
  `AttemptDiagnosticsStore::begin` 与测试夹具
- 终态文案不得有第二个形状：同一测试内比对事件与快照取到的是**同一字符串**

---

## S7 读路径改指向 + IPC 契约

**文件**：`src-tauri/src/lsp/manager.rs`（`:1012` `get_server_info`、`:1030` `get_server_logs`）、
`src-tauri/src/lsp/types.rs`、`src-tauri/src/lsp/commands.rs`

**动作**：
1. `get_server_logs` / `get_server_info` 改读 `attempt_diag`：
   **删除** `AppError::Lsp("No LSP session for: …")` 两个读路径分支（AC2）
   —— 该文案保留给写路径（`didOpen` / 请求），那里语义正确
2. `types.rs`：新增 `LspAttemptOutcome`（定义单点，`attempt_diagnostics.rs` 引用）；
   `LspServerInfo` 增 `outcome: Option<LspAttemptOutcome>` 带 `#[serde(default)]`（向后兼容）
3. 命令层（红线 6）保持极薄：只是签名/返回值透传，不动逻辑

```bash
cargo test --manifest-path src-tauri/Cargo.toml lsp::
grep -rn "No LSP session for" src-tauri/src/   # 只应剩写路径
```

**门禁**：`grep` 结果必须能逐条解释为「写路径」，且每条都在对未登记会话**发起**操作。

---

## S8 探测失败的形态判据（AC4 / AC5）

**文件**：`src-tauri/src/lsp/session/instance.rs`（探测调用点）、`src-tauri/src/lsp/installer.rs`

**动作**：
1. 探测改用 `LspExecContext`（S4 已具备）→ AC4
2. 退出码**不再丢弃**：按 `design.md` §2.2 形态表（方案 A：分形）分流。三层接缝
   （均不依赖 AppHandle）：`probe`（采集）/ `classify_probe_run`（纯判据，process.rs）/
   句柄 `record_failure`（记账）：`Err` → 记证据并**直接失败**；`非零+stderr` →
   记证据并**继续启动**（由 spawn + 握手兜底）；超时 / 无 stderr 仅记录不判定（AC5）
3. 失败消息附插件 `install` 数据给出的提示（数据驱动，**不按语言分支**，红线 15）；
   `check_plugin_installed`（PATH）继续作为自安装门控（取舍见 `design.md` §2.2）

**单测**（`tempdir()` 脚本，红线 13；落点见 `design.md` §2.2 接缝表）：
- AC1b：stderr + `exit 1` 的脚本 → 采集层拿到 stderr；经判据 + 记账后该键日志证据含该行
- AC4：可感知 cwd 的脚本（输出 `pwd`）→ 断言等于传入 ctx 的 `cwd`（仅采集层）
- AC5：`exit 1` 且 stderr 空 → 不判定失败（走继续启动路径）；`非零 + stderr 非空` →
  记证据、**不**拒绝启动；`Err`（不可执行）→ 直接失败且证据可达

```bash
cargo test --manifest-path src-tauri/Cargo.toml lsp::process
cargo test --manifest-path src-tauri/Cargo.toml lsp::attempt_diagnostics
```

**门禁**：形态表四行逐行有测试；判据与记账单元不依赖 `AppHandle`；无任何
`language_id == "…"` 新增分支（红线 15）。

---

## S9 前端同步（最小面）

**文件**：`src/features/lsp/types.ts`、`src/features/status-bar/useLspStatusMenus.ts`、
`src/features/status-bar/__tests__/LspStatusSection.test.tsx`

**动作**：
1. `types.ts`：`LspServerInfo` 加 `outcome?: LspAttemptOutcome`（`lspApi.ts` 同步 re-export）
2. `lspStatusFormat.ts` `formatInfoFooter`（纯函数 = 单一展示点）：失败态且有
   `outcome.message` → 优先展示真因；`useLspStatusMenus.ts` 只取数不加分支
3. 测试：`lspStatusFormat.test.ts` 加真因 / 无 outcome 回退 / 非失败态三例；
   `LspStatusSection.test.tsx` 加 footer 展示 outcome 的集成用例
4. **不改**「View logs」的可见性与文案 —— 目标就是让它在 `error` 态**正确工作**
5. `taskStore.ts:648` 的 `[Failed to load LSP logs]` 分支保留为兜底（正常路径不再触发）

```bash
pnpm type-check && pnpm test:fe src/features/status-bar
```

**门禁**：前端无新增「按会话存活分支」的逻辑（否则等于把后端缺陷搬到前端）。

---

## S10 配置自洽（R6 / AC9）

**文件**：`rust-toolchain.toml`

**动作**：
1. `components` 追加 `rust-analyzer`，并在文件注释里补一句「LSP 消费点要求该组件随 toolchain 一并安装」
2. 本机补齐：`rustup component add rust-analyzer --toolchain 1.99.0-aarch64-apple-darwin`
   （**已有** toolchain 的机器/CI 缓存不会因声明自动补装；新装机由 `rust-toolchain.toml`
   自动带上）
3. 复验对照：

```bash
cd /Users/tomgs/RustroverProjects/neeko && rust-analyzer --version   # 必须不再是 Unknown binary
```

**门禁**：`rust-toolchain.toml` 仍是唯一版本源（不新增第二处工具链声明）。

---

## S11 原则沉淀 + 防回退（R7 / AC10）

**动作**：
1. `.trellis/spec/backend/lsp-domain.md` 新增一节（LSP 域）：诊断归属 + 失败矩阵 + 形态判据，
   并补进 F-台账（避免后来者回退到「日志挂在会话上」）
2. `docs/best-practices/general.md` 新增跨域惯例：**失败证据随错误内联；长证据按键可查；
   证据宿主不得是「成功后才有」的对象；可用性判据必须与消费点同环境同语义**
3. 写入 §8 的晋升触发条件（DAP `stderr_buf` 无界 `String` / 终端任务域 /
   `session_store` 与诊断的 per-key 合并）
4. 护栏：AC1a/AC2 断言留在 `manager.rs` 测试里作为契约钉（比静态脚本更稳、无语法指纹
   脆弱性 —— 参考红线 13 的既有结论：无稳定指纹时不硬上静态检查）。
   「探测无 cwd 不可表达」与「写不复活被驱逐的键」是**结构/编译期事实**（S3/S2），
   落地口径 = 在 spec 里写明「不得新增不带 `ctx` 的执行入口、写只走句柄」，不假装它们
   是运行期护栏测试

```bash
pnpm lint && pnpm check
```

---

## S12 全量验证与收尾

```bash
pnpm lint                      # guards + eslint + tsc + fmt + clippy
pnpm test:rust                 # cargo test（含新增 LSP 测试）
pnpm test:fe                   # vitest
pnpm check                     # 本地全量门禁
pnpm test:coverage             # 前端地板 + Rust 60% 行覆盖
```

**端到端复验（人工，对齐事故现场）**：
1. 临时制造失败：本项目改用 `RUSTUP_TOOLCHAIN=1.92.0` 或临时注释组件声明，重启 Neeko
2. 打开 `.rs` 文件 → chip 显示 `error`，tooltip 与「View logs」**都给出真因**
   （应能看到 `Unknown binary 'rust-analyzer' …` 这类 stderr，而不是 `No LSP session`）
3. 复原后重启 → `ready`，日志面板显示正常索引输出

**收尾**：`trellis-check` → `trellis-update-spec`（若 S11 有遗漏）→ 提交（**不主动提交**，
由用户确认）→ `/trellis:finish-work`。

---

## 交付物 ↔ AC 对照

| 步骤 | AC |
|---|---|
| S1/S5/S7 | AC1a、AC2、AC6、AC7、AC10（+ fast path 不重置的回归） |
| S2 | AC7、AC8（含驱逐后不复活、生代隔离） |
| S3/S4/S8 | AC4、AC5、AC1b |
| S6 | AC3（+ 崩溃终态单写者） |
| S9 | AC1a（UI 侧可达）、AC2 |
| S10 | AC9 |
| S11 | AC10、R7 |
