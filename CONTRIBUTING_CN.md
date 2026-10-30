# 参与 Neeko 贡献指南

感谢你对 **Neeko** 的关注与贡献 —— 一个基于 Tauri 2.0 + React 18 的桌面应用，用于统一管理多项目 AI Agent 会话（本地 / WSL / SSH 三端）。

本文档说明如何搭建开发环境、遵循的代码规范、自动执行的质量门，以及如何让你的改动被合并。

> English version: [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 目录

- [开发环境](#开发环境)
- [快速开始](#快速开始)
- [常用命令](#常用命令)
- [项目结构](#项目结构)
- [代码规范](#代码规范)
- [测试驱动开发（TDD）](#测试驱动开发tdd)
- [提交信息规范](#提交信息规范)
- [质量门（Quality Gates）](#质量门quality-gates)
- [测试要求](#测试要求)
- [分支与 Pull Request](#分支与-pull-request)
- [文档](#文档)
- [发布流程](#发布流程)

---

## 开发环境

| 工具 | 版本 |
| --- | --- |
| Node.js | `>=24` |
| pnpm | `11.25.0` |
| Rust | edition 2021（stable） |
| Tauri | 2.0 |

> 具体版本以 `package.json` 的 `engines` / `packageManager` 字段为准，此处仅为快照。

请先按平台安装 Tauri 的系统依赖：

- **macOS**：Xcode Command Line Tools（`xcode-select --install`）
- **Linux**：WebKitGTK / GTK / AppIndicator / librsvg / patchelf
- **Windows**：Microsoft C++ Build Tools + WebView2

详见 [Tauri 前置依赖指南](https://v2.tauri.app/start/prerequisites/)。

## 快速开始

```bash
pnpm install          # 安装前端依赖
pnpm tauri dev        # 启动开发模式（前端端口 1420）
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm tauri dev` | 运行开发模式 |
| `pnpm tauri build` | 构建发布版本 |
| `pnpm lint` | 全部静态检查：`lint:fe` + `lint:rust`（不含测试） |
| `pnpm lint:fe` | 前端静态检查（ESLint + `tsc --noEmit`） |
| `pnpm lint:rust` | Rust 静态检查（`cargo fmt --check` + `clippy -D warnings`） |
| `pnpm lint:rust:all-targets` | 含测试目标的 Rust 静态检查（`clippy --all-targets -D warnings`）—— CI 跑的那条 |
| `pnpm lint:fix` | 写回修复：`cargo fmt`（Rust）+ ESLint `--fix`（前端） |
| `pnpm type-check` | 仅 TypeScript 类型检查 |
| `pnpm test` | 全部测试：`test:fe` + `test:rust` + `test:host` |
| `pnpm test:fe` | 运行一次前端测试（监听用 `test:fe:watch`） |
| `pnpm test:fe:coverage` | 带覆盖率跑前端测试 —— 会执行 `vitest.config.ts` 里的地板 |
| `pnpm test:rust` | 运行 Rust 测试 |
| `pnpm test:rust:coverage` | 带覆盖率跑 Rust 测试 —— 执行 `package.json` 里的 `--fail-under-lines` |
| `pnpm test:coverage` | 两套覆盖率 |
| `pnpm test:host` | Java 调试 host 自检（需 JDK，缺失时明确跳过） |
| `pnpm check` | 全量：`lint` + `test` |
| `pnpm check:quick` | 开发循环的默认命令：`lint:fe` + `lint:rust` + `test:fe` |
| `pnpm release <version>` | 升级版本、生成 changelog、打 tag（见[发布流程](#发布流程)） |

覆盖率由 **CI 把关**：`frontend-test` job 跑 `pnpm test:fe:coverage`、`backend-coverage` job 跑
`pnpm test:rust:coverage`（仅当 PR 动了 `src-tauri/**` 或 `package.json`），地板下滑会在 CI 失败。
改动带 per-file pin 的文件、或新增未测试的 Rust 代码时，本地也跑一遍同一条命令（Rust 地板只有
~1.75pt 余量）。

## 项目结构

后端目录树与模块职责的**单一事实源**是 `src-tauri/AGENTS.md`，本文不复述（维护副本必然漂移）：

- 后端（Domain-Driven）：`src-tauri/AGENTS.md`「模块布局」

目录清单请用 `ls` / Glob 现取 —— 根 `AGENTS.md`「顶层目录」已把这条定为元规则。

## 代码规范

规范的**单一事实源**是仓库根的 [`AGENTS.md`](./AGENTS.md)：15 条「审查红线」都在那里，
每条规则的正文只存在于一个 `AGENTS.md` 文件。本文只给落点索引：

| 主题 | 权威落点 |
| --- | --- |
| 架构原则（高内聚低耦合 / 依赖倒置 / OCP / DRY-KISS-YAGNI） | `AGENTS.md`「架构基本原则」 |
| 15 条审查红线（违反即 Block，编号可被代码注释引用） | `AGENTS.md` 红线表（编号 → 摘要 → 落点） |
| 后端命令层、错误与并发 | `src-tauri/AGENTS.md`「Rust 命令层约定」「错误与并发」 |

> 2026-09-25 前本文逐条复述了上述条文，已证明会漂移（当时副本里的 `pnpm lint` 描述、前端
> 目录树都是错的），故改为落点索引。新增规范请改落点文件，不要再往本文加副本。

## 测试驱动开发（TDD）

红 → 绿 → 重构的流程、分层覆盖率基线（纯函数 / Rust manager / Hooks / 组件）与硬约束
（无测试不许合入、测试独立且单个 < 100ms）见 [`AGENTS.md`](./AGENTS.md)「TDD 开发模式」
—— 那是单一事实源，本文不复述。

本仓库所有新功能与 Bug 修复都必须遵循该流程；Bug 修复从复现该 Bug 的回归测试开始。

## 提交信息规范

遵循 **Conventional Commits 1.0.0**，规则写在 `commitlint.config.ts`，可用
`pnpm commitlint --edit <file>` 本地校验：

```text
<type>(<scope>): <subject>

<body>

<footer>
```

### 允许的类型

`feat`、`fix`、`refactor`、`chore`、`docs`、`style`、`perf`、`test`、
`build`、`ci`、`revert`、`wip`

- **feat** —— 新功能
- **fix** —— Bug 修复
- **refactor** —— 代码重构（非修 Bug、非新功能）
- **chore** —— 维护（依赖、配置等）
- **docs** —— 仅文档
- **style** —— 格式调整（无逻辑变更）
- **perf** —— 性能优化
- **test** —— 新增/修改测试
- **build** / **ci** —— 构建系统 / CI 变更
- **revert** —— 回滚提交
- **wip** —— 进行中（临时）

### 规则

- **Scope** 可选但鼓励（如 `feat(search): ...`）。
- **Subject** 简短（≤ 50 字符）、祈使句、结尾无标点，中英文均可。
- 复杂改动使用 **Body**：说明"为什么改"和"怎么改"。
- 破坏性变更在 type 后加 `!`，并以 `BREAKING CHANGE:` 页脚标注。
- 关联 Issue 写在页脚（如 `Closes #123`）。

### 示例

```text
feat(search): add find-in-files content search panel

Add a full-text search panel (Ctrl+Shift+F) that works across local,
WSL and SSH projects.
```

```text
fix(file): refresh expanded dir caches on file move/delete
```

保持提交**原子化**：把不相干的改动拆分为多个独立提交。

## 质量门（Quality Gates）

本仓库**没有本地 git hook**。门禁在 CI（`.github/workflows/ci.yml`），每条门禁都是一个具名脚本，
因此任何一条结论都能在本地用同一条命令复现：

| 门禁 | 脚本 | CI job |
| --- | --- | --- |
| 前端静态检查 | `pnpm lint:fe` | `frontend-check` |
| 前端测试 + 覆盖率 | `pnpm test:fe:coverage` | `frontend-test` |
| Rust 静态检查（全目标） | `pnpm lint:rust:all-targets` | `backend-check` |
| Rust 测试 | `pnpm test:rust` | `backend-test` |
| Rust 覆盖率 | `pnpm test:rust:coverage` | `backend-coverage` |
| Java host 自检 | `pnpm test:host` | `java-host-check` |

开 PR 前请在本地跑一遍**最小回归集** —— 定义见 [`AGENTS.md`](./AGENTS.md)「Development Commands」
（单一事实源，此处不复述）。

新增门禁需要同时动三处：`package.json` 加脚本、`.github/workflows/ci.yml` 加 job 步骤、
`.github/BRANCH_PROTECTION.md` 加 required check（若需阻塞合并）。只改一处会得到一条看起来存在、
实际不触发的门。

## 测试要求

分层覆盖率基线见 [`AGENTS.md`](./AGENTS.md)「TDD 开发模式」。

本文只保留其它落点没有的一条：

- 涉及文件系统的 Rust 测试使用 `tempfile`，**严禁**写入真实的 `~/.neeko` 配置。

## 分支与 Pull Request

1. 从 `main` 创建分支（如 `feat/<short-name>` 或 `fix/<short-name>`）。
2. 按 TDD 实现，保持提交原子化且符合 Conventional 规范。
3. 本地跑通完整质量门（见[质量门](#质量门quality-gates)）。
4. 向 `main` 发起 PR，清晰描述改动内容与原因。
5. 保持 PR 聚焦单一关注点；大改动请拆分。

## 文档

- 行为变更时同步更新相关文档：
  - `AGENTS.md` —— 项目上下文与规范单一事实源
  - `README.md` —— 面向用户的功能清单
- 项目维护中英双语文档（`README.md` / `README_CN.md`、
  `CONTEXT.md` / `CONTEXT_CN.md`）。新增文档时建议同时提供中英两个版本。

## 发布流程

发布由 `pnpm release <version>`（`scripts/release.mjs`）驱动，它会：

1. 同步升级 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`
   三处版本号。
2. 用 `git-cliff`（配置在 `cliff.toml`）生成 `CHANGELOG.md`。
3. 提交 `release: v<version>` 并打 tag `v<version>`。

推送 tag 会触发 GitHub Actions 构建 Windows / macOS / Linux 三平台并发布
GitHub Release（含各平台安装包）。仅拥有推送权限的维护者执行发布。
