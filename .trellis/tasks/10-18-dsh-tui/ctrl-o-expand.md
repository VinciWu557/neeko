# Step 16 — `ctrl+o` 全局展开 / 折叠（对齐 pi 实现）

> 归属：`10-18-dsh-tui` 的追加轮次（不另建子任务目录）。
> 落点：`packages/dsh-neeko/src/tui/**`。门禁豁免不变（`prepublishOnly`）。

## 需求（用户原话）

> 支持 ctrl + o 展开折叠输出，参考 pi-tui 的实现

## 现状（改动前，实测）

| 位置 | 行为 |
| --- | --- |
| `app.ts:950` | `ctrl+o` → `toggleFold()` → 只切**最新一行** |
| `app.ts:247` | `expandedRows: WeakSet<TranscriptRow>` 存「用户展开过的行」 |
| `transcript-view.ts:102` | `isExpanded()` 有两个开关：`expanded`（逐行例外）+ `boundary`（按 turn 窗口） |
| 折叠态提示 | 助手思考行写死 `(ctrl+o to expand)`，但按键只开一行 —— 文案与行为不符 |
| 生产调用方 | `boundary` **零调用**（只有测试在用），`expanded` 是唯一实际机制 |

## pi 的参考实现（`pi-coding-agent`）

- 键位表 `app.tools.expand` = `ctrl+o`（`docs/keybindings.md:164`）。
- 动作是 `toggleToolOutputExpansion()` → `setToolsExpanded(!toolOutputExpanded)`：
  **一个全局布尔**，然后遍历 `chatContainer.children`，对每个 `isExpandable(child)`
  调 `child.setExpanded(expanded)` —— 广播式全展开 / 全折叠。
- 单行点击仍走组件自己的 `setExpanded(!this.expanded)`；**下一次全局切换会覆盖它**
  （广播就是覆盖），所以「逐行例外」的生命周期止于下一次 `ctrl+o`。
- 折叠态会报告还有多少行：`... (N more lines, ctrl+o to expand)`
  （`FALLBACK_PREVIEW_LINES = 10`）。
- 切换后给一条状态提示：`Tool output: expanded / collapsed`。

## 设计

### 单一机制：`TranscriptFold`（`src/tui/fold.ts`）

```ts
export interface FoldView {
  readonly allExpanded: boolean
  isFlipped(row: TranscriptRow): boolean
}
// 展开 = allExpanded XOR isFlipped(row)
export class TranscriptFold implements FoldView {
  toggleAll(): boolean   // 翻转全局，并清空逐行例外（= pi 的广播覆盖）
  toggle(row): void      // 翻转单行（点击）
}
```

- 例外集用 `WeakSet<TranscriptRow>`：行对象由 `transcript.ts` 持有，视图不延长其寿命。
- **`toggleAll()` 清空例外**是刻意的：不清的话「全折叠」会留下用户点开过的行，
  与 pi 的广播语义不一致，也让这个键不能当「复位」用。
- `boundary` **删除**。它在生产零调用，且与 `fold` 表达同一件事（要不要展开），
  留着就是第二个可静默失效的开关 —— spec 里「`boundary: 0` 才是全展开」那条随之改写。

### 组件缓存必须跟着折叠态失效

`app.ts:rowSignature()` 现在把 `expandedRows.has(row)` 编进签名。折叠态改成
全局布尔后，签名必须读 `fold.isExpanded(row)` —— 否则按 `ctrl+o` 后签名不变，
`rowComponents` 命中旧组件，**屏幕没有任何变化**（按了没反应）。
这是本轮最容易漏、也最难靠肉眼发现的一条，单列一条变异测试。

### 折叠态文案

折叠行报告被藏起来的量，与 pi 同构（都保持单行，不破坏折叠的省空间前提）：

| 行类型 | 折叠态 |
| --- | --- |
| 工具结果 | `📖 Read src/a.ts [ok] — line one… (+12 lines, ctrl+o)` |
| 助手思考 | `🐳 first thought… (ctrl+o to expand)`（已有，保持） |

`+N lines` 只在 `N > 0` 时出现；文件读取（`isFileRead`）仍只显示路径 ——
引一段文件内容比文件名信息更少，加行数只会更吵。

### 键位与提示同步

- `ctrl+o` 的优先级保持在模态面（model panel / theme picker / interaction）**之后**：
  打开的浮层先拥有键盘。
- 切换后追加一条 notice（`transcript: expanded` / `transcript: collapsed`）。
- `banner.ts` 的按键提示行、`commands.ts` 的 `/help` Keys 行各加 `ctrl+o expand`。

## TDD 步骤

1. **Red** `tests/tui-fold.spec.ts`：`TranscriptFold` 真值表
   （默认全折叠 / `toggleAll` 全展开 / 单行 `toggle` 翻转 / `toggleAll` 清空例外）。
2. **Red** `tests/tui-render-row.spec.ts`：`isExpanded` 迁到 `fold`；
   新增「`allExpanded` 展开全部」「例外行在全展开下折叠」「折叠工具行报告剩余行数」。
3. **Red** `tests/tui-interaction-glue.spec.ts`：按 `\x0f` 后整段转录展开
   （断言渲染文本出现结果正文）、再按一次折叠、notice 出现。
   **变异**：`rowSignature` 不读 fold → 必红。
4. **Green** 实现 `fold.ts`、改 `transcript-view.ts`、改 `app.ts`。
5. 删 `RenderOptions.boundary` / `RenderOptions.expanded`，测试全量迁移。
6. `prepublishOnly` 全绿。
   （`packages/**` 不纳入 `.trellis/spec/` 的沉淀面 —— 它的门禁是 `prepublishOnly`。）

## 验收

- [ ] `ctrl+o` 一次展开**全部**折叠行，再一次全部折叠（不是只动最新一行）。
- [ ] 展开后点击单行可单独折叠；下一次 `ctrl+o` 回到统一状态。
- [ ] 折叠工具行显示 `(+N lines, ctrl+o)`，且仍是一行。
- [ ] `/help` 与 banner 的按键行提到 `ctrl+o`。
- [ ] `packages/dsh-neeko`：`pnpm run prepublishOnly` 全绿。
- [ ] 真机（pty）复验：`ctrl+o` 往返、fullscreen 模式下同样生效。

