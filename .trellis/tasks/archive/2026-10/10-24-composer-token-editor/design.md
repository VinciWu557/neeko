# 设计：composer 富文本 token 化（Tiptap）

> 前置：`prd.md`（R1-R6 + 8 条 AC）与 `research/editor-selection.md`（选型证据）。
> 本文只写结构与取舍。

## 1. 选型决策（引 research 结论）

**Tiptap 3.x**（`@tiptap/core` + `@tiptap/react` + `@tiptap/extension-mention` +
`@tiptap/suggestion`）。决定性理由：唯一 mention+suggestion 双内建；`renderText`
直接对接 `/name @path` 序列化契约；`deleteTriggerWithBackspace` 即「退格整块删」；
suggestion 的 `plugin/async.ts`（Promise items + debounce + AbortController）正好接
Tauri IPC 异步命令源；ProseMirror「DOM 变更解析回模型」让 10-21 的镜像中间层整体
**删除**而非叠加。Lexical 被受控数据流否决（无 controlled plugin，`setEditorState`
语义 2026-09 还在修，而草稿按 tab 恢复是硬需求）；Slate 被手写补全层否决。

**依赖现状**：`prosemirror|lexical|slate` 三系全仓零命中，无重复引入。

## 2. Schema 设计：窄 schema 是 IME 安全的前提

文档只允许两种内容：**纯文本段落** + **两种 chip（inline atom node）**。不引入
加粗/标题/代码块——schema 越窄，组合期解析面越小（prd Non-Goals）。

```
Doc
└─ Paragraph+
   ├─ Text
   ├─ CommandChip { kind:'slash', name, source, icon? }    # inline atom
   └─ FileChip    { kind:'mention', path, name }           # inline atom
```

**两个 chip 都用 `Mention` 扩展配置两份实例**（`renderText` 不同），不自研 node：

| chip | renderText（序列化） | 建议 label | 属性 |
| --- | --- | --- | --- |
| CommandChip | `/` + name + 空格 | `/name` | `name` `source` |
| FileChip | `@` + path + 空格 | `@name`（sublabel 路径） | `path` `name` |

序列化是**纯函数** `docToPromptText(editor.getJSON())`（不依赖编辑器实例，可密集单测
+ golden 锁死）——不用 `getText()` 裸串，因为 renderText 的空格语义要和「附件已添加」
的状态解耦（文件 chip 序列化但 attachments 缺失时是否仍发 `@path`？**是**：文本提及
与附件是两层效果，与 10-21 AC5 一致）。

## 3. 触发与弹层：Suggestion 接旧数据源，弹层 UI 复用

```
Tiptap Suggestion(char:'/', ...)  ──items──>  createCommandSource (paletteSources)
Tiptap Suggestion(char:'@', ...)  ──items──>  createMentionSource
弹层渲染：Suggestion 的 render() 钩子挂载现有 <ComposerPalette>（props 微调）
```

- **数据源零重写**：`useComposerSources`（能力位门控、agentId 缓存、文件树预取）原样
  保留；`items(query)` 对接 suggestion 的异步接口（它内置 minQueryLength/abort，我们
  的 `filterBySubstring` 在 source 内部继续用）
- **键盘导航**由 suggestion 引擎接管（↑↓/Enter/Tab/Esc）——`handleKeyDown → boolean`
  的显式契约被 ProseMirror 的插件优先级取代；AC7 等价行为必须有集成测试钉住
- **能力位门控**：slash 源未挂载时**不注册** `/` suggestion 扩展（连查询都不发，同 R2）
- `paletteTrigger.ts` 的 `findTrigger/applySelection/triggerStartAt` 删除（触发逻辑移交
  suggestion；tokenize 高亮随之删除）——「触发判据唯一语法点」约束转移到
  suggestion 配置单点

## 4. 受控往返与死循环防护（最大架构风险）

Tiptap 是非受控编辑器。草稿按 tab 存 tab data（`editorStore.mergeTabData` 穷举白名单，
§17）：

```
mount/切tab ──> tab data 有草稿? ──setContent(getJSON) 一次
onUpdate    ──> mergeTabData({ draft: editor.getJSON() })   # 只出不进
```

