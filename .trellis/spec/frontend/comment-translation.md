# 注释翻译（代码编辑器内）

> 把源码注释与文档性注释（docstring / JSDoc）译为目标语言，**不写源文件**。
> 实现落点：`src/features/editor/comment/`。设计全文见任务 `10-19-code-comment-translation`。

---

## 1. 三层抽象（缺一不可）

```
语法树节点  →  逻辑块（行邻接分组）  →  段（prose/code/fence/blank/tag）
```

| 层 | 为什么必须有 |
| --- | --- |
| **节点**（AST） | 唯一能区分「真注释」与「字符串里的 `//`」；也提供 docstring / license 需要的位置语义 |
| **逻辑块** | 连续 `//` 在语法树里是**每行一个独立节点**（实测 Rust `/// A\n///\n/// # Example` = 7 个 `LineComment`）。逐节点翻译会打散段落、请求数 ×N |
| **段** | 一条注释块内可能混排散文与代码。代码段必须原样保留、不进请求 |

**禁止**退回正则方案：`const url = "http://x"` 里的 `//` 不是注释，且正则给不出「是否 body 首语句」这类位置语义。

---

## 2. 注释节点名方言表（实测，不得凭猜）

| 语言 | 注释节点名 | 备注 |
| --- | --- | --- |
| TS/JS / Rust / Go / Java（Lezer） | `LineComment` / `BlockComment` | `/** */` 是 `BlockComment` |
| Python / CSS（Lezer） | `Comment` | **不是** `LineComment` |
| YAML / Shell（`legacy-modes` → `StreamLanguage`） | `comment`（**小写**） | 树结构不同 |

数据表在 `commentSyntax.ts`（唯一事实源）。新增语言 = 加一行，**不要**在提取逻辑里写 `if (lang === ...)`。

**shebang 例外（实测）**：`#!` **不总是注释节点** —— Python 是 `Comment`（需要门禁跳过），Shell 是 `meta`（天然不进候选集），TS 走错误恢复无节点。所以 `isShebang` 必须存在，但**测试必须用 Python 构造**；用 shell 写的用例测到的是「无注释」而非「跳过 shebang」。

---

## 3. U2 铁律：注释里的代码一律不翻

**用户决策**：死代码、示例代码、行内代码跨度、代码围栏 —— 全部不翻译。

因此：

1. `segmentBlock` 把 `code` / `fence` 段标 `translatable: false`；
2. 引擎组装 prompt 时**这些段的原文根本不出现**；
3. `verifyComment.rejectsCodeEcho` 兜底：若模型幻觉复述代码段原文 → 判失败。

**误判方向不对称**（`design.md` D2）：

| 类别 | 判定宽度 | 判错的后果 |
| --- | --- | --- |
| `directive` / `license` / `shebang` | **判宽**（宁可多跳） | 跳过多了用户能看到原文 ✅；漏过被翻 → 工具链静默失效 ❌ |
| `code` | **判宽**（宁可多判 code） | 多判 → 用户看到原文 ✅；漏判 → 代码被翻坏、照抄即报错 ❌ |

判定「偏宽」不等于乱判：判 `code` 必须有明确信号（代码起始词 / 代码符号组合 / 示例引导行后的缩进块）。单靠「含某个符号」会误杀 `See \`cacheKey\` for details.`。

---

## 4. 内容寻址（身份 = 文本哈希，不是行号）

- 地址 = 归一化文本的哈希（`commentAddress.ts`，唯一构造点）。
- 归一化**只折叠空白**：大小写、行内 markdown 标记、占位符都承载语义。
- 身份落在 **segment** 而非 group：组边界变化（插一行重新分组）不应让无关段失效。
- 缓存键 = `profileVersion | targetLanguage | address`。**改 prompt 或加强校验必须 +1 profile 版本**，否则旧缓存永久遮蔽新规则（无任何报错，新逻辑就是不生效）。

---

## 5. 呈现：StateField + StateEffect，不进 extensions 依赖

依据 `quality-guidelines.md` 禁止模式 10：`@uiw/react-codemirror` 在 `extensions` 身份变化时 dispatch `reconfigure`，会丢弃 lint 等经 `appendConfig` 惰性安装的扩展。