## Step 16b — 提示堆积与不消失（用户反馈）

用户实测贴出的屏幕：

```
model → magpie/group/auto-step-5-preview
 transcript: expanded
 transcript: collapsed
 transcript: expanded
 transcript: collapse…   ← 提示消息不会消失
```

### 根因（两条，不是一条）

1. **每次按键 `addChild` 一条新 Text** —— `addNotice()` 只会追加。pi 把
   状态分成两类：`showStatus()` 维护**唯一一行**并 `setText()` 就地更新
   （注释原话 "to avoid log spam"，且要求上一行仍是 chatContainer 的
   `children[-2..-1]` 才复用），而 `showError/showWarning` 才追加。
   本仓把两者压成了一个 `addNotice` → 每次 `ctrl+o` 叠一行。
2. **没有任何到期机制** —— 状态行报告的是「刚才那个动作的结果」，
   是一次性消耗品；留在屏幕上就是永久噪音。

### 修法

新增 `TuiApp.showStatus(text)`（`app.ts`），与 `addNotice` 并列而非替换：

| 类别 | 入口 | 生命周期 |
| --- | --- | --- |
| 状态（model / theme / fullscreen / fold） | `showStatus()` | 单行就地更新 + 到期移除 |
| 内容与错误（`/help`、未知命令、切换失败） | `addNotice()` | 保留，直到 `/clear` 或触达 `MAX_NOTICE_COMPONENTS` |

- 槽位 `statusLine: Text | undefined`：已有则 `setText()`，没有才挂载。
  `clearStatus()` **移除**该组件而不是留空 —— 空 `Text` 不渲染但占一个槽，
  长会话会把真正的命令回显挤出容器上限。
- 倒计时 `statusTimer` 每次 `showStatus()` 重排（最后一个动作才值得看）。
  `stop()` 与 `clearTranscript()` 都走 `clearStatus()`：前者否则事件循环
  被吊住延迟退出，后者否则 `/clear` 后指针指向已卸载组件（下次状态不可见）。
- 时长走 `TuiAppOptions.statusNoticeMs`（默认 `STATUS_NOTICE_MS = 3000`），
  测试用 30/60ms 而不是 fake timers —— 到期逻辑只有 4 行，注入常数
  比 mock 时钟更不容易说谎。

### 变异验证

| 变异 | 变红 |
| --- | --- |
| `showStatus` 不复用槽位（`if (line !== undefined)` → `if (false)`） | 3 条 |
| 不排到期定时器 | 4 条 |

### 中途的设计摇摆（记录，避免复犯）

我曾把 `toggleFold` 的提示改成「完全不写状态行」，理由「pi 的
`setToolsExpanded` 没有 showStatus」——**该前提是错的**：pi 的
`setToolsExpanded()` 末行就是 `showStatus(\`Tool output: ...\`)`。
按错前提改代码会让测试反向迁移（那次 7 红里有 6 条是我自己造的）。
结论：`ctrl+o` 保留一行状态，但必须是**单行 + 到期**。

## 验收补充

- [x] 连续 4 次 `ctrl+o` 屏幕上只有 **1** 行 `transcript:` 状态。
- [x] 状态行 3s 后自动消失；再次按键重排倒计时。
- [x] 错误与 `/help` 类通知**不**到期（否则看不见失败原因）。
- [x] `stop()` / `/clear` 清掉定时器与槽位。
- [x] `prepublishOnly` 全绿：**520 测试**。
- [x] 真机 pty：4 次按键 + 切主题后，屏幕上只剩 ` theme → light` 一行状态，
      无 `transcript:` 残留（4s 后全部消失）。

## Step 17 — 模型响应错误必须打印（用户需求）

用户原话：「模型响应错误信息也需要进行提示打印，参考 pi-tui」。

### 现状（改动前，实测）

`transcript.ts` 的 `feedLogEvent` **没有 `turn/end` 分支** → 落到 `default: break`。
`dsh-agent-loop` 把模型失败的唯一 durable 落点写在那里，所以：

- 请求失败（401 / 限流 / 模型不可用）→ 用户看到回复**中途停住**，与「还在思考」不可区分；
- 死在中途的 `tool/call` → 卡片永远停在 `[running]`（没有东西会再写它的结果）；
- `--session` 恢复同一个会话 → 连停住都没有，只有问题、没有下文。

### 契约事实（读 `dsh-agent-loop` / `dsh-llm` 源码，非推断）

| 现象 | durable | 备注 |
| --- | --- | --- |
| 请求失败 | `turn/end` 的 `reason.kind === 'error'` + `LlmFailure{message,code,status,requestId}` | turn 的 `finally` 写；重试成功的 turn 是 `completed` |
| 用户取消 | `reason.kind === 'aborted'` + `TurnEndCancelCause` | `hook` 原因带自由文本 |
| 输出截断 | `reason.kind === 'max-tokens'` | |
| 流式失败 | `finish` chunk 的 `reason`；`live.abandon()` 仍发 `end` 帧 | 所以 spinner 会停 |

pi 的呈现（`assistant-message.js:135-156`）：正文之后 `Error: <msg>` / `Operation aborted`
/ `Response was truncated before completion.`，全部 `fg("error")`；并对 `pendingTools`
下发 `isError: true`。

### 修法

1. **`turnEndFailure(reason)` → 一行文案**（放 `src/dsh-adapter.ts`，桥也用；放 TUI 会造成
   bridge → TUI 反向依赖）。`error` → `Error: <msg> [CODE STATUS]`（`UNKNOWN` 码不打印，
   那是 loop 对非 Llm 错误的压平，不携带信息）；空 message → `Unknown error`；
   `aborted` → `Operation aborted (hook 原因)`；`max-tokens` → pi 的措辞；
   `completed`/未知 variant → `undefined`（**fail-open**：`TurnEndReason` 是 merge-extensible）。
2. **新行类型 `kind: 'failure'`**（不是 assistant 的字段：请求可能在任何 `start` 帧之前就失败，
   那时没有气泡可挂）。渲染 `✖` + `fg('error')`，多行 provider 消息逐行保留。
