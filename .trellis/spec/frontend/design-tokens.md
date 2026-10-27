# 设计令牌（Design Tokens）

> Neeko 前端的**样式唯一权威源**。本文档记录 token 的分层、可用清单与禁止写法。
>
> 配套护栏：`check_ui_style_tokens`（`tools/guards/checks/`）——
> 禁止新增硬编码色 / 暗色假设 / accent 底上的写死白字 / 无焦点环。
>
> ⚠ **护栏只能拦「新增」，拦不住「改粗」**：把一个低对比度元素换成 token 时，
> 护栏全绿，但视觉强度可能变了 —— 见「坑 4」。

---

## 分层

```
theme.css   语义令牌定义（--bg-primary / --accent-blue / --status-* …）
   │          按主题分块：dark / classic-dark / one-dark-pro / claude / light
   │          :root 块放「与主题无关的骨架」（density / 字体阶梯 / z-index）
   ↓
tailwind.css  桥接为 Tailwind v4 utility 类（--color-* / --text-*）
   │          @theme    → 键名与被引用变量不同名（--color-bg-primary → var(--bg-primary)）
   │          @theme inline → 键名与被引用变量同名时必须用它（否则自引用失效）
   ↓
业务代码      只用 utility 类；禁止写裸色值
```

### 为什么分两个文件

`theme.css` 是**语义层**（这条令牌是什么角色），`tailwind.css` 是**桥接层**
（这个角色对应哪个 utility 类）。合并成一个文件会让「改一个色值」与
「加一个新类」混在一起 —— 前者是主题维护，后者是 API 变更，评审关注点不同。

---

## 令牌清单

### 表面与文字

| Token | Tailwind 类 | 用途 |
|---|---|---|
| `--bg-primary` | `bg-bg-primary` | 海面（面板之间的底） |
| `--bg-secondary` | `bg-bg-secondary` | 浮岛表面 |
| `--bg-tertiary` | `bg-bg-tertiary` | 三级表面（浮岛内的 header / 输入框） |
| `--bg-hover` | `bg-bg-hover` | hover 海面 |
| `--bg-selected` | `bg-bg-selected` | **选中态**（与 dock 一致） |
| `--text-primary` | `text-text-primary` | 主文字 |
| `--text-secondary` | `text-text-secondary` | 次级文字 |
| `--text-muted` | `text-text-muted` | 元数据 / 占位 |
| `--text-on-accent` | `text-text-on-accent` | **accent 底上的文字色**（随主题变） |
| `--border-color` | `border-border` | 常规边框 / 分割线 |
| `--border-subtle` | `border-border-subtle` | **弱分割线**（层级更淡的一档） |

### 控件专属

| Token | Tailwind 类 | 用途 |
|---|---|---|
| `--switch-track` | `bg-switch-track` | **Switch 未勾选态轨道**（逐主题取值，vs 海面 ≥1.5） |

> 控件 token 与表面 token 是**不同的对比区间**，不能互相复用 —— 见坑 8。
> 新增任何「必须看得见」的控件轮廓时，先问：能不能复用 `border-border` 描边？
> 能就复用（Checkbox / ToggleGroup 的做法）；不能才加专用 token。

### 语义色

| Token | Tailwind 类 | 用途 |
|---|---|---|
| `--accent-blue` | `bg-accent-blue` / `text-accent-blue` | 主强调 |
| `--accent-green` | `text-accent-green` | 成功 |
| `--accent-yellow` | `text-accent-yellow` | 警告 |
| `--accent-red` | `text-accent-red` | 错误 / 删除 |
| `--accent-orange` | `text-accent-orange` | 辅助强调 |
| `--accent-brick` | `text-accent-brick` | 合并态（GitHub PR merged） |
| `--status-idle` | `text-status-idle` | 空闲 |
| `--status-running` | `text-status-running` | 运行中 |
| `--status-failed` | `text-status-failed` | 失败 |
| `--status-error` | `text-status-error` | **failed 的别名**（见下） |

### Git / Diff

