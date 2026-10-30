# 对齐 Orca 视觉舒适度：深色明度阶梯、浮岛边界、导航降噪与卡片紧凑化

## Goal

系统性消除 Neeko 界面相对 Orca 的「泛灰、切碎、厚重、刺眼」观感，通过深色主题明度阶梯重构、浮岛微光描边、左侧项目与会话行单行紧凑化、终端顶部工具栏合流降噪以及文件树视觉柔化，建立沉稳、克制、主次分明的桌面开发环境视觉体验。

---

## Requirements

### R1. 深色主题明度阶梯与文本柔和度重构
1. 压深 `src/styles/themes/dark.css` 的基础背景色阶，使海面底色 `--bg-primary` 下探至深邃黑（`oklch(0.145 0 0)`，约 `#0a0a0a`），浮岛底色 `--bg-secondary` 下探至 `oklch(0.175 0 0)`（约 `#101010`），拉开海面与面板的深浅层次。
2. 收敛交互态明度跨度：将 `--bg-tertiary` 调整为 `oklch(0.215 0 0)`，`--bg-hover` 调整为 `oklch(0.220 0 0)`，`--bg-selected` 从刺眼的 `oklch(0.35 0 0)`（`#2c2c2c`）下调至克制的 `oklch(0.245 0 0)`（约 `#1f1f1f`）。
3. 柔化文字对比度：将 `--text-primary` 从近纯白 `oklch(0.985 0 0)` 调整为柔和灰白 `oklch(0.900 0 0)`（约 `#e0e0e0`），`--text-secondary` 调整为 `oklch(0.740 0 0)`，`--text-muted` 调整为 `oklch(0.580 0 0)`，消除暗底纯白眩光。
4. 提升 `--border-subtle` 在深色主题下的可感知度（从 `rgb(255 255 255 / 0.04)` 提升至 `rgb(255 255 255 / 0.07)`），并同步校准 `base/variables.css` 中的兜底值。

### R2. 浮岛容器边界清晰化
1. 在 `src/ui/Island.tsx` 的 `ISLAND_CLASS` 中增加 `border border-border-subtle`，使左、中、右各浮岛面板在深色海面上具备清晰的 `1px` 微光边缘，解决三栏同色粘连与黑缝割裂问题。

### R3. 左侧项目列表与会话卡片紧凑化
1. **项目组头部降噪（`ProjectGroup.tsx`）**：
   - 将项目首字母徽标 `project-group-avatar` 从 `w-7 h-7`（`28px`）缩小为 `w-5 h-5`（`20px`）精致圆角方块，移除厚重的 `1.5px solid` 高饱和实线边框，改为柔和的 `1px` 半透明同色系細描边，字号收敛至 `text-text-micro font-semibold`。
   - 将头部内边距从 `px-3 py-2.5` 紧凑化为 `px-2.5 py-1.5`，项目名称字重从 `font-semibold` 调整为 `font-medium`。
2. **会话行单行胶囊化（`SessionRow.tsx`）**：
   - 将原有的 `48px` 双行堆叠大卡片重构为高度约 `28px`（`py-1 px-2.5 mx-1.5`）的单行紧凑胶囊。
   - 左侧图标容器从 `w-7 h-7`（16px 图标）缩小为 `w-4 h-4`（13px 图标），移除冗余内嵌底色块。
   - 将 `label` 与 `branch` 改为单行水平排布（主标签与分支名同行展示，分支名使用 `font-mono text-text-muted`），选中态在 `bg-bg-selected` 基础上增加 `border border-border-subtle`（非选中态为 `border border-transparent`），对齐 Orca 的轻量胶囊质感。

### R4. 终端顶部栏合流、Tab 字号修正与品牌图标降噪
1. **Tab 字号回归 UI 字阶（`TabItem.tsx`）**：
   - 移除 `TabItem.tsx` 中标题与关闭按钮上误绑定的 `style={{ fontSize: 'var(--terminal-font-size)' }}`，统一改用 UI 字体阶梯 `text-text-ui`（跟随 `--font-size`），并为激活态 Tab 补充 `border border-border-subtle` 细描边。
