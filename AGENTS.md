# Neeko — Repository Guidelines

> AI 编程助手项目上下文与开发规范（跨栈部分）。
>
> **分层加载模型** —— 本文件只放「改任何目录都成立」的内容（跨栈契约、通用原则、红线索引）。
> 单侧专属规则按代码物理边界拆分：
>
> - `src-tauri/AGENTS.md` —— Rust 后端专属（该侧红线 + 命令层/并发/导入防火墙）
>
> **硬指令：动手改 `src-tauri/**` 前，必须先 Read `src-tauri/AGENTS.md`。**
> 不要依赖工具自动注入 —— 各工具行为不同：opencode / Claude Code 只在 Read 工具打开该子树
> 文件时注入（`@` 提及、IDE 打开均不触发）；Codex 只拼接「仓库根 → 当前工作目录」路径上的
> 文件，从仓库根启动的会话**不会**加载嵌套文件。漏读 = 该侧全部红线整体失效（红线表的
> 摘要列只够让你停下正在违规的操作，判据与例外仍以落点文件为准）。
>
> **每条红线全文只在一个 AGENTS.md 中出现**，本文件的索引表负责指向它。

## 项目概览

**Neeko** 是基于 Tauri 2.0 + React 18 的桌面应用，统一管理多项目 AI Agent 会话，支持本地 / WSL /
SSH 远程三种项目类型。核心目标：把终端会话、Git 操作、文件变更、IDE 启动与 Skill 管理聚合到同一窗口，
并保持会话可恢复。

- **版本 / 标识符**：见 `package.json` 与 `src-tauri/tauri.conf.json`（**不在此处复述**，历史上曾滞后三个版本）
- **许可证**：Apache 2.0 · **Rust edition**：2021 · **Node**：>=24 · **包管理器**：pnpm（版本取 `package.json` 的 `packageManager` 字段）
- **前端端口**：1420（`tauri.conf.json` 的 `build.devUrl`）

## 顶层目录

```
src/                 React 前端（Feature-Based）
src-tauri/           Rust 后端（Domain-Driven）→ 规则见 src-tauri/AGENTS.md
tools/               Java 语言宿主自检脚本与手测脚本
packages/            独立发布的 npm 包（`dsh-neeko`）→ 见下方门禁豁免
```

`packages/` 下的包**不纳入根脚本门禁**（根 `lint` / `test` / `check` 都不覆盖它）：它的门禁是发布时的
`prepublishOnly`（自带的 `check` / `test` / `lint:package`）。要纳入时，同步增加根脚本与 CI job，
并同步 `.github/BRANCH_PROTECTION.md` 的 required checks —— 只改一处会得到一条看起来存在、
实际不触发的门。

**红线适用范围**：`packages/**` 是 Node 库（非 Tauri 后端），15 条红线**全部 N/A**；
仍须遵守架构基本原则、TDD 与自带 `prepublishOnly`。

子目录清单一律以 `ls` / Glob 为准，本文档不维护树状图。

## Development Commands

```bash
pnpm check:quick   # 开发循环的默认检查：前静态检查（eslint + tsc + fmt + clippy）+ 前端全量单测
```

**最小回归集：`pnpm check:quick`**。全量 `pnpm check`（再加 Rust 测试与 Java 宿主自检）由 CI 兜底，
不在本地重复。

## 架构基本原则（强制）

**高内聚低耦合** —— ① 单一职责：一个单元只有一个改变理由，承担多职责即拆分。② 高内聚：同模块代码必须
紧密相关。③ 低耦合：模块间依赖必须通过明确接口（API wrapper / `pub use` re-export / props/context），
禁止跨域直接引用内部实现。④ 依赖倒置：高层不依赖低层实现细节，两者都依赖抽象。

**开闭原则** —— 新增功能通过添加代码（新 variant / 新 strategy / 新组件）实现，而非修改已有代码；
策略集已知且固定时用 `Enum + match` 代替 `Box<dyn Trait>`（编译期 dispatch，新 variant 强制处理）。

**DRY / KISS / YAGNI** —— 重复逻辑 3 次以上必须抽象；选最简方案不过度设计；当前不需要的不实现、
不预留「将来可能用到」的抽象层。

## TDD 开发模式（强制）

Red（先写失败测试）→ Green（最少代码让测试通过）→ Refactor（保持通过下重构）。

- **新功能**：定义接口/types → 写测试（正常路径 + 边界 + 错误）→ 确认 Red → 实现 → 重构 → 跨模块补集成测试。
- **Bug 修复**：先写复现测试并确认 Red → 修复 → 确认通过 → 检查同类问题并扩展覆盖。
- **覆盖率**：纯函数 100%（直接断言）· Rust manager 核心路径（`#[test]`）· Hooks 关键行为（`renderHook`+`act`）· 组件关键交互（`@testing-library/react`）。
- **硬约束**：没有测试的新代码不允许合入；改已有代码前先确认已有测试通过；测试独立（不依赖顺序与外部状态）、快速（单个 <100ms，全量 <30s）。

