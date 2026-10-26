# Composer 富文本编辑器选型：Tiptap vs Lexical vs Slate

> 任务：`.trellis/tasks/10-24-composer-token-editor` · 调研日期：2026-10-24
> 场景：Agent Chat composer 从 textarea+镜像高亮迁移到 contenteditable 富文本，slash/@ 提及 chip 化，
> WKWebView（macOS 主战场）+ Windows/Linux，CJK IME 一等风险，发送序列化为 `/name @path` 纯文本。
> 所有外链证据均在 2026-10-24 实际抓取核对（官方文档页、GitHub 源码/issue，非二手转述）。

## 结论（推荐：Tiptap 3.x）

**明确推荐 Tiptap（ProseMirror 系）**，理由按权重：

1. **唯一自带「mention 扩展 + 生产级 suggestion 引擎」组合的候选。** `@tiptap/extension-mention`
   是一等 inline atom node：自带 `renderText`（序列化回 `@label`，正是我们的 `/name @path` 协议出口）与
   `deleteTriggerWithBackspace`（退格整块删 chip，即 PRD 的核心交互）。独立包 `@tiptap/suggestion`
   的 v3 源码里有专门的 `plugin/async.ts`：`items()` 支持异步 Promise、内置 debounce、
   AbortController 中止、`minQueryLength`、`initialItems` —— 与我们「命令列表来自 Tauri IPC 异步查询
   （实测 157 条）」的数据形态**严丝合缝**，现有 `paletteSources` 工厂可直接作为 `items` 的数据源，
   现有 `ComposerPalette` 组件可通过 suggestion 的自定义 `render` 继续作为弹层 UI（数据源与 UI 双复用）。
2. **IME 架构与我们的问题同构。** ProseMirror-view 的输入处理是「DOM 变更 → 解析回文档模型」
   （`domchange.ts` 首部注释与 `parseBetween` 可证），组合期由 DOM observer 主导、事务标注
   `"composition"` 元数据（prosemirror.net/docs/ref 可证）。我们刚在 textarea 镜像架构上踩过的
   WebKit 组合期腐坏，换成 Tiptap 后镜像层整个消失，组合期真实性由 ProseMirror 的 DOM 直接观察保证 ——
   迁移是在**删掉**一层易腐的中间层，而不是新增一层。
3. **体积最小、依赖面最干净。** 见下方证据表：core+react+mention 合计 gzip ≈ 46.1 KB（0 运行时依赖于
   core，`@tiptap/core` deps=0）。Lexical core 就 61.5 KB gzip 且 mention/typeahead 要自己从 playground
   搬代码；Slate 双包合计 ≈ 56.3 KB 还要手写整套补全。

**不推荐 Lexical** 的决定性原因：受控数据流最弱 —— 没有官方 controlled plugin（repo 全文检索仅
2021 年 PR #489 尝试过），`setEditorState` 是带运行时警告的逃生舱（官方文档 PR #9189/#9228，2026-09
还在修它的语义），而「草稿按 tab 持久化、切 tab 恢复」恰是我们的硬需求。mention node 也非产品内建，
需从 playground 拷贝。**不推荐 Slate**：官方 mentions 示例 765 行纯手写弹层/键盘导航/过滤
（`site/examples/ts/mentions.tsx`），等于重写我们刚写完的 palette 层，且 IME 历史包袱最重
（issue #2062 222 条评论）。

## 现有依赖核查

`package.json` 与 `pnpm-lock.yaml` 全文 grep `prosemirror|lexical|slate`：**零命中**。三选一都不构成
重复引入，也没有版本冲突包袱。React 为 ^18.2.0，三个候选的 react 绑定均兼容。

## 分维度对比

1. **Mention/chip 与 suggestion**：Tiptap 双内建（见上）；Lexical 有 `LexicalTypeaheadMenuPlugin`
   （官方文档含触发符+过滤+键盘导航+Portal 弹层），但 MentionNode 在
   `packages/lexical-playground/src/nodes/MentionNode.ts`（示意代码，需拷贝改造，当前继承 TextNode）；
   Slate 无任何内建，官方示例手写。
