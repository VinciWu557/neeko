# 执行计划：对齐 Orca 视觉舒适度与界面层级优化

## 1. 详细改动点清单（有序步骤）

### Step 1：重构深色主题明度阶梯与边框令牌
**目标文件**：
1. `src/styles/themes/dark.css`
2. `src/styles/base/variables.css`
3. `src/styles/__tests__/themeTokens.test.ts`

**具体改动点**：
1. 在 `src/styles/themes/dark.css` 第 17 至 35 行：
   - `--titlebar-gradient-start`: `oklch(0.178 0 0)` → `oklch(0.145 0 0)`
   - `--bg-primary`: `oklch(0.178 0 0)` → `oklch(0.145 0 0)`
   - `--bg-gradient-start`: `oklch(0.178 0 0)` → `oklch(0.145 0 0)`
   - `--bg-gradient-end`: `oklch(0.178 0 0)` → `oklch(0.145 0 0)`
   - `--bg-secondary`: `oklch(0.205 0 0)` → `oklch(0.175 0 0)`
   - `--bg-tertiary`: `oklch(0.269 0 0)` → `oklch(0.215 0 0)`
   - `--bg-hover`: `oklch(0.3 0 0)` → `oklch(0.220 0 0)`
   - `--bg-selected`: `oklch(0.35 0 0)` → `oklch(0.245 0 0)`
   - `--text-primary`: `oklch(0.985 0 0)` → `oklch(0.900 0 0)`
   - `--border-subtle`: `rgb(255 255 255 / 0.04)` → `rgb(255 255 255 / 0.07)`
   - `--text-secondary`: `oklch(0.85 0 0)` → `oklch(0.740 0 0)`
   - `--text-muted`: `oklch(0.708 0 0)` → `oklch(0.580 0 0)`
2. 在 `src/styles/base/variables.css` 第 38 行：
   - 将 `:root` 兜底 `--border-subtle` 同步为 `rgb(255 255 255 / 0.07)`。
3. 运行 `npx vitest run src/styles/__tests__/themeTokens.test.ts src/shared/utils/__tests__/themeContract.test.ts` 验证对比度与契约守卫通过。

---

### Step 2：为浮岛容器补充 1px 微光边界
**目标文件**：
1. `src/ui/Island.tsx`
2. `src/ui/__tests__/Island.test.tsx`

**具体改动点**：
1. 在 `src/ui/Island.tsx` 第 12 行：
   - 将 `ISLAND_CLASS` 修改为 `'flex flex-col overflow-hidden rounded-lg border border-border-subtle shadow-sm bg-bg-secondary min-h-0'`。
2. 在 `src/ui/__tests__/Island.test.tsx`：
   - 补充对 `border` 与 `border-border-subtle` 类名的断言。
3. 运行 `npx vitest run src/ui/__tests__/Island.test.tsx` 验证通过。

---

### Step 3：左侧项目组头部与会话行单行紧凑化
**目标文件**：
1. `src/shared/components/ProjectGroup.tsx`
2. `src/shared/components/__tests__/ProjectGroup.test.tsx`
3. `src/shared/components/SessionRow.tsx`
4. `src/shared/components/__tests__/SessionRow.test.tsx`

**具体改动点**：
1. 在 `src/shared/components/ProjectGroup.tsx`：
   - 第 111 行：头部容器类名由 `'flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-bg-hover relative'` 改为 `'flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer hover:bg-bg-hover relative'`。
   - 第 124 至 135 行：`project-group-avatar` 类名由 `'w-7 h-7 rounded-md flex items-center justify-center text-[0.95em] font-bold shrink-0 uppercase'` 改为 `'w-5 h-5 rounded flex items-center justify-center text-text-micro font-semibold shrink-0 uppercase'`；内联样式 `border` 由 `1.5px solid ${avatarStyle.color}` 改为 `1px solid ${avatarStyle.color}40`。
   - 第 137 至 140 行：项目名 `font-semibold` 改为 `font-medium`；会话数 `text-[0.85em]` 改为 `text-text-micro`。
   - 第 200 行：展开内容容器 `pb-1.5` 改为 `pb-1 space-y-0.5`。
