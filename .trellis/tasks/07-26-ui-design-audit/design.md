# Neeko UI 设计审计与优化方案（设计文档）

> 角色：产品设计师 + React 前端专家  
> 目标：现代化、专业 IDE 级体验；**只做方案，不改代码**

---

## 1. 当前信息架构 / 布局地图

```
┌──────────────────────────────────────────────────────────────────────┐
│ TitleBar (h-8)  [logo] …… [Open IDE][Task][Debug] [窗口控件]        │
├────┬───────────────────────────────┬────┬────────────────────────────┤
│ L  │ 左 DockZone（浮岛）            │ 中 │ 中心浮岛                   │ R│
│ 工 │ projects / skills …           │ 心 │ ProjectWorkspace           │ 工│
│ 具 │                               │    │  ├ 编辑器分组 + Tabs        │ 具│
│ 栏 │                               │    │  ├ Terminal / Agent / File │ 栏│
│ +  │                               │    │  └ Guide 空态              │  │
│ ⚙  │                               │    │ 或 SettingsView / Skill    │  │
├────┴───────────────────────────────┴────┴────────────────────────────┤
│ TaskConsole / DebugPanel（底部浮层，不在 dock 体系内）                 │
├──────────────────────────────────────────────────────────────────────┤
│ StatusBar (h-4)  LSP · 冲突 · Debug/Task · 行列 · 通知               │
└──────────────────────────────────────────────────────────────────────┘

全局浮层：Settings 替换中心区、各类 Dialog、QuickOpen、SymbolNav、Toast
```

### 导航模型

| 层级 | 机制 | 说明 |
| --- | --- | --- |
| 主 chrome | `DockLayout` + `DockBar` + `DockBarButton` | IDEA Islands，主路径 |
| 遗留 | `ActivityBar` / `PanelArea` / `RightPanel` | 仍导出，主路径未使用 |
| App 视图 | `appViewStore`: `normal` \| `settings` | Settings 整页替换中心 |
| 中心双模式 | Skills 激活时隐藏 workspace，显示 SkillContent | 与 dock skills 耦合 |
| 全局 palette | QuickOpen / SymbolNav | 接近 VS Code 命令面板 |

### 左/右面板注册

- 左：`projects`, `skills`
- 右：`files`, `gitControl`, `pullRequests`, `browser`, `conversations`（UI 名 History）

### 应保留的优势

1. **Islands Dock**：`bg-primary` 作“海”，面板圆角浮岛 — 有辨识度、更现代
2. **多主题 token 骨架**：`theme.css` + `shadcn-theme.css` 方向正确
3. **Feature-based 结构**：`features/*` + `ui/*` + `layout/*` 适合规模化
4. **可停靠面板 + 尺寸持久化**：专业工具感强
5. **命令面板体系**：Quick Open / Symbol Nav 符合 IDE 心智
6. **部分空态/骨架已成型**：Conversation skeleton、ProjectGuide 可作为模板
7. **原型文化**：`docs/prototypes/git-log-panel.html` 可作密度参考（当前仅存在于主仓库，未随本 worktree 签出）

---

## 2. 设计系统盘点

### 2.1 Token

| 层 | 状态 | 问题 |
| --- | --- | --- |
| 表面色 | `--bg-primary/secondary/tertiary/hover/selected` | 层级够用，但业务仍写死 hex/rgba |
| 文本色 | `--text-primary/secondary/muted` | 缺 `disabled` / 对比度规范 |
| 强调色 | `--accent-blue/green/yellow/red` | 按色相命名；Claude 下 “blue” 实为橙棕 |
| 状态色 | `--status-idle/running/failed` | 组件大量用未定义 `status-error` |
| Diff | `--diff-*` | Git UI 仍硬编码 GitHub 绿/红/紫 |
| Apple spacing/radius | `@theme` 已定义 | **组件几乎 0 使用** |
| shadcn 变量 | `--background/--primary/--radius` | 与 Neeko token 双轨；`--accent-foreground` 写死 `#2997ff` |
| 缺失 token | `--accent-orange`、`bg-bg-surface` | 被引用但主题未定义 |

### 2.2 组件采用率（量化）