3. **`isExpanded` 对 failure 恒 true**：失败行是「为什么没有回复」的唯一解释，折叠它等于
   把 bug 改回去。
4. **失败收尾悬空工具卡**：同 turn 内仍 `running` 的 tool 置为 `failed` + 错误文案
   （pi 对 `pendingTools` 同构），否则 spinner 转一整个会话。
5. **恢复路径同步**：`buildHistory` 也发 `kind: 'failure'`（`HistoryItem` 加 variant），
   `restoreRows` 消费它。只修 live 的话 `--session` 恢复仍是一问一静默。

### 变异验证

| 变异 | 变红 |
| --- | --- |
| `feedEvent` 不处理 `turn/end` | 3 条 |
| 失败时不收尾悬空工具卡 | 1 条 |
| 失败行可被折叠 | 1 条 |

### 验收

- [x] 真机 pty（故意用失效 key）：屏幕出现
      `✖ Error: 404: {"code":null,"message":"...is not available..."} [PI_AI_ERROR]`，
      多行完整、带错误码。
- [x] `prepublishOnly` 全绿：**543 测试** / `tsc`×2 / build / publint。

## Step 18 — TUI 默认全屏（用户需求）

用户原话：「tui 默认进入全屏模式」。

### 事实

pi 自己的默认就是全屏：`settings-defaults.js:61` → `tuiMode: "fullscreen"`，
`settings-manager` 只在值为 `'regular'` 时才退回主屏。本仓原本是 opt-in
（`DSH_NEEKO_FULLSCREEN=1`），与参考相反。

### 修法

- `TuiAppOptions.initialFullscreen` → **`startOnMainScreen`**（语义反转，默认全屏）。
  名字跟着新默认走：留着 `initialFullscreen` 会让「不传＝全屏」反直觉。
- 新增 `--main-screen` flag / `DSH_NEEKO_MAIN_SCREEN=1` / `TuiConfig.mainScreen`
  作为 opt-out（主屏保留终端 scrollback，这是唯一的代价）。
- `cordis.patch.yml` 的 `neeko-tui` 行透传 `mainScreen`。

### 顺带修掉的真实缺陷：退出时对话没有留在 scrollback

alt screen 的承诺是「退出后对话还在终端里」。实测（真 pty）**不成立**：
退出后写回文档只有 **1426 字节 = banner**，整段对话消失。

根因不是 `process.exit` 抢跑（我第一版这么判断，加了 `exitAfterFlush` 也没修好，
但那层仍然对：`process.stdout.write` 是异步的，退出前该等它）。真正的原因在
pi-tui：`afterTerminalStop()` 打印「最终文档」时调 `render(width)`，而
`TuiAltScreen.render()` 委派给 `layoutRoot.render()` —— 一个**没被
`renderLayoutFrame()` 测量过**的 `VStack` 只返回 **1 行**。我们用的正是
`setLayoutRoot(new VStack(...))`。

pi 自己也不走那条路：`stopInteractiveTui()` 在 fullscreen 下是
`ui.stop({ preserveScreen: mode === 'fullscreen' })` —— 直接放弃回写文档。

修法（与 pi 一致）：
1. `fullscreen.dispose()` 改 `stop({ preserveScreen: true })`，不再假装能写回文档。
2. `TuiApp.stop()` 负责让对话落到真 scrollback：`exitFullscreen()`
   （离开 alt screen + 重启主屏）→ `tui.renderNow(true)` **全量重绘** → `tui.stop()`。
   增量重绘在退出时什么都不发（主屏刚 `start()`，最后一帧不匹配任何东西）。
3. 新测试钉住「退出后终端输出里必须出现对话内容」，而不只是
   「出现过 `ESC[?1049l`」——后者之前是绿的，缺陷就是这么漏过去的。

结果：写回文档 1426 → **2741 字节**，对话完整。

### 变异/实测

| 检查 | 结果 |
| --- | --- |
| 默认启动进入 alt screen | ✅ 真 pty `altIn=true` |
| `--main-screen` 留在主屏 | ✅ 真 pty `altIn=false` |
| 退出离开 alt screen | ✅ `altOut=true` 两种模式都正常 |
| 退出后对话在 scrollback | ✅ 修复前 false / 修复后 true |

### 验收

- [x] 默认全屏；`--main-screen` / `DSH_NEEKO_MAIN_SCREEN=1` 可退出全屏。
- [x] 退出后整段对话留在终端 scrollback（真 pty 复验）。
- [x] `prepublishOnly` 全绿：**552 测试**。

## Step 19 — 退出时的乱码 `7u 62;22;52c 34;16t`（用户反馈）

用户原话：「退出时会出现乱码 7u62;22;52c;34;16t」。

### 根因

那三段不是随机字节，是**终端对我们能力查询的回复**，三对一一对应：

| 我们发的查询 | 终端的回复 | 来源 |
| --- | --- | --- |
| `ESC[>1u` + `ESC[?u`（Kitty 键盘协议协商） | `7u` | `terminal.js` `queryAndEnableKittyProtocol()` |
| `ESC[c`（设备属性 DA1） | `?62;22;52c` | 同上 |
| `ESC[16t`（单元尺寸，图片渲染用） | `?34;16t` | `tui.js` `queryCellSize()` |

这三条都在 `Terminal.start()` 里发，而**每次** `TuiBase.start()` 都会调它。
Step 18 的退出修复写的是 `exitFullscreen()` → `this.tui.start()`，于是在**退出时**
又发了一轮查询；进程随后结束，回复到达时已经没有 stdin 监听器去消费它们，
tty 就把这些字节当成用户输入回显到 shell 提示符上。

### 修法

退出路径**不重启任何渲染器**：

1. `stop()` 用 `resumeMainScreenQuietly()`（只 `dispose()` 离开 alt screen），
   **不再调 `tui.start()`**。
2. 自己打印最终文档（`printFinalDocument()`）：直接对 banner / messages / notices /
   working / interaction / theme / editor / status 调 `render(width)`，剥掉
   pi-tui 的假光标标记 `CURSOR_MARKER`，`write` 到终端。
   绕开的是 pi-tui 那条「最终文档」路径 —— 它对 `VStack` 布局根只返回 1 行
   （Step 18 已记录）。