2. **CJK IME / WebKit**：三家都有未解 Safari/WebKit issue（证据表）。架构差异：ProseMirror =
   DOM observer 解析回模型；Lexical = 自建 reconciler 全量对账（官方 intro 明言「DOM reconciler
   keeps DOM/selection/quirks in sync」）。注意 Lexical #8507（2026-05 已修）正是「token-mode
   TextNode 后紧跟组合输入丢数据」——与我们 chip 场景同类，说明 Lexical 社区在这类问题上活跃止血，
   但也说明 reconciler 对 token 节点 + IME 的组合仍在打补丁。ProseMirror 的 Safari CJK issue
   （#971/#934）悬置自 2019 未动，属「标记样式 + 组合」边缘场景，纯文本 composer 不在其内。
3. **受控/React 18**：Slate 天生受控（`<Slate value onChange>`，示例 102 行可证），最优；Tiptap
   非受控 prop，`onUpdate` → tab store、恢复走 `setContent()`（官方 Persistence 文档），需防回环，
   中等；Lexical 最弱（见结论）。
4. **体积**：Tiptap 46.1 KB gzip（core 35.9 + react 8.6 + mention 1.6）；Lexical core 61.5 KB +
   react 各模块（bundlephobia 无法整体构建 @lexical/react，多入口包）；Slate 56.3 KB（31.3+25.0）。
   本仓已有 xterm 重依赖，46 KB 增量可接受。
5. **退出成本 / 序列化**：Tiptap `editor.getText()` + mention `renderText` 自定义输出 →
   `/name @path` 纯文本；`getJSON()` 可作 tab 草稿的持久化格式（含 chip 属性 id/label/path）。
   Enter 发送走 `editorProps.handleKeyDown`，与现有「弹层优先、`isComposing` 兜底」的键盘契约
   对接点清晰。附件 chips 在 textarea 外，不受影响。

## 证据表

| # | 证据 | 链接 | 日期/状态 |
| --- | --- | --- | --- |
| E1 | Tiptap Mention 扩展官方文档 | https://tiptap.dev/docs/editor/extensions/nodes/mention | 抓取于 2026-10-24 |
| E2 | Tiptap Suggestion utility 官方文档 | https://tiptap.dev/docs/editor/api/utilities/suggestion | 同上 |
| E3 | suggestion 异步管理器源码：debounce/AbortController/minQueryLength/initialItems | https://github.com/ueberdosis/tiptap/blob/main/packages/suggestion/src/plugin/async.ts | main@2026-10 |
| E4 | mention 源码：`renderText` 序列化 + `deleteTriggerWithBackspace: false` 默认值 | https://github.com/ueberdosis/tiptap/blob/main/packages/extension-mention/src/mention.ts | 同上 |
| E5 | ProseMirror-view DOM 解析回模型架构（文件头注释 + `parseBetween`） | https://github.com/ProseMirror/prosemirror-view/blob/master/src/domchange.ts | master@2026-10 |
| E6 | 事务组合元数据（`"composition"` property） | https://prosemirror.net/docs/ref/ | 抓取于 2026-10-24 |
| E7 | PM issue：Safari CJK IME 样式错乱 | https://github.com/ProseMirror/prosemirror/issues/971 | 2019-09-06, open |
| E8 | PM issue：Safari 组合期空节点被删 | https://github.com/ProseMirror/prosemirror/issues/934 | 2019-06-06, open |
| E9 | PM issue：Chrome 中文 IME 退格产生 BR | https://github.com/ProseMirror/prosemirror/issues/1564 | 2026-03-03, open |
| E10 | Lexical 官方 intro：DOM reconciler 架构 + 明言适用「plain-text inputs with mentions」 | https://lexical.dev/docs/intro | 抓取于 2026-10-24 |
| E11 | Lexical TypeaheadMenuPlugin 官方文档（触发符+过滤+键盘导航） | https://lexical.dev/docs/react/plugins | 同上 |
| E12 | Lexical MentionNode 位于 playground（需拷贝） | https://github.com/facebook/lexical/tree/main/packages/lexical-playground/src/nodes | main@2026-10 |
| E13 | Lexical issue：Safari 文本不更新（回归悬置） | https://github.com/facebook/lexical/issues/3460 | 2022-11-30, open, 16 评论 |
| E14 | Lexical issue：JP IME 组合紧跟 token-mode TextNode 丢数据 | https://github.com/facebook/lexical/issues/8507 | 2026-05-13, closed |
| E15 | Lexical PR：完成被取消的桌面 WebKit composition | https://github.com/facebook/lexical/pull/9362 | 2026-10-17, merged |
| E16 | Lexical 受控输入仅有 2021 年 PR 尝试 | https://github.com/facebook/lexical/pull/489 | 2021-07-16 |
| E17 | Lexical `setEditorState` 语义仍在修复 | https://github.com/facebook/lexical/pull/9228 | 2026-09-24 |
| E18 | Slate 官方 mentions 示例 765 行手写弹层（无内建 suggestion） | https://github.com/ianstormtaylor/slate/blob/main/site/examples/ts/mentions.tsx | main@2026-10 |
| E19 | Slate issue：IME/软键盘编辑历史包袱（222 评论） | https://github.com/ianstormtaylor/slate/issues/2062 | 2018-08, closed via PR #4988 (2022) |
| E20 | 体积（bundlephobia API）：@tiptap/core 3.32.0 = 35.9 KB gzip；@tiptap/react = 8.6；@tiptap/extension-mention = 1.6；lexical 0.52.0 = 61.5；slate 0.146.0 = 31.3；slate-react 0.147.3 = 25.0 | https://bundlephobia.com | 抓取于 2026-10-24 |
| E21 | 本仓无三系依赖（package.json / pnpm-lock.yaml grep 零命中） | 本仓文件 | 2026-10-24 |

