# pi-tui 原生能力对标（差距测绘 + 执行顺序）

> 归属：`10-18-dsh-tui` 的追加轮次（不另建子任务目录，与前 36 个 Step 同形）。
> 落点：`packages/dsh-neeko/src/tui/**`。门禁豁免不变（`prepublishOnly`）。
> 状态：测绘完成（Step 37）；P0 已实施（Step 38–39）；**S1–S4 全部完成（Step 40）**。
> P2/P3 的「自造组件替换」已通过 S2–S4 落地（见 §9）。

## 0. 需求（用户原话）

> 能否完全对标原生的 pi-tui，当前的 tui 很多功能和原生的 tui 差异很大，
> **不要出现问题改一遍又一遍**
>
> 一步一步进行分析，分析出差距缺什么，才有针对性的进行修改

第一条是目标，第二条是**约束**：约束比目标更重要。它把任务从「补功能」改成
「找出为什么会反复改」——否则补完还是一样会反复。

用户后续决策（本轮记录的两条）：

1. **「pi 是什么行为就跟着什么行为」** —— 对齐判据不是「更合理」，是「与 pi 一致」。
   分歧时 pi 的实现即规范，不做本地改良。
2. **P2/P3 延后** —— 先把形态层（P0/P1）做对，自造组件的替换单独一轮。
   理由见 §6。

## 1. 第一性原理：四条约束

### 1.1 只有一个物理输出通道，状态是双缓冲

一个终端 = 一个字节流 + 一个 cursor。任何 `render()` 都是在「上一帧 → 这一帧」求差集。
所以所有 UI 问题最终都归约为：**谁拥有 frame₁ 这份状态**。

pi-tui 已把它封成 `TuiBase.previousLines` / `TuiAltScreen.previousScreen`。
应用层唯一该做的是**把内容挂对树**，不该关心重绘。凡是 dsh-neeko 自己算 diff、
自己算宽度、自己猜父节点的代码，都在与这条物理约束对抗。

### 1.2 「差距」不是功能清单，而是**形态差异**

pi 的 TUI 拆到底层只有 5 种形态：

| 形态 | 本质 | pi 的载体 |
| --- | --- | --- |
| **Document** | 可滚动、可增长的追加流 | `ScrollView(documentContainer)` |
| **Dock** | 固定在底部、不滚动的行区 | `VStack` dock 条目 |
| **Overlay** | 浮在 Document 之上、抢焦点 | `ui.showOverlay(component, opts)` |
| **Keybinding** | 具名 action → key 列表 | `KeybindingsManager` |
| **Entry** | 一类 transcript 行 | 一个 `Component` 子类 |

dsh-neeko 有前两种；**后三种是自造的**：

- overlay 用「`inputSlot` 换 child」实现 → 只能有一个面板，且必须占据输入框位置
- 键位用散落的 `matchesKey(data, 'ctrl+x')` 硬编码 → 无法重绑、无法 `/hotkeys`、
  无法表达「面板优先」
- entry 用 `switch (row.kind)` 分支 → 加一种行要改渲染器

**这是「改一遍又一遍」的机械原因**：三种形态都没有形成开放集合，
每加一个面板/键位/行类型都要回到中心文件改分支。

### 1.3 数据流单向不变

```
DSH agent event ──[adapter]──> TranscriptRow (纯数据, 不可变)
                                      │
                              [按 kind 分派渲染]
                                      ↓
                              Component (pi-tui)
                                      │
                              [TuiBase 内部 diff]
                                      ↓
                                  terminal
```

链上**唯一允许有状态的是三个**：`TranscriptRow[]`（append-only）、
`fold`（全局布尔）、`selection/scroll`（pi-tui 拥有）。其它必须是纯的。
现状把状态散在 15 个文件里 —— 这是第二类「改一遍又一遍」的原因。

### 1.4 差距是「没接线」，不是「没实现」

逐个 API 探针实测（`node_modules/@earendil-works/pi-tui/dist`）：

