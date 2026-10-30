# Contributing to Neeko

Thanks for your interest in contributing to **Neeko** — a Tauri 2.0 + React 18
desktop app that unifies multi-project AI agent sessions (Local / WSL / SSH).

This guide covers how to set up the project, the coding conventions we enforce,
the quality gates that run automatically, and how to get your changes merged.

> 中文版见 [CONTRIBUTING_CN.md](./CONTRIBUTING_CN.md)

---

## Table of Contents

- [Development Environment](#development-environment)
- [Quick Start](#quick-start)
- [Common Commands](#common-commands)
- [Project Structure](#project-structure)
- [Coding Conventions](#coding-conventions)
- [Test-Driven Development](#test-driven-development)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Quality Gates](#quality-gates)
- [Testing Requirements](#testing-requirements)
- [Branching & Pull Requests](#branching--pull-requests)
- [Documentation](#documentation)
- [Release Process](#release-process)

---

## Development Environment

| Tool | Version |
| --- | --- |
| Node.js | `>=24` |
| pnpm | `11.25.0` |
| Rust | edition 2021 (stable) |
| Tauri | 2.0 |

> Exact versions are owned by the `engines` / `packageManager` fields in
> `package.json`; the table above is only a snapshot.

Install the Tauri system prerequisites for your platform first:

- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: WebKitGTK / GTK / AppIndicator / librsvg / patchelf
- **Windows**: Microsoft C++ Build Tools + WebView2

See the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)
for details.

## Quick Start

```bash
pnpm install          # install frontend dependencies
pnpm tauri dev        # start the dev app (frontend on port 1420)
```

## Common Commands

| Command | Purpose |
| --- | --- |
| `pnpm tauri dev` | Run the app in development mode |
| `pnpm tauri build` | Build a release bundle |
| `pnpm lint` | All static checks: `lint:fe` + `lint:rust` (no tests) |
| `pnpm lint:fe` | Frontend static checks (ESLint + `tsc --noEmit`) |
| `pnpm lint:rust` | Rust static checks, lib-only (`cargo fmt --check` + `clippy -D warnings`) |
| `pnpm lint:rust:all-targets` | Rust static checks incl. test targets (`cargo fmt --check` + `clippy --all-targets -D warnings`) — what CI runs |
| `pnpm lint:fix` | Write-back fixes: `cargo fmt` (Rust) + ESLint `--fix` (frontend) |
| `pnpm type-check` | TypeScript type check only |
| `pnpm test` | All tests: `test:fe` + `test:rust` + `test:host` |
| `pnpm test:fe` | Frontend tests once (`test:fe:watch` for watch) |
| `pnpm test:fe:coverage` | Frontend tests with coverage — enforces the floors in `vitest.config.ts` |
| `pnpm test:rust` | Run Rust tests |
| `pnpm test:rust:coverage` | Rust tests with coverage — enforces `--fail-under-lines` from `package.json` |
| `pnpm test:coverage` | Both coverage gates |
| `pnpm test:host` | Java debug host self-check (needs a JDK; skips loudly otherwise) |
| `pnpm check` | Everything: `lint` + `test` |
| `pnpm check:quick` | The default development loop: `lint:fe` + `lint:rust` + `test:fe` |
| `pnpm release <version>` | Bump version, generate changelog, tag (see [Release](#release-process)) |

Coverage is a **CI gate**: `frontend-test` runs `pnpm test:fe:coverage` and
`backend-coverage` runs `pnpm test:rust:coverage` (only when a PR touches
`src-tauri/**` or `package.json`), so a floor that slips fails in CI.
Run the same command locally when you touch a file that has a per-file pin in
`vitest.config.ts`, or add untested Rust code (the floor has ~1.75pt of headroom,
not more).

## Project Structure

`src-tauri/AGENTS.md` is the **single source of truth** for the backend directory
tree and module responsibilities; this guide does not restate it (copies drift):

- Backend (Domain-Driven): `src-tauri/AGENTS.md` → "模块布局"

List directories with `ls` / Glob instead of maintaining a copy — the root
`AGENTS.md` "顶层目录" section makes that a standing rule.

## Coding Conventions

The **single source of truth** for conventions is [`AGENTS.md`](./AGENTS.md) at
the repo root: its 15 "review red lines" live there, and every rule's full text
lives in exactly one `AGENTS.md` file. Below is a location index only:

| Topic | Authoritative location |
| --- | --- |
| Architecture principles (cohesion/coupling, DIP, OCP, DRY-KISS-YAGNI) | `AGENTS.md` → "架构基本原则" |
| The 15 review red lines (Block-level; cite by number) | `AGENTS.md` red-line table (number → summary → home) |
| Backend command layer, errors & concurrency | `src-tauri/AGENTS.md` → "Rust 命令层约定", "错误与并发" |

> Before 2026-09-25 this guide restated all of the above and demonstrably drifted
> (the stale copy described `pnpm lint` wrong and listed an outdated frontend
> tree), so it is now an index. Add new conventions to the owning file — never a
> copy here.

## Test-Driven Development

The Red → Green → Refactor loop, the per-layer coverage baseline (pure functions /
Rust managers / hooks / components) and the hard constraints (no code without
tests; tests independent and < 100ms each) live in [`AGENTS.md`](./AGENTS.md) →
"TDD 开发模式" — the single source of truth, not restated here.

All new features and bug fixes in this repo must follow that loop; bug fixes start
with a regression test.

## Commit Message Guidelines

We follow **Conventional Commits 1.0.0**. `pnpm commitlint --edit <file>` checks a
message locally; the same rules are in `commitlint.config.ts`:

```text
<type>(<scope>): <subject>

<body>

<footer>
```

### Allowed types

`feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `perf`, `test`, `build`,
`ci`, `revert`, `wip`

- **feat** — new feature
- **fix** — bug fix
- **refactor** — code refactoring (no bug fix, no new feature)
- **chore** — maintenance (deps, config, etc.)
- **docs** — documentation only
- **style** — formatting (no logic change)
- **perf** — performance improvement
- **test** — adding/fixing tests
- **build** / **ci** — build system / CI changes
- **revert** — revert a commit
- **wip** — work in progress (temporary)

### Rules

- **Scope** is optional but encouraged (`feat(search): ...`).
- **Subject** is short (≤ 50 chars), imperative, no trailing period.
  Subject may be in English or Chinese.
- Use a **body** for complex changes: explain *why* and *how*.
- Mark breaking changes with `!` after the type and a `BREAKING CHANGE:`
  footer.
- Reference issues in the footer (e.g. `Closes #123`).

### Examples

```text
feat(search): add find-in-files content search panel

Add a full-text search panel (Ctrl+Shift+F) that works across local,
WSL and SSH projects.
```

```text
fix(file): refresh expanded dir caches on file move/delete
```

Keep commits **atomic**: split unrelated changes into separate commits.

## Quality Gates

There are **no local git hooks**. The gate is CI (`.github/workflows/ci.yml`),
and every gate is one named script, so a gate's verdict can be reproduced
locally by running that script:

| Gate | Script | CI job |
| --- | --- | --- |
| Frontend static checks | `pnpm lint:fe` | `frontend-check` |
| Frontend tests + coverage | `pnpm test:fe:coverage` | `frontend-test` |
| Rust static checks (all targets) | `pnpm lint:rust:all-targets` | `backend-check` |
| Rust tests | `pnpm test:rust` | `backend-test` |
| Rust coverage | `pnpm test:rust:coverage` | `backend-coverage` |
| Java host self-check | `pnpm test:host` | `java-host-check` |

Before opening a PR, run the **minimal regression set** locally — its definition
lives in [`AGENTS.md`](./AGENTS.md) → "Development Commands" (single source of
truth, not restated here).

Adding a gate means adding a script to `package.json`, a job step to
`.github/workflows/ci.yml`, and — if it must block merges — an entry in
`.github/BRANCH_PROTECTION.md`. Changing only one of the three yields a gate that
looks present and never fires.

## Testing Requirements

The per-layer coverage baseline lives in [`AGENTS.md`](./AGENTS.md) → "TDD 开发模式".

This guide keeps only the rule that has no other home:

- Use `tempfile` for Rust tests that touch the filesystem, and **never** write to
  the real `~/.neeko` config in tests.

## Branching & Pull Requests

1. Create a branch from `main` (e.g. `feat/<short-name>` or `fix/<short-name>`).
2. Implement following TDD, keeping commits atomic and Conventional.
3. Run the full quality gate locally (see [Quality Gates](#quality-gates)).
4. Open a PR against `main` with a clear description of the change and why.
5. Keep the PR focused on a single concern; split large changes.

## Documentation

- Update the relevant docs when behavior changes:
  - `AGENTS.md` — single source of truth for project context & conventions
  - `README.md` — user-facing capability inventory
- The project maintains bilingual docs (`README.md` / `README_CN.md`,
  `CONTEXT.md` / `CONTEXT_CN.md`). When adding a doc, consider providing both
  language versions.

## Release Process

Releases are driven by `pnpm release <version>` (`scripts/release.mjs`), which:

1. Bumps the version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`.
2. Generates `CHANGELOG.md` via `git-cliff` (config in `cliff.toml`).
3. Commits `release: v<version>` and tags `v<version>`.

Pushing the tag triggers GitHub Actions to build Windows / macOS / Linux and
publish a GitHub Release with installers. Only maintainers with push access run
releases.