| 模式 | 约数 |
| --- | --- |
| `ui/` 外 raw `<button` | **~311**（审计初值 ~325） |
| `ui/Button` 使用 | **~11 imports** |
| 内联 `style={{...}}` | **~92** |
| 硬编码字号 `text-[8–18px]` | **~266** |
| 硬编码字号 `em` / `text-[N.Nem]` | **~222**（合计 ~488） |
| raw `<input>` vs `ui/Input` | **43 vs 36** |
| Apple token 业务引用 | **~0** |
| 图标体系 | shared icons ~61 文件 + 直引 lucide ~29 + 内联 SVG/emoji |
| 暗色假设 `border-white/` / `bg-white/` | **~33** 处 |

### 2.3 视觉语言冲突

同时存在三套气质：

1. **JetBrains Islands**（DockLayout 注释明确）
2. **VS Code 密度**（细状态栏、tab、activity 逻辑）
3. **Apple spacing tokens**（定义未落地）

结论：能用、偏现代，但缺少 **统一设计语言权威源**。

---

## 3. 问题清单（按优先级）

### P0 — 破坏专业感 / 主题正确性 / 系统一致性 / IA 清晰度

#### P0-1 主题逃逸：硬编码颜色导致多主题失效

- `GitCredentialDialog.tsx`：整页 inline 写死 One Dark 色板
- `SessionChips.tsx`、`ChangesList.tsx`、PR 系列：`#3fb950` / `#f85149` / `#a371f7`
- `WSLDialog` / `RemoteDialog`：`rgba(97,175,239,…)` 写死 One Dark 蓝
- `SectionHeader` / `ContextMenu`：DOM style / hex danger
- 多处 `text-white` 叠 accent，未用 `--text-on-accent`（One Dark / OKLCH 下对比失效）

#### P0-2 设计原语未被采用（双轨 UI）

- ~311 raw button vs 11 Button（基线见 §2.2）
- Settings / StatusBar / Dock / Skill / Git 各自手写 hover/active/disabled
- Dialog 与手写 `fixed inset-0` 浮层并存（Task/Launch/部分 Settings）

#### P0-3 Token 语义破损

- 使用 `status-error` 但主题只定义 `status-failed`
- `accent-blue` 在 Claude 下是橙色 — 命名误导
- `--accent-foreground: #2997ff` 不随主题变化
- `accent-orange` / `bg-surface` 未定义却被引用

#### P0-4 导航双轨 / 死代码 / 未完成迁移

- 主路径 Dock；`ActivityBar` / `PanelArea` / `RightPanel` / `SidebarContext` 仍导出
- `DockZoneTabs` 已实现但 **DockZone 未挂载** → 多面板 zone 无法 visually 切换
- DockBar badge 恒 `hidden` 且写死 `0`

#### P0-5 Skills 信息架构冲突

- Skills 既是左侧 dock 面板，又整页替换中心 workspace
- `App.tsx` 双挂载 + CSS `hidden`：编辑器/终端从视野消失，心智模型混乱

#### P0-6 主 chrome 焦点不可见

- `DockBarButton` / ToolbarFooter 等 `focus:outline-none` 无 `focus-visible:ring`
- 键盘用户在主导航几乎无焦点反馈

#### P0-7 StatusBar 过矮

- `h-4`（16px）承载 LSP/Console/Debug 等交互，低于 VS Code/JetBrains 密度下限

---

### P1 — 专业 IDE 体验差距

#### P1-1 上下文层级不足

- TitleBar 几乎只有 logo + 动作，缺 **当前项目 / 环境(Local·WSL·SSH) / 分支**
- 用户难以持续感知“我在哪”

#### P1-2 密度体系不统一

| 区域 | 现状 | 问题 |
| --- | --- | --- |
| TitleBar | h-8 | 可接受 |
| Dock 按钮 | 外 44 / 内 32，footer 外 36 / 内 28 | 不一致 |
| Dock tabs | h-8 | |
| Editor tabs | h-6 | 偏矮；且用了 `--terminal-font-size` |
| StatusBar | h-4 | 过矮 |
| 面板头 | h-6 / h-7 / h-8 / min-h-9 | 相邻浮岛不对齐 |

#### P1-3 字体阶梯失控

- 并存：`--font-size`、`text-[8–18px]`、`0.72–1.07em`、`calc(var(--font-size)±N)`
- Appearance 调字号时大量标签不跟随