| pi-tui 已提供 | dsh-neeko 使用 | 差距性质 |
| --- | --- | --- |
| `showOverlay` / `OverlayHandle` | **0 处** | 没接线 |
| `KeybindingsManager` + 28 个 `tui.*` action | **0 处** | 没接线 |
| `Editor` 的 kill-ring / yank / undo（40 处） | 间接（用了 `Editor`） | 已白得 |
| `TuiAltScreen` 的 search / selection / scrollbar / mouse | 部分（缺 search） | 半接线 |
| `assistant-message` 的 thinking 折叠 | 自写 | 重复实现 |
| `setTitle` / `setProgress` / `setProgramStatus` | **0 处** | 没接线 |
| `captureRenderState` / `switchTuiMode` | **0 处** | 没接线 |

**结论：优先级是「接线 > 重写」。** 任何「自己再实现一遍」都是负债。

## 2. 差距测绘（file:line）

### 2.1 A 类 —— 形态缺失（结构性，导致反复修改）

| # | 差距 | 证据 | 后果 |
| --- | --- | --- | --- |
| A1 | 无 overlay 形态 | `app.ts:823` `replaceInputSlot()` 是唯一面板机制；`showOverlay` 零使用 | 面板必须顶替编辑器；同时两个面板不可能；`/model` 曾卡死 |
| A2 | 键位无注册表 | `app.ts:1335-1366` 手写 `matchesKey` 级联；`KeybindingsManager` 零使用 | 无法重绑、无法 `/hotkeys`、`ctrl+o` 硬编码在 `if` 里 |
| A3 | Entry 类型是封闭 switch | `transcript-view.ts:102` `isExpanded` + 按 `row.kind` 分支 | 新增 `diff` / `compaction` / `branch-summary` 行要改渲染器 |
| A4 | 默认屏幕不对齐 pi | `runner.ts:129` 返回 `'main'`；pi `settings-defaults.js:61` = `"fullscreen"` | **用户截图的现象**：进入时还能看到 shell 命令行 |

### 2.2 B 类 —— 能力缺口（pi 有、这里没有）

| # | 差距 | pi 载体 |
| --- | --- | --- |
| B1 | 转录内搜索（高亮 + 上下跳 + 计数） | `tui-alt-screen.js` `AltScreenSearchIndex`，`ctrl+shift+f` |
| B2 | 消息队列 / follow-up 编辑（`alt+enter` 入队、`alt+up` 取回） | `pendingMessagesContainer` + `chat-viewport.js` |
| B3 | diff 专用渲染（`+`/`-` 着色、hunk 头） | `components/diff.js` |
| B5 | 图片粘贴（`ctrl+v` → clipboard → attachment） | `app.clipboard.pasteImage` |
| B6 | 会话树 / fork / clone | `tree-selector.js`（1246 行） |
| B7 | 压缩 UI（独立进度 + summary 行） | `compaction-summary-message.js` |
| B8 | 硬件光标 / 终端标题 / 系统进度条 | `setTitle` / `setProgress` / `setProgramStatus` |
| B9 | `ctrl+z` 挂起、`ctrl+t` 思考折叠、`shift+tab` 思考档位、`ctrl+l` 模型选择、`ctrl+p` 模型循环 | `docs/keybindings.md` |
| B10 | 退出行为可配（`fullscreenExitOutput: transcript \| resume-hint`） | `settings-schema.js:271` |

### 2.3 C 类 —— 重复实现（pi 已有，这里又写一遍）

| # | 重复 | 行数 | pi 对应 |
| --- | --- | --- | --- |
| C1 | `thinking.ts` 自做 spinner 帧 | 181 | `bordered-loader.js` / `StatusIndicator` |
| C2 | `status-bar.ts` 自己排版 | 336 | `footer.js` |
| C3 | `picker.ts` 自造选择器骨架 | 173 | `SelectList` / `SettingsList` |
| C4 | `transcript-view.ts` 自己 folded 渲染 | 437 | `AssistantMessageComponent`（含 thinking 折叠） |
| C5 | `fullscreen.ts` 手写 dock | 152 | `createChatViewport()`（**逐字段对齐，可直接复用逻辑**） |

### 2.4 D 类 —— 静默风险

| # | 风险 |
| --- | --- |
| D1 | `screenMode` 缺省值写在两处（`runner.ts:129` 与 `app.ts:482` 的 `?? 'main'`），违反本包铁律九 |
| D2 | `mountFullscreen` 的字段清单必须手工枚举（已漏挂面板 3 次） |
| D3 | 49 个 spec / 819 测试；overlay、entry 注册表仍**零覆盖**（键位表 P0-2 已补 55 条） |

## 3. 目标形态：四张注册表替代三处 switch

