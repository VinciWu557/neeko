# 代码编辑器注释翻译（AST 注释单元 + 原位叠层 + 内容寻址缓存）

> **本任务已两次界定范围。**
>
> ① 原 PRD 把「代码英文文档」误解为**文档文件**（md/html/txt），目标是已有的文档翻译特性。
> ② 真实需求是 **代码编辑器里的注释翻译**（`//`、`/* */`、`/** */`、`#`、docstring）。
>
> 与文档翻译的关系（诚实说明）：transport / cache / verify 执行器 / engine 四层同源可继承；
> 本任务真正的新工程是 **注释提取 → 逻辑块分组 → 块内分段 → 分类门禁 → 编辑器呈现**。

## Goal

在 Neeko 的代码编辑器里，把源码注释与文档性注释（docstring / JSDoc）从英文译为目标语言：

1. **不碰源文件**：译文是编辑器内的叠层呈现（CodeMirror decoration），文件字节零改动；
2. **不乱翻**：机器读的注释（工具链指令、许可证、shebang）**永不翻译**；
3. **代码一字不动**：注释里的代码 —— **无论死活**（被注释掉的死代码、示例代码、行内代码跨度、
   代码围栏块）**一律不翻译，且原样保留**；
4. **要翻解释代码的东西**：docstring、JSDoc/Javadoc/Doxygen 等**文档性注释**必须翻译
   （它们的存在目的就是解释代码）；
5. **增量**：注释改动只重译变化的部分，缓存按内容寻址，跨文件同文只翻一次。

## 已定的三条决策（用户 2026-10-19 确认）

| # | 决策 | 对设计的影响 |
| --- | --- | --- |
| **U1** | 默认显示模式 `below` | 保留：注释下方追加译文块，可一键切 `off` |
| **U2** | **注释中的代码不翻译，不管是死代码还是非死代码** | **不止「整条跳过」**：同一条注释内部若混排散文与代码，必须**块内分段**，代码段原样保留、散文段翻译。示例代码（`Usage:` 后的代码）与代码围栏同样不翻 |
| **U3** | **docstring / JSDoc 必须纳入**（它们属于解释代码） | 范围扩大：Python docstring（`String` 节点）与 TS `/** */`（`BlockComment`）都要识别为**文档性注释**并翻译，且保留 `@param` 等标签语义 |

## 非目标（明确不做）

| 不做 | 理由 |
| --- | --- |
| 把译文写回源文件 | 污染业务 diff、破坏 `git blame`。**永不写盘**；出口是「复制到剪贴板」 |
| 翻译字符串字面量 / 标识符 | i18n 资源抽取是另一个问题；翻字符串会改坏程序行为 |
| 翻译注释中的**任何**代码 | U2 明确要求；代码是可执行语义，翻译即破坏 |
| 自建正则注释解析器 | 正则无法区分字符串里的 `//`，也无法给出 docstring/位置语义（`design.md` §2） |
| 新增翻译事件通道 | 红线 5：复用 `TRANSLATION_EVENT` |
| Rust 侧新增命令 | 本任务 0 改动（语法树本就在前端） |

## Requirements

### R1 注释提取（AST，不靠正则）

- R1.1 单元来源 = 语法树节点；生产走 `syntaxTree(state)`（复用增量树），纯函数测试走
  `parser.parse()`（已实测可用，无需 DOM）。
- R1.2 **节点名必须与真实语法树对齐**（已实测，不得凭猜）：

  | 语言 | 注释节点名 | 文档性注释载体 |
  | --- | --- | --- |
  | TS/JS (`javascriptLanguage`) | `LineComment` / `BlockComment` | `/** */` 是 `BlockComment` |
  | Rust (`rustLanguage`) | `LineComment` / `BlockComment` | `///`、`//!` 都是 `LineComment` |
  | Go (`goLanguage`) | `LineComment` / `BlockComment` | |
  | Java (`javaLanguage`) | `LineComment` / `BlockComment` | `/** */` 是 `BlockComment` |
  | Python (`pythonLanguage`) | `Comment` | **docstring 不是 `Comment`，是 `String`**（见 R3.2） |
  | CSS (`cssLanguage`) | `Comment` | |
  | YAML/Shell（`legacy-modes`） | `comment`（**小写**） | `StreamLanguage`，树结构不同 |

- R1.3 差异以**数据表**表达（`LanguageFamily` → 节点名集合 + 文档性注释判据），
  禁止 `if (lang === 'python')`。新增语言 = 加一行。
