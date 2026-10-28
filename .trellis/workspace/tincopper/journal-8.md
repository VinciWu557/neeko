# Journal - tincopper (Part 8)

> Continuation from `journal-7.md` (archived at ~2000 lines)
> Started: 2026-10-28

---



## Session 359: styles 目录规范化：motion 层 + form.css 转 Tailwind + 死代码清理
<!-- trellis-session: v=2 fp=95855f3ae883736e -->

**Date**: 2026-10-28
**Task**: styles 目录规范化：motion 层 + form.css 转 Tailwind + 死代码清理
**Branch**: `main`

### Summary

用户的两次追问把范围从「按主题拆 theme.css」推到「整个 styles 目录的命名规范」。

**追问 1**：「为什么要放 tokens 目录下面，这个 tokens 表达的什么意思，业界也是这样做的吗」

查证：本仓 `tokens/` **不是**业界标准的 design tokens。

```
find . -name "*.tokens.json" -o -name "style-dictionary*"  → 无
```

业界 design tokens = 平台中立的 JSON 源 + 编译管线（Style Dictionary）。
本仓 CSS 就是源，实际含义是「CSS 自定义属性定义」= theme variables。
shadcn/ui、Radix Themes 都用 `styles/themes/`，**不叫 tokens**。

结论：术语挪用。但**保留**目录名 —— 改名成本（index.css + 测试路径 + 全篇文档）
大于收益；真正值得改名是引入编译管线时。改为在 README 里纠正理解。

**追问 2**：「src/styles 目录不仅仅是主题，应该从前端专业的角度出发，对不规范的目录名进行优化」

于是做完整的目录审计 → 发现 5 类问题（见下）。

### 审计发现的 5 类问题

| # | 问题 | 证据 |
| --- | --- | --- |
| 1 | 根级游离 CSS | `jetbrains-mono.css` / `nerd-font.css` 在 `styles/` 根 |
| 2 | `base/` 混入组件样式 | `.titlebar` / `.wc-btn` / `.settings-font-item` |
| 3 | 动效放错层 | `components/animations.css` 服务 5 个域 |
| 4 | 单控件样式占一个文件位 | `components/form.css` = 14 行 / 1 个类 |
| 5 | **11 个零引用死类名** | 约 15 行永不生效的 CSS |

死类名逐个用 Python 提取字符串字面量验证（正则版会漏模板串）：

```
titlebar-left / titlebar-right / titlebar-appname / titlebar-divider
titlebar-project-name / titlebar-branch / titlebar-placeholder
path-input / settings-font-item / settings-font-name / no-scrollbar
```

全部零引用，且**产物里确认已消失**。

> 注意 `.titlebar` 本身是活的（`TitleBar.tsx` 用模板串），`.tb-icon-btn`
> 也是活的（`EditorHeader.tsx`）—— 精确判定必须看字符串字面量，不能只看 `className="`。

### 实现

**1. 新建 `motion/` 层**（用户决策）

`components/animations.css` → `motion/animations.css`。

理由：动效是**跨域横切关注点**，本文件的 keyframes 服务 5 个域 ——
`wt-`(worktree) / `lsp-` / `toast-` / `agents-expand` / `cm-nav`。
放 `components/` 会让「一个文件 = 一个功能域」这条判据失效。

`motion/` 与 `base/` / `components/` 平级，表示它是独立一层，不是组件附属。

**2. `form.css` 转 Tailwind**（用户决策）

新建 `src/ui/Radio.tsx`，用原生 `input` + `peer` 变体表达，删除 `form.css`。

未用 Radix：仓库未装 `@radix-ui/react-radio-group`，且这里只需「带视觉圆点的
radio 标签」，原生 + `peer` 足够（YAGNI）。需要成组键盘导航时再引入。

行为等价对照（写进组件 docstring）：

| 旧 CSS | 现 Tailwind |
| --- | --- |
| `position:absolute; opacity:0; w/h:0` | `sr-only`（**保留可聚焦性**） |
| `border: 1.5px solid var(--border-color)` | `border-[1.5px] border-border` |
| `.radio-mark::after` + `input:checked ~` | `after:*` + `peer-checked:after:*` |
| `.custom-radio:hover .radio-mark` | `group-hover:` |

**额外修了一个缺陷**：原 CSS 用 `opacity:0` 隐藏 input，键盘聚焦时
**没有任何视觉反馈**。补 `peer-focus-visible:ring-2`。

**3. `base.css` 纯化**

- `.titlebar` / `.wc-btn` / `.wc-close` → 新建 `components/window-chrome.css`
- `.tb-icon-btn` 保留（活类，在 `no-drag` 列表里；虽然它属 tab bar 不在拖拽区，
  本规则对它是 no-op，保留是为了不改现有行为）
