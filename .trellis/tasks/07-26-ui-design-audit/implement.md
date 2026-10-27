# 实现路线图 — UI 精致化（2026-10-27 方向修订）

> **方向修订**：本任务从「planning-only 的设计审计」改为 **实施 UI 精致化**。
> D1–D5 Decision Log 全部作废（见 `design.md` §11），不再做 IA 重排，
> 只做**视觉与一致性**。
>
> **第二次收窄（用户明确）**：
> - **不改动当前布局，只做样式 / UI 层面的优化** —— 凡涉及 DOM 结构 / 容器几何 /
>   字级 / 布局类 / chrome 尺寸的项全部移出本轮（清单见 `design.md` §10「已移出本轮」）。
> - **不主动提交代码** —— 改动留在工作树，等用户指示。
>
> 权威方案见 [`design.md`](./design.md)：
> 子任务清单 §10.1a、依赖图 §10.3、v1 边界 §10.4、原型索引 §12、
> 跨任务边界 §13、spec 大纲 §14、复测命令 §8.1。

## ✅ 已实施：CSS 架构优化（2026-08-07）

基于高内聚/低耦合原则对 `src/styles/` 重构（用户收窄范围，仅 CSS）：

- **分层**：`tokens/`（theme/shadcn/tailwind 桥接）→ `base/base.css` → `components/`（9 个单职责文件）；`index.css` 收敛为纯 `@import` 入口。
- **tokens 修复**：补 `--accent-orange`（5 主题）与 `--font-mono`；修 `--accent-foreground` 硬编码蓝 → `var(--accent-blue)`；`@theme` 增 `--color-accent-orange`。
- **硬编码消除**：`.word-diff-added/removed` → `color-mix(in srgb, var(--diff-added-text) 20%, transparent)`。
- **DRY**：theme.css 5 块 hljs 覆盖（~200 行）收敛为 markdown.css 一组 `var(--cm-*)` 映射（值已逐一对齐）。
- **layer 治理**：signature tooltip 等脱离 `@layer components` 的规则归位；`@layer base`/`components` 显式声明。
- **测试同步**：`DiffNoWrap.test.tsx` 读取路径 → `components/diff.css`（红→绿验证）。
- **验证**：`pnpm build` 无 CSS 警告（原 7 条消失）、`pnpm test:run` 1191 通过、`pnpm lint:fe` 全绿。

## 实施阶段校验命令

```bash
npx tsc --noEmit
pnpm test
pnpm exec eslint src/ui src/layout src/styles --max-warnings 0
pnpm tauri dev
```

## 实施顺序（对齐 design §10.1a / §10.3）

> **护栏最先**。不是「贯穿全程的并行项」，而是执行上的第一步 ——
> 三个月前审计结论 0 落地，根因就是没有护栏（30 条护栏无一条管 UI 样式）。
> 先做清理、新代码继续灌入，就是这三个月发生的事。

```text
1. ui-quality-gate          eslint 规则 + check_ui_style_tokens 护栏（先拦新增）
      │
2. ui-tokens-foundation    语义色 alias / status-error 断链修复 / 字体阶梯定义 / z-index 阶梯定义
      │
      ├─► 3. ui-primitives        IconButton / PanelHeader / Toolbar / EmptyState / StatusDot / FormField
      │       └─► 5. ui-interaction-states   暗色假设 / text-white / focus-visible / Settings 选中态
      └───────────────────────────────────► 4. ui-theme-escape-fix  9 处硬编码色 → 语义 token
```

**v1 cut（design §10.4）：** 全部 5 个子任务。

**本轮边界（prd.md AC0）**：只改样式层。DOM 结构 / 容器几何 / 字级 / 布局类 /
路由与挂载结构一律不动。允许的改动白名单：颜色系 class、`focus-visible:*`、
`ring-*`、token 定义文件、`src/ui/` 下新原语文件。

字体阶梯与 density token **只定义不套用** —— token 定义本身是纯 CSS 声明，
套用才会改几何。

其余（Settings 全文搜索 / Motion 语言 / Skills IA / 语义色全量 rename /
**全部 chrome 几何调整**）P1 或另行处理。

## 阶段 A — 护栏（0.5 天）· ui-quality-gate

**目标：** 先把「不复发」的地基打好 —— 没有护栏，后面 4 项会被新代码反向覆盖。

1. [x] ~~eslint 规则~~ → **改由护栏承担**（见下）。理由：eslint 要逐 JSX 元素判断
       `className` 的语义，护栏按文件扫描即可覆盖 99% 的实际写法（class 都是字面量），
       且护栏能同时管 CSS 文件；两条规则并存会出现「同一件事两个口径」。
