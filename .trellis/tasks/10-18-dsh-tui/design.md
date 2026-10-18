# Design — DSH 完整 TUI

> 根因与可行性调研见 `prd.md`。参考实现：`@xmoon76/dsh-pi-tui`（源码
> github.com/XMoon/dsh-pi-tui），本机装有其 dist（`~/.dsh/profiles/pi-tui/`）。

## 0. 总体判断

pi-tui 承担「终端 UI 框架」全部职责（渲染 + 输入编码 + 组件），本任务只写
**DSH 适配层**：把 0.2.x 的 agent/session 事件喂进 pi-tui，把用户输入喂回 agent。
适配层结构与参考实现同构，但按 0.2.x 契约重写（参考实现是 0.1.x）。

```
┌─ packages/dsh-neeko ──────────────────────────────────┐
│ src/startup.ts      ← 加 --tui flag（唯一桥侧改动）    │
│ cordis.patch.yml    ← 加 TUI runner 行（与桥行并列）   │
│ src/tui/            ← 本任务新增                       │
│   runner.ts           Cordis 入口 + agent 生命周期      │
│   app.ts              TuiApp（屏幕装配 + 键位路由）     │
│   transcript.ts       事件 → 转录行（流式 + 折叠）      │
│   present.ts          工具调用/结果呈现                 │
│   interactions.ts     审批 + 提问的行内交互             │
│   commands.ts         斜杠命令（autocomplete 驱动）     │
└──────────────────────────────────────────────────────┘
```

## 1. 入口与装配

### startup.ts 加 flag

```ts
.option('--tui', 'run the interactive terminal UI instead of the Neeko bridge')
```

`NeekoStartupValues` 加 `tui?: boolean`；`resolveStartupValues` 三态处理同 `spawn`
（照抄既有测试形态）。**桥路径零改动**：不设 `--tui` 时 `ctx.neekoStartup.tui` 为
undefined，桥行为与现在逐字节一致（AC1 的回归判据）。

### cordis.patch.yml

```yaml
- id: neeko-tui
  name: 'dsh-neeko/tui'
  inject: [neekoStartup]
  when: !!js ctx.neekoStartup.tui === true      # ← 二选一的关键
  config: ...同桥行...
```

> `when` 是 cordis patch 的条件行语法 —— **写码前先验证**。若无 `when`，
> 改为两个 runner 都挂载、各自在 apply 里检查 `config.tui` 后 no-op。
> 取后者为保底方案（不依赖未验证的 patch 语法）。

### 依赖

`@earendil-works/pi-tui: ^1.3.0` 进 dependencies。**不 vendor、不 fork**：
五个 "local rendering fixes"（参考实现 README 提到）逐条与 1.3.0 对照，
有行为差异才考虑 `patchedDependencies`（根 workspace 已有该机制）。

## 2. runner.ts — Cordis 入口（从 dsh-neeko/src/index.ts 的 doActivate 提炼）

接线照抄桥（已验证同构）：

```ts
inject = ['agentDefaultModel', 'agents']
apply(ctx, config):
  if (!config.tui) return                    // 保底：无 patch when 时的二选一
  agents = ctx.get('agents'); defaultModel = ctx.get('agentDefaultModel')
  selection = defaultModel.currentSelection()
  handle = config.sessionId
    ? await agents.resume({ resumeSessionId, agentOptions, setup })   // 失败回落 create
    : await agents.create({ sessionId: SessionId(`session-${randomUUID()}`),
                            meta: { cwd: process.cwd() }, agentOptions, setup })
  await handle.agent.whenIdle()              // 恢复的历史 ready 后再渲染
  → 构造 TuiApp(handle.agent, ...) → app.start()
  → exit 协议同桥（appExit）
```

**setup 回调**内注册：
- `agentCtx.on('approval/request', ...)` → interactions
- `agentCtx.on('user-questions/request', ...)` → interactions（复用桥的
  `canAnswerQuestions` 与 waiter 基建 —— 已变异验证过的代码直接 import）
- `installModelSelection(agentCtx, { current: selection, assembled: undefined })`