## AI 代码审查红线 (Review Gates)

> 经代码库验证，违反即为 Block 级。标「本文件 ↓」的红线全文在本文件，其余全文在对应嵌套文件。
> 编号是稳定标识符，代码注释与提交信息**一律引用编号**（如「红线 4」），不要复述或改写标题 ——
> 那会给同一条规则造出第二个名字，grep 任一名字都找不全。**术语只允许「红线」** —— 旧
> neeko-check「支柱」体系（15/13 条、编号与本表不同）已废止，活代码/活文档里出现即按本表换算。
> **摘要列**是嵌套文件未加载时的兜底（够用来识别并停止违规），判据与例外一律以落点文件为准。

| # | 红线 | 必须 / 禁止（摘要） | 全文位置 |
| --- | --- | --- | --- |
| 1 | 统一命令执行接口（Local/WSL/SSH） | 命令只走 `core::exec` / `common::executor`，禁止直接用 `std::process::Command` | `src-tauri/AGENTS.md` |
| 2 | 跨平台 shell 选择（`cmd /c` vs `sh -c`） | Local 路径按平台选 shell，禁止硬编码 `sh -c` / `bash -lc` | `src-tauri/AGENTS.md` |
| 3 | 阻塞 I/O 隔离（`spawn_blocking`） | 异步中调 `std::fs` / `std::process` / portable-pty 阻塞读写必须包 `spawn_blocking` | `src-tauri/AGENTS.md` |
| 4 | **IPC 大文本边界** | 单次 Command 返回 JSON ≤ 2MB，大载荷走二进制流或分页 | 本文件 ↓ |
| 5 | **Event 名常量化** | Event 名双端只允许来自单一常量源，禁止各自硬编码 | 本文件 ↓ |
| 6 | Command 层保持极薄 | `#[tauri::command]` 只做参数校验 + 调度，核心逻辑落 manager/service | `src-tauri/AGENTS.md` |
| 7 | `if let` 嵌套不超过 3 层 | 连续 ≥3 层 `if let` 拍平成 `match`；仅 1-2 条 happy path 才用 `if let` | `src-tauri/AGENTS.md` |
| 8 | 路径安全校验（`canonicalize` + capabilities 白名单） | 前端传入路径消费前必须 `canonicalize`，capabilities 禁止 allow-all | `src-tauri/AGENTS.md` |
| 9 | `mod.rs` 保持极薄 | `mod.rs` 只允许 `mod` 声明 + `pub use`，业务 `fn`/`impl` 抽同级文件 | `src-tauri/AGENTS.md` |
| 10 | 平台代码规范化（Platform Adapter） | 平台差异与单平台代码必须落 `platform/<theme>/`，通用文件禁止平铺 `#[cfg]`；测试域只许 item 级门控（整测试 / gated 夹具） | `src-tauri/AGENTS.md` |
| 11 | 换行边界（Line-Ending Boundary） | 禁止注入 `core.autocrlf`；禁止对工作区换行做字节级断言 | `src-tauri/AGENTS.md` |
| 12 | 路径身份唯一化（`FileRef`） | 同文件判定必须走 `FileRef`，禁止消费侧自造字符串归一 / 别名匹配 | 本文件 ↓ |
| 13 | 测试夹具路径平台无关 | 夹具路径一律由 `tempdir()` 推导，禁止硬编码 POSIX 绝对路径 | `src-tauri/AGENTS.md` |
| 14 | **LSP 能力声明必须与实现一致** | 声明客户端能力前先确定消费点，同一 diff 内给出实现或删声明 | 本文件 ↓ |
| 15 | 语言差异必须落在插件数据 | 语言差异只允许作为 `LspPlugin` 字段，通用模块禁止 `language_id` 分支 | `src-tauri/AGENTS.md` |

### 4. IPC 大文本边界（跨栈：Rust 返回 ↔ 前端消费）

单次 Command 返回的 JSON 不超过 **2MB**。Diff 视图、PTY 缓冲区、大目录列表等长度不确定的载荷，
必须走 Tauri 二进制流（`Response::new(Vec<u8>)` + 前端 `invoke<ArrayBuffer>`）或前端虚拟滚动/分页
按需请求，禁止整体 JSON 序列化返回。

### 5. Event 名常量化（跨栈：Rust ↔ 前端）

Tauri Event 字符串（如 `terminal-output-{id}`、`git-status-diff`）禁止双端各自硬编码。Rust 端定义为
常量，前端通过统一模块引用。改一端必须同步另一端；新增事件名只允许来自单一常量源。

### 12. 路径身份唯一化（跨栈：前端消费 ↔ LSP / DAP / 文件 IO）