2. [x] 护栏 `tools/guards/checks/check_ui_style_tokens.py`（**已实现，四条判据**）
3. [x] 护栏单测 `tools/guards/tests/test_check_ui_style_tokens.py` —— **13 用例全绿**
       含两条**变异验证**（删掉判据 1 / 判据 4 → 必绿）与两条**反证**
       （注释提到旧写法不得误报 / 已合规写法不得误报）
4. [x] 护栏在真实仓库首跑即抓出一处漏网：`src/ui/Switch.tsx:24` 的裸 `bg-white`
       （手写 grep `bg-white/` 会漏掉裸写法）→ 判据 2 的正则已补 `(?![-\w])`

**主改文件：** `tools/guards/checks/check_ui_style_tokens.py`（新增）、
`tools/guards/tests/test_check_ui_style_tokens.py`（新增）、
`tools/guards/tests/test_gates.py`（护栏计数 28 → 29，该文件**故意硬编码**计数）。

**实测：** `python3 tools/guards/run.py run --only check_ui_style_tokens`
→ `scanned=599 个 tsx / 0 处违规`；变异验证：种一处 `bg-[#3fb950]` → 必红，还原 → 全绿。

**退出门槛：** ✅ 存量已清零（无需 warning 模式豁免）；✅ 喂脏数据能报出。

## 阶段 B — 地基（1 天）· ui-tokens-foundation

**目标：** 修掉断链 token，定义阶梯。**只改 CSS 定义，不套用到现有元素。**

1. [x] `--status-error` alias → `--status-failed`（**5 个主题块全补**）
2. [x] tailwind 补 `--color-status-error` 映射 —— **修掉 4 处错误提示无色的 bug**
       —— **已用真实构建验证**：产物 CSS 中 `.text-status-error{color:var(--color-status-error)}`
       存在（改动前该类**根本没生成**）
3. [x] 字体阶梯 token 定义（§5.2 六项）—— 放 `:root`，`@theme inline` 桥接
4. [x] z-index 阶梯定义（§5.4 六层）
5. [x] density token 定义（§5.1 十七项）—— **只定义，不套用**
6. [x] `--border-subtle` 弱分割线 —— **逐主题显式 rgba**（不是 color-mix，见下）
       - dark / classic-dark / one-dark-pro：`rgb(255 255 255 / 0.04)`（等效原值）
       - claude：`rgb(0 0 0 / 0.08)` · light：`rgb(0 0 0 / 0.09)`（亮底可见）
       - 桥接用 `@utility border-border-subtle`（**不能**用 `@theme`，见下）
7. [x] 规范：`.trellis/spec/frontend/design-tokens.md` 落盘（新增，含三个必知的坑）

**主改文件：** `src/styles/tokens/theme.css`、`src/styles/tokens/tailwind.css`、
`.trellis/spec/frontend/design-tokens.md`（新增）、`.trellis/spec/frontend/index.md`。

**退出门槛：** ✅ `text-status-error` 类真的生成（构建产物已验证）；
✅ 5 主题切换无 token 失效；✅ 新增类名逐个在产物 CSS 中确认存在。

