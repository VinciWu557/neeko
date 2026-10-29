# README 重写与文档防漂移

> 任务目录：`.trellis/tasks/10-28-readme-rework/` · 优先级 P2 · 状态 planning
> 输入：2026-10-28 会话产出的《README 落后分析 & 调整方案》（本任务 §1 摘要其结论）

---

## 1. 背景（为什么现在做）

### 1.1 落后幅度（量化）

| 指标 | 事实 |
| --- | --- |
| README 内容截止 | **2026-08-24**（`be998d89` 只把 Node 18+ 改成 22+） |
| 当前 HEAD | 2026-10-28 |
| 该次更新之后的提交数 | **828**（`git rev-list --count HEAD --since=2026-08-24`） |
| 自 v1.0.6 以来的提交数 | **898**（`git rev-list --count v1.0.6..HEAD`） |
| README 长度 | EN 149 行 / CN 149 行 |

### 1.2 产品形态已变（README 叙事失真）

旧叙事：「左侧边栏管项目与 Git，右侧是每个项目的独立终端」。
实际：dock 三栏 "IDEA Islands" + 中心 9 类 tab + 8 个 dock 面板 + 3 个底部面板 + 9 项状态栏；
已有编辑器、LSP、调试、运行/测试、Agent Chat、资源库（skill/prompt/MCP）、PR、浏览器、会话历史、通知、CLI Hooks、AI 翻译。
证据：`src/app/shell/AppShell.tsx`、`src/shared/dock/panelMeta.ts`、`src/shared/types/tab.ts`、`src/app/panels/registry.ts`。

### 1.3 已核实的 P0 事实错误（照做会失败或误导）

| # | README 现文 | 事实 | 证据 |
| --- | --- | --- | --- |
| 1 | Rust 1.70+（中英） | 1.99.0，且刻意钉死（CI 同源） | `rust-toolchain.toml` |
| 2 | 中文版 Node 22+ | 24（英文已改，中文漏改） | `package.json` engines / `.nvmrc` |
| 3 | `libappindicator3-dev` | CI 用 `libayatana-appindicator3-dev`（Ubuntu 24.04 无前者） | `.github/workflows/build.yml` |
| 4 | 快捷键表 7 条 | `Ctrl+R`→实为 `Ctrl+Alt+R`；`Ctrl+W`=关闭标签页；`Ctrl+Alt+T` 无绑定（仅存于 action menu 旧文案）。真实表 26 项、5 分类、可自定义 | `src/shared/utils/shortcutRegistry.ts` |
| 5 | 主题 4 个，仅同步 OpenCode | 5 内置 + 自定义主题；同步 OpenCode **和 Pi**，本地/WSL/远程 | `src/shared/types/settings.ts`、`src-tauri/src/theme/service.rs` |
| 6 | Preset Agents 6 个 | **11 个**（+omp/pi/reasonix/grok/mockAgent） | `src-tauri/src/agent/builtin/providers.rs` |
| 7 | 技术栈「Pure CSS / One Dark Pro」+ xterm 仅 fit | Tailwind v4 + CSS 变量分层；缺 CodeMirror 6/LSP/DAP/SQLite/Radix+shadcn/zustand/mermaid/PlantUML/gitgraph/TipTap/resizable-panels；xterm 还有 webgl/canvas/unicode11/weblinks | `package.json`、`src/styles/README.md` |
| 8 | 左栏 + 右侧终端 | dock 三栏 islands + 底部面板 + 状态栏 | 同 §1.2 |
| 9 | 副终端 `Ctrl+Alt+T` / `Ctrl+W` | 功能在（action menu），两个快捷键均不成立 | 同 #4 |

### 1.4 已核实的 P1 能力缺失

编辑器/Files、LSP（16 语言族）、调试（Go/Java/Rust）、运行与测试（Go/Java/Rust/TS）、任务与 Console、Agent Chat（4 条传输）、资源库（skill/prompt/MCP + skills.sh + MCP Registry）、PR 面板（gh）、git log graph/stash/冲突/commit、浏览器（+元素拾取）、会话历史（扫描/恢复/导出）、通知（含 macOS 点击穿透）、CLI Hooks、AI 注释翻译与文档翻译、状态栏信息架构。

### 1.5 已核实的 P2 结构与运营问题

- 无下载安装入口：`build.yml` 已在打 tag 时产出 `.exe/.msi/.dmg/.AppImage/.deb` 并发布 Release（body 含 macOS Gatekeeper 说明），README 只教源码构建；无 updater。
- 截图 4 张全部 2026-05-02（旧 UI），`skills.png` 用于 "Skills Panel" 但功能列表无 Skills。
- 中英双份漂移（Node 版本、worktree 描述、术语不一致），且无「以哪份为准」声明。
- CHANGELOG 停在 1.0.6（v1.0.7–1.0.9 未跑 `pnpm release`），因此当前不可链。
- 无 roadmap / FAQ / 平台矩阵 / 开发者门禁段；`CONTRIBUTING`、`docs/ARCHITECTURE.md`、`AGENTS.md` 均未链。
- **结构性原因**：README 手抄了会漂移的表（版本/快捷键/agent 清单），且无任何校验 → 必然再漂。

---

## 2. 目标