| Token | Tailwind 类 | 用途 |
|---|---|---|
| `--git-status-added` | `text-git-status-added` | 新增文件 |
| `--git-status-modified` | `text-git-status-modified` | 修改 |
| `--git-status-deleted` | `text-git-status-deleted` | 删除 |
| `--git-status-untracked` | `text-git-status-untracked` | 未跟踪 |
| `--git-status-conflict` | `text-git-status-conflict` | 冲突 |
| `--diff-added` / `--diff-added-text` | `bg-diff-added` / `text-diff-added-text` | diff 新增（底 / 字） |
| `--diff-removed` / `--diff-removed-text` | `bg-diff-removed` / `text-diff-removed-text` | diff 删除（底 / 字） |

---

## 八个必须知道的坑

### 坑 1：`--status-error` 是别名，不是新颜色

业务层历史上写 `status-error`，但主题只定义了 `status-failed`。
2026-10-27 之前 **tailwind.css 里没有 `--color-status-error` 映射** ——
Tailwind 根本不生成 `text-status-error` 类，于是 4 处错误提示
（`LspPanel` / `LspCustomServersSection` ×2 / `HtmlPreview`）**没有红色**。

现在：主题 5 个块各有 `--status-error: var(--status-failed)`，
`tailwind.css` 有 `--color-status-error` 映射。

> **加新别名时的检查清单**：① 主题每个块都要有；② `tailwind.css` 要有映射；
> ③ 至少一个消费点。缺 ② 就是「类不生成」的断链 —— 表现是**样式静默失效**，
> 不报错。护栏只查「不新增反模式」，**查不出断链**（断链是「少了一个定义」，
> 不是「多了一个错写」）。

### 坑 2：`@theme` 与 `@theme inline` 的自引用

`tailwind.css` 里：

```css
@theme {
  --color-bg-primary: var(--bg-primary);   /* ✅ 键名与被引用变量不同名 */
}

@theme inline {
  --text-micro: var(--text-micro);          /* ⚠️ 同名 → 必须 inline */
}
```

`@theme`（非 inline）会把值**编译期解析**。同名时 `var(--text-micro)` 指向
`@theme` 块自身 → 自引用 → 无效。`@theme inline` 保留运行时引用 → 正常。

**判据**：键名与被引用变量**同名** → 必须 `@theme inline`。

### 坑 3：语义色的「一个定义适配 5 个主题」怎么做到

`--border-subtle` 要在 5 个主题下都对，就得随主题变。两条路：

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A. `color-mix` 混一次 | `:root` 定义一次，混 `--text-primary` 与百分比 | ❌ 降级回退值取第一个分量（坑 6），且百分比一刀切导致暗色主题变粗（坑 5） |
| B. 逐主题显式 rgba | 每个主题块各写一个 `rgb(... / α)` | ✅ **当前采用** —— 值显式、行为可预测、无降级路径 |

```css
/* theme.css */
--border-subtle: rgb(255 255 255 / 0.04);   /* dark / classic-dark / one-dark-pro */
--border-subtle: rgb(0 0 0 / 0.08);         /* claude */
--border-subtle: rgb(0 0 0 / 0.09);         /* light */

/* tailwind.css —— @utility 运行时解析 */
@utility border-border-subtle { border-color: var(--border-subtle); }
```

> 逐主题手写的代价是「加主题要改 N 处」—— 但这个代价**低于**「值被编译期
> 静默改写」的代价（后者源码对、产物错，无任何报错）。

### 坑 4：**「加一条分割线」与「把一条分割线变明显」是两回事**

这是 2026-10-27 真实的用户反馈，两轮：

> 第一轮：「projects 优化后还没有优化前好看，每个项目之间都加了一个横杠，很丑」
> 第二轮：「直接去掉不要横杠，横杠的意义是什么呢」

**第一轮的错**：把 `border-white/[0.04]`（4% 白，几乎不可见）换成
`color-mix(text-primary 8%)`（8% 近白）—— 不是「加了横杠」，是**把横杠变明显了**。
token 化只保证「跟随主题」，不保证「强度不变」。