**host 级订阅**（与桥同）：
- `ctx.on('session/event', ...)` → transcript.feed
- `ctx.on('agent/assistant-stream', ({agent, frame}) => agent===live ? transcript.feed : ∅)`
- `ctx.on('agent/status', ...)` → working indicator

> 与桥的差异：桥把事件翻译成协议帧发给 WS 客户端；TUI 直接把事件喂给渲染组件。
> **事件 → 视图状态的映射是本任务的核心新代码**，桥的 dsh-adapter.ts（翻译层）可
> 部分复用（`buildHistory` / `readSessionEvents` 原样；`translateEvent` 不适用 ——
> TUI 需要 tool 调用的完整上下文而非协议压缩形态）。

## 3. app.ts — 屏幕装配与键位路由

```
TuiMainScreen
 ├─ header Text          （标题 + 模型名）
 ├─ messages Container   （转录；ScrollView 包裹）
 ├─ working Loader       （thinking/executing/awaiting_human）
 ├─ Editor               （焦点默认）
 └─ footer Text          （提示：键位/状态）
```

键位路由（从参考实现 `handleInput` 精简）：

```
handleInput(data):
  isKeyRelease/isKeyRepeat → 忽略（Kitty 协议）
  activeQuestion?  → 问答键位（数字选选项 / 自由输入）
  activeApproval?  → 审批键位（y/n 或 SelectList）
  escape           → 取消当前 turn（agent.cancel 或 steer 语义，写码前查 .d.ts）
  ctrl+c           → 退出（二次确认或直接）
  其余             → 交给 Editor（tui.setFocus 已指 Editor）
```

流式合帧：`agent/assistant-stream` 的 chunk 进 transcript 后，50ms 合帧触发
`tui.requestRender()`（参考实现 `REPAINT_FLUSH_MS = 50`，防每 token 全屏重绘）。

## 4. transcript.ts — 事件 → 转录行

两条输入源合流到同一个有序视图（**双来源不变量**，与桥同款）：

| 来源 | 处理 |
| --- | --- |
| `agent/assistant-stream` | `start` 记 turn/step → 新建/复用助手气泡；`text-delta`/`reasoning-delta` 追加；`end` 结束该 attempt |
| `session/event`（tool/call、tool/result） | 工具行插入对应 step 位置；`assistant/message` **跳过**（已由 delta 呈现，防双发） |
| 恢复历史（`readSessionEvents` + `buildHistory`） | 初始填充，无流式语义 |

`assistant/message` 跳过时有一个边界：**中断恢复**。若 TUI 在 attempt 进行中启动
（resume 到一半的会话），历史里有 `assistant/message` 但没有对应 live delta ——
此时该消息必须从历史渲染。判据：消息的 `(turn, step)` 早于 TUI attach 时刻 →
从历史渲染；晚于 → 期望由 live delta 覆盖。恢复场景由 `whenIdle()` 之后的
初始 `buildHistory` 覆盖，运行中不会重启 attach，故 MVP 用「attach 时间线」判断
（attach 前 → 历史，attach 后 → live），不需要逐消息判。

MVP 全量渲染消息列表（不折叠）；`WINDOW_TURNS=15` 窗口化登记为后续项
（参考实现 `transcript.ts` 458 行可后补）。

## 5. interactions.ts — 审批 / 提问

**审批**（`approval/request` waterfall 监听器）：

```
requestApproval(request):
  无连接/已中止 → 'cancelled'（同桥）
  行内渲染：工具名 + reason + [允许 / 拒绝] SelectList
  用户选择 → resolve(outcome)；ESC → 'cancelled'
  request.signal abort → 收起 UI，resolve('cancelled')
```

**提问**（`user-questions/request` waterfall 监听器）：

```
answerQuestion(request):
  canAnswerQuestions(true)   // TUI 恒有"连接"（本地 UI），但保留谓词调用点
  逐题渲染：题干 + options（SelectList）或自由输入（Editor）
  abort → ASK_ABORTED reject（同桥语义）
  返回 { answers: [{ id, selected[], custom? }] }
```

