# 设计：README 重写与防漂移

> 权威设计文档。实现与检查都以本文件为准；`prd.md` 只定义需求与验收。
> 关联：`implement.md`（执行顺序）、`docs/features.md`（本任务产出的单一事实源）。

---

## 1. README 信息架构（IA）

### 1.1 三层读者与首屏预算

| 读者 | 停留 | 首屏（第 1 屏内）必须出现 | 后续落点 |
| --- | --- | --- | --- |
| 潜在用户 | 30s | 一句话定位 + 徽章行 + **下载按钮** + 主壳图 | §Install |
| 评估者 | 3min | 六组能力清单（每条带数字）+ 平台矩阵 | §Features / §Platform |
| 贡献者 | 30min | `pnpm check:quick` + 工具链来源 + 目录规范链接 | §Develop / §Architecture |

### 1.2 章节树与字数预算（EN 版为准，CN 同构）

| # | 章节 | 职责 | 预算 |
| --- | --- | --- | --- |
| 0 | 标题区 | 名称 + 副标题 + 徽章 + 语言切换 | ≤12 行 |
| 1 | `What is Neeko` | 3 句：场景痛点 → 一句话方案 → 与"终端多开"的差异 | ≤8 行 |
| 2 | `Preview` | 主壳图（大）+ 2 张壳级图（并排）+ 能力地图 | ≤12 行 |
| 3 | `Install` | **A 下载安装**（Win/mac/Linux + macOS 首启提示）/ B 源码构建 | ≤35 行 |
| 4 | `Features` | 六组，每组 4–6 条，每条 1 行（含数字/语言列表） | ≤70 行 |
| 5 | `Platform Support` | 能力 × 平台矩阵（含 WSL=Windows only、调试语言） | ≤12 行 |
| 6 | `Reference` | 快捷键 → `docs/keyboard-shortcuts.md`；设置/主题/agent/IDE 各一行 | ≤12 行 |
| 7 | `Architecture` | 三域一句话 + 链 `docs/ARCHITECTURE.md`、`CONTEXT.md` | ≤8 行 |
| 8 | `Develop` | 最小门禁 `pnpm check:quick`、TDD、目录规范、`AGENTS.md`、`CONTRIBUTING` | ≤15 行 |
| 9 | `Community` | Issues / Discussions / CoC / 变更记录（链 CHANGELOG） | ≤8 行 |
| 10 | `License` | Apache 2.0 + 商用一个短句（引用 LICENSE） | ≤4 行 |

**硬规则**

1. 不出现快捷键绑定表（只链 `docs/keyboard-shortcuts.md`）。
2. 不出现"即将支持 / coming soon / roadmap"承诺。
3. 每条能力必须可验证：写完立刻在 §2 锚点表找到对应代码位置，找不到就删。
4. 中英段落一一对应（`##` 标题序列必须完全一致）。

### 1.4 排版约定（2026-10-28 排版专项）

| # | 约定 | 理由 |
| --- | --- | --- |
| F1 | 首屏徽章拆两行：产品（Release/License/Platform）｜技术栈（Tauri/React/Rust） | 6 枚一行在窄视口折行难看，两行分组有语义 |
| F2 | `---` 之后加一行扁平目录（`**Jump to**` / `**目录**`，` · ` 分隔，**不上二级列表**） | 10 个 H2 的文档需要跳转入口；一行不占版面预算 |
| F3 | 图注与小字说明用 `<sub>`，不写加粗段落 | 视觉上从属于图片/表格，不与正文抢层级 |
| F4 | 列表统一 `- **术语** — 说明`（EN）/ `- **术语** —— 说明`（CN），每条一组、组内 4–6 条 | 扫读时左边缘对齐 |
| F5 | CN 标点：引号用「」、括号全角、破折号 `——` 前后留一个空格；术语（Agent/Skill/worktree/Diff）保留英文 | 与 EN 术语一一对应，避免二次译名 |
| F6 | Features 段无「条目数量」声明之外的数字改动；任何数字变更先改 `docs/features.md` | 数字的唯一事实源不放 README |

### 1.3 六组能力的边界（写什么 / 不写什么）