**第二轮的定案**：项目之间**根本不该有分割线**。理由：

- 项目头本身已是视觉单元（avatar + 粗体名称 + 计数）
- hover 时整行有 `bg-bg-hover` 背景块 —— **背景块已承担分组职责**
- 再加一条线 = 三重分隔

**判据：加分割线前先问「这个元素的信息边界在哪」。**
若边界已由**背景块 / 缩进 / 头像 / 字重**表达，再加线就是冗余。

> **落地方式**：不只是删 class —— `isLast` 这条数据链
> （`groupProjects` → `ProjectsPanel` → `ProjectItem` → `ConnectionProjectCard` →
> `ProjectGroup`）唯一的消费者就是那条线，故**整条链一并删除**，
> 避免留下无人消费的 prop（TS `noUnusedParameters` 也会报）。
> `groupProjects` 原本注释称 `lastGroup` 是「DnD 排序落点用」——
> **那是错的**：DnD 用的是 `over.id`（拖放目标的项目 id），与该字段无关。

### 坑 5：**换掉一个「几乎看不见」的元素时，不要把它变明显**

这是 2026-10-27 真实的用户反馈：「projects 优化后还没优化前好看，
每个项目之间都加了一个横杠，很丑」。

根因不是「加了横杠」，而是**横杠的强度变了**：

| | 原值 | 首次实现 | 结果 |
| --- | --- | --- | --- |
| 暗色主题 | `border-white/[0.04]`（4% 白，几乎不可见） | `color-mix(text-primary 8%)`（8% 近白） | **明显可见** |

`--text-primary` 在暗色主题下是 `#ffffff` / `oklch(0.985)` —— **近白**。
8% 近白叠在深底上是一条清晰的横线；4% 白则几乎看不见。

**判据：替换一个低对比度元素时，「视觉强度」是必须保持的量，
不是「用了 token」就等于等价。** token 化只保证**跟随主题**，
不保证**强度不变**。

### 坑 6：**前景色要按「它压在什么底上」选，不是按「它是文字还是图形」选**

2026-10-27 第三次同类回归：`Switch` 滑块。

```diff
- 'bg-white'                                  // 原值：只在暗色主题成立
+ 'bg-text-primary'                           // 首版：跟着「页面文字色」走
+ 'bg-text-primary data-[state=checked]:bg-text-on-accent'   // 修复
```

**用户反馈**：「开关样式优化之后更加丑了」（附 Claude 主题截图：赭红轨道上一个深棕滑块）。

**为什么首版是错的**：滑块压在 **accent 底**上，它要的是「accent 底上的前景色」
= `--text-on-accent`，**不是**「页面文字色」= `--text-primary`。

Claude 主题下这两个值差得极远：

| token | 值 | 角色 |
| --- | --- | --- |
| `--accent-blue` | `#c96442`（赭红） | 轨道底色 |
| `--text-primary` | `#2d1e14`（深棕） | 页面文字色 ← **首版误用** |
| `--text-on-accent` | `#f5f0e8`（浅米白） | accent 底上的前景色 ← **正确** |

深棕滑块压在赭红轨道上 → 对比度不足，糊成一团。

**全仓审计的结果**（2026-10-27 扫描全部 599 个 tsx + 8 个 css）：

| 位置 | 元素 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| `ui/Switch.tsx` | 滑块（accent 实底） | `bg-text-primary` | `bg-text-primary` + `checked:bg-text-on-accent` |
| `app/components/WelcomeScreen.tsx:65` | 「Add Your First Project」按钮 | `text-text-primary` | `text-text-on-accent` |
| `shared/components/GitDialog.tsx` | 自制 switch 滑块 | `bg-text-secondary` | `bg-text-primary` + `checked:bg-text-on-accent` |
| `styles/components/agent.css:71` | `.agent-bar-btn.selected` | `color: var(--text-primary)` | `color: var(--text-on-accent)` |
| `styles/base/base.css:51` | `.wc-close:hover` | `color: #fff` | `color: var(--text-on-accent)` |