两者共用桥的 waiter 生命周期模式（Map + abort listener + cancelAll on teardown）。
**与桥的关键差异**：桥通过 WS 等远端回答；TUI 的"回答者"是本地键盘 ——
`connection === undefined` 的判断换成「app 在运行」，其余契约（waterfall 协议、
`next()` 让位、answer 形状）不变。

## 6. commands.ts — 斜杠命令

pi-tui 的 `CombinedAutocompleteProvider` + `SlashCommand`：

- `/help` — 键位与命令列表
- `/clear` — 清空转录视图（不动会话日志）
- `/model` — 简易模型列表（读 `defaultModel`，MVP 只读不切）
- `/exit` — 退出

不做：注册进 DSH `CommandRuntime`（那是 host 级命令体系，参考实现把两者都做了；
MVP 只做 TUI 内命令，R3.1）。

## 7. 门禁与测试策略

| 层 | 手段 |
| --- | --- |
| startup 三态（`--tui`） | 单测，照抄 spawn 三态测试形态 |
| transcript 事件折叠（delta 累积 / tool 配对 / assistant/message 跳过 / attach 时间线） | 单测（纯函数，无终端） |
| interactions 状态机（accept/decline/abort/ESC） | 单测（伪 UI 组件） |
| runner 接线（create/resume 回落、setup 注册） | 类型面 + code review；真实行为靠 AC1-AC6 |
| 渲染 / 键位手感 | 人工（AC1/AC2/AC4/AC5），记录到 implement.md |

复用桥的测试纪律：**反证导向**。例如「`assistant/message` 跳过」的测试要在
「改成从历史重发 delta」的变异下变红。

## 8. 红线合规

| 约束 | 落点 |
| --- | --- |
| packages/ 门禁豁免 | 全部改动限 `packages/dsh-neeko/**`；验证走 `prepublishOnly` |
| 根仓零改动 | 不碰 `src-tauri/**` / `src/**`；根 `pnpm-workspace.yaml` 不动（新依赖进包内 package.json） |
| 桥零回归 | AC7：68 测试 + 真机三件套（health / WS / session.init）复跑 |
| 0.1.x API 禁用 | AC9：`session.events` / `registerProvider` / `assistant/chunk` 不出现 |

## 9. 风险与回滚

| 风险 | 对策 |
| --- | --- |
| cordis patch 无条件行语法 | 保底：双 runner 挂载 + apply 内 `config.tui` 分流（不依赖未验证语法） |
| pi-tui 1.3.0 与 fork 渲染差异 | 逐条对照五处 fix；差异小则接受，差异大则 patchedDependencies |
| `agent.cancel` / steer 语义不明 | 写码前读 `dsh-agent` `.d.ts`；找不到就砍掉 ESC 取消（MVP 可无） |
| 流式渲染卡顿 | 50ms 合帧兜底；不够再上 transcript 窗口化 |
| 双 runner 挂载后两个都 start | apply 首行 `if (!config.tui) return`；桥同理反向判断；真机验证两条路径 |
| TUI 异常导致整个 profile 崩 | runner 顶层 catch → stderr + appExit(1)（同桥的 apply 错误协议） |

## 10. 验证顺序（实施顺序不可交换；真机集中验证）

```
开发循环（Step 1–8，只跑 prepublishOnly，不起 CLI）：
1. 依赖落地 + --tui flag 三态单测
2. runner 骨架（无 UI，纯接线 + 回落逻辑单测）
3. app.ts 最小屏幕（装配 + 键位路由单测）
4. transcript：历史折叠 + attach 时间线（纯函数单测）
5. 流式 delta 渲染（含合帧、防双发单测）
6. 工具呈现
7. 审批 / 提问（状态机单测）
8. 斜杠命令

Step 9（开发完成后统一真机）：AC1–AC7 一次过，问题分组修复复验
Step 10（收尾）：AC9 契约自查 + prepublishOnly + spec 沉淀
```

真机验证集中在 Step 9：开发循环内不逐步起 CLI（用户决策），
但每步的**单测**仍是该步完成的硬门 —— Step 9 只是补上自动化覆盖不到的
渲染 / 手感 / 真实 waterfall 行为。