### 顺带修掉：`\r\n` 造成的行间空行

第一版用 `join('\r\n')` 打印，真 pty 上得到 **26 个 `\r\r\n`**（每行之间一个空行）：
此时终端已是 cooked mode，tty 的 ONLCR 会替我们把 `\n` 翻成 `\r\n`。
改成只写 `\n`。

### 验证（真 pty，`pty.fork` 分配真实终端）

| 检查 | 结果 |
| --- | --- |
| 退出后能力回复乱码 | **0**（修复前 3 处） |
| 退出后 `\r\r\n` | **0**（修复前 26） |
| 退出后对话仍在 scrollback | ✅ 2616 字节，含对话内容 |
| `--main-screen` 模式退出瞬间 `\r\r\n` | 0（92 个来自运行期正常渲染，非退出路径） |

> 测试坑：`FakeTerminal.columns` 恒有值，所以单测里 `\r\r\n` 只在显式断言时可见；
> 「终端回复乱码」在单测里**根本无法复现**（没有真终端会回复）。所以这一条必须靠
> 真 pty 验证，单测只能钉住「退出路径不再发查询」这个**因**（断言输出里不出现
> `ESC[>1u` / `ESC[?u` / `ESC[c` / `ESC[16t`）。

### 验收

- [x] 退出不再打印能力回复；`prepublishOnly` 全绿：**554 测试**（+2）。

## Step 20 — 行间距与思考/正文贴太紧（用户反馈）

用户原话：「当前的输入之间的空格有点大，而且思考输出内容与正文回复内容贴的太紧」。

### 问题 1：输入行之间空隙过大 —— `Text` 的默认 padding

`renderUser` 里的 `new Text(...)` **没传 padding**，而 pi-tui 的构造函数签名是
`constructor(text = "", paddingX = 1, paddingY = 1, ...)` —— 默认 `paddingY = 1`
会在**上下各加一个空行**。相邻两行 user 消息于是隔了两个空行，看起来像
「输入之间空格很大」。

实测行高：修复前 user 行 = **3 行**（1 内容 + 上下各 1 空行），修复后 = 1 行。

这是全文件唯一一处漏传 padding 的调用（其余 10 处都是 `, 0, 0`），所以缺陷
一直没有被别的行暴露出来。

### 问题 2：思考块与正文贴太紧

`renderAssistant` 把思考行和 `Markdown(row.text)` 直接相邻 `addChild`，中间没有
任何间隔 —— 折叠态的思考行带整行背景色，紧贴正文时读起来像同一段文字。

修：有思考时在正文前加 `new Spacer(1)`。**只在有思考时加** —— 普通回答保持
一行紧贴，不为每条消息都平白多一个空行。

### 验收

- [x] 单测：user 行渲染为 1 行；思考行与正文之间恰好 1 个空行且位置正确；
      无思考的回答仍为 1 行（不被 `Spacer` 波及）。
- [x] 真 pty 复验：printed document 里 `❯ hello` 与上一行紧邻；
      `🐳 …` → 空行 → `Hello! 👋 …`。
- [x] `prepublishOnly` 全绿：**557 测试**（+3）。

## Step 21 — 左侧留白对齐 pi 的 `outputPad`（用户需求）

用户原话：「内容输出是不是需要和左边界有一点距离比较好，参考一下 pi-tui 的输出内容
与边距的控制是怎么样的」。

### pi 的做法（读源码确认）

单一设置、单一用途：

| 事实 | 出处 |
| --- | --- |
| `outputPad` 默认 **1**，schema 只允许 `0 \| 1` | `settings-defaults.js:47`、`settings-schema.js:240` |
| 它作为 **`paddingX`** 传给**每一个** chat 组件 | `assistant-message.js` / `user-message.js` / `tool-execution.js` 的构造参数 |
| `paddingY` 由**每个组件各自**决定，不随 `outputPad` | assistant 正文 `Markdown(text, outputPad, 0, …)`（注释明说「Set paddingY=0 to avoid extra spacing before tool executions」）；user 消息用 `paddingY: 1` |
| 运行时可通过 `/settings` 改 | `interactive-mode.js` `onOutputPadChange` 遍历容器调 `setPaddingX` |

即：**水平统一 1 列，垂直按语义分别处理**。

### 我们的偏差

不一致 —— 只有 `Box(1, 0, bg)` 的工具卡与思考背景带有一列，而 user 行、
assistant 正文、failure 行都从第 0 列开始。结果是卡片像浮着、正文像 shell 输出。

### 修法

引入 `OUTPUT_PAD = 1`（`transcript-view.ts`），规则是「**每条行恰好一列，由
带背景的那一层提供**」：

- 无背景：`new Text(..., OUTPUT_PAD, 0)` / `new Markdown(text, OUTPUT_PAD, 0, …)`
- 有背景：`Box(OUTPUT_PAD, 0, bg)` 负责缩进，里面的文本 `paddingX = 0`
  （否则会缩两列 —— 这正是中途踩到的坑：我第一次重构时给思考行同时加了
  band 和 padding）

垂直间距沿用 Step 20 的结论（user 行 `paddingY = 0`，思考与正文之间显式
`Spacer(1)`），与 pi 的「水平统一、垂直分类」一致。

### 变异/测试

| 用例 | 断言 |
| --- | --- |
| user / assistant / thinking / tool / failure 五行 | 首字符前恰好 1 个空格 |
| 有背景 band vs 无背景 | 缩进**相同**（防双重内缩） |

### 验收

- [x] 单测 +7（5 类行各 1 + 背景/无背景不双缩 2）。
- [x] 真 pty 复验：`❯ hello` / `🐳 …` / `Hello! 👋` / `🖥️ Bash …` 的 indent 全部 = 1。
- [x] `prepublishOnly` 全绿：**564 测试**。

## Step 22 — 退出时打印会话恢复提示（用户需求）

用户原话：「进程退出时像 pi 一样打印会话恢复提示，需要改为 dsh 自己的，
`To resume this session: pi --session 01a15350-...`」。

