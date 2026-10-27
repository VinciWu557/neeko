# 实现路线图 — UI 精致化（2026-10-27 方向修订）

> **方向修订**：本任务从「planning-only 的设计审计」改为 **实施 UI 精致化**。
> D1–D5 Decision Log 全部作废（见 `design.md` §11），不再做 IA 重排，
> 只做**视觉与一致性**：统一密度 / 字体 / 语义色 / 交互契约 / 原语 / 壳层。
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
2. ui-tokens-foundation    density / 字体阶梯 / z-index / status-error 断链修复
      │
      ├─► 3. ui-primitives        IconButton / PanelHeader / Toolbar / EmptyState / StatusDot / FormField
      │       ├─► 4. ui-chrome-polish    TitleBar 上下文 / StatusBar 16→22 / Dock / Tab
      │       ├─► 5. ui-key-surfaces     Settings 选中态 / 表单密度 / Projects 空态 / Skills 单树
      │       └─► 6. ui-theme-escape-fix 9 处硬编码色 → 语义 token
      └────────────────────────────────────► 6.
```

**v1 cut（design §10.4）：** 全部 6 个子任务。
其余（Settings 全文搜索 / Motion 语言 / Skills IA / 语义色全量 rename）P1。

## 阶段 A — 地基（1–2 天）

**目标：** 设计系统可执行，不再靠任意值。

1. [ ] `theme.css` / `index.css` 增加 density + type scale tokens
2. [ ] `--status-error` alias → `--status-failed`
3. [ ] 语义 alias：`accent` / `success` / `warning` / `danger`（design D5：双写兼容）
4. [ ] 修复 `--accent-foreground` 写死蓝；补齐或删除 `accent-orange` / `bg-surface`
5. [ ] z-index token 阶梯（≤6 层）
6. [ ] 规范：`design-tokens.md` 草案落盘（design §14）
7. [ ] 统一 `cn` 入口（保留 `@/lib/utils`，`@/shared/utils/cn` 改 re-export）
8. [ ] 质量雏形：硬编码色 / `status-error` 检测 script（design §8.1 复测命令脚本化）

**主改文件：** `src/styles/theme.css`、`src/styles/index.css`、`src/styles/shadcn-theme.css`、`src/shared/utils/cn.ts`、`.trellis/spec/frontend/design-tokens.md`（新增）、`package.json`（script）。

**退出门槛：** 全主题切换无 token 失效；`status-error` class 生效；检测 script 可跑并输出基线计数。

## 阶段 B — 原语（2–3 天）

1. [ ] `IconButton`（sm/md，focus-visible，tooltip）
2. [ ] `PanelHeader` + `Toolbar`
3. [ ] `EmptyState` + `StatusDot` + `FormField`
4. [ ] Button/Input 尺寸对齐 IDE 密度；Input 增加 sans/mono variant
5. [ ] DockBarButton / TitleBar actions / StatusBar 可点击源迁移
6. [ ] 原语最小单测（render + 尺寸 variant + focus-visible class 存在）

**主改文件：** `src/ui/`（新增原语）、`src/app/components/DockBarButton.tsx`、`src/layout/TitleBar.tsx`、`src/features/status-bar/StatusBar.tsx`。

**参考原型：** `prototype-optimized-shell.html`（原语契约视觉）。

**退出门槛：** layout chrome 不再手写 hover 方块按钮；原语有单测。

## 阶段 C — Chrome 打磨（2 天）

1. [ ] StatusBar 高度与信息分区（16 → 22px，走 `--chrome-statusbar-h` token）
2. [ ] TitleBar 项目上下文（名称/环境/分支 — 以现有 store 为限）
3. [ ] Dock 选中态、footer 与 bar 尺寸统一 + focus-visible
4. [ ] 废弃 ActivityBar 等遗留路径（`ui-nav-cleanup`）
5. [ ] Dock badge 接线或删除
6. [ ] DockZoneTabs：**v1 禁止 zone 多面板**（design D3）——组件保留不挂载，类型/文档标注 unsupported；不写"挂载或禁止"二选一

**主改文件：** `src/features/status-bar/StatusBar.tsx`、`src/layout/TitleBar.tsx`、`src/layout/dock-layout/*`、`src/layout/ActivityBar.tsx`、`src/layout/index.ts`。

**参考原型：** `prototype-statusbar-compare.html`、`prototype-optimized-shell.html`。

**退出门槛：** 主窗口 chrome 一致；单一导航权威；StatusBar 高度来自 token。

## 阶段 D — 主题逃逸清理（1–2 天）

优先文件：

1. [ ] `GitCredentialDialog.tsx` token 化重写（→ Dialog + FormField + Input + Button）
2. [ ] `SessionChips` / `ChangesList` / PR 状态色去 hex
3. [ ] `WSLDialog` / `RemoteDialog` 去写死蓝与 emoji
4. [ ] `SectionHeader` / project ContextMenu
5. [ ] Settings 内 raw input/button 收敛（与阶段 B 原语配合）
6. [ ] 全局 `text-white` on accent → `text-on-accent`

**主改文件：** design §15 主题逃逸 P0 清单所列文件。

**参考原型：** `prototype-git-credential-compare.html`。

**退出门槛：** Light / Claude / Dark 下 Git 对话框与统计色正确；检测 script 硬编码色计数显著下降。

## 阶段 E — 关键面增量

1. Projects 空态 + SectionHeader（`ui-empty-loading`；参考 `prototype-projects-panel.html`）
2. **Skills IA 改造**（design D1 proposed-default：master-detail，去 `hidden` 双挂载；若用户推翻 D1 则按新决策执行）
3. Conversation type scale 收敛
4. Settings nav 选中态与表单密度（`ui-settings-ia`；参考 `prototype-settings-hifi.html`）
5. Skill 图标去 emoji
6. Diff/Browser toolbars → Toolbar

**退出门槛：** Skills 单树渲染；Projects 空态有多 CTA；Settings 选中态与 dock 语言一致。

## 阶段 F — 质量闸门

1. [ ] lint/script 收口：`text-[#` / 颜色字面量 style / 硬编码字号，纳入 CI 或 pre-commit
2. [ ] 空态/加载人工检查清单
3. [ ] a11y：toolbar focus-visible 抽检
4. [ ] 五主题 QA：选中对比、分隔线、菜单焦点色、状态点
5. [ ] 复测 design §8.1 全部命令，回填指标表（基线 → 当前值）

## 回滚点

- Token alias 可双写
- 组件原语先并行后替换
- StatusBar 高度一处 token 可回滚
- Skills 单树切换保留 appView 开关可回退

## 每阶段 PR 自检

1. 默认 Dark + Light 主路径点检
2. Projects / Files / Conversation / Git / Settings / Terminal
3. 键盘 Tab 走 TitleBar actions + Dock + 一个 Dialog
4. PR 描述链接对应原型（design §12）

## v1 非目标

- 重做品牌插画
- 自研完整 Design System 站点
- 改变 dock 状态机 / 拖拽逻辑（Skills IA 按 D1 单独评审）
- Dock zone 多面板可视化（D3，另开任务再议）
- Settings 全文搜索（P1）