```
                    ┌─────────────────────────────────┐
   DSH event ──────>│  TranscriptRow (纯数据)          │
                    └───────────┬─────────────────────┘
                                │
                    ┌───────────▼─────────────────────┐
                    │  EntryRegistry  kind → render    │  ← 注册表 1
                    └───────────┬─────────────────────┘
                                │ Component
                    ┌───────────▼─────────────────────┐
                    │  Screen: Document / Dock / Overlay│
                    └─────────────────────────────────┘
   stdin ──────────>│  KeyScope stack (priority)       │  ← 注册表 2
                    └───────────┬─────────────────────┘
                    ┌───────────▼─────────────────────┐
                    │  ActionRegistry                  │  ← 注册表 3
                    └───────────┬─────────────────────┘
   "/" ────────────>│  CommandRegistry                 │  ← 注册表 4
                    └─────────────────────────────────┘
```

| 模块 | 唯一职责 | 明确**不**做 |
| --- | --- | --- |
| `screen.ts` | 挂载/切换 main↔alt、决定 document/dock 归属 | 不知道 transcript 长什么样 |
| `entry/*.ts` | 一个 `kind` 的渲染 | 不知道 key、不知道命令 |
| `keymap.ts` | 数据驱动的 action→key 映射 + 优先级栈 | 不知道 action 做什么 |
| `overlay-host.ts` | 面板生命周期 + 焦点让出 | 不知道面板内容 |
| `commands.ts` | 斜杠行 → `CommandOutcome`（已是纯函数 ✓） | 不渲染 |
| `runner.ts` | DSH 事件 → `TranscriptRow` | 不渲染 |

三条接口，全部只用已有类型，不新增抽象层：

```ts
interface RenderContext { theme: ThemeCapabilities; width: number; expanded: boolean }
interface ActionHost { run(action: Action): void | Promise<void> }
interface Panel extends Component { handleKey(data: string, isKey: (n: string) => boolean): void; title: string }
```

`Panel` 不是设计出来的，是从现有三个面板（model / theme / resume）**归纳**出来的
共同超集 —— 这是「可复用」的正确判据。

### 3.1 新增 = 只加文件

| 要新增 | 现在要改 | 改后要改 |
| --- | --- | --- |
| 一种 transcript 行 | `transcript-view.ts` + `transcript.ts` + `app.ts` | 加 1 个 `entry/xxx.ts`，注册 1 行 |
| 一个键位 | `app.ts:handleInput` 加 `if` | 加 1 行 action 表项 |
| 一个面板 | 塞进 `inputSlot`（顶掉编辑器） | `overlayHost.open(panel)` |
| 一个斜杠命令 | `commands.ts` switch + `CommandOutcome` 联合 + `app.ts` 分支（3 处） | 加 1 个 `Command` 对象 |
| 一个 dock 区域 | 改 `mountFullscreen` 字段清单（已漏 3 次） | `dock.add(component, order)` |

## 4. 复用矩阵（按「白得收益 / 成本」排序 = 执行顺序）

| 优先 | 复用什么 | 替换掉 | 成本 |
| --- | --- | --- | --- |
| P0 | `TuiAltScreen` 作默认 + `createChatViewport` 布局 | `fullscreen.ts` 手写 dock + 双缺省 | 小 |
| P0 | `KeybindingsManager` + `TUI_KEYBINDINGS` | `handleInput` 的 `matchesKey` 级联 | 中 |
| P1 | `showOverlay` / `OverlayHandle` | `replaceInputSlot` 单面板机制 | 中 |
| P1 | `TuiAltScreen` 内置 search | 无（新增能力） | 零 |
| P2 | `SelectList` / `SettingsList` | `picker.ts` 自造骨架 | 中 |
| P2 | `AssistantMessageComponent` 的 thinking 折叠 | `thinking.ts` + `fold.ts` 部分 | 中 |
| P3 | `setTitle` / `setProgress` / `setProgramStatus` | 无 | 零 |

## 5. 执行顺序（每步独立可验）