**扫描方法**（可复用）：找**实底** accent 容器（`bg-accent-*` / `bg-destructive`，
**后面不跟 `/数字`** —— 半透明底不算，半透明底上用普通文字色是**对的**），
再看其前景色是不是 `text-on-accent` 系。

> **⚠ 扫描时的两个陷阱**：
> ① 正则用 `\b` 边界会把 `bg-accent-blue/15` 也算成实底 → 误报 16 处；
> ② `text-xs` / `text-sm` 是**字号**不是颜色，正则不排除会误报 5 处。
> 两轮误报后才收敛到真正的 5 处。

**仓库已有的正确范式**（首版没查就自己发明）：

```tsx
// ui/Checkbox.tsx —— 对勾在 accent 底上
'data-[state=checked]:bg-accent-blue data-[state=checked]:border-accent-blue'
'<svg className="text-text-on-accent">'

// ui/ToggleGroup.tsx —— 选中态文字在 accent 底上
'data-[state=on]:bg-accent-blue data-[state=on]:text-text-on-accent'
```

> **判据：选颜色前先问「它压在什么底上」，而不是「它是什么元素」。**
> 压在 accent 底 → `--text-on-accent`；压在 `--bg-tertiary` 等普通底 → `--text-primary`。
> 同一个元素在两种底上（如 Switch 滑块）**需要两个颜色**，靠 `data-[state=...]` 切换。

#### 已护栏化：`neeko/ui/accent-foreground`（ESLint 规则）

上面那套「扫描方法」在 2026-10-27 已经变成机器判据，不再需要人工扫：

| 位置 | 作用 |
| --- | --- |
| `tools/eslint-rules/accent-foreground.cjs` | 规则本体（AST，非正则） |
| `tools/eslint-rules/index.cjs` + `package.json` | 声明为 `eslint-plugin-neeko` |
| `package.json` 的 `devDependencies` | `"eslint-plugin-neeko": "file:tools/eslint-rules"` |
| `src/ui/__tests__/accentForegroundRule.test.ts` | 21 个用例（含 3 个变异验证） |

> **仓内 ESLint 插件的接入方式（唯一正确做法）**：把插件目录声明成一个 npm 包
> （`package.json` 里 `"name": "eslint-plugin-neeko"`），再用 `file:` 协议装进
> `devDependencies`。`.eslintrc.cjs` 里 `plugins: ['neeko']` 照常生效，
> **`eslint` CLI 直接用，不需要任何 wrapper**。
>
> 不要走 `ESLint` API 包一层那条路（首版就是这么做的，已删）：自己解析 CLI 参数会
> 带进两类缺陷 —— ① `--max-warnings` 只属于 CLI、不属于 API 构造器，传进去
> `Invalid Options` **直接崩**，CI 一旦用它门禁就炸；② wrapper 自身不在 lint 范围内。

**为什么是 ESLint 而不是护栏正则**：正则版实测误报 22 处（`bg-accent-blue/15` 16 处、
`text-xs` 5 处、`hover:border-accent-blue`、`data-[state=on]:` 变体、三元互斥分支 10 处）。
AST 能区分「实底 vs 半透明底」「底色 vs 边框色」「字号 vs 颜色」「同一状态 vs 互斥分支」。

规则放行的五种写法（**都是本仓在用的正确写法**，改动规则前先看这张表）：

| 写法 | 为什么放行 |
| --- | --- |
| `bg-accent-blue/15 text-text-primary` | 半透明底 = 海面 + 淡 accent，普通文字色才对 |
| `bg-accent-blue text-xs` | `text-xs` 是字号不是颜色 |
| `hover:border-accent-blue` / `border-l-accent-green` | 是 border 不是 bg |
| `text-accent-red bg-accent-red/10` | 淡底 + 同色字（错误提示框的既定写法） |
| `data-[state=on]:bg-accent-blue data-[state=on]:text-text-on-accent` | 状态变体互斥，不是「底 + 前景」 |
| `ok ? 'bg-accent-blue text-text-on-accent' : 'bg-bg-tertiary text-text-muted'` | 三元分支互斥，合并判定会造出不存在的组合 |

