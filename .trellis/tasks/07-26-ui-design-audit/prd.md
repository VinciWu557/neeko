# UI 精致化实施（从设计审计到实际改造）

## 目标

让 Neeko 的 UI **看起来更精致、更有设计感** —— 不是「补一份审计报告」，而是把设计系统
真正落到代码里：统一密度、统一字体阶梯、统一语义色、统一交互状态契约、补齐缺失原语，
并让**壳层**（TitleBar / StatusBar / Dock / Tab）达到专业 IDE 的完成度。

> **方向修订（2026-10-27）**
>
> 原任务是 **planning-only 的设计审计**：产出问题清单 + 路线图，不改代码。
> 用户明确将目标改为 **实施 UI 精致化**，并去掉 Decision Log D1–D5 五道决策门。
>
> **D1–D5 去掉意味着什么**：D1（Skills IA）、D2（Settings 形态）、D3（DockZoneTabs）、
> D4（Apple spacing）、D5（语义色命名策略）原本是「实现前必须先拍板」的 IA 决策。
> 去掉后本任务 **不再做 IA 重排**，只做**视觉与一致性**：
> - D1/D2/D3 → 降级为 P1 后续项，本轮不做
> - D4（Apple spacing）→ **直接废弃**：现有 `--spacing-apple-*` 引用率≈0，
>   保留会与 IDE 密度冲突。本轮只清理，不做 remap
> - D5（语义色命名）→ 简化为**最小修复**：只补断链 token（`status-error`），
>   不做全量语义色 rename（那是大爆炸改名，与「精致」无关）
>
> **去掉 D1–D5 不等于去掉所有约束**。仍然硬性成立的是 §4 设计原则、§5 目标设计系统
> （密度/字体/语义色/z-index/原语）与 §8 成功指标 —— 它们是「精致」的客观判据。

## 范围

### 在范围内

1. **设计系统地基**：density token、字体阶梯、z-index 阶梯、断链 token 修复
2. **原语层**：补齐 6 个缺失原语（`IconButton` / `PanelHeader` / `Toolbar` /
   `EmptyState` / `StatusDot` / `FormField`），统一交互状态契约
3. **壳层精致化**：TitleBar（补项目上下文）/ StatusBar（16→22px + 分区）/
   Dock / Tab 迁移到 token
4. **关键面**：Settings 选中态与表单密度、Projects 空态、Skills 单树渲染
5. **主题逃逸清零**：9 处硬编码色接入语义 token
6. **质量闸门**：eslint + 护栏，阻止问题复发
7. **新原型**：基于真实代码现状重做视觉锚点（旧的 5 份原型作废）

### 不在范围内

- 后端协议 / Agent 运行时
- 视觉品牌重设计（logo / 营销站 / 配色体系换血）
- Skills IA 重排（D1）、Settings 路由形态（D2）、Dock 多面板（D3）—— P1
- 动效系统（Motion 语言）—— P1
- WSL / SSH 远端相关 UI

## 子任务地图（按依赖顺序，不是按 CLI/页面名字）

> 原计划的 8 个子任务是「先把 IA 定好再逐层做」的思路。D1–D5 去掉后，
> 主线只剩**视觉一致性**一条，合并压缩为 6 个。

| # | ID | 范围 | 依赖 | 为什么这个顺序 |
| --- | --- | --- | --- | --- |
| 1 | `ui-quality-gate` | eslint 规则 + 1 条护栏：**禁止新增** `text-[#hex]` / 未定义 token 类 / 裸 `<button>` | — | **必须最先**。没有护栏，后面 5 项会被新代码反向覆盖回去 |
| 2 | `ui-tokens-foundation` | density token（9 个）/ 字体阶梯（5 个）/ z-index 阶梯（6 层）/ `status-error` 断链修复 / 清理 `--spacing-apple-*` | 1 | 地基。没有它，每个原语都得硬编码尺寸 |
| 3 | `ui-primitives` | 6 个原语 + 交互状态契约（hover/selected/danger/disabled/focus-visible） | 2 | 「精致」主要靠原语统一。`Button` 已有 cva 骨架，新原语照它的模式 |
| 4 | `ui-chrome-polish` | TitleBar 补项目上下文 / StatusBar 16→22 / Dock / Tab 迁移 token | 3 | 壳层是「第一眼精致」的地方 |
| 5 | `ui-key-surfaces` | Settings 选中态 + 表单密度 + Projects 空态 + Skills 单树渲染 | 3 | 体感最强的两个面（Settings / Projects）+ 一个真实副作用修复（Skills 双挂载） |
| 6 | `ui-theme-escape-fix` | 9 处硬编码色 → 语义 token | 2 | 让 Light / Claude 主题下不再「一半原生一半 GitHub」 |

### 依赖图

```text
ui-quality-gate（贯穿，但先落）
      │
      ▼
ui-tokens-foundation
      ├─► ui-primitives ──► ui-chrome-polish
      │       ├──────────► ui-key-surfaces
      │       └──────────► ui-theme-escape-fix
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

- [ ] **AC1 §8 成功指标全部达成或明确降级理由**

  | 指标 | 7 月基线 | 当前（2026-10-27） | 目标 |
  | --- | --- | --- | --- |
  | raw button（`src/ui` 外） | ~311 | 520 | <80 或给出分期理由 |
  | 硬编码 px 字号 | ~266 | 446 | chrome/feature UI 归零（宿主除外） |
  | 暗色假设 white/alpha | ~33 | 39 | 归零 |
  | z-index 魔法数档位 | 14 | 9 | ≤6（全部 token 化） |
  | theme escape（`text-[#` 等） | 多 | 9 | 0 |
  | 未定义 `status-error` | 有 | **有（4 处正在使用）** | 消除 |

  > 复测命令见 `design.md` §8.1，可机械核验。
  > 「当前」一列是 2026-10-27 实测值（原文档只有 7 月基线，缺中间态，故补齐）。
- [ ] **AC2 护栏生效**：新增硬编码色 / 未定义 token / 裸 button 能被自动拦下
- [ ] **AC3 无回归**：`pnpm check:quick` 全绿 + 既有前端测试全绿
- [ ] **AC4 新原型对齐实现**：新原型与最终代码的视觉差异为 0（逐屏比对）

### 子任务级

- `ui-quality-gate`：eslint 规则命中演示 + 护栏单测（喂脏数据必红）
- `ui-tokens-foundation`：每个新 token 有定义 + tailwind 映射 + 消费点测试；
  `status-error` 断链修复后 4 处错误提示**实测有颜色**
- `ui-primitives`：6 个原语各有 props 契约测试 + 交互状态（hover/selected/disabled）
  快照；`Button` 变体与新原语不冲突
- `ui-chrome-polish`：StatusBar 实测 22px；TitleBar 显示项目名 + 分支 + 环境；
  focus-visible 键盘可达
- `ui-key-surfaces`：Settings nav 选中态为 surface 而非大色块；Projects 空态三 CTA；
  Skills 不再双挂载（**单次渲染断言**钉住）
- `ui-theme-escape-fix`：9 处硬编码色归零；Light / Claude / One Dark 三主题下
  Git 面板取色正确

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
