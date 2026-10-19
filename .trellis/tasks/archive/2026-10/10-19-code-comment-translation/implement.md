# Implement — 代码编辑器注释翻译

> 严格 TDD：Red → Green → Refactor。阶段顺序 = 依赖顺序，每阶段可独立合入。
>
> **T1–T4 全是纯函数，可完全在 `node` 环境对真实 parser 断言（无需 DOM）。**
> 先把这四层做对再碰 CodeMirror —— 提取/分组/分段/分类错了，后面全部白做。
>
> 三条已定决策贯穿全程：U1 默认 `below` · **U2 注释中的代码一律不翻（含块内混排）** ·
> **U3 docstring/JSDoc 必须翻译**。

## 阶段 0：前置确认（不写代码）

- [ ] T0.1 读 `src/features/runner/syntax/lezer.ts` 全文（遍历工具 + O(n²) 行号教训 + 禁止直 import `@lezer/*`）。
- [ ] T0.2 读 `src/features/runner/syntax/parsers.ts`（`parserFor` 约束）。
- [ ] T0.3 读 `src/features/lsp/hooks/lspDiagnosticsProjection.ts`（`StateField`(base) + reconciler，D4 参照）。
- [ ] T0.4 读 `src/features/editor/translation/*` 全量（`TranslationTurn` / `batches` / `prompt` / `store`）。
- [ ] T0.5 读 `src/AGENTS.md` + `quality-guidelines.md` 禁止模式 10（配置纯净）。
- [ ] T0.6 读 `frontend-testing.md` §9/§11（假绿陷阱 + 夹具判别力），本任务护栏用例照此自检。
- [ ] T0.7 `pnpm check:quick` 确认基线绿。

**门禁**：不写代码。U1/U2/U3 已定；D7-Go / D8-Docstring / D9-Args 三条遗留也已定案
（`design.md` §7）—— 实现时直接按定案做，不再重新讨论。

## 阶段 1：语法数据表（`commentSyntax.ts`）

- [ ] T1.1 Red：`commentSyntax.test.ts`
  - `detectFamily`：`.ts/.tsx`→ts、`.rs`→rust、`.go`→go、`.java`→java、`.py`→python、
    `.css/.scss`→css、`.yaml/.yml/.sh`→stream、未知→null
  - `commentNodeNames(family)`：python → `['Comment']`；stream → `['comment']`；
    其余 → `['LineComment','BlockComment']`
  - **参数化（AC1）**：逐 family 用真实 parser 解析 fixture，断言至少一个候选名命中
  - `docstringPath(family)`：python 声明 `ExpressionStatement > String`；其余 null
  - `markerOf` / `linePrefixOf`：`//` `///` `//!` `#` `/**` `*` `"""` / `'''`
- [ ] T1.2 Green：实现数据表 + 查询函数。**表是唯一事实源**，无 `if (lang === ...)`。
- [ ] T1.3 Refactor：用假 language fixture 验证「新增语言只需加一行」。

**验收**：AC1。回滚：新增文件，无消费点。

## 阶段 2：提取（`extractComments.ts`）

- [ ] T2.1 Red：`extractComments.test.ts`
  - 七语言 fixture：节点数、`from/to`、`bodyFrom/bodyTo`（剥标记）、`isBlock`、`linePrefix`
  - 尾随注释（`const a = 1; // x`）→ `isTrailing = true`
  - 字符串里的 `//` **不产生**节点（AST 保证，作为回归护栏）
  - 不完整树（截断源码）不抛错
- [ ] T2.2 Red：**docstring 提取（U3，AC3）**
  - Python 模块级 docstring → 命中，`kind = docstring`
  - 类 docstring（`class X:` body 首语句）→ 命中
  - 函数 docstring → 命中
  - `x = "not a docstring"` → **不**命中（`AssignStatement` 路径）
  - 非首语句的裸字符串 → 不命中
  - `'''` 与 `"""` 两种引号都可
  - **缩进捕获（D8 前置）**：记录 docstring 的缩进列与内容起始列
- [ ] T2.3 Green：实现节点提取 + docstring 提取（两条路径合流为统一 `RawUnit`）。
- [ ] T2.4 覆盖率 100%。

