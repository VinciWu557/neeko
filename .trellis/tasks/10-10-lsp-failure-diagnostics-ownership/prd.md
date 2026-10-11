# LSP 失败诊断归属重构（诊断证据锚定身份键 + 探测环境一致性）

## 背景：一次可复现的事故

在 Neeko 中打开自身仓库（`/Users/tomgs/RustroverProjects/neeko`，含 `Cargo.toml`）的 `.rs` 文件，
rust-analyzer 无法启动；点状态栏「View logs」得到：

```
[Failed to load LSP logs: LSP error: No LSP session for: /Users/tomgs/RustroverProjects/neeko:rust]
```

已完成的取证（本次会话实测，非推测）：

| 观测 | 证据 |
|---|---|
| 真实原因 | `cd <项目根> && rust-analyzer --version` → `error: Unknown binary 'rust-analyzer' in official toolchain '1.99.0-aarch64-apple-darwin'` |
| 对照（环境变量唯一差异） | `cd /tmp && rust-analyzer --version` → `rust-analyzer 1.99.0 (b940084d 2026-09-28)` ✅ |
| toolchain 状态 | `rust-toolchain.toml` 钉 `1.99.0`；该 toolchain 已装组件**不含** `rust-analyzer`（stable 含） |
| 归因归属 | 报错串由 Neeko 自身产生：`taskStore.ts:648` ← `manager.rs:1030` `AppError::Lsp("No LSP session for: {key}")` ← `error.rs:56` `#[error("LSP error: {0}")]` |
| 用户在 chip 上看到的原因 | `instance.rs:439` `"LSP initialization: no response received"`（传输层症状，非原因） |
| 原因其实已被采集 | `instance.rs:226-259` stderr 泵把 `Unknown binary ...` 写入 `log_buffer` |

**这不是三个独立 bug，是两条原则被违反后的三种表现。** 详见 `design.md`。

## Goal

让「LSP 启动失败」这一事实与其原因**永远可达**，且**原因必须来自证据而非推断**。
诊断证据的宿主由「进程对象」改为「会话身份键」；可用性判据的执行环境由「应用默认环境」改为
「会话将要运行的环境」。同时消除触发本次事故的配置不自洽（唯一版本源未声明其消费点所需组件）。

## Requirements

**R1 失败可读（用户可见语义）**
LSP 启动失败后，状态栏「View logs」必须展示该次尝试的日志与失败原因；
`lsp_get_server_logs` 与 `lsp_get_server_info` **不得**再因「会话不存在」而报错。

**R2 失败证据完整（覆盖全部失败模式）**
以下每一种失败都必须在诊断通道留下可查询记录，且失败消息内联证据尾部：
① 插件未注册；② `ExecTarget` 缺失；③ `AppHandle` 缺失；④ `spawn` 直接失败（二进制不可解析/权限）；
⑤ 子进程启动后立即退出（握手无响应）；⑥ 握手返回错误。

**R3 探测与启动同源（环境一致性）**
同一语言服务器的「探测命令」与「真实启动」必须使用同一个 spawn 规格
（`ExecTarget` + `cwd` + `env` + argv）。**探测不带 cwd 是不可表示的**（由类型保证，不靠人工检查）。

**R4 存在性 ≠ 可运行性**
`command_exists` / `command_exists_on_path` 一类 PATH 存在性探测，
**不得单独作为「已安装 / 可启动」的结论**：在 rustup / fnm / asdf 等**代理式版本管理器**下，
PATH 中存在代理与「该工具在该项目环境下能应答」是两件事。自动安装的触发判据必须建立在
「在会话环境中能应答」之上，或其失败能被诊断通道解释。

**R5 诊断存储的生命周期与界**
诊断记录锚定身份键（`project_path` + `language_id`），**不随进程存活与否变化**；
同一键的**新一次尝试重置**上一次的诊断（保证有界，且不混两次运行的输出）；
**确定性驱逐点**：项目被移除/关闭时清理该项目的全部键。

**R6 唯一版本源自洽**
`rust-toolchain.toml` 是 Rust 工具链的唯一定义点（文件内自述）。它声明的 `components`
必须覆盖**该项目自身 LSP 消费点所需的组件**（`rust-analyzer`）——否则「唯一来源」与消费点不自洽。

**R7 原则沉淀与防回退**
上述两条原则写入 `.trellis/spec/backend/lsp-domain.md`（LSP 域特有部分）与
`docs/best-practices/`（跨域惯例），并配可执行的护栏测试。

## Acceptance Criteria