### pi 的做法

`shutdown()` 末尾（`interactive-mode.js:3515-3518`）：

```js
const resumeCommand = formatResumeCommand(this.sessionManager)
if (resumeCommand) process.stdout.write(`${chalk.dim('To resume this session:')} ${resumeCommand}\n`)
```

`formatResumeCommand` 的取舍值得照抄：仅在 `stdout.isTTY` 且会话**确实落盘**时打印，
非默认 session 目录时补 `--session-dir`，否则只拼 `--session <id>`，id 用
`quoteIfNeeded` 按需引号。

### 为什么不能直接照抄命令

dsh 的 TUI **只能经由 profile 进入**：裸 `dsh --session <id>` 会启动默认 profile，
根本不会加载 `neeko-tui` 那一行 —— 那种提示是一条**恢复不了任何东西的命令**，
比不打印更糟。

所以提示是完整调用：

```
To resume this session: dsh --profile neeko --tui --session <id>
```

### 持久化判据：dsh 没有 pi 的 `isPersisted()`

`SessionStore` 的文档写得很明确：「Persistence is intentionally not implemented here
—— the agent lifecycle attaches a session-log writer to each published session's
write handle」。所以没有可查的「是否落盘」标志。

本轮的取舍：**有 id 就打印**。理由是 dsh 的 agent 生命周期在正常 boot 下总会附加
writer，而"没有 id"是可判定的（空串）。真机验证覆盖了这条假设（见下）。

### 实现

新增 `src/tui/resume-hint.ts`（纯函数，可直测）：

```ts
resumeHint({ sessionId }) → 'To resume this session: dsh --profile neeko --tui --session <id>'
                          | undefined   // 空/空白 id
```

接在 `printFinalDocument()` 的**最后一行**（不是另起一次 write）：提示就落在
conversation 下方的 scrollback 里，与被恢复的那段对话相邻。

### 验证（真 pty，端到端）

不只是「打印了这行」，而是**拿这行去真正恢复**：

| 步骤 | 结果 |
| --- | --- |
| 起一次 TUI，发 `say RESUME-MARKER please`，Ctrl+C | 提示行 = `… --session session-0f6506b0-…` |
| 用这行命令原样再起一次 | **历史里的 `RESUME-MARKER` 出现在屏幕上** ✅ |
| 恢复后的 banner session id | 与提示中的一致 ✅ |

单测 +7：`resumeHint` 4 条（命令形状 / 空 id / 需要引号 / uuid 不加引号）+
app 层 3 条（用 dsh 而非 pi、是最后一行、无 id 时不打印）。

### 验收

- [x] 退出打印 `To resume this session: dsh --profile neeko --tui --session <id>`。
- [x] 真机：该命令原样可恢复会话且历史完整。
- [x] `prepublishOnly` 全绿：**571 测试**。

## Step 23 — `/thinking` 思考等级命令（用户需求）

用户原话：「接入模型思考等级设置命令，参考 pi-tui 的 `/thinking` 命令实现」。

### pi 的形状（`interactive-mode.js:4282-4320`）

| 输入 | 行为 |
| --- | --- |
| `/thinking` | 打开选择器（当前项带标记，enter 应用，esc 关闭） |
| `/thinking <level>` | 直接应用；大小写不敏感地匹配 |
| 未知等级 | 报错并**列出可用等级**（不静默忽略） |
| 已是的等级 | 报告「已经是该等级」，不重写配置 |
| 应用成功 | `showStatus('Thinking level: <x>')` |

### 关键差异：等级从哪来

pi 的 `session.getAvailableThinkingLevels()` 是它自己的模型目录。dsh **不允许客户端自造**：
`llm.resolveModelInfo(provider, model)` 才给出该**精确路由**的
`reasoning.efforts`（`LlmReasoningEffortInfo{id,name,description}`），
且 `resolveCallConfig` 会在任何 provider I/O **之前**拒绝不支持的显式 effort。

所以写死 `low|medium|high` 会让 UI 提供发不出去的选项。整个 `thinking.ts`
是 adapter 答案的**投影**，模块里没有一处等级字面量。

### effort 属于模型（复用既有纪律）

`withReasoningEffort()` 只改 effort、永不跨模型携带 —— 这正是
`model-switch.ts` 记录过的坑：带着上一个模型的 effort 切模型，会把新模型钉在
它可能不支持（或静默降级）的档位上，用户看到的是「切换没生效」。
清除时**删除 key** 而不是写 `undefined`：DSH 把「absent」读作 provider 默认，
且 `exactOptionalPropertyTypes` 也不允许写 `undefined`。

### 实现

| 文件 | 内容 |
| --- | --- |
| `src/tui/thinking.ts`（新） | 纯函数：`thinkingChoices` / `thinkingOutcome`（4 分支）/ `withReasoningEffort` / `renderThinkingPicker` / `thinkingPickerIntent` / `movedThinkingIndex` |
| `commands.ts` + `command-controller.ts` | `{kind:'thinking', argument}` outcome → action（TS 穷尽检查当场抓出漏接） |
| `app.ts` | `applyThinking()` / `commitThinking()` / picker 开合与键路由（面板拥有键盘期间吞掉所有键） |
| `runner.ts` | `reasoningSupport` 每次向 `llm.resolveModelInfo` 现查（不缓存：换模型就变）；`selectReasoningEffort` 改 `selectionRef.current` |

面板形态复用 `theme-picker` 那套（纯渲染 + 纯键位意图），不用 `model-panel` 的
全高列表：adapter 的 effort 集按构造只有几项，带搜索框的列表是多余装饰。

### 真机发现的补充

真实 dsh 的 `reasoning.efforts` **不带 `defaultEffort`**，而新会话的 selection
也没有 effort —— 于是没有任何一行能标 `✓`。面板当时看起来像坏的。补一条：

```
  (provider default — no level pinned)
```

这是诚实的：那种情况下请求里确实不发 effort。

### 变异验证

| 变异 | 变红 |
| --- | --- |
| `submit()` 不接 `/thinking` | 9 |
| picker 不接管键盘 | 3 |
| 光标不落在当前项 | 1 |
| 已是该等级仍重写 | 2 |