| 步 | 内容 | 验收 |
| --- | --- | --- |
| **P0-1** ✅ | `screen.ts`：`DEFAULT_SCREEN = 'fullscreen'`；`app.ts` 删 `?? 'main'`；`mountScreen()` 取代 `mountFullscreen()` | **已完成（Step 38）**：真 pty 6 组合全对，首帧 `?1049h`+`2J`+`H`，shell 命令行不再泄漏 |
| **P0-2** ✅ | `keymap.ts`：`routeKey` + `KeyScope` 栈；`handleInput` 改为走栈；新增 `/hotkeys` | **已完成**：819 测试全绿；`/hotkeys` 列出实时绑定（见 §8 与审核修正） |
| **P1-3** | `overlay-host.ts`：`showOverlay` 替 `replaceInputSlot` | `/model` 与 `/theme` 可同时打开；面板不再顶掉编辑器 |
| **P1-4** | `entry/` 注册表：`kind → render` | 加 `entry/diff.ts` 不改核心 |
| **P1-5** | 内置 search（`TuiAltScreen` 白给） | `ctrl+shift+f` 可用 |
| **P3-6** | `setTitle` / `setProgress` + `ctrl+z` / `ctrl+g` / `ctrl+v` | 对齐 `docs/keybindings.md` 全表 |

## 6. 决策记录

### 6.1 「pi 是什么行为就跟着什么行为」（用户决策）

对齐判据不是「哪个更合理」，是「pi 怎么做」。因此：

- **默认屏幕 = `fullscreen`**。pi 的 `settings-defaults.js:61` 就是 `"fullscreen"`。
  即使 main screen 保留了终端原生 scrollback（技术上更保守），也不作为默认 ——
  用户要的是与 pi 一致，不是本地最优。
- 键位、退出行为、折叠语义一律以 `docs/keybindings.md` 与 pi 源码为准，
  不引入本仓特有约定。

### 6.2 P2/P3 延后（用户决策）

**先把形态层（P0/P1）做对，自造组件的替换单独一轮。**

理由：P2 的三项（`picker.ts` / `thinking.ts` / `transcript-view.ts`）行为细节与
现有 849 条测试的断言耦合较深（尤其 `resume-list.ts` 的分页、`fold.ts` 的全局折叠）。
混在形态改动里，一旦测试变红就分不清是「形态没做对」还是「替换没对齐」——
**这正是「改一遍又一遍」的成因**，不能重犯。

延后清单（P2/P3，不丢）：

| 项 | 替换对象 | 依赖 |
| --- | --- | --- |
| C3 | `picker.ts` → `SelectList` / `SettingsList` | P1 完成（overlay 就位） |
| C1 | `thinking.ts` → `Loader` / `StatusIndicator` | P0-2 完成（键位就位） |
| C2 | `status-bar.ts` → `footer.js` 形态 | P1 完成 |
| C4 | `transcript-view.ts` folded 渲染 → `AssistantMessageComponent` 形态 | P1-4 完成（entry 注册表就位） |
| B3 | diff 渲染 | P1-4 完成 |
| B6 | 会话树 / fork | 独立一轮 |
| B2 | 消息队列 | 独立一轮 |
| ~~B4~~ | ~~外部编辑器（`ctrl+g`）~~ | **2026-10-27 用户定案：不做**（见 §6.3） |
| B5 | 图片粘贴 | P3 |
| B8 | 终端标题 / 进度条 | P3 |

### 6.3 明确不做（用户定案）

| # | 项 | 决定 | 理由 |
| --- | --- | --- | --- |
| B4 | 外部编辑器（`ctrl+g` → `$EDITOR`） | **不做** | 2026-10-27 用户决定：终端里的输入需求由 composer 本身 + `ctrl+v` 粘贴覆盖，不值得为它引入「交还终端控制权 → 等编辑器退出 → 回填」这条状态转换。留此记录是为了不再被当成遗漏重新提出。 |

> 与 §6.2 的区别：§6.2 是**延后**（要做，排队）；本节是**不做**（不排期）。
> 后续若要加，前提是 composer 真的成了瓶颈 —— 届时按 `suspend.ts` 的既有进出机制复用，
> 不要另写一套终端接管逻辑。

## 7. 验收判据（本轮）

- [x] 真 pty：`dsh --profile neeko --tui` 进入即整屏，无 shell 命令行残留
- [x] `--main-screen` / `DSH_NEEKO_SCREEN=main` 仍可 opt-out，行为不变
- [x] `screenMode` 的缺省值只剩**一处**（`screen.ts` 的 `DEFAULT_SCREEN`）
- [x] 既有测试全绿（形态重构不得改变行为）→ **819 passed**（P0-1 时 763 → P0-2 后 819）
- [x] 新增测试：屏幕决策（含 env 三态）、键位栈优先级、`/hotkeys` 输出
- [x] `prepublishOnly` 全绿
- [ ] `pnpm run build && node scripts/sync-profiles.mjs`（铁律一：两步是一步）—— 待真机前执行