**验收**：AC3。

## 阶段 3：逻辑块分组（`groupComments.ts`，U2 前置）

- [ ] T3.1 Red：`groupComments.test.ts`（判据已实测）
  - 相邻行（`nextStartLine === prevEndLine + 1`）→ 同组
  - **空行断开** → 两组
  - **代码行断开** → 两组
  - 缩进续行（`//   code sample`）→ **不**断开
  - 块注释（`/* */`）自成一组
  - 尾随注释自成一组
  - docstring 自成一组
  - 组携带：起止行、逐行原文、逐行前缀、缩进
- [ ] T3.2 Green：实现分组（单次线性扫描；节点已按 from 升序）。
- [ ] T3.3 覆盖率 100%。

**验收**：AC2。**这是 U2 能否成立的关键一层**。

## 阶段 4：块内分段与分类（`segmentBlock.ts` / `classifyBlock.ts`）—— 核心

### 4a 组级分类（门禁）

- [ ] T4.1 Red：`classifyBlock.test.ts`
  - `shebang`：`#!` 首行命中；python 普通 `#` 不命中
  - `directive`：`eslint-disable-next-line`、`@ts-expect-error`、`# type: ignore`、`noqa`、
    `//go:build linux`、`// +build`、`prettier-ignore`、`cargo:`、`#pragma` 全命中
  - `license`：文件头 5 行内 `Copyright` / `SPDX-License-Identifier` 命中；
    **文件中部的同样文本不命中**（位置语义）
  - `doc`：TS `/** */`、Rust `///`/`//!`、Java `/** */`、Python docstring、Go 紧邻 `//` 块
  - **Go 双条件（AC3a / D7-Go）**：
    - `// doc\nfunc A()` → doc
    - `// doc\n\nfunc A()` → doc（1 空行）
    - `// doc\n\n\nfunc A()` → **prose**（≥2 空行）
    - `// doc` 后无声明 → prose
    - `// doc\nvar x = 1` → doc（`VarDecl` 也算声明）
    - **回退验证**：临时去掉条件②（行距）→ ≥2 空行用例必须变红
  - `prose`：兜底
- [ ] T4.2 Green：实现组级分类。

### 4b 块内分段（U2 核心）

- [ ] T4.3 Red：`segmentBlock.test.ts` —— **本任务最关键的一组用例**
  - **混排（AC5）**：`// Replace:\n//   const x = f(a);\n// with cache.`
    → `[prose, code, prose]`，**code 段不进翻译队列**
  - **围栏（AC6）**：```` // ```ts\n// cache.set(k,v);\n// ``` ````
    → `[fence]`（含 3 行，整块原样）
  - **示例块（AC7）**：`// Usage:` 后跟缩进 ≥4 的行 → 引导行 prose，后续缩进行 code
  - 死代码整块（AC4）：`// if (cache.has(a)) { return a; }` → `[code]`
  - **散文不误判**（防误杀）：`// the method returns the id` → `[prose]`；
    `// Note: use cache for speed.` → `[prose]`（不是 code）
  - 空行 → `[blank]`（参与重建，不作为独立翻译单元）
  - doc tag 行：`@param sessionId the id` → `[tag]`；`:param x: desc` → `[tag]`；`Args:` → `[tag]`
  - **结构块整块（AC3b / D9-Args）**：`Args:` 开头到下一个非字段行之间的字段行**归同一个
    翻译单元**（不逐字段拆），字段名集合可被后续校验抽取
  - **空说明字段不送翻**：`Args:` 下只有 `n:`（无说明）→ 该行 tag 但不进队列
  - 行内代码跨度 `\`cacheKey\`` 在 prose 段内 → 仍是 prose（跨度由校验保护，不切段）
- [ ] T4.4 Green：实现分段 + 每段判 kind。
- [ ] T4.5 **误判方向自检（D2）**：写两条「该判 code 的必须 code」与两条「该判 prose 的必须 prose」
      用例，并在提交前把判定阈值调窄/调宽各跑一次，确认这两组分别变红（防止阈值调节是死代码）。