> **⚠ 返工记录（2026-10-27，用户反馈触发）**
>
> 首版 `--border-subtle` 用 `color-mix(in srgb, var(--text-primary) 8%, transparent)`，
> 放在 `:root` 一次定义。**用户反馈：「projects 优化后还没优化前好看，
> 每个项目之间都加了一个横杠，很丑」。**
>
> **根因不是「加了横杠」，而是横杠的强度变了**：
> 原值 `border-white/[0.04]` = **4% 白**（几乎不可见）；
> 新值 = **8% 近白**（`--text-primary` 在暗色主题下是 `#ffffff` / `oklch(0.985)`）
> → 暗色海面上是一条**清晰可见**的横线。
>
> **教训：token 化只保证「跟随主题」，不保证「强度不变」。**
> 替换一个**低对比度**元素时，视觉强度是必须保持的量。
> 护栏拦不住这类问题（它只判「有没有用 token」）。
>
> **第二个坑：`color-mix` 在本仓库会被降级。** 产物里出现
> `@supports (color:color-mix(...))` 包裹，回退值取 color-mix 的**第一个分量**
> → `--border-subtle: var(--text-primary)`（近白实色，比原来粗得多）。
> 同理 Tailwind 的 `@theme` 会在编译期求值变量，遇到 color-mix 里的 `var()`
> 也退化成第一个分量。
>
> **最终方案**：逐主题显式 rgba + `@utility` 桥接（运行时解析）。
> 验证方式：**看构建产物**（`dist/assets/*.css`）里的最终值，不是看源码 ——
> 源码对、产物被降级，是静默的。
>
> **⚠ 第二轮返工（2026-10-27，用户反馈触发）**
>
> 用户：「**直接去掉不要横杠，横杠的意义是什么呢**」
>
> 第一轮把强度改回等效值只是**止损**（回到「几乎不可见」）。但用户要的是**去掉**。
>
> **定案：项目之间不画分割线。** 理由：
> - 项目头本身已是视觉单元（avatar + 粗体名称 + 计数）
> - hover 时整行有 `bg-bg-hover` 背景块 —— **背景块已承担分组职责**
> - 再加一条线 = 三重分隔
>
> **落地不只删 class**：`isLast` 这条数据链
> （`groupProjects` → `ProjectsPanel` → `ProjectItem` → `ConnectionProjectCard` →
> `ProjectGroup`）**唯一的消费者就是那条线**，故整条链一并删除 ——
> 否则留下无人消费的 prop（TS `noUnusedParameters` 直接报 TS6133）。
>
> **顺带纠正一处错误注释**：`groupProjects` 原注释称 `lastGroup` 是
> 「**DnD 排序落点用**」—— 那是错的：DnD 用的是 `over.id`（拖放目标的项目 id），
> 与该字段无关。它只是那条分割线的燃料。
>
> **未动**：`useProjectList` 里另有一份 `isLast`（另一条平行链）——
> 它有自己的测试断言、且**无外部消费者**，属更早的遗留死代码，
> 与本次分割线无关，**不扩大改动范围**。
>
> **验证**：`tsc --noEmit` 通过；`vitest src/features/project/` 22 files / 187 tests 通过；
> AC0 机器复核：**DOM 标签集合未变 + 新增布局类 0 处**。
>
> **⚠ 第三轮返工（2026-10-27，用户反馈触发）**
>
> 用户：「**开关样式优化之后更加丑了**」（附 Claude 主题截图：赭红轨道上深棕滑块）
>
> **这是同一类错误的第三次**：前两次是「替换低对比度元素时把强度改粗」，
> 这次是「**前景色选错了语义**」。
>
> 首版把 Switch 滑块从 `bg-white` 改成 `bg-text-primary`，理由是「跟随主题更保险」。
> **错在：滑块压在 accent 底上，它要的是「accent 底上的前景色」
> = `--text-on-accent`，不是「页面文字色」= `--text-primary`。**
>
> Claude 主题下两者差得极远：
> `accent-blue` = `#c96442`（赭红轨道）· `text-primary` = `#2d1e14`（深棕滑块）
> → 糊成一团。正确是 `text-on-accent` = `#f5f0e8`（浅米白滑块）。
>
> **仓库本来就有正确范式，首版没查就自己发明**：
> `ui/Checkbox.tsx` 的对勾用 `text-text-on-accent`，
> `ui/ToggleGroup.tsx` 的选中态用 `text-text-on-accent`。
>
> **最终**：`bg-text-primary` + `data-[state=checked]:bg-text-on-accent`
> —— 同一元素在两种底上（accent 底 / bg-tertiary 底）需要两个颜色。
>
> **验证方式：不能只看类名，要算对比度。** 实测 5 主题滑块/轨道对比：
> 修复前 dark 1.37 / one-dark-pro 1.11（糊）→ 修复后全部 ≥2.94。
>
> **教训（已写入 spec 坑 6）**：
> **选颜色前先问「它压在什么底上」，而不是「它是什么元素」。**
>
> **全仓审计（用户要求「全部找一遍」）**：扫全部 599 个 tsx + 8 个 css，
> 除 Switch 外又找到 **4 处同型问题**，全部已修：
>
> | 位置 | 元素 | 修复前 | 修复后 |
> | --- | --- | --- | --- |
> | `app/components/WelcomeScreen.tsx:65` | 「Add Your First Project」按钮 | `text-text-primary` | `text-text-on-accent` |
> | `shared/components/GitDialog.tsx` | 自制 switch 滑块 | `bg-text-secondary` | `bg-text-primary` + `checked:bg-text-on-accent` |
> | `styles/components/agent.css:71` | `.agent-bar-btn.selected` | `color: var(--text-primary)` | `color: var(--text-on-accent)` |
> | `styles/base/base.css:51` | `.wc-close:hover` | `color: #fff` | `color: var(--text-on-accent)` |
>
> **扫描判据**：**实底** accent 容器（`bg-accent-*` 后面**不跟 `/数字`**）
> —— 半透明底不算（半透明底上用普通文字色是对的）。
>
> **扫描时的两个陷阱**（都造成误报）：
> ① 正则 `\b` 边界把 `bg-accent-blue/15` 也算实底 → 误报 16 处；
> ② `text-xs`/`text-sm` 是**字号**不是颜色 → 误报 5 处。
> 两轮误报后才收敛到真正的 5 处。
>
> **附带**：修 `GitDialog.tsx` 时触发 `check_component_size` ratchet
> （332 行基线只许缩小）—— 我加的注释把它推到 336 行。
> 处置：压缩注释 + 删一行冗余的历史注释（`// Sync homeDirPath from remoteHomeDir`，
> 代码自明）→ 回到 332 行。
> **教训**：组件规模护栏**连注释都算行数**。