#### P1-4 Empty / Loading / Error 不专业

- Projects：`No projects added` 纯文案
- Dock Suspense：`Loading {title}...`
- Conversation 有 skeleton（好），其他面板没有统一骨架
- 错误多为 toast 或零散文案，缺 ErrorState

#### P1-5 Settings 体验割裂

- 替换整个中心岛，丢失项目上下文
- active 用大面积 `accent-blue` fill，与 dock 选中（bg-selected）语言不一致
- 搜索只过滤 nav label，不是设置项全文搜索
- 大量 raw input/button + em 字号

#### P1-6 图标与符号混乱

- Lucide / shared icons / 内联 SVG / emoji（📁 ⚡ 💻）混用
- 描边 1.8 vs 2、尺寸 10–22 漂移

#### P1-7 焦点与可达性参差

- 多处 outline 被去掉
- StatusBar LSP 下拉自研 portal + 绝对定位，键盘弱
- 手写 modal 无统一 focus trap

#### P1-8 反馈系统分裂

- AppToast：仅 info/error
- notification feature 另一套
- 无统一 success / warning / progress 规范

#### P1-9 面板头 / 工具栏无标准组件

- ~82 处 `border-b border-border` 各自拼 header
- Browser / Diff / Conversation / Debug 高度与按钮尺寸不一

#### P1-10 z-index 混乱

- 14 档魔法数：50 / 100 / 200 / 999 / 1000 / 1100 / 2000 / 9998 / 9999 / 10000
- 菜单/对话框/toast 互相打架风险高

#### P1-11 菜单系统三套皮肤

- `ui/ContextMenu`：shadcn accent 蓝洗
- project `ContextMenu`：bg-hover + hex danger
- skill 菜单：刻意避开 accent 蓝

#### P1-12 浅色主题不友好

- `border-white/[0.04]`、`hover:bg-white/5` 假设暗色海面
- Light/Claude 下分割线消失或发脏

#### P1-13 底部工具不在 Islands 体系

- TaskConsole / Debug 与侧栏浮岛语言不一致，“工具在哪”心智分裂

#### P1-14 Input 默认强制 mono

- 所有 Input 用 monospaced，名称/凭据类表单不专业

---

### P2 — 可维护性与长期品质

1. 双 `cn` 路径：`@/lib/utils` 与 `@/shared/utils/cn`
2. Badge/计数器未产品化
3. Dialog 尺寸/页脚规范不统一
4. Motion 语言缺失（面板/tab）
5. `text-secondary/40` 等半透明对比风险
6. StatusBar 职责过重（LSP 管理挤进 16px）
7. Apple token 死代码 vs 任意 spacing
8. 并行 CSS 类（`.agent-bar-btn` 等）与 Tailwind 时代混用
9. 源码编码/注释乱码痕迹（迁移残留）

---

## 4. 目标设计原则

1. **Content first, chrome quiet** — 内容与浮岛是主角
2. **One density scale** — 全应用共用 compact IDE 密度
3. **Semantic tokens only** — 禁止业务硬编码颜色
4. **Primitives over snowflakes** — 按钮/输入/面板头/空态走统一组件
5. **Persistent context** — 始终可见：项目、环境、分支、活动 Agent
6. **Keyboard-first** — 可点控件必有 focus-visible
7. **Honest empty states** — 空态给行动，不只给文案

**权威锚点：**

- 布局：保留 **Islands**
- 密度：向 **VS Code / Cursor compact** 靠拢（不是 Apple HIG 宽松）
- 组件：以 **shadcn + Neeko semantic tokens** 为唯一实现层
- Apple spacing：要么 remap 为 IDE density 后真正启用，要么废弃叙事

---

## 5. 目标设计系统

### 5.1 密度 Token

```text
--chrome-titlebar-h: 32px
--chrome-statusbar-h: 22px      /* 16 → 22 */
--chrome-dockbar-w: 44px
--chrome-panel-header-h: 32px
--chrome-tab-h: 28px
--chrome-toolbar-h: 32px
--row-h-sm: 24px
--row-h-md: 28px
--row-h-lg: 32px
--icon-sm: 14px
--icon-md: 16px
--icon-lg: 20px
--radius-panel: 8px
--radius-control: 6px
--radius-chip: 9999px
--gap-island: 6px
```