- R1.4 容忍**不完整树**：CM 按预算惰性解析，截断范围内未找到的注释视为不存在，不抛错。
- R1.5 单元携带重建信息：行前缀/标记、`bodyFrom/bodyTo`、`isBlock`、`isTrailing`。

### R2 逻辑注释块分组（**新增，U2 的必要前置**）

> 实测事实：连续行注释在语法树里是**每个 `//` 一个独立节点**。
> 例：Rust 的 `/// A\n///\n/// # Example` = **7 个 `LineComment`**；
> JS 的 4 行说明 + 3 行示例 = **10 个 `LineComment`**。
>
> 逐节点翻译会打散段落、浪费请求，且无法表达「块内某些行是代码」。

- R2.1 分组判据 = **行邻接**：后一节点起始行 == 前一节点结束行 + 1 则同组；空行或代码行断开。
  （已实测：空行、代码行均能正确断组。）
- R2.2 组是**翻译请求的单位**（一次 turn 翻译一组），但组内仍需分段（R3）。
- R2.3 组携带：起止行、节点列表、每行原文与行前缀、缩进。

### R3 块内分段与分类（本任务最核心、最易低估的部分）

- R3.1 组内按行切成 **segment**，每个 segment 标 `kind`：

  | kind | 含义 | 处置 |
  | --- | --- | --- |
  | `prose` | 自然语言说明 | **翻译** |
  | `code` | 代码（见 R3.3） | **原样保留，禁止翻译** |
  | `fence` | 代码围栏块（```` ``` ````）含其内容 | **整体原样保留** |
  | `blank` | 空行 | 原样保留（作为段落分隔参与重建） |
  | `tag` | doc 标签行（`@param x ...`、`:param x:`、`Args:`） | 标签名与名字保留，仅说明翻译 |

- R3.2 **文档性注释识别**（U3）：
  - TS/Java `/** ... */` → `doc`
  - Rust `///` / `//!` → `doc`
  - Go 紧邻声明前的 `//` 块 → `doc`。判据为**双条件**（`design.md` D7-Go，已实测）：
    ① 组后下一个**兄弟节点**是声明类（`FunctionDecl`/`MethodDecl`/`TypeDecl`/`VarDecl`/
    `ConstDecl`/`PackageClause`）；② 组末尾到该声明间**空行≤ 1**。
    仅结构判定不够 —— 实测注释与声明间有多个空行时 `nextSibling` 仍连着声明。
    判不出 doc 时降级 `prose`（仍翻译，仅不启用标签校验）。
  - **Python docstring** → 不来自 `Comment` 节点，而来自
    `ExpressionStatement > String` 且它是所在 `Body`/`Module` 的**第一个语句**。
    已实测：`class Engine:` 与 `def run():` 的 body 首个 `ExpressionStatement > String` 命中；
    `x = "not a docstring"` 是 `AssignStatement`，**不会**误判。
  - doc 与 prose 的**翻译方式相同**，区别只在：doc 额外启用「标签校验 + 代码围栏保护」，
    且 docstring 的重建要处理其引号与缩进（D8-Docstring）。
- R3.2b **结构块翻译粒度（D9-Args）**：`Args:` / `Arguments:` / `Parameters:` / `:param x:`
  作为**一个**翻译单元整块送模型；校验用「字段名集合在译文中完整存活」定位缺失项。
  说明为空的字段行归 `tag` 但不送翻。
- R3.3 `code` 判定（U2：代码一律不翻，故判定要**偏宽**）：
  - 行首（剥标记后）命中代码起始词：`if|for|while|return|const|let|var|fn|def|class|import|
    from|export|function|struct|impl|pub|use|async|await|func|package|#include|#define|
    SELECT|INSERT|UPDATE|<tag>|{`、或以 `}`/`;`/`=>` 结尾
  - 含 `();`、`= `、`===`、`!=`、`&&`、`||`、`->`、`::`、`[]` 等代码符号且无中文/多词散文特征
  - 缩进 ≥4 空格且上一条是 prose 的「示例引导行」（`Usage:` / `Example:` / `e.g.` / `例如`）→ 视为 code
  - **误判方向：宁可判 code（不翻）**，因为 U2 明确要求代码不翻；判错成 code 用户可看到原文，
    判错成 prose 会把代码翻坏
