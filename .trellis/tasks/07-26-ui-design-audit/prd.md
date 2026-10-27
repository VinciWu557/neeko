# UI 精致化实施（从设计审计到实际改造）

## 目标

让 Neeko 的 UI **看起来更精致、更有设计感** —— 把设计系统真正落到代码里：
统一语义色、统一交互状态契约、补齐缺失原语、消除主题逃逸。

> **范围约束（2026-10-27，用户明确）**
>
> **① 不改动当前布局，只做样式 / UI 层面的优化。**
>
> 这条约束把原计划切掉了一大块 —— 凡是会改变**布局结构**的项全部移出本轮：
>
> | 移出项 | 为什么算「动布局」 |
> | --- | --- |
> | TitleBar 补项目上下文 | 新增 DOM 节点（项目名 / 环境 / 分支 chip） |
> | StatusBar 16 → 22px | 改容器高度，底部 chrome 整体上移 |
> | Dock / Tab 尺寸迁移 | 改 chrome 几何 |
> | Skills 单树渲染 | 改挂载结构（双挂载 → 条件渲染） |
> | ActivityBar 删除 | 删文件、改导航 |
> | Projects 空态三 CTA | 新增交互元素与结构 |
>
> **仍在本轮的**（全部是**样式层**，改 class / 改 token 定义，DOM 结构与几何不变）：
> 语义色统一 · 主题逃逸清零 · 交互状态契约（hover / selected / danger / disabled /
> focus-visible）· 断链 token 修复 · 原语补齐（新增组件但**不改现有页面结构**）·
> 字体阶梯 · z-index 阶梯 · 暗色假设清理 · 护栏
>
> **② 不主动提交代码。** 改动留在工作树，等用户指示。（与仓库 `AGENTS.md` 规范一致）

> **方向修订（2026-10-27）**
>
> 原任务是 **planning-only 的设计审计**：产出问题清单 + 路线图，不改代码。
> 用户明确将目标改为 **实施 UI 精致化**，并去掉 Decision Log D1–D5 五道决策门。
>
> **D1–D5 去掉意味着什么**：D1（Skills IA）、D2（Settings 形态）、D3（DockZoneTabs）、
> D4（Apple spacing）、D5（语义色命名策略）原本是「实现前必须先拍板」的 IA 决策。
> 去掉后本任务 **不再做 IA 重排**，只做**视觉与一致性**：
> - D1/D2/D3 → 移出本轮（本来就属于「动布局」）
> - D4（Apple spacing）→ **直接废弃**：现有 `--spacing-apple-*` 引用率≈0，
>   保留会与 IDE 密度冲突。本轮只清理，不做 remap
> - D5（语义色命名）→ 简化为**最小修复**：只补断链 token（`status-error`），
>   不做全量语义色 rename（那是大爆炸改名，与「精致」无关）
>
> **去掉 D1–D5 不等于去掉所有约束**。仍然硬性成立的是 §4 设计原则、§5 目标设计系统
> （密度/字体/语义色/z-index/原语）与 §8 成功指标 —— 它们是「精致」的客观判据。
> 其中**只涉及样式定义**的部分（语义色 / 字体阶梯 / z-index / 交互状态）在本轮执行；
> **涉及几何**的部分（density token 的 chrome 高度）本轮只**定义**不**套用**。

## 范围

### 在范围内（**全部是样式层**）

1. **语义色修复**：`status-error` 断链（4 处错误提示当前无颜色）、
   `text-white` 叠 accent（**36 处**）→ `text-on-accent`
2. **主题逃逸清零**：9 处硬编码色接入语义 token（主题已有 `--git-status-*` / `--diff-*`）
3. **暗色假设清理**：39 处 `border-white/` / `bg-white/` → 语义分割线 / hover token
4. **交互状态契约**：统一 hover / selected / danger / disabled / **focus-visible**
   （`focus:outline-none` 无替代 = 键盘用户无焦点反馈，P0-6）
5. **原语补齐**：`IconButton` / `PanelHeader` / `Toolbar` / `EmptyState` / `StatusDot` /
   `FormField` —— 新增组件供后续使用，**本轮不改现有页面的 DOM 结构**