> M3 第一次是 **0 红**：夹具里 `current` 与第一项恰好都是 `low`，光标停在第 0 项
> 时断言仍然成立。改成「当前项 = `high`」（非首项、非 adapter 默认）后才变红。
> **测试夹具必须让"错误实现"与"正确实现"产生不同输出**，否则断言是空的。

### 验收

- [x] 单测 +28（纯函数 18 + 胶水 10）。
- [x] 真机 pty：`/thinking` 列出 `Low [low]` / `High [high]`；`/thinking high` 生效，
      状态栏出现 `• high`；无默认时不误标。
- [x] `prepublishOnly` 全绿：**599 测试**。

## Step 24 — 全屏模式下选择面板不可见（用户反馈）

用户原话：「没有显示出和 pi 一样设置思考等级的列表选择，但是通过方向键却能选择出来，
只是看不到」。

### 根因：全屏布局硬编码了组件清单

`mountFullscreen()` 接收显式字段列表（`header` / `transcript` / `notices` /
`input` / `footer`），只有 `TuiApp` 构造时**逐个枚举**的那些面板才会进布局。
而 `themeText` / `thinkingText` 只挂到了**主屏**的 `tui` 子树上 —— 全屏时主屏是
**停止**的（alt screen 独占终端），所以：

- 键位正常（`handleInput` 由 alt screen 转发，与挂载无关）→ 方向键能选、
  enter 能生效；
- 画面上什么都没有（面板不在 alt screen 的布局里）。

`/theme` 一直有同一个 bug，只是没人报告。

### 修法：一个槽位，而不是一份清单

新增 `FullscreenOptions.aboveInput: Component` —— 「转录与输入之间的一切」作为
**一个容器**传入：

```
aboveInput = Container[ notices, working, interactionText, themeText, thinkingText ]
```

- 主屏 `tui.addChild(aboveInput)`，全屏 `aboveInput` 槽位引用同一个容器。
- `printFinalDocument()` 也改读这个容器（原先逐个枚举，同样的漏项风险）。

判据不是「把两个组件补进 `mountFullscreen`」—— 那是修症状：再新增一个面板还会重犯。
判据是**清单只有一个所有者**。

### 测试坑（两次都值得记）

1. **假终端不会自动重绘**。`requestRender()` 是合并 + 异步的，断言紧跟在
   `submit()` 之后拿到的是空串（第一次我据此误判成"没挂上"）。要 `await` 一个
   短定时器让 alt screen 的重绘落地。
2. **真机排查要看全屏期间输出，不能看退出后的文档**。alt screen 的内容在退出时
   被丢弃，最终文档只含主屏内容 —— 我第一版脚本在退出后找状态行，得到
   `applied=false` 的假阴性。第二次在按键之后立即打标截取，才看到
   `thinking level: medium`。

### 变异验证

| 变异 | 变红 |
| --- | --- |
| fullscreen 不传 `aboveInput`（还原成旧布局） | 2 |

### 验收

- [x] 单测 +2（全屏下 `/thinking`、`/theme` 面板必须被**屏幕上那个渲染器**画出来）。
- [x] 真机 pty：全屏下 `Thinking level` + `Low [low]`/`High [high]` 可见；`/theme` 面板可见。
- [x] 方向键 + enter 生效（状态行 `thinking level: medium`、状态栏 `• medium`）。
- [x] `--main-screen` 模式无回归。
- [x] `prepublishOnly` 全绿：**601 测试**。

## Step 25 — neeko-check 审核修复（选择器骨架）

> 审核范围：本任务全部改动（24 文件 + 3 新增，全在 `packages/dsh-neeko/**`）。
> 15 条红线 **N/A**（`AGENTS.md:49`：`packages/**` 是 Node 库）；维度 = 架构三原则 + 最佳实践。

### 第一性原理：一个选择器只有三件事

审核发现 `/model`、`/theme`、`/thinking` 三个选择器各自复刻了同样的三份东西，且已经漂移
（theme 面板 wrap、thinking 面板 clamp、pi 面板又 clamp）。回到最小构成：

1. **list + cursor**（状态）
2. **key → intent**（策略）
3. **带边框的面板，行文本由调用方给**（呈现）

差异只在「状态放哪」和「确认做什么」——那两项是参数，其余不该重复。

### 新增 `src/tui/picker.ts`（173 行，被四处消费）

| 导出 | 消除的重复 |
| --- | --- |
| `pickerIntent()` | `thinkingPickerIntent()` 与 `themePickerIntent()` 的**逐字节相同**函数体 |
| `movedIndex()` | `movedThinkingIndex()` + theme 的取模 wrap + 缺省的第四份游标数学 |
| `renderPanel()` | 两个面板各自的 `'─'.repeat(50)`、标题、hint、`→`/`✓` 标记 |
| `runPickerKey()` | `handleThemePickerKey` / `handleThinkingPickerKey` 两套 switch 结构 |

`renderThinkingPicker` 从 60 行降到 17 行（只剩行文本）；`theme-picker.ts` 从 100 行降到 69 行。

### 行为统一：clamp，不 wrap

决定性事实：pi 的 `ThinkingSelectorComponent` 委托 `SelectList`，而 `SelectList.handleInput`
是 `Math.max(0, Math.min(len - 1, index + delta))` —— **clamp**。
`ThemeController.movePicker` 用取模 **wrap**，是与参考不一致的那一份，且 wrap 会把
**渲染窗口**一起跳走（末行按下就整屏跳回顶部）。改为 clamp，测试改为断言 clamp 并写明理由。

### 顺手修掉的两个真实缺陷

1. **主题面板超窗时 `→` 标错行**：`renderThemePicker` 把 catalogue 的全局 index 直接
   传给行渲染，列表滚动后光标落在错误的位置（甚至落在面板外）。现在传
   `window.cursorRow`（窗口内位置）。变异（改回全局 index）→ 2 条变红。
2. **`LlmCatalogue.resolveModelInfo` 的返回类型是手写窄化结构**：dsh 侧 reshape 时它
   不报错，只是返回 `undefined`，症状回到「等级列表空且无错误」。改用
   `LlmModelReasoningInfo` 别名 —— 类型一变就是编译错误。