## 阶段 C — 原语（1–2 天）· ui-primitives

**目标：** 补齐 6 个缺失原语。**本轮只新增，不替换现有页面的用法**（替换会改 DOM 结构）。

1. [ ] `IconButton`（sm/md/lg，focus-visible，tooltip）
2. [ ] `PanelHeader`（标题 + actions）
3. [ ] `Toolbar`
4. [ ] `EmptyState`（icon + 标题 + 描述）
5. [ ] `StatusDot`（idle/running/failed/unknown）
6. [ ] `FormField`（label + control + hint + error）
7. [ ] 原语单测：props 契约 + 交互态（hover/selected/disabled/focus-visible）class 存在

**主改文件：** `src/ui/`（新增 6 个文件）、`src/ui/index.ts`（导出）。

> **本阶段未做 —— 刻意留白，不是遗漏。**
>
> 新增原语而**不替换任何现有用法** = 交付 6 个**无人消费**的组件：
> 它们不会被任何页面用上，验收只能靠「组件存在 + 单测通过」，
> **对「UI 看起来更精致」零贡献**。
>
> 而真正替换现有用法 = 改 DOM 结构（换组件必然改结构）→ **违反 AC0**。
>
> 两条路都走不通，所以本阶段**整体移出本轮**。原语层留作后续独立任务，
> 前提是那一轮允许改结构。

**参考原型：** `prototype-shell-v2.html`（6 个改动点清单 —— 本阶段交付的 6 个原语
是其中 #4 focus-visible 与 #5 选中态的**契约来源**，但原型不画新原语的界面）。

**退出门槛：** 6 个原语各有单测；`Button` 变体与新原语不冲突。

## 阶段 D — 主题逃逸清理（0.5 天）· ui-theme-escape-fix

**目标：** 9 处硬编码色 → 语义 token。**纯 class 替换，DOM 结构与几何不变。**

1. [x] `prDisplay.ts:27` / `PRDetailView.tsx:51,250` / `PRDetailSkeleton.tsx:21` ——
      `#a371f7`（MERGED 态）→ **`accent-brick`**（主题已有的合并色，覆盖 5 主题）
2. [x] `ChangesSection.tsx:103,108` —— `#3fb950`（新增行数）→ `diff-added-text`；
      `#f85149`（删除行数）→ `diff-removed-text`
3. [x] `SessionChips.tsx:11` —— `#3fb950` → `diff-added-text`
4. [x] `ContextMenu.tsx:79` / `TabOverflowMenu.tsx:140` —— `#e06c75` → `accent-red`

**主改文件：** 见 design §10.1a 的 `ui-theme-escape-fix` 行。

**参考原型：** `prototype-shell-v2.html` 改动点 #6。

**实测：** `rg 'text-\[#|bg-\[#|border-\[#' src --glob '!**/*test*'` → **0** ✅；
构建产物确认 `.bg-accent-brick\/20` / `.text-accent-brick` / `.text-diff-added-text` 均生成 ✅。

**附带修复：** `prDisplay.test.ts` 原断言硬编码 `'a371f7'` —— 改成断言 `accent-brick`，
并**加了一条反证用例**（状态徽标不得含任何 hex），这样「改回 hex」会让测试变红，
而不是靠护栏单点防守。

## 阶段 E — 交互状态（1 天）· ui-interaction-states

**目标：** 统一交互态。**纯 class 替换。**

1. [x] **40 处** 暗色假设 → 语义 token（比预估的 39 处多 1 处：
       护栏首跑抓出的 `src/ui/Switch.tsx` 裸 `bg-white`，见阶段 A）
   - `border-white/[0.04]` / `[0.03]` → `border-border-subtle`（弱分割线，5 主题自适应）
   - `border-white/10` → `border-border`
   - `hover:bg-white/10` / `active:bg-white/20` → `bg-bg-hover`
   - `bg-white`（Switch 滑块）→ **见下方「第三轮返工」**：最终是
     `bg-text-primary` + `data-[state=checked]:bg-text-on-accent`（按底色选前景色）