译文是**高频活数据**，若接进依赖 → 每批译文到达都重建扩展世界 → 波浪线静默消失。

正确形态（与 `lspDiagnosticsProjection.ts` 同构）：

- 模块级 `StateField`（值跨 reconfigure 保留；写成函数内 `define` 会静默归零）
- `StateEffect` 是唯一推送入口
- `commentTranslationView()` **自包含 field**（`[dataField, blockDecorationField, plugin]`）—— 让调用方不可能忘挂其中一半

### 装饰来源按种类分开（硬约束）

| 装饰种类 | 提供者 | 理由 |
| --- | --- | --- |
| `block-widget`（`below`） | **`StateField`** | CM 硬性禁止插件提供 block 装饰（见 §6 表最后一行） |
| `inline-widget` / `hover-anchor` | `ViewPlugin` | 需要 `visibleRanges` 裁剪；`StateField` 拿不到 view |

### 必须按 `visibleRanges` 裁剪

5000 行文件里 400 条注释，全量建 DOM widget 会卡；widget 产物常驻吃内存。用区间**相交**判定（不是完全包含），否则滚动时半条注释会闪烁。

---

## 6. 踩过的坑（按发现顺序）

| 现象 | 根因 | 判据 / 修法 |
| --- | --- | --- |
| 所有 docstring 提取不到 | Lezer 节点 `type.isNamed` **恒为 `undefined`** | 用「节点名是否标识符」判定具名节点 |
| 所有 docstring 被误拒 | `firstNamed === wrapper` 恒 false —— Lezer 游标对象**每次访问都是新实例** | 用 `from`/`to` **位置**比较 |
| docstring 缩进剥离静默失效 | 缩进基准取 `bodyLines[0]`，多行 docstring 该项恒为空串 → `startsWith('')` 恒真 | 基准取「首个**独立成行**的非空行」 |
| `@returns the id` 报 `doc tag name lost: the` | 把 `@returns` 后面的说明文本当成参数名 | 只有 `@param` / `:param` 有参数名 |
| `Replace:` / `Note: x` 被判 tag 且不翻译 | 字段行判据只认 `^\w+:\s`，散文也满足 | 字段行必须**有缩进**（结构块内才有） |
| `Args:` 标题污染字段行 | 标题（不可翻）与字段（可翻）被合并成一个 tag 段 | 标题行先 flush 成独立段 |
| 示例块只识别第一行 | `afterExampleLead` 在首条 code 行后就被重置 | 标志持续到缩进结束 |
| `//go:build` 被送去翻译 | TS/Go/Java 的 `lineMarkers` 只有 `//`，`///` 剥出 `/ @ts-expect-error` | 标记表加 `///`（长度降序） |
| `// doc\n\n\nfunc A()` 被判 doc | 空行计算差一：`to` 取了「下一行起始」，把换行算进组之后 | `to` = 下一行起始 − 1；空行数 = 换行数 − 1 |
| 跨文件同文重复请求 | 去重按 address，而不同文件的 address 不同 | 按**归一化文本**去重，结果按 alias 展开回所有地址 |
| below 模式 widget 完全不渲染 | `Decoration.widget({ block: true, side: 1 })` —— block widget **不能带 side** | 去掉 `side` |
| **below 模式 dispatch 直接抛错** | `Decoration.widget({ block: true })` 由 `ViewPlugin.decorations` 提供 —— CM 6.43.11 硬性禁止（`RangeError: Block decorations may not be specified via plugins`） | block 装饰由 `StateField` + `EditorView.decorations.from(f)` 提供；`ViewPlugin` 只留 inline / hover（唯一理由是它需要 `visibleRanges` 裁剪，而 field 拿不到 view） |
| **注释里的代码行凭空消失** | entry 是**段级**的（`entries.push({ text: translated })`），`code` 段没有 entry → 渲染时整行不见，还丢 `//` 前缀与原缩进（违反 U2 / R6.4） | entry 必须是**组级**：按组聚合，经 `rebuildBlock` 重建完整行（逐行带 `// ` / ` * ` / docstring 引号与缩进）；`requestedSegments` 是段级计数，`entries.length` 是组级计数，两者不可互换 |
| **块注释重建出重复的 `/**` / `*/`** | 组把开闭标记行也当 `blank` 段收进来，而 `rebuildBlock` 对 `shape === 'block'` 自己补出标记 | 喂给 `rebuildBlock` 前去掉首/尾的标记段（判据：`blank` 段的所有行 `trim()` 后等于 `blockOpen` / `blockClose`） |
| **译文块与原文视觉上无法区分** | `commentView.ts` 产出六个类名，但 `src/styles/` 里**一条规则都没有**；300+ 测试全绿 | `editor.css` 补 `cm-comment-translation*` 六条规则；`stylesWiring.test.ts` 静态断言「类名作为选择器 token 存在」（`includes` 会被 `__reason-xxx` 变体命中，必须用 `\.name(?![\w-])`） |
| **`commentAutoWarm` 开关不生效** | 字段在 `settings.ts` 定义、`appConfigNormalize.ts` 归一化，但全仓**零读取方** | `CommentTranslationBar` 里唯一读取点 + `useRef` 防重入（记录**文件路径**，切文件自然重置）；`start` 身份随状态变化，无 ref guard 时每次重渲都重发请求 |

