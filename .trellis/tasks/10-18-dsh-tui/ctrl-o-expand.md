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

## Step 29 — 整屏滚动（用户反馈）

用户原话：「当前滚动方式参考 pi-tui 的方式，当前是在内容部分滚动，需要的是整个屏幕的滚动，
不需要自己实现滚动」。

### pi 的结构（从 dist 精确取出，非推断）

```js
function createChatViewport(options) {
  const transcript = new ScrollView(options.document, { follow:'end', primary:true, ... })
  const dock = new VStack([ pendingMessages, status, widgets, editor, widgets, footer ])
  return { transcript, root: new VStack([
    { component: transcript, basis:0, grow:1, shrink:1, minSize:1 },
    { component: dock,       basis:'auto', grow:0, shrink:1, minSize:1 },
  ])}
}
// 且 documentContainer = Container[ headerContainer, loadedResourcesContainer, chatContainer ]
```

**ScrollView 包的是「document」= banner + 转录**，只有 dock（输入/状态/页脚）固定。

### 我们的偏差

`ScrollView(messages)` —— 只包转录。banner 在 ScrollView **之外**，所以滚动时
对话在静止的 banner 下方滑动，而不是整屏滚动。

### 修法

- `FullscreenOptions.header + .transcript` → **`.document: Component`**（一个容器）。
  拆成两个字段正是让人「只包转录」的原因；一个字段没有第二种解释。
- `TuiApp` 新增 `document = Container[banner, messages]`，主屏与全屏都挂它：
  - 主屏：`tui.addChild(document)`（原先两行）
  - 全屏：`mountFullscreen({ document })`
  - `printFinalDocument()` 也读它（原先是逐个枚举 banner/messages）
- 布局对齐 pi：`[ {scroll, grow:1, shrink:1, minSize:1}, aboveInput, {input, minSize:3}, footer ]`。

### 复用而非自造

没有自己实现滚动：`ScrollView` 的 `follow:'end'` + `primary` + `overscroll:'chain'` +
`scrollbar:'auto'` 全部沿用，键盘/滚轮/PageUp 由 `TuiAltScreen` 自己处理。

### 变异验证

| 变异 | 变红 |
| --- | --- |
| `ScrollView` 不含 banner（还原成只滚转录） | **26** |

（另试「把输入区 grow 进滚动区」→ 0 红，但那是**我的变异假设错了**：`grow` 只影响
VStack 内的高度分配，不会把组件移进 ScrollView。不是测试缺口。）

### 验收

- [x] 单测 +2：整屏滚动（`row 39` 可达、`row 0` 已滚出）与 dock 固定（input/footer 恒在）。
- [x] 真机 pty：PageUp 后 banner 仍在文档流中、视口顶部是 `LINE-3` 而非 `LINE-1`，
      证明整个文档在滚。
- [x] `prepublishOnly` 全绿：**649 测试**。

## Step 30 — 工具行改为原生 pi 的呈现（用户需求，方案 B）

用户原话：「先抹除之前参考的 dsh-pi-tui，直接参考原生的 pi-tui 的界面内容数据显示，
之前的 dsh-pi-tui 显示很乱」。选择方案 B（完整对齐原生 pi）。

### 原生 pi 的实际规则（读 `render-utils.js` / `tool-execution.js`）

`formatToolCallWithArgs(title, args, theme, expanded)`：

- **折叠**：`bold(name)` + `key=value` 对，整行裁到 `COLLAPSED_ARGS_CHARS = 100`
- **展开**：`bold(name)`，然后每个参数一行 `key: value`，续行缩进
- **无 emoji、无 variant 分类、无 status pill**；状态靠背景色
  （`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`）
- **结果体**：折叠取前 `FALLBACK_PREVIEW_LINES = 10` 行 +
  `... (N more lines, ctrl+o to expand)`
- 卡片是 `Box(1, 1, bg)` —— 上下各留 1 行
- 助手消息前置 `Spacer(1)`（`hasVisibleContent → Spacer(1)`）

### 删掉的东西（全部是 dsh-pi-tui 的发明）

| 删除 | 原来是什么 |
| --- | --- |
| `TOOL_VARIANTS` / `classifyTool` | 七类伪分类（read/search/bash/write/edit/code/others） |
| `VARIANT_TITLES` / `VARIANT_EMOJIS` | 每类一个标题 + 一个 emoji |
| `TOOL_TITLES` / `SYNTHETIC_TITLES` | 按工具名覆盖标题 |
| `deriveSummary` | 从 args 猜一段摘要 |
| `toolEmoji` / `toolHeader` | 把上述拼成 `🖥️ Bash <summary>` |
| `isFileRead` / `hiddenLines` | 折叠时按工具类型特殊处理 |
| status pill | `[ok]` / `[error]` / `[running]` 文字标签（背景色已表达） |

一行曾经长这样（**四个标签描述同一个调用**）：

```
🖥️ Bash Print TOOLCHECK [ok] — TOOLCHECK (+2 lines, ctrl+o)
```

现在是：

```
 bash command="echo TOOLCHECK" description="Print TOOLCHECK marker"
   TOOLCHECK
```

### 新增

- `formatToolHeader(name, args, paint, expanded, bold)` —— pi 的 header 规则
- `argsPreview(args)` —— `key=value` 预览 + 100 字符裁剪（模块私有：它是
  `formatToolHeader` 的一个分支，没有名字的 header 不算 header）
- `toolOutputLines(result, expanded, paint)` —— 10 行预览 + `(N more lines, ctrl+o to expand)`
- `Theme.bold()` —— 加粗是终端属性而非主题色，`Theme` 才是它的所有者；
  `markdownThemeOf()` 的 `bold` 改为复用（消除第二份实现）
- `RenderOptions.bold` 注入点（app 传 `theme => theme.bold`）

### 一处诚实记录