> **⚠ 改规则前必读**：`classTokenGroups()` 把三元 / `&&` 的各分支**独立成组**。
> 第一版把所有 token 合并成一个集合，立刻误报 10 处 —— 它算出「`bg-accent-blue` 上压着
> `text-text-muted`」，而这个组合在任何一次渲染里都不存在。
>
> **子元素判据取「存在性」而非「全分支」**：选中项里的次级文字常写成
> `sel ? 'text-text-on-accent/80' : 'text-text-muted'`，而父元素的 accent 底是**另一个**
> 条件分支 —— 父子分支条件在 AST 里是两棵独立子树，无法机械对齐。要求「每个分支都合法」
> 会把这条正确写法判违规（实测 8 处）。

**本轮规则抓到的真问题**（6 个文件 7 处，全是下拉项选中态）：

父元素 `selectedAgentId === agent.id && 'bg-accent-blue text-text-on-accent'` 变蓝底后，
子元素的 `<span className="text-text-muted">{agent.command}</span>` 自带颜色类**覆盖了继承**的
on-accent，暗色主题下灰字压蓝底几乎不可见。修法是子元素同步三元切换：

```tsx
<span className={cn('ml-auto text-xs',
  selected ? 'text-text-on-accent/80' : 'text-text-muted')}>
```

位置：`RemoteDialog.tsx` ×2、`WSLDialog.tsx` ×2、`ProjectSettingsDialog.tsx` ×3。

**验证方式**：不能只看类名，要算**对比度**。实测 5 主题的滑块/轨道对比：

| 主题 | 修复前（text-primary） | 修复后（text-on-accent） |
| --- | --- | --- |
| dark | 1.37 ❌ | 2.94 ✅ |
| one-dark-pro | 1.11 ❌ | 7.99 ✅ |
| claude | 4.12（但视觉糊） | 3.44 ✅ |
| classic-dark | 3.02 | 3.02 ✅ |
| light | 3.93 | 4.25 ✅ |

### 坑 7：`color-mix` 在本仓库会被降级，回退值取第一个分量

用 `color-mix` 实现 `--border-subtle` 时，产物里出现：

```css
:root{--border-subtle:var(--text-primary)}          /* 回退 */
@supports (color:color-mix(in lab,red,red)){
  :root{--border-subtle:color-mix(...)}}            /* 支持时覆盖 */
}
```

回退值是 color-mix 的**第一个分量** —— 不支持 color-mix 的浏览器里，
分割线变成**近白实色**（比原来粗得多）。

同理，Tailwind 的 `@theme` 会在**编译期**求值变量，遇到 color-mix 里的 `var()`
无法求值就退化成第一个分量。

**结论**：`--border-subtle` 用**显式 rgba**（逐主题给值），
且桥接用 `@utility` 而非 `@theme`：

```css
/* theme.css —— 逐主题显式值 */
--border-subtle: rgb(255 255 255 / 0.04);   /* dark / classic-dark / one-dark-pro */
--border-subtle: rgb(0 0 0 / 0.08);         /* claude */
--border-subtle: rgb(0 0 0 / 0.09);         /* light */

/* tailwind.css —— @utility 运行时解析 */
@utility border-border-subtle {
  border-color: var(--border-subtle);
}
```

> **验收方式**：看**构建产物**里的最终值，不是看源码。
> `pnpm build` 后检查 `dist/assets/*.css` 里的 `--border-subtle:` 声明 ——
> 源码写得对、产物被降级，是静默的。

### 坑 8：**表面层级 token 不能拿来当控件轨道**

2026-10-27 用户反馈：「按钮在不同主题下看着很别扭，特别在 claude、light 主题下面
特别明显的不协调」（附 Switch 截图）。

排查结论不是滑块颜色错，而是 **未勾选态的轨道几乎看不见**：