---

## 6b. 入口接线（方案 A：编辑器内工具条）

```
FileViewer → FileEditor → CommentTranslationBar → useCommentTranslateActions → 引擎
```

**为什么多一层 `CommentTranslationBar`**：`FileEditor` 贴着 `check_component_size` 的 300 行
ratchet 红线。把「装配 hook + 条件显示 + 渲染工具条」收成独立组件后，`FileEditor` 只多一行
条件渲染 —— 否则新债直接让护栏变红（本轮实证：一体化写法让 FileEditor 涨到 331 行）。

**默认项来源**：`CommentTranslationBar` **自读** `AppConfig.translation`，不经 `FileEditor`
透传。少一层 props 传递，也避免为透传在红线文件里再加行。

**入口显示判据**：`canEdit && isTranslatableCommentFile(filePath)`。必须判 ——
`extractComments` 对 unknown 家族**静默返回空**，不判就会出现「点了按钮什么都不发生」，
比不显示按钮更糟。

**内容变化清理**：hook 记录上次翻译时的 `source`，`content` prop 变化即清空译文。
不清会留下位置已漂移的错位译文。位置本身由 `StateField.mapPos` 映射，但内容语义变了，
旧译文不再可信。

**L1 预热（R7 默认关）**：`CommentTranslationBar` 是 `AppConfig.translation.commentAutoWarm`
的**唯一读取点**。effect 必须用 `useRef` 防重入（记的是**文件路径**，不是布尔值）：
`start` 的身份随内部 state 变化，无 guard 时每次重渲都会重发一次请求。

---

## 6c. 失败组的单组重试（R6.6）

失败 chip 的点击 → **只重算该组**。四层各自的一个坑，都不产生编译/类型/渲染信号：

```
chip DOM（data-comment-retry-group）
  → 插件 eventHandlers（click）
  → 模块级注册表（{current: view} → 回调）
  → hook retryGroup(startLine)
  → 控制器 onlyGroups + previousEntries
  → 引擎 onlyAddresses
  → mergeCommentEntries 合并后 push
```

### 组标识用 `startLine`（1-based），不用下标、不用偏移

下标依赖「本次有哪些组被门禁跳过」。同一文件里门禁结果一变（把 `// eslint-disable`
改成普通注释），下标就指向**另一个组** —— 点 A 组的 chip 重试了 B 组，全程无报错。
偏移随任何编辑平移。`startLine` 由语法树位置推导，同一份源码重推后落回同一组。

### entries 必须**显式合并**，且合并职责在纯函数层

`setCommentTranslations` 是**整体替换**语义。重试一组却 push「本次算出的组」= 把其余
组的译文静默清空。所以控制器接收 `previousEntries`，由 `mergeCommentEntries` 合并：

- `onlyGroups` 缺省 → 原样返回本次结果（整文件翻译要能清掉已删除组的幽灵译文）；
- 提供时 → 保留「本次**没有重新产出**」的旧 entry，再加本次的（按 `from` 重排）。

判据是「本次有没有产出同组 entry」而不是「组号不在重试集合里」：重试可能因中止/异常
什么都没产出，那时删掉旧 entry 会让界面**比重试前更差**。

### 引擎用「入口收窄作用域」而不是四处判断