变异验证时我先写了「header 不显示参数」的变异，得到 **0 红**——一度以为测试有缺口。
实际是**变异字符串没匹配上**（清掉了三元表达式的一部分而非整个分支）。修正后 5 条变红。
教训：变异必须确认真的改到了代码；`grep` 一下变异后的行比相信 0 红更可靠。

### 变异验证

| 变异 | 变红 |
| --- | --- |
| header 不显示参数 | **5**（首次因变异未生效而假 0 红） |
| 折叠不限行数 | 6 |
| 去掉前置空行 | 3 |

### 验收

- [x] `tool-present.ts` 273 → 231 行；variant 表 200 行全部删除。
- [x] 单测 **637**（`tui-tool-present.spec.ts` 15 条全新契约）。
- [x] 真机 pty：`bash command="echo TOOLCHECK" description="..."`，
      **无 emoji / 无 `[ok]` / 折叠提示为 pi 措辞**。
- [x] `prepublishOnly` 全绿。

## Step 31 — 命令回复从 dock 移入对话流（用户报的钉底 bug）

用户报的现象（附截图）：`/compact` 的回复 `No compactable history yet.` **钉在输入框正上方**，
不随对话滚动。用户原话：「当前工具执行结果持续在底部不跟随消息滚动」，确认是选项 C。

### 排查过程（先说结论，再说弯路）

**弯路一：怀疑工具卡在 dock。** 实测排除 —— 工具卡在 `messages` 里，逐帧重放确认它
紧跟 reasoning、后面还有下一条 assistant 消息，都在同一条流里。

**弯路二：怀疑 `follow: 'end'` 用错。** 读了 pi 的 `chat-viewport.js`，
`new ScrollView(document, { follow: "end", primary: true, overscroll: "chain" })` ——
与我们的 `fullscreen.ts` **逐项相同**。PageUp 也实测有效（第二帧输出空 = 已到顶）。

**弯路三（假线索）：怀疑 repaint 风暴。** pty 探测收到 366 万帧，一度以为有死循环。
实际是 `select` 在 pty EOF 后空转；修正探测逻辑后 197 帧，正常。

**真正根因**：用户给截图后才定位 —— 回复来自 `addNotice()`，而 `notices` 容器挂在
`aboveInput`（dock，`fullscreen.ts` 里 dock 是**不滚动**的固定行）。所有 `/` 命令的
持久回复（`/help`、`/model`、错误、`/compact` 结果）都走这条路，全部钉底。

### 改动

`notices` 从 `aboveInput` 移入 `document`，紧跟 `messages` 之后：

```
TuiMainScreen
 ├─ document          ← 滚动区
 │   ├─ banner
 │   ├─ messages      (transcript)
 │   └─ notices        ← 移到这里（命令回复）
 ├─ aboveInput        ← dock，不再含 notices
 │   ├─ working
 │   ├─ interaction / theme / thinking / resume
 ├─ editor
 └─ status
```

**保留独立容器**（不复用 `messages`）：`mountTranscript` 每次 flush 重建自己的容器，
写进去的回复下一次 repaint 就没了。这个理由与位置无关，仍然成立。

**dock 保留什么**：只有「滚动时仍需可见」的瞬态内容 —— 单行活动提示、审批面板、
选择器面板、输入框、状态栏。与 pi 的 dock 语义一致。

### 对照 pi

pi 的 `/compact` 根本不往固定区写文本：`handleCompactCommand` 直接
`await this.session.compact()`，结果通过会话事件变成一条 chat entry
（`CompactionSummaryMessageComponent`）。命令回复是**对话内容**，不是 UI 提示。

### 变异验证

| 变异 | 变红 |
| --- | --- |
| `notices` 移回 `aboveInput` | **3** |

### 真机验收

历史为空时 `/compact`：

```
 / commands · ctrl+o expand · ctrl+c exit
 No compactable history yet.          ← 在文档流里，不再钉在输入框上方
```

历史非空时（实际生效）：

```
 16  MARKER-ONE
 17  ❯ This is an automatic…
 19  Compacted 4 history items (~4781 tokens).   ← 紧跟消息之后
```

- [x] 单测 **640**（`tui-app.spec.ts` 新增 3 条锁定容器归属与顺序）。
- [x] `prepublishOnly` 全绿。

## Step 32 — neeko-check 复审后的问题修复

对 Step 30–31 的改动做了一次规范审核（增量，12 文件）。`packages/**` 的 15 条红线
全部 N/A（根 `AGENTS.md:49`），审核聚焦架构原则 / 最佳实践 / TDD。共 6 项，全部修复。

### Block 级

**1. 死参数 `cwd` 整条链路**

`RenderOptions.cwd` 与 `RenderContext.cwd` 已无任何读者 —— 删除 variant 表后，
唯一消费者 `toolHeader(name, args, cwd)` 没了，`cwd` 成了「只写不读」的字段，
而 `app.ts` 仍在每帧传 `cwd: this.cwd()`。

按第一性原理确认它**不是被误删的能力**：pi 原生对路径工具确实用 `shortenPath()`
折叠 home 前缀，但那是 `find`/`read` **各自 renderer** 的事，不是通用 header 的责任。
通用 header 显示 `path="/work/src/a.ts"` 原样，与 pi 的 `formatToolCallWithArgs` 一致。
所以删，不补（YAGNI）。

**2. 死函数 `indent()`**

原本服务 `renderTool` 的「运行中显示 args」分支，该分支已被 pi 的
`formatToolHeader` 取代。零调用点。

### Warning 级

**3. `printFinalDocument()` 打印了错误的组件**（真实行为差异，有复现）

它打印 `this.editor`，但编辑器现在住在 `inputSlot` 里。实测：**`/model` 面板
打开时退出，最终文档不含面板内容** —— 打印了一个未挂载的组件。

这与 Step 31 的 `/model` 卡住是**同一类错误**：修了读取路径（谁在槽里），
漏了打印路径。改为打印 `this.inputSlot`。

**4. 测试文件遮蔽 + 三份 `strip`**

