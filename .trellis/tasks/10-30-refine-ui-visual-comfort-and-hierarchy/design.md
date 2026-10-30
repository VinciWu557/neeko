# 技术设计：对齐 Orca 视觉舒适度与界面层级优化

## 1. 架构边界与改动范围

本任务属于纯前端视觉与组件排版层重构，严格收敛在 `src/styles/`、`src/ui/`、`src/shared/components/`、`src/features/editor/components/` 与 `src/features/file/components/` 五个目录内，零后端（`src-tauri/`）改动，零 Zustand Store 结构改动，零跨模块导入边界变更。

```
改动影响域拓扑
src/styles/themes/dark.css ──────────► 全局深色明度阶梯、选中态底色、文本柔化、弱分割线令牌
src/styles/base/variables.css ───────► :root 兜底 --border-subtle 同步
src/ui/Island.tsx ───────────────────► ISLAND_CLASS 补充 border border-border-subtle
src/shared/components/
  ├── ProjectGroup.tsx ──────────────► 缩小项目首字母徽标 (28px→20px)、弱化描边、收紧行高
  └── SessionRow.tsx ────────────────► 双行 48px 卡片重构为单行 28px 紧凑胶囊 + 选中态细描边
src/features/editor/components/
  ├── TabItem.tsx ───────────────────► 移除 --terminal-font-size 误用，回归 UI 字阶 + 激活态描边
  ├── PaneTabBar.tsx ────────────────► AgentBar 与分屏按钮并入顶栏单行布局，消除次级工具栏行
  └── AgentBar.tsx ──────────────────► 修正按钮字号、精简内边距、降低常驻彩色图标视觉侵略性
src/features/file/components/
  └── FileTreeRow.tsx ───────────────► 目录字重回归 font-normal、文件图标适度柔化 (opacity-80)
```

---

## 2. 详细设计规范

### 2.1 深色主题令牌重校准（`src/styles/themes/dark.css`）

在不增删任何主题变量名（保持 59 个契约变量完全一致）的前提下，重新标定 `dark.css` 的 OKLCH 明度曲线：

| 变量名 | 修改前 | 修改后 | 等效 HEX 变化 | 对比度校验 |
| --- | --- | --- | --- | --- |
| `--titlebar-gradient-start` | `oklch(0.178 0 0)` | `oklch(0.145 0 0)` | `#0e0e0e` → `#0a0a0a` | 窗口顶栏与海面同色 |
| `--bg-primary` | `oklch(0.178 0 0)` | `oklch(0.145 0 0)` | `#0e0e0e` → `#0a0a0a` | 与 `--switch-track` (`#363636`) 对比度为 `1.67`（满足 `>= 1.5`） |
| `--bg-gradient-start` | `oklch(0.178 0 0)` | `oklch(0.145 0 0)` | `#0e0e0e` → `#0a0a0a` | 保持纯色无渐变断层 |
| `--bg-gradient-end` | `oklch(0.178 0 0)` | `oklch(0.145 0 0)` | `#0e0e0e` → `#0a0a0a` | 保持纯色无渐变断层 |
| `--bg-secondary` | `oklch(0.205 0 0)` | `oklch(0.175 0 0)` | `#131313` → `#101010` | 浮岛与终端底色更深邃沉稳 |
| `--bg-tertiary` | `oklch(0.269 0 0)` | `oklch(0.215 0 0)` | `#242424` → `#191919` | 输入框与次级块不再突兀泛灰 |
| `--bg-hover` | `oklch(0.3 0 0)` | `oklch(0.220 0 0)` | `#2d2d2d` → `#1a1a1a` | 悬停反馈细腻柔和 |
| `--bg-selected` | `oklch(0.35 0 0)` | `oklch(0.245 0 0)` | `#393939` → `#1f1f1f` | 消除亮灰大色块；与 `--text-primary` 对比度约 `10.8`（远高于 `>= 3.0`） |
| `--text-primary` | `oklch(0.985 0 0)` | `oklch(0.900 0 0)` | `#f9f9f9` → `#e0e0e0` | 消除纯白刺眼感，对齐 Orca 柔和灰白 |
| `--text-secondary` | `oklch(0.85 0 0)` | `oklch(0.740 0 0)` | `#cecece` → `#ababab` | 次级文本层级清晰 |
| `--text-muted` | `oklch(0.708 0 0)` | `oklch(0.580 0 0)` | `#9e9e9e` → `#7a7a7a` | 弱化辅助元数据与非激活图标 |
| `--border-subtle` | `rgb(255 255 255 / 0.04)` | `rgb(255 255 255 / 0.07)` | 4% 白 → 7% 白 | 让浮岛描边与选中胶囊轮廓恰到好处地显现 |

### 2.2 浮岛容器描边契约（`src/ui/Island.tsx`）

将 `ISLAND_CLASS` 从：
```ts
export const ISLAND_CLASS =
  'flex flex-col overflow-hidden rounded-lg shadow-sm bg-bg-secondary min-h-0';
```
更新为：
```ts
export const ISLAND_CLASS =
  'flex flex-col overflow-hidden rounded-lg border border-border-subtle shadow-sm bg-bg-secondary min-h-0';
```
此改动遵循单一事实源原则，自动生效于左侧 DockZone、中央编辑器与终端区、右侧文件树 DockZone、底部面板及 Library 双岛，无需在各业务面板重复声明边框。

### 2.3 左侧项目组与会话行紧凑化设计