6. **字体阶梯与 z-index 阶梯**：定义 token 并在**不改几何**的前提下替换硬编码字号
7. **Settings 选中态**：大色块 → surface 选中（纯 class 替换）
8. **质量闸门**：eslint + 护栏，阻止问题复发
9. **新原型**：**改动点清单**（不是界面效果图）—— 6 个改动点逐条给出
   「现状 class / 目标 class / 改后效果 / 精确文件:行」。
   旧的 5 份原型作废；第二版两份也作废（呈现方式仍是「界面效果图」，
   看起来像在重新设计整个界面）。

### 不在范围内（本轮明确排除）

- **一切会改变布局结构的改动**（见上方「范围约束」表）
- 后端协议 / Agent 运行时
- 视觉品牌重设计（logo / 营销站 / 配色体系换血）
- 动效系统（Motion 语言）—— P1
- WSL / SSH 远端相关 UI

## 子任务地图（按依赖顺序，**均为样式层**）

| # | ID | 范围 | 依赖 | 样式层？ |
| --- | --- | --- | --- | --- |
| 1 | `ui-quality-gate` | eslint 规则 + 1 条护栏：**禁止新增** `text-[#hex]` / 未定义 token 类 | — | ✅ 只读分析 |
| 2 | `ui-tokens-foundation` | 语义色 alias / `status-error` 断链修复 / 字体阶梯 / z-index 阶梯 / 清理 `--spacing-apple-*` | 1 | ✅ 只改 CSS 定义 |
| 3 | `ui-primitives` | 6 个原语 + 交互状态契约（含 focus-visible） | 2 | ✅ 新增组件，不改现有结构 |
| 4 | `ui-theme-escape-fix` | 9 处硬编码色 → 语义 token | 2 | ✅ 纯 class 替换 |
| 5 | `ui-interaction-states` | 暗色假设清理 / `text-white` → `text-on-accent` / focus-visible 补齐 / Settings 选中态 | 3 | ✅ 纯 class 替换 |

### 被移出本轮的子任务

| 原 ID | 移出原因 |
| --- | --- |
| `ui-chrome-polish` | TitleBar 补上下文 / StatusBar 16→22 / Dock / Tab —— **全是几何改动** |
| `ui-key-surfaces` | Projects 空态 / Skills 单树 —— **改结构**；其「Settings 选中态」拆到 #5（纯 class） |

### 依赖图

```text
ui-quality-gate（先落）
      │
      ▼
ui-tokens-foundation
      ├─► ui-primitives ──► ui-interaction-states
      └─────────────────► ui-theme-escape-fix
```

**关键顺序说明**：`ui-quality-gate` 在原 §10.3 里标「贯穿全程」，但**执行上必须最先落**。
理由见下方「为什么护栏必须第一个做」。

## 为什么护栏必须第一个做

原审计结论至今 0 落地，根因不是没时间，是**没有护栏**：

- `tools/guards/checks/` 30 条护栏，**没有一条管 UI 样式**
- eslint 无相关规则
- 实测三个月间代码量 +68%（235→396 个 tsx），而硬编码色字面量从 33 涨到 **39**、
  raw button 从 311 涨到 **520** —— 比率持平，意味着**每个新 PR 都在复制旧问题**

先做清理、新代码继续灌入，是这三个月发生的事。故护栏先落（哪怕只拦新增）。

## 验收标准

### 父任务级（跨子任务）

- [x] **AC0（新增，本轮硬约束）布局零改动** —— **成立，已机器验证**：
  - **新增布局类 0 处**：`git diff -U0 -- src/` 逐文件比对「删除行的 class 集合」
    与「新增行的 class 集合」，只统计**净新增**的布局类（`flex`/`grid`/`absolute`/
    `w-*`/`h-*`/`p-*`/`gap-*`…）→ **0**。
  - **DOM 结构零变化**：逐文件比对 JSX 标签集合（含开合方向）→ **未变**。
  - 改的全是颜色系 class 与 `focus-visible:*` / `ring-*`。
  > **踩过的坑**：第一版自查脚本按「整行是否含布局类」判定，报出 126 处**假阳性**
  > （`-` 行和 `+` 行里布局类都存在且完全相同）。正确判据是**集合差** ——
  > 「新增行有、删除行没有」的 class 才是真正的新增。
  本轮 diff **不得**包含：
  - DOM 结构变更（新增 / 删除 / 重排元素）
  - 容器尺寸变更（高度 / 宽度 / padding / margin / gap）
  - 字号变更（不引入新的 `text-[Npx]`，不改变现有元素的字级）
  - 布局类变更（`flex` / `grid` / `absolute` / `order` / `w-` / `h-`）
  - 组件文件的新增或删除（除 `src/ui/` 下的新原语）
  - 路由、挂载结构、面板宽度、chrome 几何的任何改动
  **验证方式**：`git diff` 逐 hunk 人工审阅 + 一个只读脚本断言「无布局类变更」。
  允许的改动白名单：`text-*`（颜色系）/ `bg-*`（颜色系）/ `border-*`（颜色系）/
  `focus-visible:*` / `hover:*`（颜色系）/ `ring-*` / token 定义文件 / `src/ui/` 新文件。