## 迁移风险清单

- **R1 IME 回归矩阵重跑**：删镜像层后必须在 WKWebView（macOS）+ Windows 上重跑 CJK 组合期用例
  （拼音中途弹层不触发、组合期 Enter 不发送、退格重组）。现有 `compositionProps`/`composing`
  逻辑迁到 `handleKeyDown` + ProseMirror 原生 composition 处理。
- **R2 受控回环**：`onUpdate` 写 tab store，恢复时 `setContent` 需防「update→store→再 setContent」
  死循环（对比当前 textarea 受控 value 的简单模型，这是行为语义的真实变化）。
- **R3 空内容判定**：`input.trim().length === 0` 改为 `editor.isEmpty`（或 getJSON 节点遍历）；
  send 按钮 disable 与 ratchet/行数增长改从 DOM/编辑器视图取。
- **R4 测试重写面**：`ComposerMirror`、`paletteHighlight` 整体删除；`paletteTrigger` 纯函数层与
  单测保留（findTrigger/applySelection 语义映射到 suggestion 的 `findSuggestionMatch` 配置）；
  `ChatComposer` 组件测试需以编辑器实例 mock 重写。
- **R5 序列化契约**：`/name @path` 的回归测试必须锁定 `renderText` 输出格式（含触发符与尾随空格），
  防 pi rpc 语义漂移（PRD 约束）。
- **R6 纯文本粘贴**：粘贴 `@foo` 文本默认不自动 chip 化（mention 仅从 HTML paste 解析）——接受此
  行为并在验收标准里写明，或后续单独加 paste 解析。
- **R7 体积与加载**：+46 KB gzip 进入首屏 composer 包；如需可动态 import 编辑器组件做代码分割。
- **R8 Windows/Linux 桌面差异**：Tiptap 生态对非 WebKit 引擎（Chromium/WebView2、Linux WebKitGTK）
  的覆盖依赖 ProseMirror 上游，E9（Chrome CJK）提示 Linux/Windows 上仍需独立冒烟。