#### `src/shared/components/ProjectGroup.tsx`
1. **头部容器**：将 `gap-2.5 px-3 py-2.5` 调整为 `gap-2 px-2.5 py-1.5 rounded-md`，降低单项目头部高度。
2. **项目徽标（`project-group-avatar`）**：
   - 类名从 `'w-7 h-7 rounded-md flex items-center justify-center text-[0.95em] font-bold shrink-0 uppercase'` 调整为 `'w-5 h-5 rounded flex items-center justify-center text-text-micro font-semibold shrink-0 uppercase'`。
   - 内联样式移除刺眼的 `border: 1.5px solid ${avatarStyle.color}`，改为 `border: 1px solid ${avatarStyle.color}40`，保留 `color: avatarStyle.color` 与 `backgroundColor: avatarStyle.backgroundColor`，既满足既有测试断言 `expect(avatar).toHaveStyle({ color: ... })`，又大幅降低方框阵列的视觉重量。
3. **项目名称**：字重从 `font-semibold` 改为 `font-medium`，计数 `(N)` 字号使用 `text-text-micro text-text-muted`。

#### `src/shared/components/SessionRow.tsx`
1. **行容器**：从 `'group flex items-center gap-2.5 pl-4 pr-3 py-2 mx-1.5 rounded-md cursor-pointer transition-colors'` 调整为单行紧凑胶囊：
   ```tsx
   'group flex items-center gap-2 pl-2.5 pr-2 py-1 mx-1.5 rounded-md border cursor-pointer transition-colors',
   deleting && 'wt-deleting',
   isActive
     ? 'bg-bg-selected border-border-subtle'
     : 'border-transparent hover:bg-bg-hover',
   ```
2. **行首图标**：从 `w-7 h-7 rounded-md`（`<Icon size={16} />`）缩小为 `w-4 h-4 flex items-center justify-center shrink-0`（`<Icon size={13} />`），移除冗余的 `style={{ backgroundColor: ... }}` 内联底色。
3. **文本排布（单行化）**：
   将原有的上下两行 `<div>` 改为水平单行 `flex items-center gap-1.5 min-w-0`：
   ```tsx
   <div className="flex-1 flex items-center gap-1.5 min-w-0">
     {editing ?? (
       <>
         <span
           className={cn(
             'text-text-ui truncate',
             isActive ? 'font-medium text-text-primary' : 'text-text-secondary group-hover:text-text-primary',
           )}
           onDoubleClick={onLabelDoubleClick}
           title={labelTitle}
         >
           {label}
         </span>
         {branch && (
           <span className="text-text-meta font-mono text-text-muted truncate shrink-0 max-w-[60%]">
             {branch}
           </span>
         )}
       </>
     )}
   </div>
   ```
   这样既将每行高度从 `48px` 压缩至 `28px`，又完整保留 `label` 与 `branch` 两个 DOM 文本节点，确保 `SessionRow.test.tsx` 100% 兼容。

### 2.4 终端顶部栏合流与字号修正设计

#### `src/features/editor/components/TabItem.tsx`
1. 移除标题 `<span>` 与关闭 `<button>` 上的 `style={{ fontSize: 'var(--terminal-font-size)' }}`，改用 `text-text-ui` 类名，使 Tab 栏文字与全局 12px UI 字体对齐。
2. 为 Tab 容器增加 `border`：激活态使用 `'bg-bg-selected border-border-subtle text-text-primary'`，非激活态使用 `'border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary'`。

#### `src/features/editor/components/PaneTabBar.tsx` 与 `AgentBar.tsx`
1. **单行合流（`PaneTabBar.tsx`）**：
   - 将原本位于第二行的 `AgentBar` 与分屏按钮组（`Split Horizontal`、`Split Vertical`、`Close Pane`）合流至第一行 `h-8` 头部容器右侧，在 `TabBar` 与右侧工具簇之间用一条 `w-px h-3.5 bg-border-subtle shrink-0` 细分割线隔开，并在底部加 `border-b border-border-subtle` 与终端画布形成清晰分界。
   - 当 `AgentBar` 处于展开态且换行时，容器允许自适应高度（`min-h-8 py-1`），常规单行状态下整个 `PaneTabBar` 仅占 `32px` 单行高度，直接省去原有的第二行独立工具条。
2. **Agent 按钮降噪（`AgentBar.tsx`）**：
   - 移除 `style={{ fontSize: 'var(--terminal-font-size)' }}`，改为 `text-text-meta`。
   - 按钮内边距从 `px-2 min-h-6` 收紧为 `px-1.5 h-6`，未选中态图标包裹层添加 `opacity-75 group-hover/agent:opacity-100 transition-opacity`，降低常驻彩色品牌图标的视觉冲击。

### 2.5 右侧文件树柔化设计（`src/features/file/components/FileTreeRow.tsx`）

1. **目录字重统一**：第 177 行目录名称 `<span>` 的类名从 `flex-1 font-medium truncate ${nameColorClass}` 调整为 `flex-1 font-normal truncate ${nameColorClass}`，仅当前激活打开的文件行保留 `font-medium`。
2. **文件与文件夹图标降噪**：为目录与文件的 `<img />` 标签增加 `opacity-80` 类（高亮选中行保持 `opacity-100`），削弱高饱和度彩色 SVG 图标在深色背景下的刺眼程度。

---

## 3. 兼容性与回滚策略

1. **向后兼容性**：所有组件 Props 接口签名保持不变，无破坏性 API 变更。
2. **回滚粒度**：五个改动模块（主题令牌、Island 描边、左侧项目树、中央 Tab 栏、右侧文件树）相互正交，任意子模块均可独立回退而不影响其余模块运行。