`tests/tui-fullscreen.spec.ts` 新增的 `describe` 内定义了局部 `function mount()`，
遮蔽了模块级同名函数。同文件还有三份 `strip()`（最新那份少了 `_pi:` 规则，已漂移）。
→ 局部函数改名 `mountScrollingDocument()`，`strip` 提到模块级唯一实现。

### Nit 级

**5. `Paint` 签名重复内联 5 次**

`transcript-view.ts` 有 5 处 `paint: (token: ThemeToken, text: string) => string`。
`tool-present.ts` 已导出 `Paint`，改为 `import type { Paint }` 复用。

**6. `bold` 四层穿透 → 一层**

原链路：`app` → `RenderContext.bold` → `RenderOptions.bold` → `formatToolHeader`。
四层传递只为一次调用。

第一性原理：`fg` 与 `bold` 都是**主题提供的能力**，且抵达同一批 renderer。
`renderRow` 本来就有 `theme` 参数在派生 `paint`，`bold` 却另开一条通道 —— 这就是耦合。

→ 引入 `ThemeCapabilities { fg; bold? }`，一个参数承载两者：

```ts
// 之前
renderRow(row, { fg }, md, { bold, ... })
// 之后
renderRow(row, { fg, bold }, md, { ... })
```

`bold` 保持可选，所以只画颜色的调用方（测试、dump）仍能渲染，只是不加粗。

**顺带修一处热路径开销**：合并没有把 `capabilities` 对象放进每行的 `map` 回调里
（那样每帧 N 次分配），而是提到循环外，一帧一个。

### 变异验证

| 变异 | 变红 |
| --- | --- |
| `theme.bold` 被忽略 | **1** |
| 退出时打印 editor 而非槽 | **1** |
| header 不传 bold | **1** |

### 验收

- [x] 单测 **647**（新增：主题 bold 生效 / 无 bold 时降级 / 退出打印槽位占用者）。
- [x] 死代码零残留（`cwd`、`indent` 均已无定义）。
- [x] `prepublishOnly` 全绿（tests + tsc×2 + build + publint）。

## Step 33 — 第二轮独立复核

Step 32 修完后要求「再检查一遍」。这轮不重复上轮结论，从**未被检查过的维度**入手。

### 发现一：`NO_BOLD` 与内联恒等函数重复（DRY）

`tool-present.ts` 有 `NO_BOLD`，`transcript-view.ts:168` 又内联了一份
`(text: string) => text`。同一个概念两处定义。

→ 导出 `NO_BOLD` 与 `Bold` 类型，`renderTool` 的参数类型改为 `Bold`。
（`PLAIN_MARKDOWN_THEME` 里那 16 个恒等函数**不算**重复：它们是刻意的空主题，
每个字段语义不同。）

### 发现二：`ThemeCapabilities.fg` 与 `Paint` 是同一签名

前者写成方法形式 `fg(token, text): string`，后者是函数类型。结构兼容但不统一，
导致 `app.ts` 写出 `Parameters<typeof theme.fg>[0]` 这种绕弯代码。

→ `ThemeCapabilities.fg: Paint`（直接复用），`app.ts` 改用显式 `ThemeCapabilities`
标注，`Parameters<...>` 消失。

**同时修正一处措辞**：我最初写「`Theme` 已满足接口，无需 adapter」——验证后
不成立：`Theme` 的成员是绑定到实例的方法，赋给裸函数类型仍需箭头包装。
注释改为准确表述。

### 发现三：三个导出没有外部读者（最小暴露面）

对 `tool-present.ts` / `transcript-view.ts` / `theme.ts` 的全部 export 做了
读者扫描（`src/` 内其他文件）：

| 符号 | 外部读者 | 处置 |
| --- | --- | --- |
| `FOLDED_PREVIEW_LINES` | 0（仅自用） | 收回模块私有 |
| `argsPreview` | 0（仅测试直接调） | 收回模块私有 |
| `COLLAPSED_ARGS_CHARS` | 测试引用边界值 | 保留 export |
| `FOLDED_CHARS` | 测试引用边界值 | 保留 export |

`argsPreview` 在测试里只有一个 describe，断言「空输入返回空串」——而该行为已被
`formatToolHeader('bash', {}, …)` 返回裸名字覆盖。**删除该 describe**：为一个已由
公开 API 覆盖的内部函数单独写测试，是测试耦合实现。

### 变异验证（本轮）

| 变异 | 变红 |
| --- | --- |
| `NO_BOLD` 改成非恒等 | **5** |
| header 丢 bold | **1** |
| 折叠不截断 | **6** |

### 验收

- [x] 单测 **646**（净 −1：删掉测内部函数的冗余 describe）。
- [x] 导出面收敛：`FOLDED_PREVIEW_LINES` / `argsPreview` 转私有。
- [x] `prepublishOnly` 全绿。

## Step 34 — 第三轮复核：测试夹层的 ANSI 剥离统一

前两轮修的是 `src/` 的问题。这轮换到 `tests/`，按「最大化复用」找出**同类实现的散落**。

### 根因：七份 ANSI 剥离，规则各自漂移

| 文件 | 规则 |
| --- | --- |
| `tui-render-row` | `[0-9;]*m` |
| `tui-status-bar` | `[a-z0-9;]*m` |
| `tui-banner` | `[0-9;?]*[a-zA-Z]` |
| `tui-interaction-glue` | `[0-9;]*m` + `_pi:` |

后果是**测试之间的文字不可移植**：一条断言在 A 文件能过、在 B 文件会失败，因为剥掉的
字符集不同。上一轮修的 `tui-fullscreen.spec.ts` 三份 `strip()` 漂移只是这个模式的局部。

→ 新建 `tests/support/ansi.ts` 的 `stripAnsi()`，规则一次说清：