- [x] **AC1 §8 成功指标（本轮可达部分）** —— **本轮可达项全部达成**：

  | 指标 | 7 月基线 | 当前（2026-10-27） | 本轮目标 |
  | --- | --- | --- | --- |
  | theme escape（`text-[#` 等） | 多 | 9 | **0** ✅ |
  | 未定义 `status-error` | 有 | **有（4 处正在使用）** | **消除** ✅（构建产物已验证类生成）|
  | 暗色假设 white/alpha | ~33 | 39 | **归零** ✅（实际清了 40 处）|
  | z-index 魔法数档位 | 14 | 9 | ≤6（token 化，不改实际层级）→ **阶梯已定义，未套用** |
  | 硬编码 px 字号 | ~266 | 446 | 本轮**只定义阶梯**不全面替换（替换会改几何） |
  | raw button（`src/ui` 外） | ~311 | 520 | 本轮**不追求**（替换按钮会改结构与行为） |

  > 复测命令见 `design.md` §8.1，可机械核验。
  > 「当前」一列是 2026-10-27 实测值（原文档只有 7 月基线，缺中间态，故补齐）。
  > **本轮只做颜色系与 token 层**；密度与字号阶梯本轮**只定义不套用** ——
  > 套用即改变几何，违反 AC0。
- [x] **AC2 护栏生效** ✅ —— `check_ui_style_tokens` 四条判据 + 13 个单测
      （含 2 条变异验证 + 2 条反证）；真实仓库首跑即抓出 `Switch.tsx` 的裸 `bg-white`
- [x] **AC3 无回归** ✅ —— `pnpm check:quick` 全绿：
      **31 条护栏 0 违规**（含新护栏）+ eslint/tsc/clippy + 改动文件单测
      （126 test files / 1114 tests）；护栏自身单测 **673 用例全绿**
- [x] **AC4 原型对齐实现** ✅ —— 原型 6 个改动点逐条落地：
      #1 status-error 断链 / #2 text-white→text-on-accent（32 处）/
      #3 暗色假设→语义 token（40 处）/ #4 focus-visible（8 文件）/
      #5 Settings 选中态 surface（4 处）/ #6 主题逃逸清零（9 处）

### 子任务级

- `ui-quality-gate`：✅ 护栏命中演示 + 13 个单测（喂脏数据必红，含变异验证与反证）
  - ⚠ **eslint 规则改由护栏承担**：eslint 要逐 JSX 元素判断 `className` 语义，
    护栏按文件扫描即可覆盖 99% 的实际写法（class 都是字面量），且能同时管 CSS 文件。
    两条规则并存会出现「同一件事两个口径」。
- `ui-tokens-foundation`：✅ 每个新 token 有定义 + tailwind 映射；
  `status-error` 断链修复后**构建产物已验证**类生成；
  字体阶梯与 z-index 阶梯**已定义**（未套用）
- `ui-primitives`：⏸ **本阶段整体移出本轮** —— 新增原语而**不替换任何现有用法**
  = 交付 6 个**无人消费**的组件（对「UI 更精致」零贡献）；而替换现有用法 = 改 DOM
  结构 = **违反 AC0**。两条路都走不通，故留作后续独立任务（前提是那轮允许改结构）。
- `ui-theme-escape-fix`：✅ 9 处硬编码色归零；构建产物确认新类均生成
- `ui-interaction-states`：✅ 暗色假设归零（40 处）；`text-white`（32 处）→
  `text-text-on-accent`；`focus:outline-none` **真缺** focus-visible 替代的
  **8 个文件**全部补上；Settings nav 选中态为 surface 而非大色块