| 组 | 标题（EN / CN） | 写 | 不写 |
| --- | --- | --- | --- |
| ① | Projects & Connections / 多项目与连接 | 本地·WSL·SSH 三类、worktree、重启恢复、拖拽排序 | SSH 凭据存储实现、session 文件格式 |
| ② | Terminal & Agents / 终端与 Agent | 独立 PTY、10 CLI Agent + 自定义、一键切换、split、副终端、CLI Hooks、主题同步 | PTY 缓存策略、libc echo 控制 |
| ③ | Agent Chat / Agent 对话 | 多 agent、4 条传输（opencode serve / Pi RPC / ACP / jsonl）、tool 卡片、审批、模型选择、resume、附件、slash/@ | 协议细节、`ChatLaunch` 派发规则 |
| ④ | Coding / 编码 | 编辑器、LSP 16 语言、调试 3 语言、运行/测试 4 语言、任务与 Console、AI 注释/文档翻译 | LSP 三通道模型、DAP 适配器实现 |
| ⑤ | Version Control / 版本控制 | 变更树、diff 模式、branch/worktree/stash/冲突、commit（含 AI 生成 message）、log graph、PR（需 `gh`） | git2 与 CLI 混用原因 |
| ⑥ | Library & Signals / 资源与信息 | skill/prompt/MCP、skills.sh、MCP Registry、插入 prompt、浏览器+拾取、会话历史、通知、状态栏 | 同步引擎实现、SQLite 表结构 |

---

## 2. 事实锚点表（claim registry）

> 这是 README 与 `docs/features.md` 的共同数据源，也是护栏判据的来源。
> **原则**：能被机器校验的只留 4 类（版本/清单/图存在/关键词），其余靠"改代码时读锚点"。

| Claim | 唯一事实源 | README 展示形态 | 机器校验 |
| --- | --- | --- | --- |
| Rust 版本 | `rust-toolchain.toml` `channel` | "Rust (pinned via `rust-toolchain.toml`)" **不写数字** | ✅ 若出现数字必须相等 |
| Node 版本 | `package.json` `engines.node` + `.nvmrc` | "Node 24+" | ✅ 相等 |
| pnpm 版本 | `package.json` `packageManager` | "pnpm 11+" | ✅ 主版本相等 |
| 内置 CLI Agent（10） | `src-tauri/src/agent/builtin/providers.rs` | 名称清单 + 数量 | ✅ 数量 + 名称集合 |
| MockAgent（1） | 同上（`id: "mockAgent"`） | 单独一句"内置 MockAgent 可无 CLI 试用 Chat" | ✅ 存在性 |
| IDE 预设（7） | `src/shared/utils/idePresets.ts` | 名称清单 | ⛔ 人工（低频） |
| 主题（5 + 自定义） | `src/shared/types/settings.ts` `BUILTIN_THEMES` | 名称清单 | ✅ 数量相等 |
| 快捷键（26） | `src/shared/utils/shortcutRegistry.ts` | **只链文档，不列** | ✅ 反向检查：README 不得出现绑定表 |
| LSP 语言（16） | `src-tauri/src/lsp/plugin/builtins/all.rs` | `models()` 数量 | ⛔ 人工 |
| 调试语言（Go/Java/Rust） | `src-tauri/src/dap/adapter/`（go/lldb/java） | 列表 | ⛔ 人工 |
| 运行/测试语言（Go/Java/Rust/TS） | `src/features/runner/languages/` | 列表 | ⛔ 人工 |
| Tab 类型（9） | `src/shared/types/tab.ts` | 不列（读者不关心） | — |
| dock 面板（8） | `src/shared/dock/panelMeta.ts` | 只在能力地图里出现 | ⛔ 人工 |
| 版本号 | `package.json` `version` | 徽章（release 链接）+ Install 段 | ✅ 与 tag 提示一致（弱校验） |
| 平台支持 | `.github/workflows/build.yml` matrix | 矩阵表 | ⛔ 人工 |
| 截图文件 | `docs/.img/shell-*.webp` | `<img>` 引用 | ✅ 文件存在 |

**"不写数字"策略**：Rust 版本写"pinned via rust-toolchain.toml"而不是"1.99+"，把最易漂的项变成链接式表述；Node/pnpm 写主版本（升级时护栏会提示）。

---

## 3. 截图设计（B）

### 3.1 三张壳级题材

| 文件 | 构图 | 为什么要这张 | 明确不拍 |
| --- | --- | --- | --- |
| `shell-projects.webp` | 整窗：左 Projects（2 假项目 + 1 worktree）/ 中终端 tab / 右 Git Control / 底部状态栏 | 一图交代"多项目 + 工作台"的核心承诺 | 设置页、下拉菜单、hover 态 |
| `shell-agent-chat.webp` | 整窗：Agent Chat tab（含 1 张 tool 卡片 + 模型选择器）+ 左栏 | 差异化第一名 | 长对话流、审批弹窗细节 |
| `shell-library.webp` | 整窗：Library（skills 列表 + 详情） | 生态感 + 与 prompt/MCP 的关系靠文字表达 | MCP 表单、市场分页 |