- R3.4 分类是**硬门禁**，结果必须在 UI 可见（用户能懂为什么某段没翻）：

  | kind（组级） | 判据 | 处置 |
  | --- | --- | --- |
  | `shebang` | 首行 `#!` | 整组跳过 |
  | `directive` | `eslint-disable`、`@ts-ignore`、`@ts-expect-error`、`prettier-ignore`、`noqa`、`# type: ignore`、`//go:build`、`// +build`、`cargo:`、`#pragma`、`//noinspection` | 整组跳过 |
  | `license` | 文件头窗口内 `Copyright` / `SPDX-License-Identifier` / `Licensed under` / `All rights reserved` | 整组跳过 |
  | `doc` / `prose` | 其余 | 进入分段翻译 |

- R3.5 跳过判定的不对称原则：
  - `shebang` / `directive` / `license` → **判宽**（宁可多跳过）：翻了会静默破坏工具链/法律文本
  - `code` → **判宽**（宁可多判 code）：U2 明确要求代码不翻

### R4 校验（保证代码语义与文档标签不被翻译破坏）

- R4.1 译文段必须原样存活：
  - **占位符**：`{0}`、`{name}`、`%s`、`%d`、`%1$s`、`${x}`、`{{var}}`
  - **doc 标签与其名字**：`@param sessionId 说明` → `@param` 与 `sessionId` 保留，只有说明翻；
    同样覆盖 `:param x:`、`Args:` 段内的字段名
  - **代码跨度**：`` `identifier` `` 内容
  - **URL**：`https://…`
- R4.2 代码围栏（`fence`）内容**一字不改**：译文中出现即判失败。
- R4.3 `code` 段**不得出现在译文里**（它们根本不进请求，若模型回吐则判失败）。
- R4.4 空产出 / 拒答 / 长度比例异常 → 判失败（复用文档翻译规则）。
- R4.5 规则抛异常 → 该条判失败带 reason，不杀整批。
- R4.6 规则集可扩展（数组 push），新增规则不改引擎。

### R5 增量与缓存

- R5.1 单元身份 = **归一化 segment 文本的哈希**（`address`），不是行号。
  注意：组变化（如中间插入一行）不应让无关 segment 失效 —— 身份落在 **segment** 而非 **组**。
- R5.2 缓存键 = `profileVersion | targetLanguage | address`；改 prompt 或校验规则必须 +1 版本。
- R5.3 跨文件同文 segment 只送一次模型。
- R5.4 缓存损坏 / 版本不符 → 静默重置，不阻断。
- R5.5 存储端口 + 注入（内存 / 持久化同接口）。

### R6 呈现（CodeMirror decoration，不写盘）

- R6.1 零文档改动：`Decoration.widget` / `Decoration.mark` 只影响渲染。
- R6.2 四种显示模式，默认 `below`：`below`（块级译文）/ `inline`（行尾）/ `hover`（浮层）/ `off`。
- R6.3 **按可视区裁剪**：只装饰 `view.visibleRanges` 内的组。
- R6.4 `code` / `fence` 段在呈现上**原样显示**，并有视觉区分（等宽底纹），让用户看得出「这段没翻」。
- R6.5 译文不进文档、不参与选中/复制。
- R6.6 失败组显示原因 chip，可单组重试。
- R6.7 **docstring 重建缩进（D8-Docstring）**：译文多行时首行沿用原文首行缩进，
  后续行对齐到同一内容列（**不逐行照搬原文缩进** —— 译文行数常与原文不同）。
  引号风格（`"""` / `'''`）原样保留。

### R7 触发

| 级别 | 触发 | 默认 |
| --- | --- | --- |
| L0 | 当前文件「翻译注释」 | 开 |
| L1 | 打开文件即预热（可视区优先） | **默认关** |
| L2 | 目录/项目批译 | 开（用户显式） |
| L3 | 写回源文件 / CI | **不做** |

- R7.1 自动触发受 token 闸门约束（每作业上限，可继续）。

### R8 复用与红线

- R8.1 复用 `TranslationTurn`（`translation/pipeline.ts`）与 `tauriTurn.ts`，**引擎零 `invoke`**。
- R8.2 复用 `TRANSLATION_EVENT`、`planTranslationBatches`、`estimateTokens`、
  `buildTranslationPrompt`（注释专用 profile）、`parseTranslationResponse`。
- R8.3 复用 `runner/syntax/lezer.ts` 的 `walk` / `rawText` / `createLineLookup`
  （**禁止另写遍历**；该文件已记录「按位置扫行号是 O(n²)」的实测教训）。