- [ ] T4.6 覆盖率 100%。

**验收**：AC4、AC5、AC6、AC7、AC10、AC11。

## 阶段 5：地址 / 校验 / 重建（纯函数收尾）

- [ ] T5.1 Red：`commentAddress.test.ts`
  - 归一化（剥标记、折叠空白、**保留大小写与行内代码**）→ 稳定地址
  - 幂等；大小写差异 → 不同地址
  - **身份落在 segment（AC12/D3）**：块中间插入一行，其余 segment 地址不变
- [ ] T5.2 Red：`verifyComment.test.ts`
  - `preservesPlaceholders`：`{0}`/`%s`/`${x}`/`{name}`/`%1$s`/`{{v}}` 逐种缺失即失败
  - `preservesDocTags`：`@param sessionId 说明` → 译文须含 `@param` 与 `sessionId`（AC5 补充）
  - `preservesCodeSpans`：`` `x` `` 内容多重集相等
  - `preservesUrls`
  - **`rejectsCodeEcho`（AC9）**：译文里出现 fence 内容 或 code 段原文 → 判失败
  - **`preservesArgsFieldNames`（AC3b / D9-Args）**：`Args:` 块内的字段名集合
    （如 `{n, count}`）逐名比对；缺 `n` → 失败且 reason 含 `n`
  - `notEmptyOrRefusal` / `plausibleLength`
  - 规则抛异常 → `{ok:false, reason:/rule threw/}`
  - 注入自定义规则生效（开闭性）
- [ ] T5.3 Red：`rebuildBlock.test.ts`
  - 行注释块：逐行按 `//`/`///`/`#` 前缀补齐
  - 块注释：多行按 ` * ` 前缀补齐
  - **docstring 缩进（AC3c / D8-Docstring）**：
    - `indent=4` 多行译文 → 首行缩进 4，后续行对齐到内容列
    - 译文单行 → 保持单行（`"""text"""`）
    - 原文 closing `"""` 独占一行 → 译文也独占一行且同缩进
    - `'''` 引号风格原样保留
    - **回退验证**：把「首行锚定」改为「逐行照搬原文缩进」→ 行数不等的用例必须变红
  - 混排块的 code 段用**原文行**参与重建（不掺译文）
  - 尾随注释单行重建
- [ ] T5.4 Green：实现三模块。覆盖率 100%。

**验收**：AC8、AC9、AC12（单文件侧）。

## 阶段 6：缓存与引擎（复用上一版设计）

- [ ] T6.1 `translation/cache.ts` + 测试：键含 `profileVersion|targetLanguage|address`；
      损坏重置；碰撞退化 miss；LRU 淘汰。
- [ ] T6.2 `translation/engine.ts` + 测试（fake turn）覆盖 8 条路径：
      全命中 / 全 miss / **跨文件去重（AC13）** / 段缺失 / 校验失败 / 重试成功 / 单批抛错 / abort。
- [ ] T6.3 混排回归：一块内 3 段 prose + 2 段 code → 只 3 段进请求，code 段原样出现在结果里。

## 阶段 7：编辑器呈现（`commentDecorations.ts`）

> 风险最高（CodeMirror 扩展身份陷阱）。建议**先落地 `off` 模式**验证扩展注册不影响现有 lint 波浪线，
> 这是最省事的回归判据。

- [ ] T7.1 Red：`commentTranslations.test.ts`（`EditorState` + transaction，无需 DOM）
  - `setCommentTranslations` effect 更新后 `StateField` 值变化
  - **AC16**：推送译文产生的 transaction 中 `tr.effects` **不含** `StateEffect.reconfigure`
  - 模块级 `StateField` 身份稳定（两次 import 同一 field）
- [ ] T7.2 Red：`buildCommentDecorations.test.ts`（纯函数）
  - `below`：每组后 block widget
  - `inline`：组末行尾 inline widget
  - `hover`：无 widget，安装 hover 源
  - `off`：空集
  - **AC14**：只给 `ranges` 内的组建 widget（100 组 + 窄 range → widget 数 = 命中数）
  - **code/fence 段在装饰里原样呈现**（R6.4）