### 5.2 字体阶梯（绑定 --font-size）

| Token | 公式 | 用途 |
| --- | --- | --- |
| `text-micro` | max(10px, base-2) | 时间戳、快捷键 hint |
| `text-meta` | max(11px, base-1) | 次级元数据 |
| `text-ui` | base (12) | 默认 UI |
| `text-ui-md` | base+1 | 列表主标题 |
| `text-ui-lg` | base+2 | 面板标题 |
| `text-section` | base+4 | Settings section |

业务层禁止再写 `text-[11px]` / `0.86em`（xterm/CM 宿主除外）。

### 5.3 语义色（渐进 rename）

| 新语义 | 映射自 | 用途 |
| --- | --- | --- |
| `--color-accent` | accent-blue | 主强调（可非蓝） |
| `--color-success` | accent-green / status-idle | 成功 |
| `--color-warning` | accent-yellow / status-running | 警告/索引中 |
| `--color-danger` | accent-red / status-failed | 错误/删除 |
| `--status-error` | alias → status-failed | 兼容现有 class |

兼容期旧名作 alias；修掉 `--accent-foreground` 写死蓝。

### 5.4 z-index 阶梯（最多 6 层）

```text
--z-base
--z-dropdown
--z-sticky
--z-modal
--z-toast
--z-devtools
```

### 5.5 必建原语 / Pattern

| 组件 | 职责 |
| --- | --- |
| `IconButton` | 24/28/32 热区、tooltip、focus-visible、active |
| `PanelHeader` | 标题 + actions；固定高度 |
| `Toolbar` | 横向工具条 |
| `EmptyState` | icon + 标题 + 描述 + 主/次 CTA |
| `StatusDot` | idle/running/failed/unknown |
| `FormField` | label + control + hint + error |
| `ChromeChip` | 分支/环境/计数 |
| `UnderlineTabs` | 参考 GitControl 本地好模式 |

### 5.6 交互状态契约

- hover：`bg-bg-hover`，文字 → primary
- selected：`bg-bg-selected` **或** accent fill + **仅** `text-on-accent`
- danger hover：`bg-accent-red/10 text-accent-red`
- disabled：`opacity-50 pointer-events-none`
- focus-visible：统一 ring（`var(--accent-blue)` / semantic accent）

### 5.7 布局 refinement

1. **TitleBar**：logo | 项目名 + 环境 badge + 分支 | 分组 actions
2. **StatusBar**：22px；左 LSP/Git 摘要；中任务；右行列/通知；详细管理进菜单
3. **Settings**：v1 保持中心岛替换；选中态与 dock 一致（selected surface）；全文搜索为 P1（见 §11 Decision Log）
4. **Skills IA**：v1 推荐 **master-detail**（左列表 + 中心详情）；禁止 `hidden` 双挂载（见 §11）
5. **DockZoneTabs**：v1 **禁止 zone 多面板**；组件保留但主路径不挂载（见 §11）
6. **删除/冻结** ActivityBar 等遗留导航（`ui-nav-cleanup`）
7. **Apple spacing token**：废弃业务叙事；density token 成为唯一间距权威（见 §11）

---

## 6. 关键界面优化建议

### Projects

- 空态：图标 + Add Local / WSL / SSH 三 CTA
- Git +/- 走 diff tokens；环境用统一色点/图标

### Workspace / Tabs

- Tab 高度与关闭热区对齐 density
- Dirty / Running / Failed 统一 StatusDot
- Tab 文案用 UI 字号，不用 terminal font size
- Guide 升级为带快捷键提示的 Onboarding

### Conversation

- 已有 skeleton — 作列表面板参考
- 收敛 `text-[10/11px]` 到 type scale
- Agent filter 抽 `ChromeChip`

### Git / PR / 连接

- 全面去 hex；`GitCredentialDialog` → Dialog + FormField + Input + Button
- WSL/Remote 去写死蓝与 emoji 图标
- Diff toolbar → Toolbar 原语

### Skill

- emoji → Lucide/自定义 SVG
- 卡片密度与 Projects 对齐

### Terminal / Editor

- 宿主主题桥接独立；chrome 与宿主分离

---

## 7. React 架构建议（实现阶段）