## 当前真实基线（2026-10-27 实测）

> 这一节是本次方向修订时补的 —— 原文档只有 7 月的基线，没有中间态，
> 导致「3 个月没动」这个事实被低估。

### 落地情况：规划 100% 交付，实施 0%

`task.json` 的 8 个 `subtasks` 全部**从未创建**（全仓零引用）。

### §5 目标设计系统落地检查

| §5 目标 | 现状 |
| --- | --- |
| `--chrome-titlebar-h: 32px` | ✅ `h-8` 已达标 |
| `--chrome-dockbar-w: 44px` | ✅ `w-11` 已达标 |
| `--chrome-statusbar-h: 22px` | ❌ `h-4` = 16px（差 6px） |
| density token ×9 | ❌ 全缺 |
| 字体阶梯 ×5 | ❌ 全缺 |
| z-index token（≤6 层） | ❌ 全缺，现存 9 档魔法数 |
| 8 个目标原语 | ❌ 全缺（`ui/` 有 21 个组件，但这 6 个没有） |
| 语义色 alias | ❌ 无；且 `--status-error` **断链**（主题未定义 + tailwind 未映射） |

### 一个当前正在生效的 bug

`text-status-error` 被 4 处使用（`LspPanel` 错误提示、`LspCustomServersSection` ×2、
`HtmlPreview`），但：

- `src/styles/tokens/theme.css` 只定义了 `--status-failed`（5 个主题都有）
- `src/styles/tokens/tailwind.css` 只映射了 `--color-status-{idle,running,failed}`
- **没有 `--color-status-error`** → Tailwind 根本不生成该类
  → 这 4 处错误提示**没有红色**，而紧邻的 `text-status-failed`（正确映射）有

这不是审美问题，是**错误提示在视觉上失效**。列为 `ui-tokens-foundation` 的第一个修复项。

### 一个重要资产（决定了主题逃逸的成本）

主题里**已有 `git-status-{added,modified,deleted,untracked,conflict}` 五个 token，
覆盖全部 5 个主题**，外加 `--diff-added/removed` 系列。

所以「Git 面板显示 GitHub 绿红紫」这个问题**不需要新建色板**，只需把
`#3fb950`/`#f85149`/`#a371f7` 接回已有的 `--git-status-*` / `--diff-*`。
`ui-theme-escape-fix` 的成本远低于原估计。

### 主题逃逸 9 处明细

| 文件 | 硬编码 |
| --- | --- |
| `shared/components/SessionChips.tsx:11` | `#3fb950` |
| `shared/components/ContextMenu.tsx:79` | `#e06c75` |
| `features/git/utils/prDisplay.ts:27` | `#a371f7` |
| `features/git/components/ChangesSection.tsx:103/108` | `#3fb950` / `#f85149` |
| `features/editor/components/TabOverflowMenu.tsx:140` | `#e06c75` |
| `features/git/components/pr-detail/PRDetailSkeleton.tsx:21` | `#a371f7` |
| `features/git/components/pr-detail/PRDetailView.tsx:51/250` | `#a371f7` ×3 |

## 跨任务边界

与 `07-26-unified-task-hub`（同样在等用户拍板）：

- 本任务负责 **Settings 视觉**（token / 选中态 / FormField / 密度）
- task-hub 负责 **Integrations 的 IA 与内容**
- 约定：task-hub 的新 UI **必须**用 Neeko semantic token / 原语，不引进新色板
- 本任务**不改** Settings 路由模型（`appView === 'settings'` 保持）

## 明确不在本任务范围

- 动效 / Motion 语言（P1）
- Skills IA 重排、Settings 路由形态、Dock 多面板（P1，D1–D3）
- 语义色全量 rename（只做最小修复，D5 简化）
- 对比度专项审计、`prefers-reduced-motion`（P1）
- 最小窗口 / 窄宽断点

## 参考

- `design.md` §4 设计原则 · §5 目标设计系统 · §8 成功指标 · §8.1 复测命令
- `implement.md` 阶段映射与验证命令
- `.trellis/spec/frontend/component-guidelines.md` —— 原语与 token 引用约定
- `.trellis/spec/frontend/quality-guidelines.md` —— 护栏接入方式
- `src/styles/tokens/theme.css` / `tailwind.css` —— 现有 token 全貌