**单向闸门**：`setContent` 只发生在「编辑器实例创建后恢复该 tab 草稿」这一次 +
tab 身份切换；`onUpdate` 的 store 写回**永不**触发 setContent。恢复用 `getJSON()`
而非纯文本（chip 属性 id/path 在纯文本里不可逆）。store 里草稿是 JSON doc，**纯文本
镜像不再单独存**——`onSend` 时序列化（§2 纯函数）。

**mergeTabData 登记**（§17 同 diff 强制）：`AgentChatTabData` 加 `composerDoc` 字段
+ `editorStore.test.ts` 真 store 写入读回用例。旧 `input: string` 字段的迁移：见 §7。

## 5. 键盘与 IME

- Enter 发送 / Shift+Enter 换行：`editorProps.handleKeyDown` —— 弹层打开时
  suggestion 引擎先消费（插件优先级高于 editorProps 的 Enter 分支）；发送分支判断
  `editor.isEmpty`（空内容禁发，替换现 `input.trim().length === 0`）
- IME：ProseMirror 原生组合处理；10-21 的「组合期 Enter 不发送」守卫迁到
  `handleKeyDown` 里读 `event.isComposing`（ProseMirror 事务带 composition 元数据，
  但 keydown 层面仍以 isComposing 为准）
- 自动增高：editor DOM 高度监听（`ResizeObserver` 或 onUpdate 后量 scrollHeight），
  max-height 与 overflow 同现状；滚动场景由 ProseMirror 自己的 scroll handling 接管

## 6. 落点与删除清单

```
新增  composer/editorSchema.ts        # Chip 双实例配置 + docToPromptText 纯函数
新增  composer/RichComposer.tsx        # Tiptap 编辑器 + suggestion 接线（<300 行）
新增  composer/ChipView.tsx            # ReactNodeViewRenderer：图标+标签+配色 pill
复用  paletteSources.ts / ComposerPalette.tsx / useComposerSources / useAgentCommands
保留  AttachFilePicker / 附件 chips / 能力位链路（后端零改动）
删除  ComposerMirror.tsx / paletteHighlight.ts(+test) / paletteTrigger.ts(+test)
删除  .composer-mirror / .composer-token* CSS；mirror 相关测试断言
改造  ChatComposer.tsx                 # textarea → <RichComposer>，props 契约不变
```

**后端零改动**——这是与 10-21 的关键分界：`list_agent_commands` / 能力位 / 契约测试
全部原样。

## 7. 迁移与回滚

- **旧草稿兼容**：tab data 里已存的 `input: string` 恢复时作为纯文本 `setContent`；
  新草稿写 `composerDoc`。`input` 字段保留读取一个版本后清理（不做双向同步——两份
  表示必然漂移，禁止）
- **回滚点**：`ChatComposer` props 契约不变意味着 `git revert` 即可整体回到 textarea
  实现；不做运行时开关（YAGNI——一次性的迁移，不是长期双轨）
- **分支**：等 10-21 真机复测 + 提交合入后，从 main 开新分支（implement 阶段 0 检查）

## 8. 测试策略

| 层 | 做法 |
| --- | --- |
| 序列化（纯函数） | `docToPromptText` golden：chip/文本混排、chip 相邻、chip 后无空格补空格、空文档 |
| mergeTabData | 真 store 写入读回（§17 判据，不得 mock store） |
| 弹层集成 | `/` 触发→弹层→Enter 选中→chip 入文（suggestion mock 数据源）；Enter 不发送（AC7 等价） |
| 键盘 | handleKeyDown：Enter 发送 / Shift+Enter 换行 / isComposing 跳过 |
| 受控回环 | onUpdate 写 store 后**不再** setContent（断言 setContent 调用次数 = 1） |
| 删除护栏 | grep 断言镜像层符号零残留（`RETIRED_FRONTEND` 式反向护栏） |
| 真机 | AC6 IME 矩阵（macOS + Windows：组合输入/方向键/候选删除）、AC2 pi 展开 |

**变异验证清单**：序列化丢空格 → golden 红；`setContent` 进 onUpdate 依赖 → 回环
用例红（调用次数 >1）；mergeTabData 漏登记 → 真 store 用例红。

## 9. 不做的事