- [ ] **AC1a 失败后日志可读（编排层）**：用既有装配端口桩 `FailingSessionFactory`
  （`manager.rs:1493`，`build` 固定返回 `Err`）走 `get_or_create_session` 返回 `Err` 后，
  `get_server_logs(key)` **返回含失败原因的条目**且**不返回 `Err`**。
  — 这是本次事故的直接复现（当前实现必 Red：会返回 `No LSP session for: …`）。
- [ ] **AC1b 真实子进程的 stderr 进证据（进程层）**：`tempdir()` 内脚本（stderr 输出一行 + `exit 1`，
  平台无关，红线 13）经探测/启动路径运行时，其 stderr 行进入该键的日志证据。
  — 与 AC1a 分层：AC1a 钉「归属」，AC1b 钉「采集」。
- [ ] **AC2 从未尝试 ≠ 报错**：对从未尝试过的键，`get_server_logs` 返回空数组、
  `get_server_info` 返回 unknown 形态；两者均不返回 `Err`。
- [ ] **AC3 失败消息内联证据**：失败返回的 `AppError` 文案包含 stderr 尾部（对齐 DAP 既有惯例
  `dap/session.rs:247` `"{base} | adapter stderr: {detail}"`）；`crash_message` 不再只报
  `"{server} exited unexpectedly"` 而丢掉原因。
- [ ] **AC4 探测环境正确**：探测命令的 spawn 规格与真实启动一致（含 workspace root 作为 cwd）。
  测试用可感知 cwd 的夹具脚本断言（`tempdir` 推导路径，禁止硬编码 POSIX 绝对路径）。
- [ ] **AC5 探测失败不降级**：探测非零退出 / 无法启动时，其 stderr 进入诊断通道，
  不再被静默降级为 `LspServerInfo::unknown()`；探测返回的退出码不得被丢弃。
  形态判据按 `design.md` §2.2（方案 A「分形」，2026-10-11 确认）：`Err`（执行不了）
  直接失败；「非零退出 **且** stderr 非空」只记证据并内联进失败消息、**不**拒绝启动
  （由真实 spawn + 握手兜底）；超时与无 stderr 的弱信号只记录。
- [ ] **AC6 驱逐有效**：项目移除后，该项目全部键的诊断记录被清理（store 为空）。
- [ ] **AC7 重置语义**：同一键第二次尝试不含第一次尝试的日志条目。
- [ ] **AC8 界**：单键诊断占用仍受既有 `LOG_RING_MAX_BYTES` 约束；键的数量受驱逐点约束，
  有测试或断言说明「键不被清理」时不会无界增长。
- [ ] **AC9 配置自洽**：`rust-toolchain.toml` 的 `components` 含 `rust-analyzer`，
  且 `pnpm check` 全绿（含 `test:rust` / `test:host`）。
- [ ] **AC10 防回退**：新增护栏测试钉住「缺会话时读日志/信息不报错」这一契约；
  并证明「探测无 cwd」在类型层面不可表达。

## Constraints（项目红线）

- 红线 1：所有命令执行走 `crate::core::exec` / `common::executor`；`lsp/process.rs` 是既有正例。
- 红线 3：异步中阻塞 I/O 必须 `spawn_blocking`（`LspManager` 方法已在 `spawn_blocking` 上跑，保持）。
- 红线 4：单次 Command 返回 ≤ 2MB；日志条数仍由 `limit` 约束（默认 500）。
- 红线 5：事件名只允许来自单一常量源；本任务**不新增事件名**。
- 红线 9：`mod.rs` 只放 `mod` + `pub use`，新文件放同级。
- 红线 13：测试夹具路径一律 `tempdir()` 推导。
- 红线 15：探测策略差异必须是 `LspPlugin` 字段，禁止在通用模块写语言分支。

## Out of Scope

- 不改 LSP 协议语义、诊断呈现、补全/重构（C 通道）等既有能力。
- 不为「将来可能用到」造跨域框架（见 `design.md` §8 的晋升触发条件）。
- 不修 DAP `stderr_buf` 的无界 `String`（记录为触发条件，不在本任务改）。
- 不改前端 UI 结构与文案体系（本任务的目标正是**让现有「View logs」入口变得正确**）。

## 依赖

- 无硬前置。与 `10-07-unify-command-execution` 有交界（探测/启动都属命令执行），
  但互不阻塞：本任务只用 `core::exec` 既有 facade，不迁移其它域。

## Notes

- 术语以 `docs/domain-model.md` 为准。
- 本任务**不**把「环境修好」当作完成条件（那是 R6）；完成条件是
  **同类失败在任何环境下都能自我解释**。