**共同纪律**：整窗截图、无红框标注、无光标、无通知横幅、无个人路径、图注只写"是什么"（不写快捷键、不写交互步骤）。

### 3.2 图像规格

- 源：Retina 全窗（macOS `maximized: true`）→ 缩放到 **1600px 宽**。
- 格式：WebP，质量 80–84，目标 ≤300KB/张（当前 3 张 PNG 共 1.6MB）。
- 命名带壳版本：`shell-<subject>.webp`；壳版本记在 README 的 HTML 注释行：
  `<!-- shots: 2026-10, app 1.0.9, shell: dock-islands -->`
- 保留原始 PNG？**不保留**（只提交 WebP，避免仓库膨胀）。

### 3.3 fixture 启动方案（HOME 隔离，避免暴露真实数据）

现状约束：
- 会话持久化路径写死 `~/.neeko/sessions.json`（`src-tauri/src/session/manager.rs` `StorageManager::new()`，无 env 覆盖）。
- 因此**不碰用户真实 `~/.neeko`**，改用 HOME 重定向：

```bash
# 1) 生产前端产物（debug 二进制用 dist/，不走 devUrl）
pnpm build
# 2) 编译 debug 二进制（不打包，快）
cargo build --manifest-path src-tauri/Cargo.toml
# 3) 在隔离 HOME 下启动
mkdir -p /tmp/neeko-shot/home/.neeko
HOME=/tmp/neeko-shot/home ./src-tauri/target/debug/neeko
```

- fixture 项目：`/tmp/neeko-shot/projects/{atlas,beacon}` 两个真实 git 仓库（真实 commit，让 Git 面板/装饰有内容），`atlas` 下再造 1 个 worktree（`git worktree add ../atlas-experiment`）。
- 预置 `sessions.json`：手写 `SessionStore`（字段见 `src-tauri/src/session/model.rs`：`projects[] / active_project_id / last_updated / worktree_state`），或首次启动后点选一次再复制快照。**优先手写**，可复跑。
- 假数据：文件名用中性词（`pipeline.ts`、`design.md`），commit message 用英文；不出现真实仓库名/远程 URL。

**G0 闸门（必须先验证）**

| 检查 | 通过判据 | 失败处理 |
| --- | --- | --- |
| HOME 隔离生效 | 启动后 `~/.neeko` mtime 不变，`/tmp/neeko-shot/home/.neeko` 被写入 | 停下，确认是否改用 `NEeko` 侧 env 方案或让用户自拍 |
| 窗口捕获可用 | `screencapture` 成功产出 PNG（macOS 需屏幕录制权限） | 请求用户授权；仍失败 → 转「用户自拍」 |
| 假项目可见 | 左栏出现 2 项目 + 1 worktree，Git 面板有变更 | 修 fixture（不进入拍摄） |

### 3.4 隐私检查清单（拍摄后逐项过）

- [ ] 侧栏/标题栏无真实项目名、无 `/Users/<name>` 路径
- [ ] 终端无历史输出、无真实主机名/IP、无 git remote
- [ ] 状态栏无真实分支之外的信息泄漏（分支名用 `main` / `feat/pipeline`）
- [ ] 通知/历史面板未出现在画面中
- [ ] EXIF/元数据：`sips`/`cwebp` 重编码后无 macOS 元数据

---

## 4. 能力地图 SVG（B 之 4）

- 文件：`docs/.img/capability-map.svg`，viewBox `0 0 1200 620`，单文件、无外链字体（用 `font-family="system-ui, sans-serif"`）、无脚本。
- 结构：中心 `Neeko` 圆角块 → 三列六块（①Projects ②Terminal/Agents ③Agent Chat ④Coding/LSP/Debug ⑤Version Control ⑥Library/Signals），箭头只标数据方向（`PTY` / `LSP/DAP` / `git2+gh` / `SQLite`）。
- 配色：中性底 `#111418` + 语义强调（蓝/绿/橙，与主题无关的固定色），**不使用主题变量**（GitHub 双主题下必须都可读）。
- 文字：最小 13px、每块 ≤4 行、无英文缩写歧义（`LSP`/`DAP`/`MCP` 保留简称但在 README 正文明示一次）。
- 为什么不用 mermaid：GitHub 能渲染 mermaid，但布局不可控、无法做品牌化，且能力地图需要一次成型、长期不变。