### 其余清单项

| 项 | 处理 |
| --- | --- |
| `ReasoningSupport` 是 `LlmModelReasoningInfo` 的手写副本 | 改为 `type` 别名；编出来才发现 effort id 是 **branded**，测试夹具随之改用 `ReasoningEffortId()`（以前用裸字符串是撒谎） |
| `transcript.ts` 的 `export { turnEndFailure }` 转发 | 删除；测试直接从 `dsh-adapter` 导入 |
| `getSelection` 的内联匿名返回类型 | 改为 `ModelSelection`（dsh 已有该类型） |
| `printFinalDocument` 绕过渲染抽象 | **保留并说明**：退出路径不能用 `start()`（会重发能力查询 → shell 乱码），`render(width)` 是唯一可用契约；注释记录理由 |
| `showStatus` / `addNotice` 并存 | **保留**：注释写明分工（状态 vs 内容/错误），本轮未发现第三种混用 |

### 变异验证（4/4 变红）

| 变异 | 变红 |
| --- | --- |
| `movedIndex` 改回 wrap | 3 |
| 去掉 `✓` 标记 | 5 |
| `escape` 优先级错 | 4 |
| `ThemeController` 又 wrap 回去 | 1 |

### 验收

- [x] `picker.ts` 被 `theme-controller` / `theme-picker` / `thinking` / `app` 四处消费，
      面板 chrome 单点（`grep "'─'.repeat" src/tui/*.ts` 仅剩 picker.ts）。
- [x] 三个选择器行为一致：同一组键、同一 clamp 规则、同一边框宽度。
- [x] 单测 **608**（+5 picker 骨架/执行器，+1 超窗光标回归）。
- [x] 真机 pty：`/thinking` 与 `/theme` 面板在全屏下均可见，边框统一 50 列。
- [x] `prepublishOnly` 全绿。

## Step 26 — `/resume` 会话恢复（用户需求）

用户原话：「支持会话恢复命令 resume，选择 resume 命令列表当前的会话列表，当选择某个会话时
能进行恢复，参考 pi-tui 的实现」。

### DSH 有哪些可用 API（先查，再造）

| 入口 | 结论 |
| --- | --- |
| `ctx.sessionQuery.listSessions()` | ✅ 正确来源：newest-first 的 `SessionRecord[] = { header, live, persisted }` |
| `ctx.sessionQuery.readTitle(id)` | ✅ 标题是**每个会话一次独立日志读取**，不在 `SessionRecord` 里 |
| `ctx.sessionPersistence.list()` | 下层同源（`listSessions` 内部就是调它），不是替代方案 |
| `dsh-api-session-controller.list()` | web 层封装，TUI 侧无此依赖 |
| `agents.resume({ resumeSessionId })` | ✅ 恢复入口，runner 已在用 |

**结论：支持**。不需要方案 B（自己解 zstd / 解析 header）——那会重复实现 dsh 的存储契约。

### 真机根因：挂起的是标题，不是列表

初版把 `listSessions()` 与 419 次 `readTitle()` 放在同一个 `Promise.all` 里。真机上
`/resume` 45 秒无反应。逐层插桩（写到文件，绕开 alt screen 覆盖）得到决定性数据：

```
P2 before-list
P2 query-ok n=419      ← 列表本身是通的
```

配合一项独立测量：**扫描 413 个会话文件只需 16ms**。所以「慢」不成立 ——
挂的是 419 次逐会话日志读取。

排查过程中被证伪的三个假设（记下来避免重走）：
1. `inject` 未声明 `sessionQuery` → 加了 `inject`，无效，已撤销。
2. 锁竞争 → `tryLockExclusive` 是非阻塞的，失败立即抛错，不会挂。
3. 目录太大扫得慢 → 实测 16ms。

### 修法：列表与标题分离

- `listSessions()` 只返回 `{ header, live, persisted }`（廉价）。
- `sessionTitles(ids)` 单独取标题，**面板先出**，标题到达后合并重绘，并**保留用户
  已移动的光标**（重绘不能把选择拽回原位）。
- 标题失败只降级（行回落到会话 id 前 8 位），不影响列表可用性。
- 5 秒超时把「按键毫无反应」变成屏幕上的明确错误 —— 这是任何方案都需要的防护，
  也是这次能从「静默死键」定位到真因的关键工具。

**真机延迟：45s 超时 → 0.13 秒。**

### 复用上一轮的 picker 骨架

`/resume` 没有新写一套面板：`renderPanel` + `runPickerKey` + `movedIndex` 直接复用，
`resume-list.ts` 只负责「一行说什么」（标题/cwd 尾段/相对时间/`[current]` 标记）。

### 顺手补的穷尽性守卫

`submit()` 的 `switch (action.kind)` 原本没有 `default`，新增 `resume` variant 时
**不会**编译失败 —— 命令会静默什么都不做。加了 `assertNever()`：

```ts
default:
  return assertNever(action, 'unhandled command action')
```

### 验收

- [x] 单测 **634**（`resume-list` 9 + glue 17）。
- [x] 变异 4/4 变红（submit 未接 / picker 不接管键盘 / id 不生效 / 光标不落当前会话）。
      M4 首次 0 红：夹具里当前会话恰好在首行，`return 0` 与正确实现输出相同 ——
      这是第二次踩同一个坑（thinking 那轮也是），**夹具必须让错误实现产生不同输出**。
- [x] 真机 pty：`/resume` 面板 **0.13s** 出现、列出真实会话、上下移动 + enter 恢复。
- [x] `prepublishOnly` 全绿。

## Step 27 — `/resume` 标题按页加载（用户反馈）

用户原话：「不需要一次全部加载出来，应该需要支持分页加载的方式，会话加载太多会影响性能」。

### 为什么必须分页（实测，不是推断）

一个标题 = **读一次并解压一个会话 artifact**。三种做法在真实 profile（437 个会话）上的结果：

| 做法 | 结果 |
| --- | --- |
| 全部一次加载（424 并发） | **永不完成** —— 40 秒仍在 pending |
| 固定头部窗口（前 20） | 面板秒开，但**滚过去的行永远是 id** |
| **跟随可见窗口分页** | 面板秒开，滚动到哪取到哪 |