「是不是同一个文件」只允许在 `FileRef` 形态上判定（`src/shared/utils/fileRef.ts` 的 `sameFile`）。
调用方禁止自行发明字符串归一（正则匹配、`startsWith` 拼项目根、别名表），那正是「同一份源码两种
表示」的入口。身份函数要**全且幂等**（`id(id(x)) === id(x)`），任何一种身份缺席文法就会被当成相对
路径拼上项目根，产出伪路径。`..` 只在词法层保留，后端读取前的 `canonicalize` 是安全兜底（红线 8）。

### 14. LSP 能力声明必须与实现一致（跨栈：Rust 声明 ↔ TS 消费）

向语言服务器声明的每一项客户端能力都是**行为契约** —— 服务器据此切换通道，声明了却没人实现 =
静默功能缺失；**该声明却没声明同样违约**（rust-analyzer 会整条丢弃 flyimport 候选）。

改 `build_client_capabilities()` / `plugin.with_extended_client_capabilities()` 前必须回答
「哪段代码消费它」，并在**同一 diff 内**给出实现或删掉声明。消费者统一在
`src/features/lsp/hooks/lspCompletionResolve.ts`。护栏测试
`java_plugin_advertises_only_implemented_extended_capabilities`。

**禁止**因为某次事故就把能力按语言切成开关 —— 那会违反红线 15。

## Important Files

| 文件 | 作用（导航摘要） |
| --- | --- |
| `src-tauri/src/lib.rs` | 后端模块聚合与命令注册入口 |
| `src-tauri/src/app/` | 组合根（`boot` Builder 组装 · `close` 关闭协议 · `commands` 生命周期命令） |
| `src-tauri/src/app_state.rs` | `AppStateWrapper` 组装中心 |
| `src-tauri/src/common/error.rs` | `AppError` 定义与错误转换 |
| `src/app/App.tsx` · `src/app/hooks/useAppShell.ts` | 前端组合根组件 · 主协调 hook |
| `src/shared/store/` · `src/shared/types/` | zustand 全局状态 · TypeScript 类型 |
| `src/shared/utils/fileRef.ts` | 路径身份唯一化入口（红线 12） |
| `package.json` · `src-tauri/Cargo.toml` · `src-tauri/tauri.conf.json` | 脚本与版本 · Rust 依赖与目标 · Tauri 构建与窗口 |
| `src-tauri/AGENTS.md` | Rust 后端红线全文与命令层/并发约定 |

## 已知问题

- SSH 凭据重连自动填充可能有边界情况；SSH 路径自动补全下拉可能有 z-index 问题
- 自定义 IDE 的 icon 解析不支持
- **改了 `node_modules` / `patches/*.patch` 后 Vite 预打包不失效会继续跑旧代码**：改完必须先
  `rm -rf node_modules/.vite`，否则开发环境继续跑补丁前的旧代码。

## AI Assistant Workflow Notes

**检查的频次（硬指令）**：`pnpm check:quick` **只在收尾跑一次**，不是「每改一个文件就跑一遍」——
把一轮改动攒完再确认绿。它已含全部静态检查（eslint / tsc / fmt / clippy）与前端单测，所以开发中
不要再单独敲 `pnpm lint` / `pnpm test`：那些不是更细的检查，只是重做同一批工作。

**唯一例外（红绿反馈，不是验证）**：TDD 要看到测试由红转绿时，可跑**单个**测试文件
（`vitest related <file>` / `cargo test <name>`）—— 那是观察，不是门禁。

**不要主动跑 `pnpm check`**：由 CI 执行，本地重复只是浪费几分钟。例外仅两种：
用户明确要求，或排查「`check:quick` 绿但 CI 红」的覆盖面差异。

**覆盖面要诚实**：`check:quick` 的 Rust 侧只有 `cargo fmt` 与 `cargo clippy`，**不跑 `cargo test`**；
`pnpm test` 才含 Rust 测试与 Java 宿主自检。缺口由 CI 兜底。

**收尾**：只跑这一次 `pnpm check:quick` 确认通过 → 同步必要文档 → **不要主动提交代码**。

## Quick Change Playbooks

单侧 playbook 见 `src-tauri/AGENTS.md`「Rust 命令层约定」（新增命令），此处只留跨栈条目。

- **改构建或权限配置**：同步检查 `package.json`、`vite.config.ts`、`tauri.conf.json`、`capabilities/default.json`、`rust-toolchain.toml`（Rust 工具链唯一版本源；workflow 内不得再写 `dtolnay/rust-toolchain@stable`，那会让 CI 比本地先滚动），验证 `pnpm tauri dev` 与 `build`

## 相关文档

- `CONTEXT.md` · `CONTEXT_CN.md` 领域词汇表（模块划分与术语）
- `CONTRIBUTING.md` · `CONTRIBUTING_CN.md` 贡献流程
- `README.md` · `README_CN.md` 功能清单与快捷键（面向用户）
- `CHANGELOG.md` 版本变更记录