---

## 5. 文案策略

### 5.1 术语表（EN ↔ CN，写进 README 前先固定）

| EN | CN | 说明 |
| --- | --- | --- |
| Project | 项目 | 一个被纳管的工作目录（本地/WSL/远程） |
| Worktree | Worktree（不译） | git worktree，中文首次出现加"工作树"括注 |
| Agent | Agent（不译） | AI CLI（opencode/claude-code/…） |
| Agent Chat | Agent 对话 | 统一对话面板 |
| Library | 资源库 | skill / prompt / MCP 三类 |
| Skill | Skill（不译） | `SKILL.md` 能力包 |
| Prompt | 提示词 | 可复用提示词 |
| MCP | MCP | Model Context Protocol server |
| Task / Console | 任务 / 控制台 | 任务运行与输出 |
| Runner / Debug | 运行 / 调试 | 运行配置与 DAP |

### 5.2 句式规则

1. 动词开头、一句话一条；并列项用 `—` 引出细节。
2. 每个数字必须在 §2 有锚点（"16 languages"、"9 panels" 之类要么可核，要么不写）。
3. 禁用形容词堆叠（"强大的"、"流畅的"）；用可验证事实替代。
4. 首次出现专有名词给一次解释，后续不再解释。
5. 每条功能末尾不写"等"，宁少写不模糊。

### 5.3 双语同步

- 顺序：EN 草稿 → CN 改写（不是逐字直译）→ **结构 diff**：`##` / `###` 的**数量与顺序**必须相同（标题允许本地化，因此不比标题文本）。
- 版本/安装/清单三段：允许逐字一致（数字与命令不翻译）。
- 顶部互相声明：EN `English | [简体中文](README_CN.md)`（已有），CN 增加一行
  `> 本文件为中文镜像；技术与版本以 [README.md](README.md) 为准。`

---

## 6. CHANGELOG 策略（C）

```bash
# 备份后重生成（cliff.toml 不动）
cp CHANGELOG.md /tmp/CHANGELOG.before.md
git-cliff --output CHANGELOG.md --tag v1.0.9
```

- v1.0.7 / v1.0.8 无 tag、无 release 提交 → 会并入 `[1.0.9]`，这是**诚实**结果；不手工补假分段。
- 校验：① 开头仍是 `# Changelog` 前言；② 含 `## [1.0.9]`；③ `## [1.0.6]` 段落仍在且条目数不减少（`git-cliff` 全量重算，理论不变）；④ 文件行数增长合理（~898 提交）。
- README `Community` 段加一行 `[Changelog](CHANGELOG.md)`；不嵌入内容。

---

## 7. 护栏设计（D）

### 7.1 判据（只有 5 条，宁窄勿宽）

| id | 判据 | 失败文案要点 |
| --- | --- | --- |
| C1 工具链一致 | README(`_CN`) 中出现的 `Node (\d+)`、`pnpm (\d+)`、`Rust (\d+\.\d+)` 必须等于 `engines.node` 主版本、`packageManager` 主版本、`rust-toolchain.toml` channel 主次版本 | 指出三处真实值 |
| C2 Agent 清单 | 从 `providers.rs` 抽取内置 id（10 个 `shell_agent` + 显式 `id:`）；README 必须列出全部 CLI agent 展示名，且**不得出现未登记的名字**；MockAgent 单独提及 | 列出差集 |
| C3 主题数量 | README 声明的主题数与 `BUILTIN_THEMES.length` 相等 | 给出真实值 |
| C4 无快捷键表 | README 不得出现含 `Ctrl+` 的多行表格行，也不得出现"快捷键"小节标题；只允许 `docs/keyboard-shortcuts.md` 链接 | 指出去登记表 |
| C5 图存在 | README 引用的**相对路径图片**必须存在（`docs/.img/shell-*.webp`、`capability-map.svg` 等）；只要被引用就校验，未引用的不强制 | 列出缺失路径 |

> **实现期修订（2026-10-28）**：原稿写的是「3 张 shell 图必须都被引用」。但截图流被 macOS 屏幕录制权限阻塞（见 `implement.md` 阶段 0 的 G0 结果），强判据会让 `pnpm check:quick` 在截图补齐前**持续变红** —— 门禁变红会诱导人绕过它。改为「引用即校验」：图未落地时 README 不引用它（也就不会红），落地后自动开始被校验。