2. 在 `src/shared/components/SessionRow.tsx`：
   - 第 56 至 60 行：行容器类名改为 `'group flex items-center gap-2 pl-2.5 pr-2 py-1 mx-1.5 rounded-md border cursor-pointer transition-colors'`，激活态分支为 `isActive ? 'bg-bg-selected border-border-subtle' : 'border-transparent hover:bg-bg-hover'`。
   - 第 70 至 80 行：左侧图标容器改为 `w-4 h-4 flex items-center justify-center shrink-0`，移除内联 `backgroundColor` 样式，`<Icon size={16} />` 改为 `<Icon size={13} />`。
   - 第 81 至 95 行：将 `label` 与 `branch` 改为同行水平排列（`flex-1 flex items-center gap-1.5 min-w-0`），`label` 使用 `text-text-ui truncate`，`branch` 使用 `text-text-meta font-mono text-text-muted truncate`。
3. 运行 `npx vitest run src/shared/components/__tests__/ProjectGroup.test.tsx src/shared/components/__tests__/SessionRow.test.tsx` 验证通过。

---

### Step 4：终端顶部工具栏单行合流、Tab 字号修正与 Agent 图标降噪
**目标文件**：
1. `src/features/editor/components/TabItem.tsx`
2. `src/features/editor/components/AgentBar.tsx`
3. `src/features/editor/components/PaneTabBar.tsx`
4. `src/features/editor/components/__tests__/TabItem.test.tsx`
5. `src/features/editor/components/__tests__/TabBar.test.tsx`

**具体改动点**：
1. 在 `src/features/editor/components/TabItem.tsx`：
   - 第 96 至 99 行：补充 `border` 类，激活态为 `'bg-bg-selected border-border-subtle text-text-primary'`，非激活态为 `'border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary'`。
   - 第 117 行与第 124 行：移除 `style={{ fontSize: 'var(--terminal-font-size)' }}`，标题 `<span>` 添加 `text-text-ui`，关闭按钮添加 `text-text-meta`。
2. 在 `src/features/editor/components/AgentBar.tsx`：
   - 第 41 至 67 行：将外层容器调整为紧凑内联行 `flex items-center gap-0.5 flex-wrap min-w-0`；按钮移除 `style={{ fontSize: 'var(--terminal-font-size)' }}`，改用 `text-text-meta px-1.5 h-6 rounded`；未选中态图标包裹 `<span className={selected ? 'opacity-100' : 'opacity-75 group-hover:opacity-100 transition-opacity'}>`。
3. 在 `src/features/editor/components/PaneTabBar.tsx`：
   - 第 77 至 163 行：将 `TabBar`、`AgentBar` 与分屏按钮整合进带 `border-b border-border-subtle` 的紧凑头部容器内，使常规终端视图下 Tab 与右侧 Agent 快捷按钮、分屏按钮共处同一水平带，消除独立次级工具栏造成的双层割裂。
4. 运行 `npx vitest run src/features/editor/components/__tests__/TabItem.test.tsx src/features/editor/components/__tests__/TabBar.test.tsx` 验证通过。

---

### Step 5：右侧文件树字重统一与彩色图标柔化
**目标文件**：
1. `src/features/file/components/FileTreeRow.tsx`
2. `src/features/file/components/__tests__/FilesPanel.test.tsx`

**具体改动点**：
1. 在 `src/features/file/components/FileTreeRow.tsx`：
   - 第 170 行与第 206 行：目录与文件图标 `<img />` 根据 `isHighlighted` 增加透明度控制 `${isHighlighted ? 'opacity-100' : 'opacity-80'}`。
   - 第 177 行：目录名 `<span>` 类名从 `flex-1 font-medium truncate ${nameColorClass}` 改为 `flex-1 font-normal truncate ${nameColorClass}`。
2. 运行 `npx vitest run src/features/file/components/__tests__/FilesPanel.test.tsx` 验证通过。

---

## 2. 质量门禁与验收命令

全部步骤完成后，在收尾阶段执行一次：
```bash
pnpm check:quick
```
确认 ESLint、TypeScript 类型检查、Rust 格式校验、28 条架构护栏（含 `check_ui_style_tokens` 与 `check_styles_layout`）以及全部关联单元测试一次通过。