- 运行时双轨开关（回滚靠 git revert）
- 子 agent 数据源（schema 属性预留 `kind` 判别即可）
- 富文本格式（加粗/标题/代码块）
- 旧 `input` 字段的双向同步（两份表示必然漂移）

## 10. 交付记录（2026-10-26 归档）

### 10.1 落地提交

四个原子提交，全部快进合并入 `main`（`Session 338` 记录，`--ff-only`）：

| Hash | 内容 |
| --- | --- |
| `4f163ddd` | 后端 opencode `list_commands` + `commands` 能力位（`/api/command`，两版共享层） |
| `461d2e24` | 前端 Tiptap 替换镜像层（含删除 `ComposerMirror` / `paletteHighlight` / `paletteTrigger`） |
| `c67239d0` | 接线 + palette 分组 + 附件改为文档投影 + 缓存键带 directory |
| `c5a4cce4` | spec 两篇（`interaction-patterns` §composer chip / `agent-chat-transports` §9.4b） |

`feat/composer-token-editor` 分支已在 `Session 339` 的清理中删除（相对 main 未合并提交数 = 0），
故 `task.json.branch` 已由该分支名改为 `main`。

### 10.2 计划外的三处扩张（实现时发现必需）

1. **R3b 附件单一表示**：原计划保留 `.wa-at` 附件 chips 区，实现时发现「退格删 chip 后
   附件仍随消息发送」是真实缺陷（两份表示必然漂移）。改为 `docToRequestFiles(doc)` 投影，
   `useChatAttachments` 只剩 skill 槽。
2. **R3c 弹层分组与分词搜索**：分组渲染 + 按空格分词匹配 + 高亮行 `scrollIntoView`。
   原 PRD 只要求「与 10-21 等价」，实测 10-21 的整串子串匹配在混合数据源下不可用。
3. **opencode 命令端点**（`4f163ddd`）：任务本应「后端零改动」，但 opencode 走 serve
   传输时 `commands: false` 导致 `/` 完全无反应。查明 `/api/command` 是 `/api/*`
   共享层（1.x 与 2.x 共存），补了后端发现逻辑与有界重试（8×250ms，命令异步发现
   实测 0→2→5 条）。

### 10.3 自查发现的假绿（三轮，记录以避免重复）

| 轮次 | 问题 | 修法 |
| --- | --- | --- |
| 1 | `'/'` 与 `'@'` 硬编码 7 处，`char` 兼任三义 | 收敛为 `chipSpec.ts` 单一事实源 |
| 2 | `attrsOf` 产出未声明的 `label` 属性（ProseMirror 丢弃）⇒ 所有 `?? label` 兜底永不可达 | 只产声明过的键；加双向契约测试 |
| 3 | 测试辅助 `typeText` 漏 `emitUpdate: true` ⇒ 多个用例假绿 | 修正辅助函数 |

### 10.4 真机验证（用户手工确认，2026-10-26）

自动化门禁覆盖代码路径，以下四项覆盖真实渲染与真实后端行为，本环境无法自动化：

- **AC2**：`/trellis-start` chip 发送后 pi 真的展开该命令
- **AC6**：CJK IME —— macOS 与 Windows 双平台（组合输入可见、上屏正确、
  组合期方向键无乱码、退格删 chip 不残留触发符）
- chip 视觉：深浅两套主题下的对比度、长路径 chip 的省略号截断
- 附件链路：`@` 选中文件后 chip 出现、发送后清空

**全部通过。** AC6 在 PRD「关键风险」表里排第一（删镜像层后 WKWebView 组合期行为需重验），
该风险现已被双平台实测关闭。

### 10.5 门禁

- `vitest run`：647 文件 / **6014 用例**全绿
- `cargo test --lib`：2241 passed（本任务后端的 opencode 部分）
- 组件行数 ratchet：最大 208 行（`editorSchema.ts`）< 300
- 包体积：主 chunk gzip 1033.61 kB（Tiptap 约 +46 kB，与选型预估一致）

### 10.6 与后续任务的关系

`10-21-mention-slash-palette` 仍在 `in_progress`，其镜像高亮层已被本任务整体替换删除。
**该任务的真机项已无验证对象** —— 应视为被本任务取代，而非「未完成」。后续处理
10-21 时以其 PRD 的哪些 AC 仍适用为准，不要再验镜像层对齐。