1. ESLint/脚本：禁止 feature 内 `text-[#`、颜色字面量 style
2. 新代码强制原语；旧代码按 P0 文件优先扫
3. 统一 `cn` 入口
4. 不要大爆炸重写：token → 原语 → chrome → feature
5. Skills 中心切换改为单树路由/条件渲染，避免双挂载

---

## 8. 成功指标

| 指标 | 基线 | 目标 |
| --- | --- | --- |
| raw button（ui 外） | ~311 | <80 |
| Button 采用 | ~11 | 覆盖对话框主操作与工具栏 |
| feature 硬编码色 | 多 | 交互 chrome 归零 |
| 硬编码 px 字号 | ~266 | chrome/feature UI 归零（宿主除外） |
| 暗色假设 white/alpha | ~33 | Light/Claude 路径归零 |
| StatusBar 高 | 16px | 22px |
| 未定义 status-error | 有 | 消除 |
| 导航双轨 | 有 | 仅 Dock |
| Projects 空态 | 纯文案 | 多 CTA EmptyState |
| Skills 双挂载 | 有 | 单一 IA |
| z-index 魔法数 | 14 档 | ≤6 token 层 |

### 8.1 复测命令（实现阶段每 PR 可跑）

```bash
# raw buttons outside src/ui
rg -n '<button\b' src --glob '!**/*test*' -g '!src/ui/**' | wc -l

# Button imports
rg -n "from ['\"]@/ui/button['\"]" src --glob '!**/*test*' | wc -l

# hardcoded px / em type sizes
rg -n 'text-\[(8|9|10|11|12|13|14|15|16|17|18)px\]' src --glob '!**/*test*' | wc -l
rg -n 'text-\[[0-9.]+em\]|0\.[0-9]+em' src --glob '!**/*test*' | wc -l

# theme escape candidates
rg -n 'text-\[#|bg-\[#|border-\[#' src --glob '!**/*test*' | wc -l
rg -n 'border-white/|bg-white/|hover:bg-white/' src --glob '!**/*test*' | wc -l

# broken / legacy tokens
rg -n 'status-error|accent-orange|bg-surface' src --glob '!**/*test*'
```

---

## 9. 风险与取舍

| 风险 | 缓解 |
| --- | --- |
| 大范围 class 替换易回归 | 分 feature PR；先 alias |
| 密度调整影响肌肉记忆 | StatusBar/Tab 分两步或可配置 |
| Islands 间距减少内容区 | gap 4–6px |
| 语义色重命名成本 | 双写 1–2 个版本 |
| Skills IA 改动影响工作流 | 默认 master-detail；双挂载改单树前先做状态清点 |
| 与 unified-task-hub 争 Settings/TitleBar | 见 §13 跨任务边界 |

---

## 10. 实现子任务（2026-10-27 重排）

> 原 8 个子任务是「先把 IA 定好再逐层做」的思路。D1–D5 去掉后主线只剩视觉一致性，
> 合并压缩为 6 个，**并把护栏提到最前**（理由见 `prd.md`「为什么护栏必须第一个做」）。

| # | ID | 范围 | 依赖 | v1? |
| --- | --- | --- | --- | --- |
| 1 | `ui-quality-gate` | eslint 规则 + 1 条护栏：禁止新增 `text-[#hex]` / 未定义 token 类 / 裸 `<button>` | — | **Yes**（最先） |
| 2 | `ui-tokens-foundation` | density token（§5.1 九项）/ 字体阶梯（§5.2 五项）/ z-index 阶梯（§5.4 六层）/ `status-error` 断链修复 / 清理 `--spacing-apple-*` | 1 | **Yes** |
| 3 | `ui-primitives` | `IconButton` / `PanelHeader` / `Toolbar` / `EmptyState` / `StatusDot` / `FormField`（§5.5）+ §5.6 交互状态契约 | 2 | **Yes** |
| 4 | `ui-chrome-polish` | TitleBar 补项目上下文 / StatusBar 16→22 / Dock / Tab 迁移 token | 3 | **Yes** |
| 5 | `ui-key-surfaces` | Settings 选中态 + 表单密度 + Projects 空态 + Skills 单树渲染 | 3 | **Yes** |
| 6 | `ui-theme-escape-fix` | 9 处硬编码色 → 语义 token | 2 | **Yes** |

