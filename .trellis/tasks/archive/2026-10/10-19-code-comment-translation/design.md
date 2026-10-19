# Design — 代码编辑器注释翻译

> 本设计的所有技术前提都在本机实跑验证过（§1.3 证据表），不是推测。
>
> 与文档翻译的关系：`address` / `cache` / `verify` 执行器 / `engine` 四层同源可继承。
> 本任务真正的新工程是 **提取 → 分组 → 分段 → 分类 → 呈现** 五层，占本任务代码量 ~70%。

## 1. 第一性原理

### 1.1 四条约束

```
约束 1  代码必须仍可执行 / 可被工具链解析
        → 译文只能存在于渲染层，永不进入文件字节

约束 2  注释里有大量「机器读的」文本
        → 翻译前必须分类；分类错 = 静默破坏工具链（比翻错更严重）

约束 3  注释是语法树节点，不是自由文本
        → 切分必须来自 AST；正则扫 // 会把字符串里的 // 当注释

约束 4  注释内部混排散文与代码，且连续行注释是 N 个独立节点
        → 必须在节点之上再建「逻辑块」与「块内 segment」两层抽象
```

### 1.2 核心判断（三层抽象，缺一不可）

> **不是「节点 → 翻译」，而是「节点 → 逻辑块 → segment → 只翻 prose/tag 段」。**

| 层 | 为什么必须有 |
| --- | --- |
| **节点层**（AST） | 唯一能区分「真注释」与「字符串里的 `//`」的层；也提供位置语义（docstring 判定依赖在 body 的位置） |
| **逻辑块层** | 连续 `//` 在树里是 N 个节点（实测 Rust `/// A\n///\n/// # Example` = 7 个）。逐节点翻译会打散段落、请求数爆炸 |
| **segment 层** | 一条注释块内可能第 1、3 行是散文、第 2 行是代码（实测 JS 用例）。U2 要求代码不翻 → 必须能按行切分并各自分类 |

少了任一层都会退化：
- 少逻辑块 → 段落被打散，模型失去上下文，且请求数 × N
- 少 segment → 只能「整块翻」或「整块跳过」二选一，无法满足 U2 的混排要求

### 1.3 已验证的技术前提（实测证据）

| 前提 | 验证方式 | 结论 |
| --- | --- | --- |
| 七种语言注释节点名 | `@codemirror/lang-*` 的 `.parser.parse()` 实地 dump | TS/JS/Rust/Go/Java = `LineComment`+`BlockComment`；Python/CSS = `Comment`；legacy-modes = `comment`（小写） |
| **连续行注释是 N 个节点** | Rust `/// A\n///\n/// # Example\n///\n/// ```rust\n/// let x=compute();\n/// ``` ` dump | **7 个 `LineComment`**，不是一个块 |
| **块内混排代码是常态** | JS `// Replace:\n//   const x = compute(a,b);\n//   if (x>0) {return x;}\n// with cached form.` dump | **逐行独立节点**，代码行与散文行完全同构 → 只能靠内容分类区分 |
| **行邻接分组可行** | 构造 4 组样例（相邻/空行隔开/代码隔开/缩进续行） | 判据 `nextStartLine === prevEndLine + 1` 正确分出 4 组 |
| **Python docstring 判别可行** | dump Python 模块/类/函数 | docstring = `ExpressionStatement > String` 且在 `Body`/`Module` 的**首语句**；`x = "..."` 是 `AssignStatement`，不误判 |
| `Decoration.widget`/`mark` 可组合 | 用 `EditorState` + `EditorView.decorations` 构造 | ✅ 可加 inline widget + mark |
| 注释节点 from/to 可精确切片 | dump 输出 `[0,14]` = `// hello world` | ✅ 范围含标记本身 |