- [ ] T7.3 Green：实现 `StateField` + `StateEffect` + reconciler（`visibleRanges`/doc 变化重算）。
- [ ] T7.4 接线 `useEditorExtensions`：field + reconciler 进 **base**（**不进 `extensions` 依赖数组**）。

**验收**：AC14、AC15、AC16。

## 阶段 8：控制器与 UI

- [ ] T8.1 `useCommentTranslation.ts`：提取→分组→分段→分类→引擎→推 effect；
      返回 `{ running, total, done, skipped, failed, mode, setMode, start, stop, retryGroup }`。
- [ ] T8.2 工具栏入口：「翻译注释」+ 显示模式切换 + 跳过统计（按原型）。
- [ ] T8.3 失败组 reason chip + 单组重试。
- [ ] T8.4 组件测试：模式切换、跳过数展示、停止保留成果。

**验收**：AC18 对齐。

## 阶段 9：设置项

- [ ] T9.1 `AppConfig.translation` 增 `commentMode?: 'below'|'inline'|'hover'|'off'`、
      `commentAutoWarm?: boolean`。
- [ ] T9.2 `appConfigNormalize.ts` 同步校验；设置面板加控件；补 normalize 测试。

## 阶段 10：收尾

- [ ] T10.1 `pnpm check:quick` 每轮 → 收尾一次 `pnpm check`。
- [ ] T10.2 覆盖率：纯函数 100%（`commentSyntax`/`extractComments`/`groupComments`/`segmentBlock`/
      `classifyBlock`/`commentAddress`/`verifyComment`/`rebuildBlock`）。
- [ ] T10.3 **回退验证（frontend-testing.md §9/§11）**：把 segmentBlock 的 code 判定与
      groupComments 的邻接判据各回退一次，确认 AC2/AC5 变红。
- [ ] T10.4 更新 spec：`.trellis/spec/frontend/` 增「注释翻译：三层抽象 + 代码不翻 + 分类门禁」
      一节，记录：节点名方言表、连续行注释是 N 个节点、docstring 判别路径、D2 不对称原则。
- [ ] T10.5 `add_session.py`；不主动提交。

## 验证命令

```bash
# 纯函数层（无需 DOM，最快反馈）
pnpm test:fe -- --run src/features/editor/comment
pnpm type-check
pnpm check:quick                                  # 开发循环（~15-20s）
pnpm check                                        # 收尾一次
```

## 红线自检清单

- [ ] 红线 5：未新增事件名，复用 `TRANSLATION_EVENT`
- [ ] 红线 4：译文按批走事件流，无整份译文 JSON 返回
- [ ] 红线 12：文件身份走 `FileRef`，无字符串拼接
- [ ] 前端导入防火墙：`comment/*.ts` 纯层零 `invoke`、零 store 导入
- [ ] 配置纯净（禁止模式 10）：译文不进 `extensions` 依赖，走 `StateField`
- [ ] 无 `@lezer/*` 直接 import（走 `runner/syntax/lezer.ts` 类型派生）
- [ ] 语言分派不新增第二份扩展名映射
- [ ] **U2 铁律**：`code` / `fence` 段不出现在任何 prompt 里（用测试断言 prompt 内容）
- [ ] 不写盘：无任何 `saveFile`/文件写入路径（AC15）
- [ ] 红线 11：无换行相关字节处理

## 回滚点

| 阶段 | 回滚方式 | 影响面 |
| --- | --- | --- |
| T1–T6 | 删新增文件 | 零 |
| T7 | 移除 field/reconciler 注册 | 编辑器行为回到现状 |
| T8 | 隐藏按钮 | 功能不可见 |
| T9 | 删配置字段 | 读取 tolerant，无迁移 |

## 交付顺序建议

T1→T2→T3→T4 是**纯函数四段**，必须串行验收（T4 的分段语义依赖 T3 的分组边界）。
T4b 是本任务成败关键 —— 建议单独一次 review，重点看「混排用例」与「误判方向自检」两组。

T7 单独一个 PR，先落 `off` 模式，验证不影响现有 lint 波浪线后再开 `below`。