### 10.1a 子任务清单（2026-10-27 实际落点）

| ID | 落点文件（真实路径） |
| --- | --- |
| `ui-quality-gate` | `tools/guards/checks/check_ui_style_tokens.py`（新增）· `eslint.config.js`（新增规则） |
| `ui-tokens-foundation` | `src/styles/tokens/theme.css` · `src/styles/tokens/tailwind.css` |
| `ui-primitives` | `src/ui/IconButton.tsx` · `PanelHeader.tsx` · `Toolbar.tsx` · `EmptyState.tsx` · `StatusDot.tsx` · `FormField.tsx` · `src/ui/index.ts` |
| `ui-chrome-polish` | `src/layout/TitleBar.tsx` · `src/features/status-bar/StatusBar.tsx` · `src/app/components/DockBarButton.tsx` · `src/layout/dock-layout/DockBar.tsx` |
| `ui-key-surfaces` | `src/features/settings/components/SettingsSidebar.tsx` · `SettingsPanel.tsx` · `src/features/project/components/*` |
| `ui-theme-escape-fix` | `src/shared/components/SessionChips.tsx` · `ContextMenu.tsx` · `src/features/git/utils/prDisplay.ts` · `src/features/git/components/ChangesSection.tsx` · `src/features/git/components/pr-detail/{PRDetailView,PRDetailSkeleton}.tsx` · `src/features/editor/components/TabOverflowMenu.tsx` |

> 原 §15 落点表列的 `src/styles/theme.css` / `index.css` / `shadcn-theme.css` 已迁移到
> `src/styles/tokens/`（见 `implement.md` 头部的 CSS 架构优化记录）。

### 10.2 阶段映射（A–F ↔ 子任务）

```text
A 地基        → ui-tokens-density + ui-quality-gate(雏形)
B 原语        → ui-primitives-chrome（组件新建）
C Chrome      → ui-primitives-chrome（TitleBar/StatusBar/Dock 迁移）
                 + ui-nav-cleanup
D 主题逃逸    → ui-theme-escape-fix
E 关键面      → ui-empty-loading + ui-settings-ia + ui-skills-ia
                 + Conversation type scale（可并入 tokens 后续 PR）
F 质量闸门    → ui-quality-gate（收口）
```

### 10.3 依赖图

```text
ui-quality-gate（先落，贯穿全部）
      │
      ▼
ui-tokens-foundation
      ├─► ui-primitives
      │      ├─► ui-chrome-polish
      │      ├─► ui-key-surfaces
      │      └─► ui-theme-escape-fix
      └──────────────────────────► ui-theme-escape-fix
```

**与原图的差异**：原图把 `ui-quality-gate` 标为「贯穿全程」的并行项，
但**执行上必须最先落**。理由：三个月前审计结论 0 落地，根因就是没有护栏 ——
`tools/guards/checks/` 30 条护栏无一条管 UI 样式，eslint 也无相关规则；
三个月间代码量 +68%（235→396 个 tsx）而硬编码色字面量从 33 涨到 39、raw button
从 311 涨到 520，**比率持平 = 每个新 PR 都在复制旧问题**。

### 10.4 v1 cut line

**v1 必做（= 全部 6 个子任务）**：护栏 → token 地基 → 6 原语 → 壳层 → 关键面 → 主题逃逸。

**v1 可延后（P1）**：Settings 全文搜索、全局面板骨架铺齐、Conversation 全量 type scale、
Motion 语言、Badge 产品化、Skills IA 重排（D1）、Settings 路由形态（D2）、
Dock 多面板（D3）、语义色全量 rename。

**注意**：原 v1 里的「nav cleanup」已不作为独立子任务 ——
`ActivityBar` 实测主路径已无人使用（只剩 `LibraryActivityBar` 是 library 域自己的东西），
直接删除即可，不需要「冻结」这么重的处置。`DockZoneTabs` 至今不存在，无需处置。

实现前每个子任务再写独立 prd/design；本文件是父任务权威方案。

---

## 11. Decision Log