| 主题 | `bg-tertiary` 轨道 vs 海面 | 观感 |
| --- | --- | --- |
| light | **1.08** | 轨道消失，只剩一颗深色圆球漂着 |
| claude | **1.11** | 同上 |
| classic-dark | 1.16 | 同上 |
| dark | 1.25 | 勉强 |
| one-dark-pro | 1.31 | 勉强 |

**根因**：`--bg-tertiary` 是**表面层级**色（面板、卡片、下拉项），它与海面的对比
按设计就该很淡 —— 层级差异靠「很淡的色差 + 圆角 + 阴影」共同表达。

而**控件轨道**的需求完全不同：

| 用途 | 对比区间 | 理由 |
| --- | --- | --- |
| 表面层级（`bg-tertiary`） | 1.0 ~ 1.3 | 只要「隐约分层」，不能抢内容 |
| 控件轨道（`switch-track`） | **1.5 ~ 2.0** | 要**成形**（否则看不见控件），但不能抢眼 |
| 文字对比（`text-primary`） | ≥ 4.5 | 可读性底线 |

三个区间不重叠，所以**不能复用**。这就是 `--switch-track` 是独立 token
而不是某个 surface 别名的原因。

#### 为什么只有 Switch 出问题

同类控件 `Checkbox` / `ToggleGroup` 都有 `border border-border` 描边，
所以从没这个问题 —— 描边把轮廓画出来了，填充色淡不淡无所谓。

Switch 是唯一**只靠填充色**表达轮廓的控件。修法是双管：

```tsx
// 填充：专用 token（逐主题，对比 ≥1.5）
'bg-switch-track'
// 描边：与 Checkbox / ToggleGroup 对齐
'data-[state=unchecked]:bg-switch-track data-[state=unchecked]:border-border'
// 勾选态 accent 实底自己就是轮廓，去掉描边
'data-[state=checked]:bg-accent-blue data-[state=checked]:border-transparent'
```

#### 取值方法（可复用到任何新控件）

以该主题 `--bg-primary` 的 oklch 明度为基准，**暗底 +0.15 / 亮底 −0.15**，
彩度压到 `0.008`（几乎无彩，不抢 accent 的戏），色相跟随主题。

| 主题 | `--bg-primary` | `--switch-track` | 对比 |
| --- | --- | --- | --- |
| dark | `#111111` | `#363636` | 1.56 |
| one-dark-pro | `#21252b` | `#3f4349` | 1.55 |
| classic-dark | `#26292f` | `#43464d` | 1.54 |
| light | `#ebecf0` | `#bebfc3` | 1.56 |
| claude | `#f0ebe2` | `#c3bfb7` | 1.54 |

#### 附带发现：滑块**不能**统一用白色

排查时容易顺手把滑块改成 `bg-white`（「亮色主题下白滑块最自然」）。
实测否定 —— 新轨道色下的滑块对比：

| 主题 | `text-primary` 滑块 | 白色滑块 |
| --- | --- | --- |
| dark | 11.58 | 12.08 |
| one-dark-pro | 4.67 | 9.95 |
| classic-dark | 9.45 | 9.45 |
| light | **9.07** | **1.84** ❌ |
| claude | **8.76** | **1.62** ❌ |

亮色主题下白色滑块与浅色轨道几乎同色。所以滑块必须**跟着底色走**：
未勾选（`switch-track` 底）用 `text-primary`，勾选（accent 底）用 `text-on-accent`。

#### 机器判据

| 文件 | 作用 |
| --- | --- |
| `src/ui/Switch.tsx` | `SWITCH_TRACK_CLASS` / `SWITCH_THUMB_CLASS` 导出（class 契约常量化） |
| `src/ui/__tests__/Switch.test.tsx` | 13 用例（含 2 变异验证：改回 `bg-bg-tertiary` / 删描边） |
| `src/styles/tokens/__tests__/themeTokens.test.ts` | **真算对比度**：每个主题的 `switch-track` vs `bg-primary` 必须 ≥1.5 |

> 对比度测试是这组里最值钱的一条 —— 它会在**任何人调主题底色时自动把关**：
> 改了 `--bg-primary` 就必须重算 `--switch-track`，否则测试红。
> 这比「记住有个坑」可靠。