## 8. P0-2 实施记录（键位栈）

`src/tui/keymap.ts` + `app.ts` 的 `handleInput`/`keyScopes`，命令面 `/hotkeys`。

**优先级（栈序 = 级联序）**：exit → model-panel → pickers → interaction → view(fold) → editor。
两半 `app.*` 刻意分置：exit 全局（模态面板里也必须能退出），fold 不是（挂起的审批/提问拥有键盘）。

审核轮修正（均带变异验证）：

- **B1 错字键位让退出键静默消失**：`installKeymap` 直接用用户 overrides 建 manager，
  而 override **替换**缺省而非追加 —— 一个错字（`'ctr+q'`）让 `app.clear` 既无缺省也无法匹配，
  实测 `ctrl+c` 与 `ctrl+q` 双死 = TUI 无法退出。修：`normaliseKeyId()`（复刻 `matchesKey` 语法：
  修饰键可任意序各至多一次 + 一个基键，大小写折叠）+ `sanitiseOverrides()`（丢弃永不触发的键；
  整条动作全废 → 回落缺省；空数组保留 = pi 的「禁用」语义）。
- **B2 BOM 让整份文件被忽略**：`JSON.parse` 拒绝 BOM → 文件全废且无提示，而同包的
  theme loader 一直在 strip。修：同规则剥离。
- **B3 `formatKeyText` 只大写首段**：pi 的 `formatKeyPart` 对**每一段**首字母大写
  （`Ctrl+Shift+P` / `Option+Enter`）。已按 pi 实现校正（附 `ctrl+shift+p` 断言）。
- **W1 fold 守卫位置**：「`busy` 时不折叠」写在 handler 内 → 仍返回 consumed，
  键被吞掉而非回落。修：栈构建期改为 `handle: () => false`，让 scope 的回答保持真实。
- **W2 `/hotkeys` 的 `app.exit` 描述**照抄了 pi 的「(editor empty)」，但本仓 `app.exit`
  无条件退出 —— 表格会撒谎。修：改为本仓行为。
- **文档**：README 的 Keys 表补「`/hotkeys` 是权威」+ `keybindings.json` 用法与校验语义。

**方法记录**：审核发现的三条 Block 全部落在同一处 —— **未验证的第三方行为假设**
（`matchesKey` 对非法 id 静默 false、`formatKeyPart` 的大小写粒度、BOM 与 `JSON.parse`）。
这些都能**用探针在 5 分钟内实测**（本轮即如此定位），比读类型和注释可靠。

## 9. 实施记录（Step 40 — S1…S4 全量对齐）

> 用户决策演进：「pi 是什么行为就跟着什么行为」→「不引入 pi-coding-agent，参考其组件写法移植」
> →「主题也包括」→「先就保持和 pi 一样」。

### 9.1 依赖边界（用户决策）

**不引入 `@earendil-works/pi-coding-agent`**（dist 20MB + 副作用 22 个直接依赖 + 123MB 间接）。
它虽然是 `index.js` 可导入的，但把整个 CLI 应用拖进一个库不合理。改为**按源码移植其组件写法**，
只依赖 `pi-tui`。

### 9.2 移植清单

| 新文件 | 移植来源 | 替换掉 |
| --- | --- | --- |
| `message-view.ts` | `user-message.js` / `assistant-message.js` / `tool-execution.js` / `render-utils.js` / `keybinding-hints.js` | `transcript-view.ts` 437 + `tool-present.ts` 242 |
| `composer.ts` | `custom-editor.js`（`renderTopBorder`）+ `theme.js`（`getEditorTheme`） | 无色的 `editorTheme` 常量 |
| `status-indicator.ts` | `status-indicator.js` + `dynamic-border.js` + `footer.js` 的 token 选择 | 手工 spinner 计时器 |
| `thinking-selector.ts` | `thinking-selector.js` | `thinking.ts` 的渲染部分（181→140，保留纯逻辑） |
| `theme-selector.ts` | `theme-selector.js` | `theme-picker.ts` 69 |
| `resume-selector.ts` | `session-selector.js`（**只移植面板**） | `app.ts` 里手写的窗口化渲染 |