`onlyAddresses` 在 `translateSegments` 最前面 filter 一次，后续去重/缓存/凑批/校验全都
只看这批段。四处各加一次判断的话，漏任何一处都表现为「别的组被重译」（只是变慢）
或「被过滤的段又出现在结果里」（错误）。

### chip 可达性有两道静默杀手

| 杀手 | 后果 | 约束 |
| --- | --- | --- |
| `WidgetType.ignoreEvent()` 返回 `true` | CM 的 `eventBelongsToEditor` 直接丢弃事件，`eventHandlers` 收不到 | 行内 widget 必须返回 `false`；**行内模式的 chip 就是整个 widget**，用例要点它 |
| 注册要求「已有 view 才注册」 | 视图由子组件 ref 回调创建，挂载时 `current` 还是 `null`；祖先被 `React.memo` 挡住时不会重渲 → 永不注册 | 注册表存**引用**（`{current}`），命中时才读 |

回调经模块级注册表而不是 `extensions` 依赖：后者身份抖动会触发 `reconfigure`，丢掉
lint 等经 `appendConfig` 惰性安装的扩展（AC16 / 禁止模式 10）。注册表按 view 索引而不是
全局单槽：分屏时组号在不同文件里可能都叫 3。

### 工具条与 chip 是两种粒度

工具条按钮 = 重试**全部**失败组（整文件重跑，缓存保证不重复请求）；
chip = 重试**这一组**。两者走不同到达路径（React 节点 vs widget DOM），不可互相替代。

---

## 7. 单一实现清单（禁止再写第二份）

重复的危害不在「体积」，而在**漂移无人知**：副本与原件行为一致时测试全绿，
只有原件改了副本没跟上才出事 —— 而那时早已没人记得有副本。下列几处只能有**一个实现**，
已由 `comment/__tests__/singleSourceGuards.test.ts` 静态钉住。

| 能力 | 唯一实现 | 消费者 |
| --- | --- | --- |
| 行号索引 / 行首表 | `runner/syntax/lezer.ts`（`createLineLookup` / `createLineStarts`），经 `@/features/runner` 门面导出 | `extractComments` / `classifyBlock` / `useCommentTranslation` |
| 模型输出 JSON 数组解析 | `translation/prompt.ts` 的 `parseTranslationResponse` | `translateSegments`（`parseTranslationArray` 就是它的别名） |
| doc 判据 | `commentSyntax.ts` 的 `docRule` 槽（`markup` / `structural` / `null`） | `classifyBlock` 查表，**不得**写 `family === 'xxx'` |
| 行级文本启发式 | `commentHeuristics.ts` | `segmentBlock`（只管状态机） |

**为什么行索引必须经门面**：`editor` → `features/runner/**` 的深导被 ESLint 防火墙拦死
（只放行 `index/store/types/api`）。门面不导出 → 只能抄一份，这正是当初三份副本的成因。

---

## 8. 性能：索引只建一次

`classifyBlock` / 段定位都吃行号与语法树位置。任何**在组循环里**扫源或遍历树的写法
都是 O(n²)。实测（同一实现、不同组数）：100 组 2.8ms → 400 组 22.1ms → 1600 组 215.6ms。

正确形态：`useCommentTranslation` 建一次 `lineStarts` + `declIndex`（声明节点按
`(from 升序, to 降序)` 排序的具名节点表），经 `ctx` 传给每个组。

排序键必须是 `to` **降序**：`package m` 里 `PackageClause(26,35)` 与关键字子节点
`package(26,33)` 同起点，让子节点排前会让二分命中关键字、doc 判定全面失效。

护栏不看墙钟（会抖），而是数构造次数（spy）+ 给一个「一旦访问就抛」的毒化树。

## 9. 测试取向

- 纯函数层（提取/分组/分段/分类/校验/重建/地址）→ **node 环境**，不碰 DOM。
- 渲染层 → jsdom。**四种模式都能在真实 `EditorView` 上断言**（`below` 也是 —— block widget 在 jsdom 下**确实会渲染**，早前「jsdom 不渲染 block widget」的结论是错把 CM 的 `RangeError` 当成了环境限制）。`createBelowWidgetForTest().toDOM()` 只用于断言 widget 产物，不能替代「装饰能否挂上编辑器」。
- 接线护栏用**静态断言**（读源文件）：译文数据不得成为 `useEditorExtensions` 的 props、不得出现在其 useMemo 依赖数组。这类回归运行时测不出（「本该存在的东西消失了」）。