> **教训（已记录，两次）**：
> ① 我最初假设「Python 也用 `LineComment`」→ 实测是 `Comment`。
> ② 我最初以为「连续 `///` 会合成一个块注释节点」→ 实测是 N 个独立节点。
>
> 这类差异只能跑真实 parser 得到。因此 AC1/AC2/AC3 都要求**参数化逐语言/逐结构断言**，
> 而不是模糊 `/comment/i` 匹配 —— 后者会让验收失去判别力。

## 2. 为什么必须先有语法树（否定正则方案）

正则看似 20 行能搞定，真实代码里必错：

```ts
const url = "http://x";   // 正则看到 //x";  是假注释
const s = a / b; // c      // 除法 vs 注释边界
```

更根本的是：**正则无法给出位置语义**，而分类依赖它 ——
license 只在文件头窗口判、docstring 依赖「是否 body 首语句」、Go doc 依赖「是否紧邻声明」。

结论：不做正则兜底。**没有语法树就不翻译**（该文件功能静默不可用，UI 说明原因）。
符合仓库既有取向（`runner/syntax/lezer.ts` 注释里写过同一原则：「宁可没有按钮，也不给错按钮」）。

## 3. 模块边界

| 模块 | 唯一职责 | 纯 | 新增/复用 |
| --- | --- | --- | --- |
| `comment/commentSyntax.ts` | `LanguageFamily` → 节点名/标记/**docstring 路径** 数据表；`detectFamily` | 是 | 新增 |
| `comment/extractComments.ts` | 语法树 → `RawComment[]` + `RawDocstring[]` | 是 | 新增 |
| `comment/groupComments.ts` | 节点 → **逻辑块**（行邻接分组） | 是 | 新增（**U2 前置**） |
| `comment/segmentBlock.ts` | 块 → **segment[]**（prose/code/fence/blank/tag） | 是 | 新增（**核心**） |
| `comment/classifyBlock.ts` | 块 → 组级 kind（shebang/directive/license/doc/prose） | 是 | 新增（**门禁**） |
| `comment/commentAddress.ts` | 归一化 segment 文本 → 内容地址 | 是 | 复用 address 思路 |
| `comment/verifyComment.ts` | 译文段 → 判定（占位符/标签/围栏/代码回吐） | 是 | 新增规则表，复用 `VerifyRule` 类型 |
| `comment/rebuildBlock.ts` | 译文段 + 原标记 → 可渲染行（含 docstring 缩进） | 是 | 新增 |
| `translation/cache.ts` | 地址 → 译文（端口 + 注入） | 否 | 复用上一版设计 |
| `translation/engine.ts` | 去重 → 缓存 → 补漏 → 校验 → 重试 → 进度 | 否 | 复用上一版设计 |
| `comment/commentDecorations.ts` | `StateField` + `StateEffect`；`visibleRanges` 裁剪；四种模式 | 否 | 新增（**核心**） |
| `comment/useCommentTranslation.ts` | 控制器：提取→分组→分段→分类→引擎→推 decoration | 否 | 新增 |

判据：删任一行，其余仍能编译。

## 4. 低耦合：隔离点

```
useCommentTranslation ──inject──> CommentSource(纯函数族) / TranslationTurn / TranslationCache / CommentDisplay
```

- **`CommentSource`**：提取 + 分组 + 分段 + 分类 + 重建合成一个注入面。
  测试直接用**字符串源码**喂（`parser.parse()` 建树，已实测），不需要真 CodeMirror state。
- **`TranslationTurn`**：复用已有接口，**零 `invoke`**。
- **`TranslationCache`**：同文档翻译的端口。
- **`CommentDisplay`**：四种模式同接口，新增模式不改引擎、不改提取。

## 5. 高可扩展

| 未来需求 | 改动 | 核心逻辑改动 |
| --- | --- | --- |
| 新增语言（Kotlin/Swift/C#） | `commentSyntax.ts` 加一行（节点名 + 标记 + docstring 路径） | 0 |
| 新增 segment 种类（如表格行） | `segmentBlock.ts` 加一个判定函数 | 0 |
| 新增显示模式（侧栏对照） | 实现一个 `CommentDisplay` | 0 |
| 新增校验规则（禁繁体/保 snake_case） | push 一条 `VerifyRule` | 0 |
| 新增跳过类别 | 分类器加一条判定函数 | 0 |

## 6. 关键决策与取舍

### D1 三层抽象（节点 → 块 → segment）

见 §1.2。这是本设计最不可省的部分 —— 也是我在调研前**低估**的部分。

### D2 代码判定偏宽，指令判定偏宽（不对称原则）

三种跳过类别的误判代价**不对称**：

| 类别 | 误判方向 | 后果 |
| --- | --- | --- |
| `directive`/`license`/`shebang` | 判宽（多跳过） | 用户看到原文，可手动处理 ✅ |
| 同上 | 判窄（漏过 → 被翻） | `//go:build linux` 被翻 → **构建静默失败，没人想到是翻译** ❌ |
| `code`（U2） | 判宽（多判 code） | 用户看到原文未翻，可能抱怨但**代码安全** ✅ |
| `code` | 判窄（漏过 → 被翻） | 示例代码被翻坏 → **照抄即报错** ❌ |

> 所以两侧都判宽。唯一的代价是「该翻的散文被判成 code」—— 这需要
> **`Example:`/`Usage:` 之后的缩进块**这类明确信号才触发，避免把普通散文误杀。

### D3 身份落在 segment，不落在块

若地址按「块」算，在注释块中间插一行就会让**整块**失效（含未变的行）。
按 segment 算，插入一行只影响相邻 segment，其余命中缓存。这是 AC12 的判据。

### D4 呈现用 `StateField` + `StateEffect`，不用 `extensions` 依赖

依据 `quality-guidelines.md` 禁止模式 10：`@uiw/react-codemirror` 在 `extensions` 引用变化时
dispatch `reconfigure`，会丢掉 lint 等经 `appendConfig` 惰性安装的扩展。译文是**高频活数据**，
接进依赖 = 每批译文到达就重建扩展世界 → 波浪线静默消失。

正确形态（与 `lspDiagnosticsProjection.ts` 同构）：

```
模块级  commentTranslationField = StateField.define<DecorationSet>(...)   // 必须在 base 且模块级
        setCommentTranslations  = StateEffect.define<...>()               // 推送唯一入口
reconciler  ViewPlugin：visibleRanges 变化时重算（滚动才为新区建 widget）
```

### D5 可视区裁剪是必需项

5000 行文件 400 条注释，全量建 DOM widget 会卡；widget 的 `toDOM` 产物常驻也吃内存。
装饰集合按 `view.visibleRanges` 生成，滚动/编辑经 `ViewPlugin.update` 重算。AC14 测试点。

### D6 多行重建

- **块注释**：译文仍多行时按原 ` * ` 前缀逐行补齐。
- **行注释块**：逐行按原 `//` / `///` / `#` 前缀补齐；`code` 段用原文行。
- **docstring**：按原始缩进对齐（`"""` 内文本首列），见 §7 遗留 2。

### D7 不写盘，但给「复制」

用户想把译文真正落到代码里是合理需求。出口是**复制到剪贴板**（显式动作），
而非自动写回：diff 干净、`git blame` 不炸、译文垃圾不落盘，但仍有手动通路。

## 7. 已定决策（用户 2026-10-19 采纳推荐建议）

> 三条遗留均已定案。依据标签：`[实测]` = 本机实跑验证，`[推荐]` = 采纳推荐方案。

### D7-Shebang shebang 的节点形态随家族不同（实测）

写 T7 时发现一个容易误判的事实：**`#!` 不总是注释节点**。

| 家族 | `#!/usr/bin/env x` 的节点 | 需要 `isShebang` 门禁吗 |
| --- | --- | --- |
| Python | `Comment` | **需要**（否则会被翻译） |
| Shell（StreamLanguage） | `meta`（不是注释） | 不需要（天然不进候选集） |
| TS/JS | 错误恢复，无 `Comment` 节点 | 不需要 |

**判据**：不要假设「所有语言的 shebang 都是注释」。`isShebang` 仍必须存在（Python 需要它），
但**测试必须用 Python 构造** —— 用 shell 写的用例测到的是「无注释」，不是「跳过 shebang」
（这类夹具选错会让门禁形同虚设，是 `frontend-testing.md` §11 的同类问题）。

### D7-Go Go 的 `//` doc 判定 —— 结构判定 + 行距判据（**双条件，缺一不可**）

**为什么不能只靠行号统计**（实测发现）：Go 源码树里顶层注释与声明是**兄弟节点**，
`nextSibling` 直接就是被声明的声明 —— 这让「紧邻」变成结构判定而非文本猜测。

但**纯结构判定会误判**（实测）：

| 源码 | `nextSibling` | 中间空行数 |
| --- | --- | --- |
| `// doc\nfunc A() {}` | `FunctionDecl` | 1 |
| `// doc\n\nfunc A() {}` | `FunctionDecl` | 2 |
| `// doc\n\n\nfunc A() {}` | `FunctionDecl` | 3 |

注释与声明间有空行时，语法树结构完全相同（都是兄弟）、只是位置距离不同。

**定案判据（两个条件同时满足才判 `doc`）**：
1. 组结束后的下一个**兄弟节点**是声明类节点
   （`FunctionDecl` / `MethodDecl` / `TypeDecl` / `VarDecl` / `ConstDecl` / `PackageClause`）；
2. 组末尾到该声明起始之间**空行数 ≤ 1**（即最多一个空行）。

**为什么需要条件 2**：Go 惯例允许注释与声明间有一个空行（少见但合法），两个以上即为
「与声明无关的独立注释」。

**为何不需统计阈值**：结构给了「下一兄弟是声明」，行距给了「贴得够近」，两者足够；
不再引入「几行以内」这类需要采样定标的魔法数。

**误判方向**：判不出 doc 时降级为 `prose` —— **仍会翻译**，只是不启用 doc 标签校验。
因此误判代价很小（一致性检查少一层），这是可以接受的。

### D8-Docstring 缩进重建 —— 按原文首行缩进锚定，后续行跟随

**定案（方案 A）**：译文多行时，**首行沿用原文首行缩进**，后续行统一对齐到
「首行缩进 + docstring 内容起始列」，不逐行照搬原文缩进。

```
原文（缩进 4，内容起始列 7）：        译文：
    """Translate a batch.                     """通过一次 agent 回合翻译一批片段。
                                             返回按索引对齐的字符串数组。
    """                                        """
```

**理由**：PEP 257 惯例是 docstring 内容从 `"""` 之后开始；译文行数通常与原文不同，
逐行照搬原文缩进在行数不匹配时会产生参差。锚定首行是唯一行数无关的方案。

**引号处理**：`"""` / `'''` 原样保留，不在译文里改用引号风格。

**closing delimiter**：若原文 closing `"""` 独占一行，译文最后一行之后换行 + 同缩进 + `"""`；
若原文是单行（`"""text"""`），译文也保持单行（多行译文则退化为上面的多行形态）。

### D9-Args `Args:` / `:param` 结构块 —— 整块一次翻 + 块级标签集合校验

**定案**：结构块（`Args:` / `Arguments:` / `:param x:` / `Parameters:`）作为**一个翻译单元**
整块送模型，不逐字段拆分。

**校验方式**：块级校验「**标签/字段名集合**在译文中完整存活」——抽取块内的字段名集合
（如 `{n, count}`、`{groups}`），断言译文中每个名字仍出现。

**为何整块**：结构块通常很短（几行），逐字段拆分会把请求数抬高 2-5 倍；
而字段名存活用集合比对已能做到精确定位（reason 里报缺失的具体名字）。

**边界**：若某字段说明为空（只有名字），该行归 `tag` 段但**不送翻**（无内容可翻）。

**与 R4.1 的关系**：这是 R4.1「doc 标签与其名字」在结构块上的具体化，不新增规则类型。

## 8. 复用清单

| 复用对象 | 位置 | 方式 |
| --- | --- | --- |
| `walk` / `rawText` / `createLineLookup` | `features/runner/syntax/lezer.ts` | 直接用；**禁止另写遍历**（该文件的 O(n²) 教训直接适用本任务） |
| `SyntaxTree` / `SyntaxNode` 类型 | 同上（从 `syntaxTree` 返回类型派生） | 直接用（项目禁止直 import `@lezer/*`） |
| `parserFor` 约束 | `features/runner/syntax/parsers.ts` | 「经 `@codemirror/lang-*` 取 parser」 |
| `getLanguageExtension` / `LANG_MAP` | `shared/utils/codemirror.ts` | 语言分派单一来源 |
| `TranslationTurn` / `tauriTurn` | `features/editor/translation/` | 原样复用 |
| `TRANSLATION_EVENT` + `SequencedEvent` | `shared/events.ts:81` | 原样复用 |
| `planTranslationBatches` / `estimateTokens` | `translation/batches.ts` | 原样复用 |
| `parseTranslationResponse` | `translation/prompt.ts` | 原样复用 |
| `lspDiagnosticsProjection` 投影模式 | `features/lsp/hooks/` | D4 的参照实现 |
| `VerifyRule` 类型与执行器 | 本任务新建 | 与文档翻译共用 |

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 节点名猜错（两次已实证） | AC1 参数化实测；数据表唯一事实源 |
| 连续行注释被打散 | 逻辑块层（AC2）+ 行邻接判据（已实测） |
| 块内代码被翻译（U2） | segment 层 + code 判定偏宽（D2）+ 校验兜底（AC9） |
| 散文被误判成 code（该翻没翻） | 只在 `Example:`/`Usage:`/缩进块等强信号下判 code；其余偏散文 |
| docstring 漏识别 | 实测两条路径（`ExpressionStatement>String` 首语句），AC3 固化 |
| 翻译破坏工具链指令 | 组级硬门禁（AC10/AC11） |
| 大文件渲染卡顿 | `visibleRanges` 裁剪（AC14） |
| 配置重建丢 lint 扩展 | `StateField`(base) + `StateEffect`（AC16） |
| 不完整语法树漏注释 | 静默容忍（R1.4） |
| 用户误以为源文件被改 | 译文不进文档、不参与选中（R6.5）+ AC15 字节断言 |
| agent 子进程堆积 | 有界并发 2（复用 engine 设计） |

## 10. 测试策略

**纯函数 100%**（全部可用 `node` 环境，无需 DOM）：
- `commentSyntax`：family 检测、节点名表、docstring 路径
- `extractComments`：七语言 fixture + Python docstring 三种位置
- `groupComments`：行邻接四组样例（相邻/空行/代码/缩进续行）
- `segmentBlock`：**混排用例**（散文+代码+围栏+tag+blank 各段分类）—— 本任务最关键的一组
- `classifyBlock`：每类正反例 + 误判方向（该判宽的必须宽）
- `rebuildBlock`：行注释/块注释/docstring 三种重建形态
- `verifyComment`：占位符/标签/围栏/代码回吐 + 规则抛异常

**`useCommentTranslation` 集成**（fake turn + fake cache）：全跳过 / 部分翻 / 混排只翻 prose /
校验失败重试 / abort / 缓存命中。

**CodeMirror 层**（真实 `EditorState` + parser，不需要 DOM）：AC1、AC14、AC16。

**回归验证要求**（`.trellis/spec/unit-test/frontend-testing.md` §9/§11）：每条护栏用例写完后，
把实现回退到缺陷版本跑一次，**必须是红的**。绿色本身不构成证据。