2. **终端次级工具栏合流与色彩克制（`PaneTabBar.tsx` / `AgentBar.tsx`）**：
   - 将 `PaneTabBar.tsx` 中原本独占第二行的 `AgentBar` 与分屏按钮合并至第一行 TabBar 右侧区域（当空间充足时内联展示，或以紧凑单行工具簇呈现），消除终端上方双层条带叠加，释放约 `28px` 纵向终端视口高度。
   - 将 `AgentBar.tsx` 中的按钮字号从 `--terminal-font-size` 修正为 `text-text-meta`，并对未选中的第三方 Agent 彩色图标施加轻微饱和度与不透明度克制（`opacity-75 hover:opacity-100 transition-opacity`），避免一排高饱和彩色图标常驻抢眼。

### R5. 右侧文件树色彩与排版静谧化
1. **文件树图标与字重克制（`FileTreeRow.tsx`）**：
   - 目录名称字重从 `font-medium` 调整为常规字重 `font-normal`（仅激活文件保持 `font-medium`），消除文件夹与文件混排时的粗细跳动。
   - 对非高亮行的文件与文件夹 SVG 图标施加适度柔和化处理（`opacity-80`），在保留文件类型辨识度的同时消除右侧「高饱和彩虹条带」对余光的干扰。
   - 文件树行选中态同样配齐柔和过渡与紧凑内边距。

### R6. 两侧 DockBar 图标视觉减重
1. 在 `src/layout/dock-layout/DockBar.tsx` 及关联按钮中，保持非激活态图标处于低明度静默状态（`text-text-muted`），降低外围 44px 工具轨的视觉侵略性。

---

## Constraints

1. **严守主题契约与护栏**：
   - 不新增未在 `src/shared/utils/themeVariables.ts` 登记的 CSS 变量，或如新增必须同步更新契约与全部 5 个主题文件。本任务优先在既有 59 个契约变量内完成调优。
   - 所有样式修改必须通过 `check_ui_style_tokens` 与 `check_styles_layout` 护栏检查，严禁引入硬编码裸色值或 `color-mix` 降级隐患。
2. **严守对比度机器判据**：
   - 修改 `dark.css` 后，`src/styles/__tests__/themeTokens.test.ts` 中的 `--switch-track` vs `--bg-primary` 对比度必须 `>= 1.5`，`--text-primary` vs `--bg-selected` 对比度必须 `>= 3.0`。
3. **保持组件功能与单测契约兼容**：
   - `ProjectGroup` 必须保留 `data-testid="project-group-avatar"` 及 `color` 样式映射；
   - `SessionRow` 必须同时渲染 `label` 与 `branch` 文本节点；
   - `Island` 必须保留 `ISLAND_CLASS` 既有基础类名。

---

## Acceptance Criteria

- [ ] `src/styles/themes/dark.css` 完成明度阶梯与文本柔和度更新，`themeTokens.test.ts` 与 `themeContract.test.ts` 全部通过。
- [ ] `src/ui/Island.tsx` 的 `ISLAND_CLASS` 包含 `border border-border-subtle`，浮岛边界在深色主题下清晰可辨，`Island.test.tsx` 通过。
- [ ] `ProjectGroup.tsx` 与 `SessionRow.tsx` 完成紧凑化与单行胶囊改造，选中态具备 `1px` 微光描边且不再出现厚重亮灰大色块，`ProjectGroup.test.tsx` 与 `SessionRow.test.tsx` 通过。
- [ ] `TabItem.tsx`、`PaneTabBar.tsx` 与 `AgentBar.tsx` 完成字号修正、单行合流与图标降噪，终端顶部不再出现双层高饱和工具栏堆叠，相关编辑器单测全部通过。
- [ ] `FileTreeRow.tsx` 完成字重统一与图标柔和化，文件树相关单测全部通过。
- [ ] `pnpm check:quick` 静态检查、28 条护栏及关联单元测试全部零报错通过。