---

## 字体阶梯

| Token | Tailwind 类 | 公式 | 用途 |
|---|---|---|---|
| `--text-micro` | `text-text-micro` | `max(10px, base-2)` | 时间戳、快捷键 hint |
| `--text-meta` | `text-text-meta` | `max(11px, base-1)` | 次级元数据 |
| `--text-ui` | `text-text-ui` | `base` | 默认 UI |
| `--text-ui-md` | `text-text-ui-md` | `base+1` | 列表主标题 |
| `--text-ui-lg` | `text-text-ui-lg` | `base+2` | 面板标题 |
| `--text-section` | `text-text-section` | `base+4` | Settings section |

**业务层禁止再写 `text-[11px]` / `text-[0.86em]`** ——
那些写法不跟随用户设置的字号（`--font-size` 由 Appearance 面板驱动）。

**例外白名单**（宿主渲染，不属 UI 层级）：
xterm 终端、CodeMirror、第三方 diff 渲染器。

---

## 密度 token

定义在 `:root`，**当前只定义不套用**（2026-10-27 的 UI 精致化任务明确
「不改动当前布局」—— 套用即改变容器几何）。

```text
--chrome-titlebar-h: 32px      --row-h-sm: 24px        --icon-sm: 14px
--chrome-statusbar-h: 22px     --row-h-md: 28px        --icon-md: 16px
--chrome-dockbar-w: 44px       --row-h-lg: 32px        --icon-lg: 20px
--chrome-panel-header-h: 32px  --radius-panel: 8px     --radius-control: 6px
--chrome-tab-h: 28px           --radius-chip: 9999px   --gap-island: 6px
--chrome-toolbar-h: 32px
```

---

## z-index 阶梯

```text
--z-base: 0      --z-dropdown: 100    --z-sticky: 200
--z-modal: 1000  --z-toast: 1100      --z-devtools: 9999
```

同样**当前只定义不套用**（改层级 = 改行为）。

---

## 禁止写法

护栏 `check_ui_style_tokens` 强制以下四条：

| # | 禁止 | 替代 | 后果 |
|---|---|---|---|
| 1 | `text-[#3fb950]` / `bg-[#a371f7]` | `text-git-status-added` / `text-accent-brick` | 主题切换后不跟着变 |
| 2 | `border-white/[0.04]` / `bg-white` | `border-border-subtle` / `bg-bg-hover` | 亮色主题下**直接消失** |
| 3 | `bg-accent-blue text-white` | `bg-accent-blue text-text-on-accent` | 某些主题下对比失效 |
| 4 | `focus:outline-none`（无 `focus-visible:` 替代） | `focus-visible:ring-2 focus-visible:ring-accent-blue` | 键盘用户看不到焦点 |

### 判据 3 的两个变体

| 底色 | 用什么 |
|---|---|
| **实心** accent 底（`bg-accent-blue` / `bg-accent-red` / `bg-destructive`） | `text-text-on-accent` |
| **半透明** accent 底（`bg-accent` = 12% 蓝） | `text-accent-foreground`（= `--accent-blue`） |

半透明底上用 `text-on-accent` 会是「深底深字」—— 选错比不选更糟。

---

## 交互状态契约

| 状态 | 写法 |
|---|---|
| hover | `hover:bg-bg-hover` + `hover:text-text-primary` |
| selected | `bg-bg-selected` + `text-text-primary`（**不用** accent 大色块） |
| danger hover | `hover:bg-accent-red/15` + `text-accent-red` |
| disabled | `opacity-50 pointer-events-none` |
| focus-visible | `focus-visible:ring-2 focus-visible:ring-accent-blue` |

> **焦点环用 `focus-visible:` 而不是 `focus:`** —— 后者在鼠标点击时也会出环，
> 视觉噪声。`ui/Dialog.tsx` / `ui/Badge.tsx` / `LspCustomServersSection.tsx`
> 2026-10-27 前用的就是 `focus:ring-2`，已改。
