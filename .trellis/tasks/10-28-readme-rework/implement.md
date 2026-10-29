# 实施计划

> 顺序：**0 前置闸门 → D1 事实源 → A 文档 → B 图片 → C 变更记录 → D2 护栏 → 收尾验证**
> 依据：`prd.md` §6 验收、`design.md` 各节。**不主动 git commit**（仓库规范）。

---

## 阶段 0 · 前置验证（≤45min，可能阻塞 B 流）

- [ ] **0.1 读护栏契约**：`tools/guards/core/contract.py`（`Guard` / `Context` / `GuardResult`）、
      `tools/guards/checks/check_script_references.py`（文档类护栏先例）、`check_codemirror_singleton.py`（最小形态）。
      产出：D2 的实现骨架（不写文件）。
- [ ] **0.2 G0-a HOME 隔离启动实测**（`design.md` §3.3）：
      `pnpm build` → `cargo build --manifest-path src-tauri/Cargo.toml` →
      `HOME=/tmp/neeko-shot/home ./src-tauri/target/debug/neeko`
      判据：真实 `~/.neeko` 未被写入；隔离 HOME 下生成 `sessions.json`。
- [ ] **0.3 G0-b 窗口捕获实测**：`screencapture` 出一张非空 PNG（macOS 屏幕录制权限）。
- [ ] **0.4 G0-c fixture 可见性**：假项目 + worktree 出现在左栏，Git 面板有变更。

> **G0 闸门**：0.2/0.3 任一失败 → **停**，回报用户改走「用户自拍」（prd D3 的 fallback），
> 不做任何真实数据截屏。0.4 失败只修 fixture（可继续）。

---

## 阶段 1 · D1 单一事实源（~40min）

- [ ] **1.1** 按 `design.md` §2 建立 claim 清单，逐条核对代码位置（已在设计期核过，此处只确认无漂移）。
- [ ] **1.2** 写 `docs/features.md`：六组、30+ 条、每条 `{#, 组, 能力, 一句话, 锚点, README?}`（`design.md` §8 模板）。
- [ ] **1.3** 自检：每条锚点在仓库中存在（`ls`/`test -e`）；无行号、无实现细节。

**验收**：`docs/features.md` 条目 ≥30，锚点 100% 存在；`README` 列标 ✅ 的条目数在 24–30 之间（六组各 4–5 条）。

---

## 阶段 2 · A 文档主体（~2h）

- [ ] **2.1 README.md（EN）**：按 `design.md` §1.2 的 11 节重写。
      - 首屏：定位 + 徽章（release / license / platform / Tauri / Rust / React）+ 下载 CTA + 主壳图。
      - Features：只写 `features.md` 中标 ✅ 的条目；每条含数字且可核（`design.md` §2）。
      - Reference：快捷键只链 `docs/keyboard-shortcuts.md`；不再出现绑定表。
      - Develop：`pnpm check:quick`（唯一默认门禁）+ `rust-toolchain.toml` + `AGENTS.md` + `CONTRIBUTING.md`。