dsh 自己的 prepared-session 缓存默认就是 **5** —— 印证了并发必须有界。

### 实现

| 位置 | 职责 |
| --- | --- |
| `runner.sessionTitles(ids)` | 有界并发（5/批）；`readTitle(id).title`（返回的是完整 `SessionTitleSnapshot`，不是字符串） |
| `app.fillSessionTitles()` | 只请求 `listWindow(...)` 当前页的 id，跳过已缓存的 |
| `sessionTitleCache` | 按 id 缓存 → 滚回去免费 |
| `sessionTitlesPending` | 同一页不重复请求 |
| `sessionTitlesGeneration` | 面板重开/关闭时递增 → **过期页直接丢弃**，不会覆盖新面板 |

面板本身也窗口化（10 行 + `↑/↓ N more`），否则 437 行会把编辑区顶出屏幕。

### 一个被我改坏又改回来的地方

诊断中我一度把 `out[id] = title.title` 改成 `typeof title === 'string'`，**那是错的**：
`readTitle()` 返回 `SessionTitleSnapshot` 对象。真机插桩的原始输出：

```
KNOWN readTitle={"title":"say MARKER-BEFORE-CLEAR","messageSeqs":[8],"source":{"kind":"fallback"},...}
```

原始代码一直是对的。教训：**诊断期间不要顺手"修正"看起来可疑但未验证的行**。

### 最终验证（真机，文件日志 + pty）

```
R session-b02f6c69 -> "hello"
R 2833ce5f-fd42-48 -> "You are analyzing the `src/tui/`"
R session-0f6506b0 -> "say RESUME-MARKER please"
...
共请求 135 次（不是 437）
```

- 分页生效：437 个会话只请求了 135 次
- 屏幕确认：滚到排名 44 后出现真实标题 `hello`
- 前 10 名确实 `UNDEF` —— 那些是我 pty 测试产生的空会话（title=null），不是缺陷

### 变异验证（4/4 变红）

| 变异 | 变红 |
| --- | --- |
| 一次全量加载 | 2 |
| 不查缓存 | 1 |
| 滚动不取新页 | 1 |
| 不丢弃过期页 | 1（首次 0 红：原断言用「已关闭」场景，两条路径都得空 panel；改成「重开后有旧页到达」才锁住） |

### 验收

- [x] 单测 **636**（分页 6 条：只请求可见页 / 命中缓存 / 滚动取新页 / 标题上屏 / 页失败降级 / 丢弃过期页）。
- [x] 真机：面板 3 秒内出现（不等标题），`↓ 427 more`，滚动后真实标题上屏。
- [x] `prepublishOnly` 全绿。

## Step 28 — `/resume` 预扫描标题再过滤（用户选择方案 B）

用户反馈「还是看不到」，并选择「先取第一页标题再显示」（方案 B）。

### 三个真因（逐个实测排除）

| # | 原因 | 证据 |
| --- | --- | --- |
| 1 | **profile 里是旧构建** | `lib/` mtime 1792417923 vs profile 副本 1792417657（旧 266 秒）。已加 `scripts/sync-profiles.mjs` |
| 2 | 用户贴的 10 个 id **全部无标题** | 逐个查 projcache：`title=None`、`titleInput.count=0`（从未发过消息） |
| 3 | 预扫描窗口太小 | 前 60 名**零个**有标题，第一个有标题的正好在 index 60 |

### 方案 B 的可行性来自批量 API

之前「预取判据页」失败（60 个 2 秒超时）是因为走逐条 `readTitle`。dsh 有**批量**读：

```ts
ctx.sessionQuery.readTitleSnapshots(ids)   // 共享一次 corpus observation
```

实测对比：

| 路径 | 60 个 | 150 个 |
| --- | --- | --- |
| 逐条 `readTitle` | **2 秒超时，0 个** | — |
| 批量 `readTitleSnapshots` | 320 ms | **908 ms，拿到 50 个标题** |

### 实现

- `runner.sessionTitles` 优先走批量 API，失败回落逐条（兼容旧 dsh）。
- `app.rescanTitles()`：打开面板前预扫描 `RESUME_PRESCAN = 150` 个，**不设超时**
  —— 它决定面板内容，部分扫描会让「已过滤」看起来像真的。
- 过滤键仍是「有无标题」：`visibleResumeChoices()`，`/resume all` 可看全部。
- 其余分页与缓存机制不变（滚动仍按可见页补）。

### 真机结果

```
→ ✓ 271194d5 · dsh-neeko · now
  hello · dsh-neeko · 3h
  You are analyzing the `src/tui/` · dsh-neeko · 4h
  hello · dsh-neeko · 4h
  say RESUME-MARKER please · dsh-neeko · 5h
  run bash: echo PADCHECK · dsh-neeko · 5h
提示: hiding 403 session(s) with no conversation — /resume all to show them
```

**打开延迟 1.95 秒**（`listSessions` 159ms + 预扫描 908ms + 渲染）。

> 曾误判为 15 秒 —— 那是 pty 脚本的 `read_for(15)` 固定等待。教训：测延迟要用
> 「轮询到目标字符串即返回」，不能用固定 sleep。

### 新增工具：`scripts/sync-profiles.mjs`

`file:` 依赖装进 profile 的是**目录拷贝，不是软链接**（实测 `realpath` 指向自身），
所以 `pnpm run build` 之后必须同步。脚本按 `$DSH_HOME/profiles/*` 扫描、用包名判定，
连 `cordis.patch.yml` 一起拷（它也是运行时 surface）。

### 验收

- [x] 真机：面板首屏全部为真实标题，隐藏计数与 `/resume all` 提示正确。
- [x] 打开延迟 1.95s。
- [x] 单测 **642**；`prepublishOnly` 全绿。

## 不在本轮范围

- `ctrl+t`（pi 的独立 thinking 折叠键）：本轮只有一个折叠维度，不引入第二个键。
- 按 turn 窗口化的默认折叠（原 `boundary` 想做的事）：生产从未启用，不复活。