| # | 目标 | 成功信号 |
| --- | --- | --- |
| G1 | 陌生用户 30 秒知道「这是什么、和终端多开有什么不同」 | 首屏含一句话定位 + 1 张主壳图 + 下载入口 |
| G2 | 评估者 3 分钟知道「能干什么 + 凭什么信」 | 六组任务视角能力清单（各带可验证数字）+ 平台矩阵 |
| G3 | 使用者 1 分钟装起来 | 下载段在源码段之前；三平台安装步骤 + macOS 首启提示 |
| G4 | 贡献者 30 分钟进入开发 | 开发段：`pnpm check:quick`、`rust-toolchain`、目录规范、`AGENTS.md` |
| G5 | 文档不再随代码漂移 | `docs/features.md` 单一事实源 + `check_readme_claims` 护栏 + 截图拍摄触发点 |

---

## 3. 非目标

1. 不改产品代码与 UI（仅文档 + 护栏脚本）。
2. 不写 roadmap 承诺（`07-26-unified-task-hub` 仍在 planning，不得出现）。
3. 不做截图自动化流水线（fixture 一次一跑即可）。
4. 不重构 `docs/`（只新增 `docs/features.md`），不动 `.trellis/spec/**` 既有条目（除 §implement D4 注明的一处可选补充）。
5. 不翻译代码注释 / spec 文档。
6. 不修改 `cliff.toml`、不改 `scripts/release.mjs` 的既有流程。

---

## 4. 已拍板决策（本轮不再讨论）

| # | 决策 | 结论 |
| --- | --- | --- |
| D1 | 定位措辞 | 「AI-native 项目工作台」：terminal + editor + agent chat + library |
| D2 | 截图预算 | **3 张壳级截图 + 1 张能力地图 SVG**，不追加 |
| D3 | 截图来源 | **fixture 假项目**（HOME 隔离启动），不使用真实项目数据 |
| D4 | CHANGELOG | 用 `git-cliff` 重生成（工具已在库、`release.mjs` 已用），不手写、不加新依赖 |
| D5 | 防漂移 | 上 `check_readme_claims` 护栏（5 条窄判据） |
| D6 | 任务结构 | 单任务，不拆父子（同一套文件、同一评审人） |
| D7 | 双语策略 | EN 为源、CN 镜像；顶部互相声明；版本/安装/清单段落逐字对齐 |

---

## 5. 交付物（4 条工作流）

| 流 | 交付 | 路径 |
| --- | --- | --- |
| A | README 重写（EN + CN） | `README.md`、`README_CN.md` |
| B | 3 张壳级截图 + 1 张能力地图 | `docs/.img/shell-projects.webp`、`shell-agent-chat.webp`、`shell-library.webp`、`docs/.img/capability-map.svg` |
| C | CHANGELOG 重生成 | `CHANGELOG.md` |
| D | 能力事实源 + 护栏 | `docs/features.md`、`tools/guards/checks/check_readme_claims.py` |

---

## 6. 验收标准

| # | 验收项 | 判据 |
| --- | --- | --- |
| AC1 | 三问测试 | 3 位不了解项目的人分别在 30s / 3min / 30min 内答对「是什么」「怎么装」「能干什么」 |
| AC2 | 无失效快捷键副本 | README 内不出现快捷键绑定表；只链 `docs/keyboard-shortcuts.md`（由护栏强制） |
| AC3 | 版本事实一致 | README 的 Node/pnpm/Rust 与 `engines.node` / `packageManager` / `rust-toolchain.toml` 一致（护栏强制） |
| AC4 | 图片规格 | 3 张 WebP 各 ≤300KB，SVG ≤100KB；`docs/.img/shell-*.webp` 存在且被 README 引用（护栏强制存在性） |
| AC5 | CHANGELOG | 含 `## [1.0.9]` 段；EN/CN README 均链到它且链接可解析 |
| AC6 | 门禁绿 | `pnpm check:quick` 通过（含新护栏） |
| AC7 | 护栏有效性 | 篡改 README 版本号 / agent 数量 / 加回快捷键表 / 删图 → 各自红；还原 → 绿（4 正例 + 4 反例） |
| AC8 | 双语结构一致 | EN/CN 的 `##` 标题序列完全相同（可脚本比对），正文语义等价 |
| AC9 | 链接完整 | README 内所有相对路径链接在仓库中可解析（脚本比对） |
| AC10 | 无未上线承诺 | README 不出现未归档任务名、未实现功能、"即将支持"类文案 |
| AC11 | 无隐私泄漏 | 截图中不含真实用户名/家目录/主机名/IP/git remote |

---

## 7. 依赖与前置

- **G0 前置闸门（截图）**：需实测「HOME 隔离启动 + 窗口捕获」可行（见 `design.md` §3.3）。若不可行 → 停下回到用户确认改用「用户自拍」路径，不得用真实项目数据凑数。
- 计划中的规划文档：`design.md`（信息架构 + 事实锚点 + 截图/护栏设计）、`implement.md`（A→B→C→D 顺序与验证）。

## 8. 参考

- `docs/keyboard-shortcuts.md`（「README 不复制绑定表」的既有先例）
- `tools/guards/checks/check_script_references.py`（文档中引用的命令必须真实存在 —— 本任务护栏的同族先例）
- `AGENTS.md`（不主动提交、收尾只跑 `pnpm check:quick`）