**为什么这 5 条能被机器判**：它们都是**有限枚举**（版本字符串、id 集合、数组长度、路径存在），不含语义判断。语义正确性（"这功能描述还成立吗"）永远靠人，护栏只钉"最容易被无意识抄错"的部分 —— 与 `.trellis/spec/guides/invariant-enforcement.md` 的分层判据一致。

### 7.2 实现约束

- 路径 `tools/guards/checks/check_readme_claims.py`（目录即注册，无需改清单）。
- 形态照抄 `check_script_references.py` / `check_codemirror_singleton.py`：
  `GUARD = Guard(id=..., title=..., scopes=(...), docs="docs/features.md", fix_hint=...)` + `check(ctx) -> GuardResult`。
- `scopes`：`README.md`、`README_CN.md`、`docs/features.md`、`rust-toolchain.toml`、`package.json`、`docs/.img/*`。
- `scanned`：统计实际解析的 README 与锚点文件数；**抛 0 → 框架判 ERROR**（防正则失效静默通过）。
- 解析 `rust-toolchain.toml` 用 `re`（`channel\s*=\s*"([^"]+)"`），`package.json` 用 `json`。
- **不解析 Rust 语义**：只做文本抽取；`shell_agent(` 调用数 + `id: "x".into()` 数量变化 → 抽取不到即 ERROR（响亮失败，符合仓库既有失效模式约定）。
- 展示名映射表内置在 guard 内（id → 展示名），因为 providers.rs 里 name 与 id 不同形（`claude-code` → `Claude Code`）；新增内置 agent 时护栏会红并提示更新映射 —— 这是**刻意的**：新增内置 agent 必须同时更新 README。

### 7.3 正反例自测（AC7，实现时逐条跑）

| 场景 | 期望 |
| --- | --- |
| 原样 | PASS |
| README 改 `Node 22+` | VIOLATION（C1） |
| README 删掉一个 agent 名 | VIOLATION（C2） |
| README 加回快捷键表 | VIOLATION（C4） |
| 删除 `shell-library.webp` | VIOLATION（C5） |
| 全部还原 | PASS |

---

## 8. `docs/features.md` 结构（D 之 1）

目的：README 是摘要（六组 × 4–6 条），`features.md` 是全量清单（30+ 条）且**每条带锚点**，两者共用同一套编号，避免"能力只有营销名、没有落点"。

```md
# 能力清单（单一事实源）

> README 的 Features 段是本文件的摘要。新增能力：先在此登记（含锚点），再决定是否进 README。

| # | 组 | 能力 | 一句话 | 锚点（代码/文档） | README |
| --- | --- | --- | --- | --- | --- |
| 1.1 | 多项目 | 本地/WSL/SSH 三类项目 | ... | src-tauri/src/project/ | ✅ |
| 2.3 | 终端 | CLI Hooks 状态回传 | ... | src-tauri/src/agent/hooks/ | ✅ |
| ... |
```

规则：锚点必须指向**目录或单文件**（不含行号，行号必然腐烂）；`README` 列只写 ✅/—；不写实现细节。

---

## 9. 风险与回滚

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 截图 G0 失败（权限/隔离） | B 流阻塞 | 停在 G0，回报用户改用自拍路径；**不得**用真实数据截屏 |
| fixture 与真实环境差异（字体/主题） | 图与用户实际观感不同 | 使用默认主题 + 默认字体，不做个性化 |
| 护栏误伤（如 README 里出现 "Node 24+ / Node 22" 对比句） | 门禁红得莫名其妙 | C1 只匹配"要求"句式（`Node \d+\+?`）；误伤时改文案不改判据（判据窄化优先） |
| CHANGELOG 重生成 diff 巨大 | review 困难 | 单独提交，只做 C 流 |
| 中英漂移复发 | 长期问题 | §5.3 结构 diff + D7 声明 + 护栏不覆盖（靠 PR 模板提醒） |

回滚：文档改动可整文件 `git checkout`；护栏独立文件，`git revert` 即恢复；CHANGELOG 单提交可回退。

---

## 10. 验证命令

```bash
pnpm check:quick                          # 收尾一次性门禁（含新护栏）
python3 tools/guards/run.py list          # 确认 check_readme_claims 已注册、stages 正确
python3 tools/guards/run.py run --stage local --suite lint   # 只跑静态档（开发中可用）
node -e "…"                               # 链接解析（实现时用 20 行脚本，一次性，不入库）
```