### 夹具选择比断言更关键（本轮实证）

三条测试首版是**假绿**：

1. 「非首语句裸字符串不判 docstring」用了 `"stray string"`（单引号）→ 被「无三引号」分支拒绝，**根本没走到首语句判定**。改用 `"""stray"""` 后变异立刻能抓。
2. 「去重」用例在默认 token 预算下两段被**合并成一批**，「1 次请求」既可能来自去重也可能来自凑批。加 `tokenBudget: 1` 逼成逐段成批才有判别力。
3. 「示例引导行」用例里的代码行本身能被 `looksLikeCode` 判 code → 引导行机制是冗余路径。换成「不像代码的缩进行」后暴露了真 bug。

**判定准则**：写完用例后做变异（把实现改回缺陷版本），必须是红的。不红先怀疑夹具。

### 变异验证记录（本轮）

只报绿色不算完成——每条修复都做过「把实现改回缺陷版本，测试必须变红」的复核：

| 修复 | 变异方式 | 变红用例 |
| --- | --- | --- |
| block 装饰改由 `StateField` 提供 | 把 block 装饰塞回 `ViewPlugin.decorations` | 4 条（含 `RangeError: Block decorations may not be specified via plugins`） |
| 行索引 / 声明索引只建一次 | 忽略 `ctx.lineStarts`（每组重建） | 1 条（spy 计数 41 ≠ 1） |
| 同上（树侧） | 忽略 `ctx.declIndex`（每组重建） | 1 条（毒化树当场抛出） |
| `docRule` 进数据表 | go 的 `docRule` 改回 `null` | 6 条（4 条 Go doc 语义 + 数据表断言 + 索引复用） |
| 同上（禁止 `family ===`） | 分类器改回 `family === 'go'` | 1 条（源码断言） |
| 行索引复用 runner 门面 | 撤掉门面导出 + 抄回私有实现 | 3 条 |
| 复用 `parseTranslationResponse` | 抄回私有副本 | 2 条（含函数对象身份断言） |
| 测试加载器迁出生产模块 | 塞回 `PARSER_LOADERS` + `extractFromSource` | 1 条 |
| 启发式与状态机分离 | 把 `looksLikeCode` 塞回 `segmentBlock.ts` | 1 条 |
| 失败 chip 单组重试（R6.6） | 引擎忽略 `onlyAddresses`（作用域不收窄） | 3 条（含「只请求命中段」） |
| 同上（控制器作用域） | 忽略 `onlyGroups`（整文件重跑） | 1 条 |
| 同上（合并语义） | `mergeCommentEntries` 退化为「返回本次结果」 | 3 条（含端到端点击重试） |
| 同上（chip 可点击） | chip 不带 `data-comment-retry-group` | 7 条 |
| 同上（事件回调） | 插件 `eventHandlers` 不调注册表 | 5 条 |
| 同上（规格透传） | `buildCommentDecorations` 丢 `groupKey` | 6 条 |
| 同上（`ignoreEvent`） | `InlineWidget.ignoreEvent` 改回 `true` | 1 条（行内 chip 点击收不到事件） |
| 同上（晚绑定） | 桥接改回「已有 view 才注册」 | 1 条（视图挂载于挂载后、不重渲） |

> **「晚绑定」那条是本轮实现过程中真踩到的缺陷**：首版注册表是 `WeakMap<EditorView, fn>`，
> 注册要求传入真实视图，而视图由子组件的 ref 回调创建 —— 挂载时 `current` 还是 `null`。
> 「视图出现必然触发重渲」这个假设并不成立（祖先被 `React.memo` 挡住时 props 全稳定），
> 于是注册永不发生，chip 点击毫无反应，编译/类型/渲染全绿。改成存 `{current}` 引用后
> 注册在挂载时必然发生，命中时才读 `current`。
>
> `ignoreEvent` 那条是**已有实现本就正确**（行内 widget 一直返回 `false`），本轮补上用例
> 把这份正确性钉住 —— 它是「chip 可点」能成立的前提，而此前无任何断言保护它。