- **SGR** `\x1b[…m`，含主题实际发出的 `38;2;r;g;b` 复合形式
- **光标/屏幕控制** `\x1b[…H/J/K` 与私有模式 `\x1b[?25h/l`
- **OSC** `\x1b]…\x07` 或 `\x1b]…\x1b\\`（超链接、剪贴板）
- **pi-tui fake-cursor** `\x1b_pi:…\`

7 个文件全部改为委托，本地实现清零。

### 顺带暴露一个测试夹具造假问题

`tui-status-bar.spec.ts` 的 paint 桩写成 `\x1b[${token}m${text}\x1b[0m` —— 把 **token 名**
塞进 SGR 参数位。SGR 参数只能是数字、`;`、`?`，所以 `\x1b[route-magpie-autom`
**不是任何终端或剥离器认识的序列**，宽度断言因此建立在假数据上。

修法不是放宽剥离器迁就它，而是让桩回到真实形态：token 名改走 **OSC** 序列
（`\x1b]8;;token\x07`）—— 真实的转义序列、真的零宽、真的能被 `visibleWidth` 忽略，
同时测试仍能读到用了哪个 token。

这是一次有意义的「测试先骗自己、再骗实现」的暴露：如果剥离器当初为了让它通过而放宽规则，
真实主题的复合 SGR 就会被漏掉。

### 一处刻意保留

`tui-render-row` 的 `flat()` 与 `tui-interaction-glue` 的 `transcript()` 最初各自只去
`_pi:` 保留颜色。核查后确认下游断言全是纯文本（`toContain('line 19')`、查找 `❯`），
统一为 `stripAnsi` 无损。

### 变异验证

| 变异 | 变红 |
| --- | --- |
| 移除 SGR 规则 | **12** |
| 移除 `_pi:` 规则 | **2** |

12 红说明共享剥离器确实被整个 suite 使用，而不是「建了但没人用」。

### 验收

- [x] 单测 **653**（+7：`tests/support/ansi.spec.ts` 覆盖四条规则）。
- [x] 本地剥离实现清零（`grep` 只剩 `support/ansi.ts`）。
- [x] `prepublishOnly` 全绿。

### 未做（记录理由）

`app.ts` 1937 行、8 个职责块，是明显的内聚问题。但拆分它属于**架构重构**，会同时打散
646 条测试的针对性，不适合与本次「问题清单修复」混在一起。已记录，另开任务处理。

`assertNever` 只在 `app.ts` 私有定义，`transcript-view.ts` 的 `switch` 无 `default` 但靠
TS 返回类型兜底（新增 variant 会因「函数可能不返回」编译失败）。为改善报错文案而新建
一个 utils 模块，收益小于成本 —— 按 YAGNI 不做。

## Step 35 — app.ts 第二轮瘦身：两个真正有状态的单元

上一轮把 `/resume`（279 行）抽出后，`app.ts` 仍 1643 行。这轮先量了一遍八块职责，
再决定抽什么 —— 标准是**有没有独立状态或独立不变量**，不是「哪块行数多」。

### 抽了什么，为什么

**1. `notice-log.ts`（166 行）—— 有独立不变量**

`notices` / `statusLine` / `statusTimer` 三个字段被十几个调用点直接摸，但它们守的是
同一条契约的**两头**：

- **上限**：`/help` 一次八行，不限量则整个会话的内存与每帧成本一起涨。
- **寿命**：状态行必须被**复用**而不是追加，否则每次 `ctrl+o` 都留一行
  `transcript: expanded` 在提示符上方；同时还必须**过期**，否则复用的槽位变成历史。

这两条是一体的：一个只管上限的容器会让状态行堆叠，一个只管复用的槽位会永久占位。
拆开写就会漏掉「状态行被上限挤掉后要重新挂载」这种情况 —— 而它正是原代码里
注释最多的一段。

**2. `row-cache.ts`（118 行）—— 纯函数，零 app 状态**

`rowSignature` 与 `syncChildren` 是 flush 里唯一不依赖 app 的五件事之一。它们各自
带一条值得单独说清的规则：

- 签名要**足够便宜**（每 50 ms 跑一次全量），但太粗会让流式回复冻住，太细则缓存
  永不命中；
- 协调要**按下标匹配**以保持子数组 identity，`clear()` + 重加会重建整个数组且逐项
  `indexOf`。

顺带把 `visibleRows`（`/clear` 的水位线）也搬过去 —— 它和上面两者构成「一次 flush
要画什么」。

### 没抽什么，为什么

- **`transcript + notices` 剩 143 行**：`mountTranscript` 的 flush 要 theme 投影、
  图片预取、renderer 调用和 `activeTui` 重绘。抽出去要传 6+ 个协作者，内聚反而降低。
- **`/thinking`（132 行）**：纯逻辑（`thinkingChoices` / `thinkingOutcome` /
  `renderThinkingPicker`）已在 `thinking.ts`。剩下的只是「读 support → 判分支 → 调
  回调」，没有独立异步状态、没有代数守卫，搬进 controller 只增一层间接。
- **`key arbitration`（190 行）**：真正分派只有 40 行，其余是 `toggleFold` /
  `syncSpinner` / 图片预取 —— 块归属标错了，但那是注释问题不是结构问题。

按 YAGNI：**不为行数搬家**。抽一个只会让调用链多一层、而耦合没有减少的模块，是
把「文件变小」当成目标而不是结果。

### 结果

| | 之前 | 之后 |
| --- | --- | --- |
| `app.ts` | 1643 | **1516** |
| 累计（从 1937 起） | — | **−421（−21.7%）** |

### 变异验证（6/6 有效）

| 变异 | 变红 |
| --- | --- |
| 去掉 notices 上限 | 3 |
| 状态行不校验是否仍挂载 | 2 |
| 状态行不重启倒计时 | 2 |
| 签名漏 `spinnerFrame` | 1 |
| 签名漏 `attachTime` | 1 |
| 签名漏 `result.length` | 1 |

最后一项**首次报 0 红**：我的变异脚本转义没匹配上，改对之后才红。同一个陷阱在这个
任务里出现第二次了 —— 变异必须 `grep` 确认真的改到了代码，不能相信 0 红。

### 验收

- [x] 单测 **696**（+18：`notice-log` 10 条、`row-cache` 18 条，含新增的 result 增长）。
- [x] `prepublishOnly` 全绿；连跑 5 次无 flake。
- [x] 真机 pty：`/help`、`/theme` 面板、工具卡 pi 形态、流式、正常退出全通过。

## Step 36 — 屏幕模式改成三态（neeko-check 复审后的根因修复）

上一轮把默认改成了 main screen，但 neeko-check 审出两个 Block：`DSH_NEEKO_MAIN_SCREEN`
文档说「force the main screen」而代码完全忽略它；`app.ts` 两处注释互相矛盾。

### 根因不是那两个 Block，是表示法

真实域有**三态**：显式 main / 显式 fullscreen / **未表态**（第三态携带默认值）。
它被写成 `mainScreen?: boolean`，而**每层对 `undefined` 的解释相反**：

| 层 | `undefined` 的含义 |
| --- | --- |
| `startup` / `TuiConfig` | 未表态 |
| `TuiApp.startOnMainScreen` | **fullscreen**（`!== true` 才进 alt screen） |

两种极性并存，信息在层间必然丢失 —— 这才是「默认值不可达」和「env 被忽略」的共同原因。
两个 Block 都是症状。

### 修法：给第三态一个名字

```ts
export type ScreenMode = 'main' | 'fullscreen'   // 缺省 = 未表态
```

- `startup`：`--main-screen` / `--fullscreen` → `screen`，**无 flag 就不写这个键**
- `cordis.patch.yml`：原样透传 `'main' | 'fullscreen' | undefined`
  （不再 `=== true`，那一步把「未表态」和「false」压成同一个值）
- `runner.screenModeOf()`：唯一的决策点（配置 > `DSH_NEEKO_SCREEN` > 两个旧变量 > 默认）
- `TuiApp.screenMode`：**执行**决策，不再自带默认

`TuiApp` 的字段名从 `startOnMainScreen`（布尔、负向、缺省=fullscreen）改为 `screenMode`
（具名、正向、缺省=main）。方向反了两次的根源就此消失。

### 顺带解决的

- **`DSH_NEEKO_MAIN_SCREEN` 真正生效**（此前无读取点），并新增 `DSH_NEEKO_SCREEN`
  统一两个旧变量；三者冲突时的规则与 flag 一致：**保守的 main 赢**
- `app.ts:482` 的旧注释（「Alt screen by default」）被删，与新语义一致
- `startup.ts` 的嵌套三元提为 `screenRequest()`，一个函数只回答「用户说了什么」

### 为什么 `startup` 不 import 那个类型

`ScreenMode` 定义在 `tui/fullscreen.ts`，但 `startup` 不依赖 `tui/*` —— 让 CLI 解析器
为了描述一个 flag 而拉进 pi-tui 是不划算的。`startup` 里用字面量联合，两处重复的是
两个 TypeScript 单词，不是业务规则；为此新建一个模块（YAGNI）反而更差。取舍写在类型注释里。

### 附带修掉一个反复出现的测试缺陷

`tui-fullscreen.spec.ts` **第三次**出现「局部 `function mount()` 遮蔽模块级同名函数」——
不报错，只是让那个 describe 静默地测另一套夹具。

Typescript 抓不到（两个函数互不相干、`noUnusedLocals` 也认为它被用了），所以加了一条
文本扫描测试 `tests/support/no-shadowed-helpers.spec.ts`：扫全部 spec，禁止嵌套同名函数。
用测试而不是引入 eslint —— 这个包刻意不带 lint 依赖，为一条规则装一整套工具不划算。

### 变异验证（6/6 有效）

| 变异 | 变红 |
| --- | --- |
| 默认改成 fullscreen | 2 |
| 配置不再优先 | 2 |
| 丢 `MAIN_SCREEN` 分支 | 1 |
| 丢 `DSH_NEEKO_SCREEN` | 1 |
| `app.ts` 默认改回 fullscreen | 2 |
| `startup` 不认 `--main-screen` | 4 |

「丢 `MAIN_SCREEN` 分支」**首次报 0 红**：默认本来就是 `main`，删掉那段结果不变 —— 说明它是
**冗余分支**。查清后才发现它只在「两个旧变量同时设置」时有效，于是补了那条冲突测试，
并顺势把优先级定成「保守的 main 赢」（与 flag 一致，此前是实现顺序的副作用）。

### 真机（8 种组合全部正确）

| 调用 | alt screen |
| --- | --- |
| 默认 | False |
| `--fullscreen` | True |
| `--main-screen` | False |
| `DSH_NEEKO_SCREEN=fullscreen` | True |
| `DSH_NEEKO_SCREEN=bogus`（应忽略） | False |
| `DSH_NEEKO_FULLSCREEN=1`（旧） | True |
| `DSH_NEEKO_MAIN_SCREEN=1`（旧） | False |
| `--main-screen` + `FULLSCREEN=1`（flag 赢） | False |

### 验收

- [x] 单测 **756**（+51：屏幕模式 9 条 + 遮蔽检查 46 条 + 测试改写）
- [x] `prepublishOnly` 全绿
- [x] 真机 8 种组合验证

## 不在本轮范围

- `ctrl+t`（pi 的独立 thinking 折叠键）：本轮只有一个折叠维度，不引入第二个键。
- 按 turn 窗口化的默认折叠（原 `boundary` 想做的事）：生产从未启用，不复活。

## Step 37 — pi-tui 原生能力对标（用户需求 · 测绘轮）

用户原话：

> 能否完全对标原生的 pi-tui，当前的 tui 很多功能和原生的 tui 差异很大，
> **不要出现问题改一遍又一遍**

约束比目标重要：它把任务从「补功能」改成「找出为什么会反复改」。
完整测绘（4 类 22 项，file:line 级）见 **`pi-parity.md`**，此处只留结论。

### 三条结论

**① 「改一遍又一遍」的机械原因：三种形态没形成开放集合**

| 形态 | pi 的载体 | 本仓现状 | 后果 |
| --- | --- | --- | --- |
| Overlay | `ui.showOverlay()` | **0 处**；用 `replaceInputSlot`（`app.ts:823`）顶替编辑器 | 同时两个面板不可能；`/model` 曾卡死 |
| Keybinding | `KeybindingsManager` + 28 个 `tui.*` | **0 处**；`handleInput` 手写 `matchesKey` 级联（`app.ts:1335`） | 无法重绑、无法 `/hotkeys`、面板优先级靠 `if` 位置 |
| Entry | 一个 `Component` 子类 | `switch (row.kind)`（`transcript-view.ts:102`） | 加一种行要改渲染器 |

每加一个面板/键位/行类型都要回中心文件改分支 —— 这就是反复改的来源。

**② 差距是「没接线」，不是「没实现」**

pi-tui 已提供而本仓使用数为 0 的：`showOverlay`、`KeybindingsManager`、
`setTitle` / `setProgress` / `setProgramStatus`、`captureRenderState` / `switchTuiMode`。
→ 优先级定为 **接线 > 重写**；任何「自己再实现一遍」都是负债。
（`Editor` 的 kill-ring / yank / undo 40 处是白得的，因为已经用了 `Editor`。）

**③ 用户截图那个现象 = A4 默认屏幕不对齐**

`runner.ts:129` 返回 `'main'`，pi `settings-defaults.js:61` 是 `"fullscreen"`。
`TuiMainScreen` 首次渲染的注释就是 "assumes clean screen"，它**不清屏** ——
所以 shell 命令行必然留在最上面。alt screen 进入时是 `?1049h` + `2J` + `H`。

### 用户决策

- **「pi 是什么行为就跟着什么行为」** —— 对齐判据不是「哪个更合理」，是「pi 怎么做」。
  因此默认屏幕定为 `fullscreen`，`--main-screen` / `DSH_NEEKO_SCREEN=main` 保留为 opt-out。
- **P2/P3 延后** —— 先把形态层做对，自造组件替换（`picker.ts` / `thinking.ts` /
  `status-bar.ts` / `transcript-view.ts`）单独一轮。理由：这四项与 849 条测试断言
  耦合深，混在形态改动里一旦变红就分不清是「形态没做对」还是「替换没对齐」。
  延后清单在 `pi-parity.md` §6.2。

### 执行顺序

| 步 | 内容 | 验收 |
| --- | --- | --- |
| P0-1 | `screen.ts`：`DEFAULT_SCREEN='fullscreen'`；删 `app.ts:482` 的 `?? 'main'`；`mountScreen()` 取代 `mountFullscreen()` | 真 pty 进入即整屏 |
| P0-2 | `keymap.ts`：`routeKey` + `KeyScope` 栈；`/hotkeys` | 849 测试全绿 + 新测试 |
| P1-3 | `overlay-host.ts`：`showOverlay` 替 `replaceInputSlot` | 两个面板可同时开 |
| P1-4 | `entry/` 注册表 | 加 `entry/diff.ts` 不改核心 |
| P1-5 | 内置 search（`TuiAltScreen` 白给） | `ctrl+shift+f` 可用 |
| P3-6 | `setTitle` / `setProgress` / `ctrl+z` / `ctrl+g` / `ctrl+v` | 对齐 `docs/keybindings.md` |

### 顺带记录：本仓自己定的铁律九已被违反

`screenMode` 的缺省值写在**两处**：`runner.ts:129` 返回 `'main'`，
`app.ts:482` 又写一次 `?? 'main'`。P0-1 会把缺省收敛成 `screen.ts` 的
`DEFAULT_SCREEN` 一个常量 —— 这是本轮要顺带修掉的结构性缺陷。

## Step 38 — P0-1 屏幕形态：默认对齐 pi，缺省收敛为单一来源

> 用户决策：「pi 是什么行为就跟着什么行为」。
> 上一步（Step 37）的测绘结论是 A4「默认屏幕不对齐 pi」+ D1「缺省值两处」。

### 用户报的现象

> 刚开始进入的时候 pi 是完整的界面，而 dsh-neeko tui 是还能看到命令行

真机取证：`TuiMainScreen` 首次渲染的注释就是 *"First render - just output
everything without clearing"* —— 它**不清屏**。所以 shell 那行
`tomgs@tomgs-2 neeko % dsh --profile neeko --tui` 必然留在最上面。
pi 的默认是 alt screen（`settings-defaults.js` → `tuiMode: "fullscreen"`），
进入时发 `?1049h` + `2J` + `H`，所以首帧是干净整屏。

### 修法

| 改动 | 内容 |
| --- | --- |
| 新 `src/tui/screen.ts` | `DEFAULT_SCREEN = 'fullscreen'`；`resolveScreen(config, env)` 唯一决策点；`mountScreen()` 两种形态；`ScreenParts` 四个聚合 |
| `app.ts` | 删 `?? 'main'`；构造时 `resolveScreen()` 一次；`screenParts()` 一个 builder 供两块屏共用 |
| `runner.ts` | `screenModeOf()` 降为 `resolveScreen()` 的别名，不再自带逻辑与缺省 |
| 删 `fullscreen.ts` | 并入 `screen.ts`（152 行 → 一块形态逻辑） |

**顺带根治 D2**：`mountFullscreen()` 的字段清单换成 `ScreenParts` 四个聚合。
面板挂在 `aboveInput` / `inputSlot` 容器里，屏幕收到的就是容器，**加面板无法被遗忘**。

### 挂载与启动分离

`mountScreen()` 只组装树、不碰终端；`start()` 才进 raw mode 与 alt screen。
理由：`TuiApp` 要先画 banner 再让字节到达终端；测试也能在没有 TTY 的情况下检查挂载树。
原实现两种屏的契约不同（alt 在 `mountFullscreen()` 内部 start，main 由 `TuiApp` start），
只有一种能在测试里跑。

### 变异验证（4/4 有效）

| 变异 | 变红 |
| --- | --- |
| `DEFAULT_SCREEN` 改回 `'main'` | 3 |
| `app.ts` 恢复 `?? 'fullscreen'` 第二缺省 | 1 |
| 删 `DSH_NEEKO_MAIN_SCREEN` 分支 | 2 |
| `mountScreen` 挂载即 start | 1 |

### 真机 pty（6 种组合）

| 调用 | altIn | altOut | capJunk |
| --- | --- | --- | --- |
| 默认 | True | True | False |
| `--main-screen` | False | False | False |
| `DSH_NEEKO_SCREEN=main` | False | False | False |
| `DSH_NEEKO_SCREEN=fullscreen` | True | True | False |
| `DSH_NEEKO_SCREEN=bogus`（应忽略→默认） | True | True | False |
| `DSH_NEEKO_MAIN_SCREEN=1` | False | False | False |

首帧专项：`?1049h` 后紧跟 `2J`+`H`（清屏+home），mouse reporting 开，
**shell 命令行不再泄漏**。

### 验收

- [x] 真 pty 进入即整屏，无 shell 命令行残留
- [x] `--main-screen` / `DSH_NEEKO_SCREEN=main` opt-out 正常
- [x] 缺省值只剩 `screen.ts:73` 一处（结构测试钉住 `app.ts` 不得出现 `?? '`）
- [x] 单测 **763**（48 文件）；删 `tui-screen-mode.spec.ts`（被 `tui-screen.spec.ts` 取代）
- [x] `prepublishOnly` 全绿；`build` + `sync-profiles` 已跑（铁律一）
- [ ] P0-2 键位栈（下一轮）

## Step 39–40 — pi-tui 原生对齐（S1…S4）+ 屏幕/滚动定案

> 测绘见 `pi-parity.md` §9。本轮是「对标 pi」的执行段，**用户三次纠正**推翻了我前两轮的判断。

### 用户决策链

1. 「pi 是什么行为就跟着什么行为」
2. 「不引入 pi-coding-agent，参考其组件写法移植到当前系统」
3. 「主题也包括，但可以加载 `~/.dsh/themes/*.json`，写法保持和 pi 一致」
4. 「先就保持和 pi 一样就行」

### S1 主题：补 fallback 链（不补则任何 pi 主题都崩）

**真实缺陷**：`Theme` 没有 pi 的 token fallback。pi 的 `dark.json` / `light.json` 都**省略**
`scrollbarTrack` / `scrollbarThumb` / `searchMatchBg` / `searchMatchText`，靠链补齐。

- `theme-tokens.ts` 加 `THEME_TOKEN_SPECS`（56 token 的 slot + 四个 fallback）
- `theme.ts` 加 `withTokenFallbacks()`；`has()` 改为「能否绘制」
- **顺带修**：构造函数把 `''`（终端默认色，合法）与解析失败（拼错）混为一谈，两者都写 reset
  → 拼写错误看起来像有意为之，且 `has()` 永远无法报告
- `theme-data.ts` 删掉内置主题里那 4 个 token（写死让 fallback 链在自带主题上永不执行）

真机：`~/.dsh/themes` 里 5 个真实 pi 主题全部可加载；`/theme` 列出 7 项。

### S2 消息组件：按源码移植

`message-view.ts` 移植 `UserMessageComponent` / `AssistantMessageComponent` /
`ToolExecutionComponent` / `formatToolCallWithArgs` / `keyHint`。删 `transcript-view.ts` 437 +
`tool-present.ts` 242。

修掉的真实缺陷：
- `zoneMarked` 用 `Container` 包装 → 丢 `children`，破坏 `invalidate` 传播；且每次返回新数组，
  破坏渲染缓存 → 改为在组件自身 `render` 上注入标记
- 折叠提示硬编码 `ctrl+o` → 用户重绑后提示错误 → `setKeyReader` 读实时注册表
- 工具卡缺前置 `Spacer(1)` → 卡片紧贴上一行

### S3 输入框：`CustomEditor` 的边框形态

`composer.ts` 移植 `renderTopBorder` + `getEditorTheme`；`status-indicator.ts` 移植
`StatusIndicator` / `DynamicBorder`。

**真实缺陷**：边框宽度少 1 列（pi 公式里 `"── "` 后那个前导空格漏了），两个分支都中招，
每帧边框比终端窄一列，右边框呈锯齿。

**照 pi 保留的怪癖**：约 24–36 列时标签和溢出标记会同时消失（`bothFit` 失败 → 降级 spinner
→ 落进 label-only 分支）。改了就与 pi 在同终端不一致，写成测试记录。

### S4 选择器：换 `SelectList`

`thinking-selector.ts` / `theme-selector.ts` / `resume-selector.ts`。删 `theme-picker.ts` 69。

**主题选择器新增能力：实时预览**（`onSelectionChange` → 改调色板，未提交）。真机确认下移一格
后重绘颜色真的变了（`118;129;134` → `135;144;149`）。

**真实缺陷**：`panel.list` 是构造时的字段，`applyFilter` 重建列表后仍指向旧对象 ——
`selectedModel` / detail 行 / `ctrl+s` 全部从没人看的列表读答案。改为 getter。

**`resume` 只移植面板**：pi 的 `SessionSelectorComponent` 892 行含 scope 切换 / 排序 / 删除 /
重命名 / 后台扫描，本仓都没有对应物（语料库契约就是 newest-first，且无持久化 API）。

### 屏幕与滚动：三次纠正（最终定案）

| 用户说 | 我的错误判断 | 事实 |
| --- | --- | --- |
| 启动不该看到 shell 命令行 | 以为 pi 默认 fullscreen | **pi 默认 regular**：`settings-defaults.js` 写 `fullscreen`，但 `getTuiMode()` 返回 `"regular"` 除非存的是字面量；用户 profile 就是 `"tuiMode": "regular"`。实测 `pi` 无 `?1049h` |
| 要终端 scrollback + 终端滚动条 | 用 alt screen 默认 | 只有主屏有。用户截图的滚动条即证据 |
| 消息滚动查看不了 | 把 `tailWindow` 当性能优化 | **`tailWindow` 是元凶**：裁成 `rows - dock`，超出部分根本不渲染，从未进 scrollback |

最终形态（零本地改良）：

```
main:       document(整个) + aboveInput + input + footer    ← pi regular
fullscreen: ScrollView(document) + 固定 dock                 ← pi createChatViewport
启动:       不清屏（pi 实测 2J=0 / 3J=0）
```

撤回三个自造改动：`tailWindow`、启动清屏（`2J`+`H`）、fullscreen 的 B2（编辑器进滚动流，
会让往上滚后无法输入）。`screen.ts` 388 → 340 行。

真机对齐验证：

| | pi regular | dsh main |
| --- | --- | --- |
| alt screen | False | **False** |
| 启动 `2J` / `3J` | 0 / 0 | **0 / 0** |
| 退出后 scrollback | 1383 行 | **1212 行** |
| 两轮对话保留 | ✅ | **✅** |

### 顺带修掉的真实缺陷

- `setClearOnShrink(true)` 在 `/clear` 后**永久打开** → 之后任何内容收缩都整屏重绘 + 清
  scrollback（22.9KB → 12.5KB）
- 退出路径 `drainInput()`：Kitty 释放事件（`9;5:3u`）留在 stdin 会被 shell 回显。
  **诚实记录：这个修复我未能复现验证**（四种场景都无乱码），保留是因为 pi-tui 文档明确要求
  且 `stop()` 此前从不排空 stdin；不声称它修好了用户报的现象。

### 验收

- **889 passed / 52 files**（S1 前 794）
- `prepublishOnly` 全绿 + `sync-profiles`
- 变异 35/35（含 6 条「首次 0 红」：1 条是真缺陷、5 条是测试不够刁钻）
- 用户确认：「这样没有问题，非常好」

## Step 41 — neeko-check 审核修复 + app.ts 拆分

> 用户指令：`/neeko-check` 从第一性原理 + 高内聚/低耦合/可扩展性审当前改动；
> 然后「app.ts 能否保持轻薄，可以拆分多文件的方式」。

### 审核方式

两个独立审核者并行（架构原则 / 规范一致性）+ 我逐条实测复核。
**15 条红线对本包全部 N/A**（Node 库，非 Tauri 后端）。

### 4 个 Block（全部实测复现）

| # | 缺陷 | 实测 | 修法 |
| --- | --- | --- | --- |
| B1 | `zoneMarked` 原地改写 `Text` 的缓存数组 | 500 帧首行 100→8116 字节（每帧 +16） | `[...lines]` 后再改 |
| B2 | `/resume` 高亮与实际选择脱节 | `view.index=2` 但选中仍 `s0`，enter resume 错的会话 | `setChoices` 增 `index` 参数 |
| B3 | `thinking-selector` 硬编码导航键 | 重绑后方向键与 `ctrl+n` **两键皆死** | 改走 `getKeybindings()` + `NAV_ACTIONS` |
| B4 | 屏幕模式文档三方矛盾 | 代码 `main`，CLI/README 说 `fullscreen` | 三处统一 + README 重写 |

### 8 个 Warning

W1 `styleBold` 手写 `\x1b[1m` → `theme.bold()`（铁律五）
W2 `stripTerminalControl` → `stripTerminalSequences`（实测 pi-tui 不处理 CR/C0，保留这两条）
W3 删死代码：`window.ts`(89)+测试、`renderPanel`/`runPickerKey`/`renderPanel` 等
W4 `app.ts` 拆分（见下）
W5 删 `keyHint`/`hintLine`（零消费者）
W6 **删掉 transcript 的整套动画** —— `spinnerFrame` 出签名、50 行定时器删除
W7 `PI_CODING_AGENT_DIR` → 统一为代码事实 `PI_AGENT_DIR`
W8 `AGENTS.md`/README 模块清单按实际重写

### W6 值得单独记：比审核者建议的更彻底

审核者说「两套 80ms 动画时钟」→ 建议合并。查下去发现**可以整个删**：
pi 的折叠思考行是纯文字 `Thinking...`，`🐳` 是本仓自造的。删掉 glyph 后
`spinnerFrame` 整条链（定时器 + 进签名 + 常量）都不需要 —— 每 80ms 不再重建流式行。

### app.ts 拆分（用户要求）

| 新模块 | 行数 | 职责 |
| --- | --- | --- |
| `panel-host.ts` | 125 | dock 的单占用者规则（三份复制的归宿） |
| `view-tree.ts` | 127 | 控件树（容器 + 文本行） |
| `subsystems.ts` | 134 | 四个 controller 的构造 |

`app.ts` **1851 → 1703**（-148），`selectListThemeOf` 移入 `theme.ts`。
顺手删掉 `resumeText` —— 建了、挂了、**从不写**的死行。

**未拆的**：`submit`(78) 的 14 个 case 必须留在 app.ts（每个都调 `this.xxx`，
且 `assertNever` 保证穷尽性）；`mountTranscript`(53) 是 flush 管线，抽出去要 6+ 个协作者。

### 变异验证 8/8

B1 / B2 / B3 / B4 / W4 / PanelHost.hide 不 restore / PanelHost 关闭仍报 consumed /
PanelHost.show 不清 dock / view-tree 无永久行 —— 全部有效。

其中 **B2 首次 0 红**：查明是没有任何测试覆盖「app 传递 index」这条路径
（之前的验证是临时脚本，没进测试套件）。补 3 条「enter 必须 resume 高亮行」后才抓住。

### 验收

- **896 passed / 51 files**（删 21 条死测试，加 26 条断言）
- `prepublishOnly` 全绿 + `sync-profiles`
- 本轮引入的死代码清零（`--noUnusedLocals` 只剩 `index.ts` 两条既有问题）