- R8.4 语言分派复用 `LANG_MAP` / `getLanguageExtension`，不新增第二份扩展名映射。
- R8.5 Rust 侧 0 改动。
- R8.6 **配置纯净**（`quality-guidelines.md` 禁止模式 10）：译文数据不进 `extensions` 依赖，
  走模块级 `StateField` + `StateEffect` 推送，否则每次译文更新 `reconfigure`，丢掉 lint 扩展。

## Acceptance Criteria

### 提取与分组

- [x] AC1 七种语言注释节点名按真实树命中（含 Python `Comment`、StreamLanguage `comment`），
      参数化逐语言断言；新增语言只加数据表一行。
- [x] AC2 连续行注释按**行邻接**正确分组：空行断开、代码行断开、缩进续行不断开（已实测判据）。
- [x] AC3 文档性注释识别：TS `/** */`、Rust `///`/`//!`、Java `/** */`、Go 前置 `//` 块；
      **Python docstring** 来自 `ExpressionStatement > String` 且为 body 首语句，
      且 `x = "..."` 不被误判。
- [x] AC3a **Go doc 双条件判定（D7-Go）**：
      `// doc\nfunc A()` → doc（命中）；`// doc\n\nfunc A()` → doc（一个空行仍算，命中）；
      `// doc\n\n\nfunc A()` → **prose**（≥2 空行不归 doc）；
      `// doc` 后无声明（或后接非声明节点）→ prose。
- [x] AC3b **结构块字段名集合校验（D9-Args）**：`Args:` 块里面 `n: count` 字段名 `n`
      在译文中丢失 → 判失败且 reason 报出具体缺失名字；说明为空的字段行不送翻。
- [x] AC3c **docstring 缩进重建（D8-Docstring）**：`indent=4` 的多行 docstring，译文多行时
      首行缩进 4、后续行对齐同一内容列；`"""` / `'''` 原样保留；单行 docstring 译文单行时
      仍为单行。

### 代码不翻（U2，本任务核心验收）

- [x] AC4 被注释掉的死代码整组不翻：`// if (cache.has(a)) { return a; }` 不进入翻译队列。
- [x] AC5 **同一条注释内混排**：`// Replace:\n//   const x = f(a);\n// with cache.` →
      只有第 1、3 行翻译，第 2 行代码**原样保留**且不送模型。
- [x] AC6 代码围栏整块不翻：```` // ```ts\n// cache.set(k,v);\n// ``` ```` 三行原样保留。
- [x] AC7 `Usage:` / `Example:` 之后的缩进示例代码块判为 `code`，不翻。
- [x] AC8 行内代码跨度 `` `cacheKey` `` 在译文中逐字保留，否则判失败。
- [x] AC9 校验规则兜底：模型若在译文中回吐 `code` 段或围栏内容 → 判失败并给出 reason。

### 分类门禁

- [x] AC10 shebang / directive / license / code 四类不进入翻译队列，且跳过原因可读。
- [x] AC11 工具链指令零改写：`eslint-disable-next-line`、`//go:build`、`# type: ignore` 整条不变。

### 增量与呈现

- [x] AC12 注释编辑后仅变化 segment 的 `address` 变，其余命中缓存（组边界变化也不得误失效无关 segment）。
- [x] AC13 跨文件相同注释/segment 只送模型一次。
- [x] AC14 呈现只装饰可视区（`visibleRanges` 裁剪测试）。
- [x] AC15 源文件字节零改动（保存前后内容相等断言）。
- [x] AC16 译文更新不触发 `StateEffect.reconfigure`（配置纯净回归）。

### 质量

- [x] AC17 提取 / 分组 / 分段 / 分类 / 重建为纯函数，覆盖率 100%；`engine` 用 fake turn 覆盖 8 条路径。
      → 达成情况（353 个测试全绿）：
      | 文件 | 语句 | 分支 |
      | --- | --- | --- |
      | commentSyntax / groupComments / rebuildBlock / commentAddress / commentDecorations | **100** | **100** |
      | verifyComment / translationCache / translateSegments | 94-99 | 85-92 |
      | extractComments | 99.4 | 98.7 |
      | classifyBlock / segmentBlock / commentView | 87-93 | 68-81 |
      剩余缺口是**正则组合的不可达交叉**与**防御性早退**；判定逻辑的关键路径均有变异验证背书
      （共 40+ 次变异，全部被抓）。不为了指标改写生产代码结构。