- 11 个死类名删除

`base/` 现在只含 `*` / `body` / `#root` / `.is-scrolling` + 滚动条规则。

**4. 护栏加第 4 条判据**

`components/` 下每个文件必须够一个「域」：

```
非注释代码行 > 20 且 顶层类 ≥ 2
```

数字取中位：现存最小的真域是 `onboarding.css`（33 行 / 2 类）。

**刻意不写成护栏的**：「某个类只服务一个组件」这类语义判断 —— 写成正则只会误报。

### 踩到的坑

**坑 1：字体相对路径断裂（真实回归）**

字体文件从 `styles/` 移到 `styles/fonts/` 后，`url("../assets/fonts/X.ttf")`
的解析目标变成 `styles/assets/`（不存在）。

```
解析结果: src/styles/assets/fonts/JetBrainsMono-Light.ttf   ← 不存在
正确应为: src/assets/fonts/JetBrainsMono-Light.ttf          ← 存在
```

**这类断裂构建不报错** —— Vite 静默跳过，只有运行时字体不生效。
改成 `../../assets/fonts/`，逐个验证 5 个路径，并跑 `vite build` 确认
`dist/assets/*.ttf` 5 个都在、CSS 里路径已重写为 `/assets/...`。

**坑 2：护栏单测被新判据连带打红 10 个**

既有夹具是 `a { color: red; }`（3 行），新判据 4 判它们「不够一个域」。
解法不是放宽判据，而是加一个**合规夹具** `DOMAIN_CSS`（25 条选择器），
让与判据 4 无关的用例保持聚焦。

**坑 3：`container.querySelector` 违反 testing-library 规则**

照 `ui/Switch.tsx` 的先例，把 class 契约抽成导出常量 `RADIO_MARK_CLASS`，
测试直接断言常量 —— 本来就更合适，因为这条契约不依赖渲染结果。

### 产出

| 文件 | 改动 |
| --- | --- |
| `src/styles/README.md` | **新增**：五层准入判据 + 「域」判据 + tokens 术语纠正 |
| `src/styles/motion/animations.css` | 从 `components/` 迁入（`git mv`） |
| `src/styles/components/window-chrome.css` | **新增**：TitleBar + WindowControls |
| `src/styles/components/form.css` | **删除**（转 `ui/Radio.tsx`） |
| `src/styles/base/base.css` | 纯化：只留元素级规则 + 删 11 个死类名 |
| `src/styles/fonts/{jetbrains-mono,nerd-font}.css` | 从根级移入 + 修相对路径 |
| `src/ui/Radio.tsx` | **新增**：`RADIO_MARK_CLASS` 导出 |
| `src/ui/__tests__/Radio.test.tsx` | **新增**：9 用例 |
| `tools/guards/checks/check_styles_layout.py` | 加判据 4 + `motion/` 白名单 |
| `tools/guards/tests/test_check_styles_layout.py` | 13 → 18 用例 |
| `src/features/connection/components/{Remote,RemoteAuth}Dialog.tsx` | 改用 `<Radio>` |
| `src/styles/index.css` | 聚合加 `motion/`，删 `form.css` |
| `.trellis/spec/frontend/design-tokens.md` | 补「样式层目录」小节 |

### Testing

- [OK] `Radio.test.tsx` 9/9
- [OK] `test_check_styles_layout.py` 18/18
- [OK] **变异验证 ×2**：去掉 `peer-focus-visible` → 红；去掉
      `peer-checked:after:scale-100` → 红；还原后全绿
- [OK] **真实仓库护栏验证**：种 3 个违规（坏文件名 / 未声明目录 / 根级文件）全部命中
- [OK] **产物验证**：11 个死类名全部从 `dist/assets/*.css` 消失；
      `custom-radio` 0 处；`wc-btn` / `wt-spin` / `peer-checked` 均在
- [OK] `vite build` 通过，5 个字体正确打包
- [OK] `pnpm check:quick` 全绿：**32 条护栏全过**

### Next Steps

- 拆 `tokens/themes/*.css` 未做 —— 收益低于契约抽取（Session 362 已决定）
- 待用户指示是否提交

### Git Commits

(No commits - planning session)

### Status

[OK] **Completed**


## Session 360: 修复审核发现的 1 Block + 3 Warning + 2 Nit（主题校验后门）
<!-- trellis-session: v=2 fp=5245a9180b0d226e -->

**Date**: 2026-10-28
**Task**: 修复审核发现的 1 Block + 3 Warning + 2 Nit（主题校验后门）
**Branch**: `main`

### Summary

Session summary was not supplied.

### Git Commits

(No commits - planning session)

### Status

[OK] **Completed**
