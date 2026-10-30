# Neeko 与 Orca 视觉舒适度像素级审计与代码溯源

## 1. 像素采样基准对比

对当前 Neeko 深色主题截图与 Orca 截图进行原图 RGB 采样，结果对比如下：

| 界面区域 | Neeko 采样值 | Neeko 对应令牌或类 | Orca 采样值 | 视觉差异分析 |
| --- | --- | --- | --- | --- |
| 窗口顶栏与外框 | `#0e0e0e` `14,14,14` | `--bg-primary: oklch(0.178 0 0)` | `#131313` `19,19,19` | Neeko 外框暗、面板亮；Orca 外框微亮、核心画布深邃 |
| 左侧项目栏底色 | `#131313` `19,19,19` | `Island` `bg-bg-secondary` | `#0a0a0a` `10,10,10` | Neeko 与终端同色无主次；Orca 保持深黑沉浸底色 |
| 中央终端画布底色 | `#131313` `19,19,19` | `--terminal-bg: var(--bg-secondary)` | `#0a0a0a` `10,10,10` | Neeko 终端底色偏灰；Orca 接近纯黑，终端字符对比更纯净 |
| 右侧文件树底色 | `#131313` `19,19,19` | `Island` `bg-bg-secondary` | `#131313` `19,19,19` | Orca 右栏比中央终端亮 9 个 RGB 阶差，自然退居辅助地位 |
| 左侧列表选中态 | `#2c2c2c` `44,44,44` | `--bg-selected: oklch(0.35 0 0)` | `#181818` `24,24,24` 配 `#262626` 描边 | Neeko 选中态跃升 25 个 RGB 单位，形成刺眼亮灰大色块 |
| 终端激活标签底色 | `#2c2c2c` `44,44,44` | `--bg-selected: oklch(0.35 0 0)` | `#1b1b1b` `27,27,27` | Neeko 激活标签底色过亮，且字号绑定了 14px 终端字号显得拥挤 |

---

## 2. 代码级成因定位

### 2.1 深色主题明度阶梯与纯白眩光
文件位置：`src/styles/themes/dark.css`

1. `--bg-primary` 为 `oklch(0.178 0 0)`，与 `--bg-secondary` 的 `oklch(0.205 0 0)` 仅差 5 个 RGB 单位，导致 `3px` 海面缝隙在无描边情况下像面板开裂而非分层。
2. `--bg-selected` 为 `oklch(0.35 0 0)`，与 `--bg-secondary` 跨度过大，导致左侧会话选中行与顶部激活 Tab 形成高亮度灰块。
3. `--text-primary` 为 `oklch(0.985 0 0)` 近乎纯白 `#f9f9f9`，在深色背景下配合高密度列表产生明显眩光。
4. `--border-subtle` 为 `rgb(255 255 255 / 0.04)`，在暗底上几乎不可见，无法为浮岛与选中胶囊提供清晰边界。

### 2.2 浮岛容器缺少微光边界
文件位置：`src/ui/Island.tsx`

`ISLAND_CLASS` 当前定义为 `'flex flex-col overflow-hidden rounded-lg shadow-sm bg-bg-secondary min-h-0'`。在 `#0e0e0e` 海面上，`shadow-sm` 黑色阴影完全不可见，且缺少 `border border-border-subtle`，使得左中右三块同色面板在视觉上粘连。

### 2.3 左侧项目头与会话行尺度厚重
文件位置：`src/shared/components/ProjectGroup.tsx`、`src/shared/components/SessionRow.tsx`

1. `ProjectGroup.tsx` 第 124 至 135 行：`project-group-avatar` 尺寸为 `w-7 h-7` 即 `28px`，且带有 `border: 1.5px solid ${avatarStyle.color}` 的高饱和度粗边框；头部内边距为 `px-3 py-2.5`。
2. `SessionRow.tsx` 第 53 至 106 行：采用上下双行堆叠结构（第一行 `font-semibold` 显示 `label`，第二行 `text-[0.85em] font-mono` 显示 `branch`），左侧套有 `w-7 h-7` 图标盒，单行总高度达 `48px`，选中时形成厚重色块。

### 2.4 终端顶部双层工具栏与 Tab 字号错位
文件位置：`src/features/editor/components/PaneTabBar.tsx`、`src/features/editor/components/TabItem.tsx`、`src/features/editor/components/AgentBar.tsx`

1. `TabItem.tsx` 第 117 行与第 124 行：Tab 标题与关闭按钮内联样式误用 `style={{ fontSize: 'var(--terminal-font-size)' }}`（默认 `14px`），在 `h-6`（`24px`）的 Tab 容器内显得字号偏大且偏离全局 UI 字阶 `--text-ui`（`12px`）。
2. `PaneTabBar.tsx` 第 103 至 162 行：当激活 Tab 为终端时，`showAgentBarRow` 单独渲染第二行水平工具栏，放置 `AgentBar`（高饱和度彩色品牌图标）与分屏按钮，额外占用 `32px` 纵向高度并制造顶部色彩噪音。

### 2.5 右侧文件树色彩饱和度与字重偏重
文件位置：`src/features/file/components/FileTreeRow.tsx`、`src/features/file/components/FilesPanelHeader.tsx`

1. `FileTreeRow.tsx` 第 166 至 177 行：所有目录名统一使用 `font-medium` 搭配 `--text-primary` 近白文字，文件图标与文件夹图标以 100% 饱和度与不透明度渲染，三十余行彩色 SVG 图标在右侧排布形成彩虹带。
2. 行内间距 `py-0.5` 与圆角高亮缺少微妙的饱和度克制，未选中状态下彩色图标抢夺中央终端注意力。

---

## 3. 自动化门禁与单测约束核查

1. `src/styles/__tests__/themeTokens.test.ts`：
   - 强制校验每个主题文件完整包含 `THEME_VARIABLES` 的 59 个变量。
   - 强制校验 `--switch-track` 与 `--bg-primary` 对比度不低于 `1.5`。
   - 强制校验 `--text-primary` 与 `--bg-selected` 对比度不低于 `3.0`。
2. `tools/guards/checks/check_ui_style_tokens.py`：
   - 禁止在组件与样式中新增硬编码色值、暗色假设（例如 `border-white/...`）以及无 `focus-visible:` 的 `focus:outline-none`。
3. `src/ui/__tests__/Island.test.tsx`：
   - 断言 `ISLAND_CLASS.split(' ')` 包含 `flex`、`flex-col`、`rounded-lg`、`shadow-sm`、`bg-bg-secondary`。新增 `border` 与 `border-border-subtle` 完全向后兼容。
4. `src/shared/components/__tests__/ProjectGroup.test.tsx`：
   - 断言 `data-testid="project-group-avatar"` 存在且 `style.color` 为 `avatarStyle.color`，文本包含首字母。
5. `src/shared/components/__tests__/SessionRow.test.tsx`：
   - 断言 `label` 与 `branch` 文本均存在于渲染结果中。单行化改造时保留两个文本节点即可满足全部既有单测。