> **2026-10-27：全部作废（D1–D5 去掉）。**
>
> 原 Decision Log 的作用是「实现前必须先拍板的 IA 决策」。用户明确去掉这五道门，
> 本任务不再做 IA 重排，改为专注**视觉与一致性**。
>
> | ID | 原决策 | 现状 |
> | --- | --- | --- |
> | D1 | Skills master-detail | ❌ 作废 → 双挂载修复降为 P1（属性能/焦点副作用，不属「精致」） |
> | D2 | Settings 保持中心岛整页 | ❌ 作废 → 选中态视觉仍要改（D2 是**路由形态**，不是**视觉**） |
> | D3 | DockZoneTabs 保留不挂载 | ❌ 作废 → 组件至今不存在，无需处置；ActivityBar 实测已无人使用，直接删 |
> | D4 | 废弃 Apple spacing 叙事 | ✅ **保留并直接执行** —— 现有 `--spacing-apple-*` 引用率≈0，与 IDE 密度冲突，本轮清理 |
> | D5 | 语义色双写渐进 rename | 🔻 **简化为最小修复** —— 只补断链 token（`status-error`），不做全量 rename |

**仍然硬性成立的约束**（不是 Decision，是「精致」的客观判据）：

- §4 七条设计原则
- §5 目标设计系统（density / 字体阶梯 / 语义色 / z-index / 8 原语）
- §5.6 交互状态契约（hover / selected / danger / disabled / focus-visible）
- §8 成功指标 + §8.1 复测命令

---

## 12. 原型索引

> **2026-10-27 重做**：旧 5 份原型（optimized-shell / statusbar-compare / settings-hifi /
> projects-panel / git-credential-compare）**已作废并删除** ——
> 它们基于 7 月的纸面设计，与今天的真实代码脱节（StatusBar 实际 16px、
> 主题实际色值、`ui/` 原语实际清单都不同）。
> 新原型基于**真实代码**重做：色值取自 `src/styles/tokens/theme.css`，
> 尺寸取自实际组件，现状问题标注了精确源码位置。

| 原型文件 | 覆盖问题 | 对应子任务 | 验收看点 |
| --- | --- | --- | --- |
| [`prototype-shell-v2.html`](./prototype-shell-v2.html) | 壳层（TitleBar / Dock / StatusBar / PanelHeader / StatusDot / EmptyState） | `ui-primitives` + `ui-chrome-polish` | TitleBar 有项目上下文；StatusBar 22px；Git 状态色走 token；Dock 选中态有指示条 |
| [`prototype-surfaces-v2.html`](./prototype-surfaces-v2.html) | Settings 选中态 / FormField 错误态 / 主题逃逸 | `ui-key-surfaces` + `ui-tokens-foundation` + `ui-theme-escape-fix` | nav 选中是 surface 不是大色块；错误提示**有颜色**；Git 取色走 token |

**新原型的三条硬约束**（与旧原型的区别）：

1. **色值必须来自 `theme.css`** —— 不允许原型里出现 theme.css 没有的色值，
   否则原型就成了新的「纸面设计」。
2. **现状问题必须标注精确源码位置** —— 如 `StatusBar.tsx:14`、
   `SettingsSidebar.tsx:72`、`PRDetailView.tsx:51`。这样实现 PR 知道自己改哪里。
3. **密度与字体阶梯用 token 表达** —— 原型里的 `22px` 写成
   `var(--chrome-statusbar-h)`，实现时才知道该建哪个 token。

---

## 13. 跨任务边界（vs `unified-task-hub`）

| 面 | `ui-design-audit` 负责 | `unified-task-hub` 负责 | 协作约定 |
| --- | --- | --- | --- |
| Settings 视觉 | token、nav 选中态、FormField/密度、raw input 收敛 | Integrations 信息架构、Provider 卡片内容与连接流 | task-hub 新 UI **必须**用 Neeko semantic token / 原语，不引进新色板 |
| Settings 路由 | 保持 `appView=settings` 直到另开 IA 任务 | 可新增 Integrations section/item | 不并行改 Settings 路由模型 |
| TitleBar | 项目名 / 环境 / 分支上下文；actions 分组与 IconButton | Launch 文案（原 Task Runner）与入口语义 | UI 任务不改 Launch 业务；文案任务不改 chrome 密度 |
| 空态 | `EmptyState` 原语与 Projects 模板 | Work Items / Integrations 空态文案与 CTA 目标 | 文案可不同，布局骨架共用 EmptyState |
| StatusBar | 高度、分区、可点热区 | Launch/Debug 状态内容 | 内容接入走现有 slot，不新造 16px 控件 |