`resume` 只移植面板：pi 的 `SessionSelectorComponent` 有 892 行的 scope 切换 / 排序 / 删除 /
重命名 / 后台扫描，而 dsh 的 `sessionQuery.listSessions()` 已按调用方要求回答、语料库契约就是
newest-first、本仓没有持久化 API —— 那四项**没有对应物**。

### 9.3 主题（S1）

| 改动 | 内容 |
| --- | --- |
| `theme-tokens.ts` | 加 `THEME_TOKEN_SPECS`：56 token 的 slot + **fallback 链**（pi 的四个：track→muted、thumb→text、matchBg→selectedBg、matchText→text） |
| `theme.ts` | `withTokenFallbacks()`；`has()` 改为「能否绘制」；**修真实缺陷** —— 构造函数把 `''`（终端默认色，合法）和解析失败（拼错）混为一谈 |
| `theme-data.ts` | 删掉内置主题里那 4 个 token（pi 里是省略的，写死会让 fallback 链在自带主题上永不执行） |
| 搜索路径 | `~/.dsh/themes` 优先，`~/.pi/agent/themes` 兼容；新增 `DSH_HOME` |

**根因**：没有 fallback 链 → 任何真实 pi 主题都会崩 `Theme token scrollbarTrack has unresolved
fallback muted`。修好后 `~/.dsh/themes` 里 5 个真实 pi 主题全部可加载。

### 9.4 屏幕与滚动（最重要的一轮）

用户三次纠正，每次都推翻了我前一轮的判断：

| 需求 | 我的错误 | 事实 |
| --- | --- | --- |
| 启动不要看到 shell 命令行 | 以为 pi 默认 fullscreen | **pi 默认 regular**：`getTuiMode()` 返回 `"regular"` 除非存的是字面量 `"fullscreen"`；用户 profile 就是 `"tuiMode": "regular"`。实测 `pi` 无 `?1049h` |
| 要终端 scrollback + 终端滚动条 | 用 alt screen | 只有主屏有；用户截图的滚动条就是证据 |
| 消息要能滚动回看 | 加了 `tailWindow` 当性能优化 | **`tailWindow` 是元凶**：它把 document 裁成 `rows - dock`，超出部分根本不渲染，所以那些内容从未进 scrollback |

最终：**完全照 pi，零本地改良**。

```
main:       document(整个) + aboveInput + input + footer     ← pi regular 的形态
fullscreen: ScrollView(document) + 固定 dock                  ← pi createChatViewport 的形态
启动:       不清屏（pi 实测 2J=0 / 3J=0）
```

撤回的三个自造改动：`tailWindow`、启动清屏（`2J`+`H`）、fullscreen 的 B2（编辑器进滚动流）。
`screen.ts` 388 → 340 行，纯减法。

### 9.5 变异验证汇总

| 轮次 | 有效/总数 | 首次 0 红的原因（均已查明） |
| --- | --- | --- |
| 屏幕形态 | 4/4 | — |
| 键位栈 | 8/8 | 「MAIN_SCREEN 分支」是冗余分支，查清后补了冲突测试 |
| 消息组件 | 5/5 | 工具卡 Spacer：`Box(1,1,bg)` 自带 paddingY，断言「首行空」太弱 → 改断言空行数 |
| 状态指示 | 5/5 | — |
| 选择器 | 6/6 | model 游标保留连报 4 次 0 红：探针 isKey 写错 / 过滤词让目标恰排第一（两次）/ **`panel.list` 是过时引用（真缺陷）** |
| resume 选择器 | 4/4 | — |
| 屏幕滚动 | 3/3 | — |

**教训**：0 红必须查到底。6 条「0 红」里 1 条是真缺陷、5 条是测试不够刁钻。

### 9.6 一处纠正自己的错误认知

`SelectList` **不支持** `pageUp`/`pageDown` —— 它的 `handleInput` 只处理 up/down/enter/cancel，
且上下**环绕**。注释已改正，行为写进测试。

### 9.7 验收

- **889 passed / 52 files**（S1 前 794）
- `prepublishOnly` 全绿 + `sync-profiles`
- 真机与 pi 逐项对齐：alt=False、`2J`=0、`3J`=0、退出后 scrollback 1212 行、两轮对话全保留