- [ ] **2.2 README_CN.md**：按 §5.1 术语表改写（非逐字直译）；顶部加「以 README.md 为准」声明。
- [ ] **2.3 结构对齐**：比对两份 `^## ` 序列完全一致；版本/安装命令段落逐字一致。
- [ ] **2.4 链接解析**：README 内所有相对链接在仓库存在（`README_CN.md`、`docs/keyboard-shortcuts.md`、
      `docs/ARCHITECTURE.md`、`CONTEXT.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`LICENSE`、`docs/.img/*`）。
      注：`CHANGELOG.md` 链接在阶段 4 之后才有效，允许短暂 404（阶段 4 完成后复检）。

**验收**：AC1（三问，见收尾）、AC2、AC3、AC8、AC9、AC10。

---

## 阶段 3 · B 图片（~1.5h，依赖 G0）

- [ ] **3.1** 生成 fixture：`/tmp/neeko-shot/projects/{atlas,beacon}` 两个 git 仓库（3–5 个真实 commit、
      有未提交变更），`atlas` 加 1 个 worktree；写隔离 HOME 的 `sessions.json`（字段见 `session/model.rs`）。
- [ ] **3.2** 拍 3 张（`design.md` §3.1 题材）：`shell-projects` / `shell-agent-chat` / `shell-library`。
- [ ] **3.3** 隐私清单逐项过（`design.md` §3.4）；任何一项不过 → 重拍。
- [ ] **3.4** 压缩：1600px 宽 + WebP q82；验收 ≤300KB/张；`git check-ignore` 确认未误加原始 PNG。
- [ ] **3.5** 画 `docs/.img/capability-map.svg`（`design.md` §4）：1200×620、六块 + 中心、中性底 + 强调色。
- [ ] **3.6** README 接线：主壳图放 §Preview 首图，另两张并排；能力地图随后；加 HTML 注释
      `<!-- shots: 2026-10, app 1.0.9, shell: dock-islands -->`。

**验收**：AC4、AC11。图片本体在阶段 5 由护栏 C5 复核。

---

## 阶段 4 · C 变更记录（~15min）

- [ ] **4.1** `cp CHANGELOG.md /tmp/CHANGELOG.before.md` 后
      `git-cliff --output CHANGELOG.md --tag v1.0.9`（`cliff.toml` 不动）。
- [ ] **4.2** 校验（`design.md` §6）：前言保留、含 `## [1.0.9]`、`## [1.0.6]` 条目数不减、行数合理。
- [ ] **4.3** README/CN 的 Community 段已链 `CHANGELOG.md`（阶段 2 已写），复检可达。

**验收**：AC5。

---

## 阶段 5 · D2 护栏（~1.5h）

- [ ] **5.1** 实现 `tools/guards/checks/check_readme_claims.py`：5 条判据 C1–C5（`design.md` §7.1/§7.2）。
      - `scanned` 必须如实统计；抽取空 → 抛异常让框架判 ERROR。
      - `fix_hint` 写清「改文档还是改代码」。
- [ ] **5.2** `python3 tools/guards/run.py list` 确认已注册（目录即注册，无需改清单）。
- [ ] **5.3** 正反例 6 条（`design.md` §7.3）逐条跑，记录输出。
- [ ] **5.4** 可选：在 `.trellis/spec/frontend/quality-guidelines.md` 补一段「README 事实源与 C1–C5」，
      指向 `docs/features.md`（仅当用户认可；否则跳过，spec 不改）。

**验收**：AC7（6 场景）、AC6 的前置。

---

## 阶段 6 · 收尾（~30min）

- [ ] **6.1** `pnpm check:quick` 全绿（**唯一一次**全量收尾，不重复跑 lint/test）。
- [ ] **6.2** 链接复检（含 `CHANGELOG.md`）、双语 `##` 序列比对、`git status` 确认无多余文件
      （`/tmp` fixture、原始 PNG 不入库）。
- [ ] **6.3** AC1 三问复核：自问自答 + 请用户抽查（不做形式化测试）。
- [ ] **6.4** 汇总报告：改了哪些文件、AC 逐条结论、G0 实测记录、护栏 6 场景输出。
- [ ] **6.5** 不提交，交给用户决定提交切分（建议：`docs(readme)` / `docs(changelog)` / `feat(guards)` 三次）。

---

## 验证命令速查

```bash
# 开发期（只跑静态档，不做全量）
python3 tools/guards/run.py run --stage local --suite lint

# 收尾（一次）
pnpm check:quick

# 护栏注册/明细
python3 tools/guards/run.py list

# 隔离截图（阶段 3）
pnpm build && cargo build --manifest-path src-tauri/Cargo.toml
HOME=/tmp/neeko-shot/home ./src-tauri/target/debug/neeko
```

---

## Review gates

| Gate | 时机 | 判据 |
| --- | --- | --- |
| G0 | 阶段 0 末 | HOME 隔离 + 捕获 + fixture 三项实测记录（任一失败即停） |
| G1 | 阶段 2 末 | 三问测试通过 + 无快捷键表 + 双语结构一致 |
| G2 | 阶段 3 末 | 隐私清单全过 + 图片体积达标 |
| G3 | 阶段 5 末 | 护栏 6 场景结果表 |
| G4 | 阶段 6 末 | `pnpm check:quick` 绿 + `git status` 干净（除预期改动） |

## 回滚点

1. 阶段 2 前：`git checkout README.md README_CN.md docs/features.md`。
2. 阶段 3 后：删 `docs/.img/shell-*.webp`、`capability-map.svg` 并回退 README 图片段。
3. 阶段 4：`cp /tmp/CHANGELOG.before.md CHANGELOG.md`。
4. 阶段 5：删 `tools/guards/checks/check_readme_claims.py`（框架自动不再加载）。

---

## 执行记录（2026-10-28）

### 阶段 0 · 前置验证

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 0.1 护栏契约 | ✅ | `contract.py`（Guard/Context/GuardResult）、`check_script_references.py`、`check_codemirror_singleton.py` 已读；注册表要求 `GUARD.id == 文件名` 且**必须有** `tests/test_<id>.py` |
| 0.2 HOME 隔离 | ✅ | `HOME=/tmp/neeko-shot/home` 下生成 `neeko.db` / `agent_sessions.db` / `agent-hooks/` / `neeko.log`；真实 `~/.neeko/sessions.json` md5 `055ff7ad…` 与 mtime 全程未变 |
| 0.3 窗口捕获 | ❌ **阻塞** | `screencapture -x` → `could not create image from display`（macOS 屏幕录制 TCC 未授权） |
| 0.4 fixture 可见性 | ✅（数据面） | 日志 `[boot] restored 2 of 2 project(s); active project: atlas`；WebContent 子进程存活 |

**G0 结论**：B 流的 3 张壳级截图**未完成**，按 PRD §7 停在闸门，等用户授权后补拍。
不涉及真实数据（全程隔离 HOME），仓库无残留（fixture 在 `/tmp`）。

### 阶段 1–6

| 阶段 | 结果 | 关键数字 |
| --- | --- | --- |
| 1 单一事实源 | ✅ | `docs/features.md` **48 条**（六组），**30 条**标 ✅，锚点缺失 **0** |
| 2 文档主体 | ✅ | EN/CN 各 **10 个 `##` + 8 个 `###`**（结构对齐）；相对链接 **0** 失效 |
| 3 图片 | ⏸ 部分 | `capability-map.svg` ✅（8KB，XML 合法）；3 张 `shell-*.webp` **待拍** |
| 4 CHANGELOG | ✅ | 1445 → **2364** 行；`## [1.0.9] - 2026-10-28`（889 条）；`## [1.0.6]` 21 条（重算后比旧文件多 1 条，无丢段） |
| 5 护栏 | ✅ | `check_readme_claims` 5 条判据 + **9** 个单测；框架自测计数 30 → **31**（`test_gates.py` 两处 ratchet） |
| 6 收尾 | ✅ | `pnpm check:quick`：**33 条护栏全通过**（25.7s）；`git status` 仅预期文件 |

### 护栏正反例实测（AC7）

| 场景 | 结果 |
| --- | --- |
| 原样 | exit 0 `ok` |
| README 改 `Node 22+` | exit 1 |
| 删掉 `Grok` | exit 1，输出 `README.md: 缺少内置 agent 'Grok' 的说明` |
| 加回快捷键表 | exit 1 |
| 主题数改 4 | exit 1 |
| 删除 `capability-map.svg` | exit 1 |
| 全部还原 | exit 0 `ok` |

### 与设计的偏差（均为实现期决定，已回写 `design.md`）

1. **C5 收窄**为「引用的相对路径图片必须存在」，而非「3 张 shell 图必须都被引用」—— 否则截图未落地期间门禁恒红，会诱导绕过。
2. **双语结构对齐**比较 `##` / `###` 的**数量与顺序**，不比标题文本（CN 标题本地化）。

### 待办

- [ ] **B 流截图**（需用户：给运行本 Agent 的终端/宿主应用开「屏幕录制」权限，或本地执行 `/tmp/neeko-shot/capture.sh`）
- [ ] 截图落地后在 README/CN 的 `## Preview` 补 3 个 `<img>`，并把 `shell-*.webp` 纳入 C5 自动校验
- [ ] 可选：`.trellis/spec/frontend/quality-guidelines.md` 补一段「README 事实源与 C1–C5」（待用户确认）

### 补充记录（2026-10-28 晚）：dev 启动方式与截图脚本修正

**用户反馈**：`pnpm run dev` 是黑屏。

**实测结论**（headless Chrome 截图 + 后端日志）：

1. `pnpm dev` 只启 Vite，不起 Tauri 外壳；用浏览器打开 `http://localhost:1420` 时，
   应用在首个 `invoke` 处失败（`Cannot read properties of undefined (reading 'metadata')`），
   ErrorBoundary 停在黑底 + 错误提示 —— **这是 Tauri 应用在纯浏览器里的预期表现**，不是回归。
   `package.json` 的 `dev` 只是 `vite`；受支持的开发入口始终是 `pnpm tauri dev`
   （README/CONTRIBUTING 两处一致）。
2. **发现并修正本任务自己的截图方案缺陷**：`cargo build` 产出的是 **dev 构建**，加载 `devUrl`
   (`http://localhost:1420`)，**不加载打包进二进制的 dist**。原 `design.md` §3.3 里
   「`pnpm build` → `cargo build` → 直接跑二进制」会得到空白窗口（我最初那次 G0 观察到的
   blank / `web content process terminated` 正是这个原因，不是 TCC 之外的另一个 bug）。
   正确做法二选一：
   - **dev 路径**：先 `pnpm dev`，再跑 debug 二进制（已验证：日志出现前端驱动的
     `check_agents_installed count=11`、`GitWorker started for atlas`、watcher 启动 = UI 真的跑起来了）；
   - **production 路径**：`pnpm tauri build --debug` 出 `.app` 再跑。
   `capture.sh` 已按 dev 路径重写（先起 Vite 再起应用，退出时清理两个进程）。
3. 顺带结论：**headless Chrome 可以截图**（`--headless=new --screenshot`），但纯浏览器渲染
   会因缺 Tauri IPC 而失败，不能用来替代真实窗口截图（真实性也不满足 `design.md` §3.1）。

**待用户决策的可选改进**：在 `main.tsx` / ErrorBoundary 增加「检测到非 Tauri 环境 → 渲染
一行提示（请用 `pnpm tauri dev`）」的兜底，把黑屏变成可自解释的提示。属产品代码改动，
超出本任务非目标 #1，需要单独授权。

### 补充记录（2026-10-28 晚 · 第二段）：截图仍卡 TCC，原因已定位

`grep TCC` 级别的结论（`ps` 进程链实证）：

```
launchd(1) → /Applications/Neeko.app/Contents/MacOS/neeko(891) → /bin/zsh → pi → bash
```

**本 Agent 会话运行在 Neeko 自己的终端里**，因此 `screencapture` 的「责任进程」是
`Neeko.app` —— 它没有「屏幕录制」权限，所以 `screencapture -x` 恒报
`could not create image from display`；这与仓库代码无关，也与本任务的改动无关。

同时 `osascript` 辅助访问被拒（`osascript 不允许辅助访问 (-1728)`），即**即使补上屏幕录制，
我也无法用脚本点击进入 Agent Chat / Library 两个视图**（需要 Accessibility）。

**处置**：截图改为「用户侧一次执行 + 我侧收尾」：
1. 用户在已运行的 Ghostty 里执行 `bash /tmp/neeko-shot/capture.sh`；
2. 脚本复用/启动 1420 的 Vite → 以隔离 HOME 启动 debug 二进制 → 三次回车各拍一张
   （`/tmp/neeko-shot/raw-{projects,agent-chat,library}.png`，>50KB 才算成功）；
3. 我负责裁切 → 1600px WebP(q82) → `docs/.img/shell-*.webp` → README 接线（C5 护栏随即开始校验）。

脚本 v3 变更：优先复用已在跑的 1420 dev server（避免 Vite 退到 1421 导致窗口空白）、
截图后校验文件体积 > 50KB（防全黑小图混过）。

### 补充记录（2026-10-28 · 第三段）：排版专项（A 流二次打磨）

用户反馈「重新对文档进行排版优化」，按 `design.md` §1.4 F1–F6 重排两份 README，**不改任何事实**。

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 徽章拆两行 | EN/CN | 产品三项 / 技术栈三项，窄视口不再折行 |
| 新增扁平目录 | EN/CN | `**Jump to**` / `**目录**` 一行，` · ` 分隔 10 个 H2 |
| 图注降级 `<sub>` | EN/CN | Preview 图注、MockAgent 句、平台说明句共 3 处 |
| 列表句式统一 | EN/CN | 第 1 组首条改成 `**术语** — 说明`（原为 `**术语** in one sidebar —`） |
| CN 标点/术语 | CN | ASCII 双引号 → 「」；`+` → 「与」；`技能` → `Skill`；图注 `git 工作树` → `git worktree`；镜像声明补术语政策一行 |
| Install 表句式 | EN/CN | macOS 行由 `— drag …` 统一为括号式，与另两行同构 |

**验证**：`##` 10/10、`###` 8/8（双语一致）；相对链接 EN 15 / CN 16 全可解析；
内部锚点 EN 11 / CN 11 全命中；无行尾空格、无连续空行；
`pnpm check:quick` → **33 条护栏全通过**（`check_readme_claims` 仍绿：node=24 pnpm=11 rust=1.99 · agents=11 · themes=5）。

**顺带发现（未处理，待确认）**：`docs/.img/project-struct.png`（203KB）已无任何文档引用，
与本任务已删除的 3 张旧图同类；是否一并删除请用户决定。