若两任务同时改同一文件：先合 token/原语，再合业务面板。

---

## 14. Frontend Spec 大纲（实现时写入 `.trellis/spec/frontend/`）

> 当前 `.trellis/spec/frontend/` **没有** token / 原语专项文档（只有 `component-guidelines.md`
> 里的表单控件约定）。下列两份是本任务的**核心知识产出**。

1. **`design-tokens.md`**（新建）
   - density token 表（§5.1 九项）
   - 字体阶梯（§5.2）与「业务层禁止再写 `text-[11px]`」的例外清单（xterm / CodeMirror / 第三方 diff）
   - z-index 阶梯（§5.4 六层）
   - 语义色与 alias 规则（`--status-error` → `--status-failed` 的兼容期写法）
   - Light 主题禁止 `*-white/N` 当分割线或 hover 海面
2. **`ui-primitives.md`**（新建）
   - 6 个新原语的 props 与尺寸契约
   - §5.6 交互状态契约（hover / selected / danger / disabled / focus-visible）
   - 何时允许 raw `<button>`（极少数性能 / 虚拟列表 cell，需注释理由）
3. **`component-guidelines.md`**（扩写）
   - 补「表单控件必须复用 `ui/` 原语」之外的**按钮 / 面板头 / 空态**约束
   - 补「新增业务代码必须用 semantic token，不写 `text-[#hex]`」
4. **质量钩子**
   - eslint 规则 + `tools/guards/checks/check_ui_style_tokens.py`
   - PR 自检：Dark + Light 主路径；Tab 焦点走 Dock + 一 Dialog

阶段 2（`ui-tokens-foundation`）合并前应至少落盘 `design-tokens.md` 草案。

---

## 15. 关键文件清单（**已按 2026-10-27 实际路径更新**）

| 区域 | 路径 |
| --- | --- |
| App 壳 / Skills 双挂载 | `src/app/App.tsx` · `src/app/shell/AppShell.tsx` |
| TitleBar | `src/layout/TitleBar.tsx` · `src/app/panels/TitleBarActions.tsx` |
| StatusBar | `src/features/status-bar/StatusBar.tsx` · `src/features/status-bar/StatusBarCluster.tsx` |
| Dock chrome | `src/layout/dock-layout/DockBar.tsx` · `src/app/components/DockBarButton.tsx` |
| 遗留导航 | `src/layout/ActivityBar.tsx` · `RightPanel.tsx` · `PanelArea`（实测主路径已不用） |
| Tokens | `src/styles/tokens/theme.css` · `src/styles/tokens/tailwind.css` · `src/styles/tokens/shadcn.css` |
| 原语层 | `src/ui/*`（现 21 个组件，缺 6 个） · `src/lib/utils.ts` · `src/shared/utils/cn.ts` |
| Settings | `src/features/settings/components/SettingsSidebar.tsx` · `SettingsPanel.tsx` · `constants.ts` |
| 主题逃逸 9 处 | `src/shared/components/SessionChips.tsx` · `ContextMenu.tsx` · `src/features/git/utils/prDisplay.ts` · `src/features/git/components/ChangesSection.tsx` · `src/features/git/components/pr-detail/PRDetailView.tsx` · `PRDetailSkeleton.tsx` · `src/features/editor/components/TabOverflowMenu.tsx` |
| 项目空态 | `src/features/project/components/*` · `src/app/components/ProjectView.tsx` |
| 护栏 | `tools/guards/checks/check_ui_style_tokens.py`（新建） · `eslint.config.js` |
| 本任务原型 | `.trellis/tasks/07-26-ui-design-audit/prototype-*-v2.html` |

---

## 16. 附录：仍可加深的审计维度（非 v1 阻塞）

1. Skills 双挂载的性能/订阅副作用测量
2. 最小窗口与窄宽断点
3. macOS / Windows 窗口控件与 TitleBar 拖拽区
4. 对比度与 `prefers-reduced-motion`
5. 现有 `ui/*` 可复用清单，避免重复造原语
6. 组件测试 vs 纯人工视觉清单的自动化边界