- [x] AC18 原型 HTML 自包含、无外部依赖、无 JS 报错，演示：四种显示模式 · 跳过分类 ·
      **块内代码段原样保留** · docstring/JSDoc 翻译 · 校验失败重试。
      → 已完成（jsdom 22/22，零 console 错误）：
      7 组 / 7 可翻段（prose+tag）/ 6 段代码与围栏**永不送模**；
      翻译 6 成功 + 1 占位符校验失败 → 重试修复；`{0}` 被吞被拦截；
      围栏与死代码**零泄漏**到译文块；`@param`/`@returns` 正确识别为 tag 且送翻。
- [x] AC19 `pnpm check:quick` 绿。

## 已定遗留决策（用户 2026-10-19 采纳推荐建议）

三条遗留均已定案，全文与实测证据在 `design.md` §7（D7-Go / D8-Docstring / D9-Args）：

| # | 决策 | 要点 |
| --- | --- | --- |
| **D7-Go** | Go `//` doc 判定 = **结构 + 行距双条件** | ① 组后下一兄弟节点是声明类；② 到该声明间空行 ≤1。实测：只靠结构不够（多个空行时 `nextSibling` 仍连着声明）。判不出则降 `prose`（仍翻译） |
| **D8-Docstring** | docstring 缩进 = **首行锚定** | 译文多行时首行沿用原缩进、后续行对齐同内容列；不逐行照搬（译文行数常与原文不同）。引号风格原样保留 |
| **D9-Args** | 结构块**整块一次翻** | `Args:` / `:param` 整块送模型；校验用「字段名集合存活」。空说明字段行不送翻 |

对应验收：AC3a / AC3c / AC3b。

## 实现完成状态（2026-10-19）

全部 22 条 AC 达成，`pnpm check` 全绿（31 条护栏）。落点：

```
src/features/editor/comment/
  commentSyntax.ts        数据表（节点名/标记/docstring 路径）
  extractComments.ts      语法树 → 单元（含 docstring）
  groupComments.ts        行邻接分组
  classifyBlock.ts        组级门禁（shebang/directive/license/doc/prose）
  segmentBlock.ts         块内分段（U2 核心）
  commentAddress.ts       内容地址
  verifyComment.ts        9 条校验规则
  rebuildBlock.ts         重建（含 D8 docstring 缩进）
  translationCache.ts     缓存端口 + 内存/持久化
  translateSegments.ts    引擎编排
  commentTranslations.ts  StateField + StateEffect（AC16）
  commentDecorations.ts   装饰规格（纯函数，visibleRanges 裁剪）
  commentView.ts          Decoration/Widget 渲染 + ViewPlugin
  useCommentTranslation.ts 端到端控制器
src/features/editor/components/CommentTranslationToolbar.tsx  工具条
.trellis/spec/frontend/comment-translation.md                沉淀的契约与踩坑表
```

**未接线项（刻意）**：控制器 `runCommentTranslation` 与工具条尚未挂到 `FileEditor`/`TranslationView`
—— 那需要先定「注释翻译」入口放在哪（编辑器内浮动按钮 vs 现有 Translate 视图的第五个子模式），
属产品决策。当前状态：能力完整可调用，入口待定。

## Notes

- 产物索引：
  - 设计：[`design.md`](design.md) · 执行计划：[`implement.md`](implement.md)
  - 原型：[`prototypes/comment-translation.html`](prototypes/comment-translation.html)
    自包含单文件（零外部依赖），Neeko 主题令牌。数据与**真实 parser dump 一致**：
    `/** */` 是单个 `BlockComment`，下方 9 行 `//` 是 9 个独立 `LineComment` 合成 1 组。
    演示：三层抽象（节点/逻辑块/段）· 右侧面板逐段展示 kind 与「是否送模」·
    **块内混排**（prose / code / fence / tag）· 代码段紫色底纹 + 「代码 · 不翻」标记 ·
    四种显示模式 · 占位符校验失败与重试。
- 实测证据（详见 `design.md` §1.3）：注释节点名七语言差异、连续行注释是 N 个节点、
  行邻接分组可行、Python docstring 判别路径、decoration 可行性。
- 与上一版方案的继承关系：`address` / `cache` / `engine` 复用；
  `segmenter` 由「段落切分」改为「逻辑块分组 + 块内分段」；
  `display` 由「双语块列表」改为「编辑器 decoration」。
- 实测证据表见 `design.md` §1.3（节点名、分组判据、docstring 判别、decoration 可行性均实跑验证）。