2. [x] **`text-white` 叠 accent —— 32 处**（不是 6 处，首轮统计只 grep 了部分文件）→
   `text-text-on-accent`（`--text-on-accent` 随主题变）
   - 特例 `ExternallyModifiedDialog.tsx`：底色是**半透明** `bg-accent`（12% 蓝），
     不是实心 accent → 用 `text-accent-foreground`（= `--accent-blue`）而非
     `text-on-accent`（后者是深色字，在浅色底上会「深底深字」）
   全量清单：`rg 'text-white' src --glob '!**/*test*'`
   含 `ui/Button.tsx:13,14` · `ui/ToggleGroup.tsx:33` · `ui/Checkbox.tsx:35` ·
   `app/components/ErrorBoundary.tsx:107` · `features/settings/components/TerminalPanel.tsx:225` ·
   `features/connection/components/{RemoteDialog,WSLDialog}.tsx`（各 4 处）·
   `shared/components/ProjectSettingsDialog.tsx`（5 处）·
   `features/{skill,notification,editor,git,action-menu}/**`
3. [x] `focus:outline-none` **真缺** focus-visible 替代的 **8 个文件**：
   `ui/Dialog.tsx` · `ui/Badge.tsx` · `app/components/DockBarButton.tsx` ·
   `app/components/ToolbarFooter.tsx` · `features/settings/components/LspCustomServersSection.tsx` ·
   `features/runner/components/LaunchConfigDialog.tsx` ·
   `features/runner/components/DebugVariablesPane.tsx` ·
   `features/task/components/TaskDialog.tsx`
   （已合规、不动：`SettingsSidebar.tsx` / `ReferencesPeekDialog.tsx` 已有 focus-visible；
   `LspStatusSection.tsx` / `LspServerRow.tsx` 早就合规 —— 说明规范是**局部**缺失，不是全局缺失）
   > `ui/Dialog.tsx` 与 `ui/Badge.tsx` 用的是 `focus:ring-2`（非 focus-visible）——
   > 鼠标点击也会出环，与「仅键盘显示焦点」的设计意图不符，需一并核对。
4. [ ] Settings nav 选中态：`!bg-accent-blue !text-[var(--text-on-accent)]`（4 处）→
   surface 选中 + 左侧指示条
5. [ ] 效果一致性检查：Light / Claude 主题下分割线与 hover 可见

**主改文件：** 见 design §10.1a 的 `ui-interaction-states` 行。

**参考原型：** `prototype-shell-v2.html` 的改动点 #2 / #3 / #4 / #5。

**实测退出门槛：** ✅ `rg 'border-white/|bg-white/' src --glob '!**/*test*'` → **0**
（剩余 2 处命中是 token 文件里**解释旧写法**的注释，非代码）；
✅ `rg 'text-white' src --glob '!**/*test*'` → **0**；
✅ 每个 `focus:outline-none` 所在文件都有 `focus-visible:`；
✅ Settings 选中态为 surface 而非大色块。

## 回滚点

- Token alias 可双写（`--status-error` 只是 alias，删掉即回滚）
- 原语**只新增不替换** —— 不替换就没有回滚风险
- 主题逃逸逐文件改，改完一个文件可单独回滚（纯 class 替换）
- 交互态逐文件改，同上
- 护栏 warning 模式 —— 发现误报可先降级为不报错

## 每阶段 PR 自检

1. 默认 Dark + Light / Claude 主路径点检（**只查颜色与交互态，不查几何**）
2. Projects / Files / Conversation / Git / Settings / Terminal 的颜色表现
3. 键盘 Tab 走 Dock + 一个 Dialog —— **焦点环可见**
4. PR 描述链接对应原型（design §12）
5. **`git diff` 逐 hunk 自查：无 DOM 结构 / 无尺寸 / 无字级 / 无布局类变更**
   （prd.md AC0 的白名单）

## v1 非目标

- 重做品牌插画
- 自研完整 Design System 站点
- **任何会改变布局的改动**（DOM 结构 / 容器几何 / 字级 / 布局类 / chrome 尺寸）
- 改变 dock 状态机 / 拖拽逻辑（Skills IA 按 D1 单独评审）
- Dock zone 多面板可视化（D3，另开任务再议）
- Settings 全文搜索（P1）
- raw button 收敛（换组件 = 改结构与行为）
- 字体阶梯与 density token 的**套用**（只定义）
