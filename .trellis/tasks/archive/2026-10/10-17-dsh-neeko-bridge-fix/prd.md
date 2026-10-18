# PRD — dsh-neeko 桥修复（`--no-spawn` 崩溃 + user-questions 注册 API 失效）

> 任务来源：`10-16-notify-dsh` 的 Step 0（U7 消费侧归属）在核实「桥是否可用」时被阻断。
> 该任务的 `prd.md` 明确把「`dsh-neeko` 包本身的改动」划在范围外，并要求「须另立任务
> 并走其 `prepublishOnly` 门禁」—— 本任务即那个另立任务。
>
> **本任务只修桥，不做 Neeko 侧 DSH 通知接入。** 接入仍归 `10-16-notify-dsh`。

## Goal

`dsh --profile neeko` 能真正起来：绑定端口、`/neeko-health` 返回 200、WebSocket 可连接、
DSH 的 approval / question 事件能经桥送出。当前它**一条都做不到** —— 启动即崩。

## 现状：桥是写完了的，但跑不起来

先澄清一个容易误判的点：`packages/dsh-neeko` **不是半成品**。

| 核验项 | 实测结果 |
| --- | --- |
| 源码规模 | `src/` 5 文件 1545 行；`lib/` 已构建 |
| 既有测试 | `pnpm test` → **35/35 通过** |
| WS server 传输层 | 手工起 `NeekoWsServer`：health 200、`/ws` 升级成功、坏路径 404 拒绝 —— **全部正常** |
| 类型检查 | `pnpm check` → `tsc --noEmit` **通过** |

所以问题不在「写没写」，而在**它被验证时用的契约与真实运行时不是同一份**（见根因 ②）。

## 根因（四条，均已实证，不是推测）

### 根因 ①：`--no-spawn` 被错当成 `spawnCommand: false`

**初版 PRD 把它归因为「`cordis.patch.yml` 的 `spawnCommand` 缺兜底」，那是错的。**
实测纠正如下（保留纠错痕迹，防后人重走）：

`schemastery` 的 `z.object` 对缺键是宽容的 —— 用真实 `Config` 验过：

```
spawnCommand 缺省    -> OK
spawnCommand=false   -> ERR      ← 只有 false 才炸
spawnCommand=string  -> OK
```

所以问题不在 schema，也不在 patch 的兜底，而在 `src/startup.ts:99-104`：

```ts
const options = program.opts<{ ...; spawn?: string; spawnEnabled?: boolean }>()
...
...(options.spawnEnabled === false ? { autoSpawn: false } : {}),      // ← 读了一个不存在的键
...(options.spawn === undefined ? {} : { spawnCommand: options.spawn }), // ← 把 false 灌进 string 字段
```

`commander` 把 `--spawn <command>` 与 `--no-spawn` 归一到**同一个** `spawn` 键（实测）：

```
['--no-spawn']          -> {"spawn":false}
['--spawn','/bin/true'] -> {"spawn":"/bin/true"}
[]                      -> {}
```

两个连锁错误：

1. `options.spawnEnabled` **commander 从不产出** → 恒为 `undefined` →
   `--no-spawn` 时 `autoSpawn` **永远不会被设成 false**（意图丢失）。
2. 同一情形下 `options.spawn === false`（不是 `undefined`）→ 被写进 `spawnCommand`
   → schema 拒绝 → 整个 profile 条目不激活。

**实测**：`dsh --profile neeko --no-spawn --port 3197` →
`ValidationError: invalid config: $.spawnCommand expected string but got false`，端口未监听。

### 根因 ②：`userQuestions.registerProvider()` 在运行时不存在（本任务最核心的一条）

`src/index.ts:157`：

```ts
const questionDisposer = this.ctx.get('userQuestions')?.registerProvider(this.questionProvider())
```

`registerProvider` 在 **0.1.0-rc.8** 里确实存在 —— 包自己的 `node_modules` 里就能 grep 到：

```
node_modules/@deepseek-ai/dsh-user-questions/lib/index.js:31:  registerProvider(provider) {
node_modules/@deepseek-ai/dsh-user-questions/lib/types/index.d.ts:46:  registerProvider(provider: UserQuestionProvider): () => void;
```

但**真实运行时是 0.2.0-rc.2**，该版本已移除这个方法。0.2.0-rc.2 的
`dsh-user-questions` 只暴露：

```
method: 'answer'
method: 'attachWait'
```

且 `UserQuestionProvider` **类型本身已从 0.2.0-rc.2 的公开导出中删除**。

**这解释了一个反常现象**：`pnpm check` 通过，运行时却崩。
包的 devDependencies 钉 `0.1.0-rc.6 / rc.8`，而 `dsh` CLI 自带 `0.2.0-rc.2` 的 peer ——
**类型检查跑在旧契约上，运行时跑在新契约上**。类型安全在这里是假绿。

0.2.0-rc.2 的权威扩展机制是 **Agent 作用域 Cordis waterfall**（源码注释原文）：

> *"UI packages compose answerers on the Agent-scoped Cordis waterfall."*

```js
// dsh-user-questions/lib/index.js:681
this.ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", { ...request, agent }, noAnswerer)
```

真实注册范例（`dsh-client-ui-user-questions`）：

```js
ctx.remote.$on('user-questions/request', (request, next) => answerQuestion(ctx, this, request, next, cards))
```

**决定性旁证**：桥的 **approval 侧早就用对了**同一个模式 ——

```ts
// src/index.ts:304
const approvalDisposer = agentCtx.on('approval/request', (request: ApprovalRequest) => this.requestApproval(request))
```

`user-approval` 的 `decide()` 同样走 `ctx.waterfall(..., "approval/request", ...)`。
所以 question 侧是**同一模式下的单点错误**，修法与 approval 完全对称，不是架构重做。

**实测**：绕开 ① 后用 `--spawn /bin/true` 起 → 报
`this.ctx.get(...)?.registerProvider is not a function`，端口仍未监听。

### 根因 ③：peer 版本门禁（环境侧，已临时解开，但需要正式处理）

插件声明 peer `^0.1.0-rc.6`，本机 dsh 是 `0.2.0-rc.2`，dsh 直接拒绝加载该 profile bundle：

```
dsh: skipping profile bundle "dsh-neeko": Plugin dsh-neeko@0.1.0 is incompatible with dsh 0.2.0-rc.2
```

我已用 `dsh plugin allow-version dsh-neeko@0.1.0 --dsh-version 0.2.0-rc.2 --accept-risk`
授予了精确版本豁免（**本机状态已改，非仓库改动**）。但那只是「允许冒险加载」，
不解决 ② 的 API 不匹配。**peer 范围需要随 ② 一起上修**，否则每个新用户都要手动豁免一次。

### 根因 ④：事件模型整体换代 —— 翻译层照 0.1.x 写（**上修 peer 后暴露**）

把 dev 依赖提到 0.2.0-rc.2 后 `tsc` 立刻炸出 20+ 错，核心一条：

```
error TS2678: Type '"assistant/chunk"' is not comparable to
  '"turn/start" | ... | "assistant/message" | ...'
```

**0.2.0-rc.2 的会话日志根本没有 `assistant/chunk` 这个事件。** 权威契约
（`dsh-session/lib/types/types.d.ts` 的 `SessionEventMap`）是：

```
turn/start  turn/end  step/start  step/end
user/message  developer/message  system/message
assistant/message  assistant/attempt
tool/call  tool/result
request/header  request/context  session/end-seed
```

即从「增量 chunk 流」改成「settled 完整消息」。这不是改名，是**协议模型变了**：

| 关注点 | 0.1.x（桥原本假设） | 0.2.0-rc.2（真实） |
| --- | --- | --- |
| 实时文本流 | 日志里的 `assistant/chunk` | **`agent/assistant-stream`**（agent 作用域独立通道，`start`/`chunk`/`end` 帧） |
| 落盘助手消息 | 靠 chunk 累积 | `assistant/message`（含 `message` + 紧凑 `stream` + `usage` + `interrupted`） |
| 工具结果 id | `message.source.callId` | `message.toolCallId` |
| 日志读取 | `session.events`（属性） | `session.snapshotEvents()`（方法） |

**关键结论**：实时 delta 与落盘消息是**两个不同来源**。桥原实现把落盘日志当 delta 源用，
即使修好了 `registerProvider` 和 `session.events`，助手文本仍会**全部静默丢失**。


## Requirements

### R1 修 ①：`--no-spawn` 的解析

- R1.1 `startup.ts` 必须从 **`options.spawn`**（commander 的真实键）区分两种情形，
  而不是读不存在的 `options.spawnEnabled`。
- R1.2 `--no-spawn`（`options.spawn === false`）→ 只设 `autoSpawn: false`，
  **不得**写入 `spawnCommand`。
- R1.3 `--spawn <cmd>`（string）→ 设 `spawnCommand`，且 `autoSpawn` 保持默认（true）。
- R1.4 两者都未给 → 两个键都不设，交给 patch 的兜底（`autoSpawn ?? true`）。
- R1.5 `Config` schema 与 patch 兜底**不需要**改动 —— 它们本来是对的
  （缺键可接受）。若要改，必须先给出反证：现 schema 在缺键时确实失败。

### R2 修 ②：question 侧改用 waterfall

- R2.1 删除 `start()` 里的 `registerProvider` 调用（它在新契约下无意义且必崩）。
- R2.2 在 `setupAgent` 里注册 `agentCtx.on('user-questions/request', ...)`，与 approval 侧对称
  —— 同一处 setup、同一处 dispose，随 agent 生命周期生效与回收。
- R2.3 answerer 必须遵守 waterfall 协议：**接受请求则返回答案，不接受则调用 `next()`**
  （让内层 `noAnswerer` 产生 `NO_PROVIDER`）。不得无条件吞掉请求。
- R2.4 必须能响应 `request.signal` 的中止（`ASK_ABORTED` 语义），与既有 `askOneQuestion` 一致。
- R2.5 `inject` 声明要复核：若 question 改为事件注册，`userQuestions` 是否仍是启动硬依赖？
  若不再需要，应从 `inject` 移除（否则平白多一个启动阻塞点）。

### R3 修 ③：peer 范围与真实运行时对齐

- R3.1 `package.json` 的 peerDependencies 范围必须能覆盖实际使用的 dsh 版本，
  不能继续只写 `^0.1.0-rc.6`。
- R3.2 devDependencies 必须与 peer 目标同代，否则**类型检查继续假绿**
  （这是根因 ② 能溜进发布的直接原因）。
- R3.3 若决定只支持某一代，则要在 README 写明，并让 peer 范围如实表达该决定。

### R5 修 ④：翻译层迁移到 0.2.x 事件模型

- R5.1 实时 delta **只能**来自 `agent/assistant-stream`（`start` 帧提供 turn/step）。
- R5.2 落盘日志**不得**再被当作 delta 源 —— 否则每个 token 双发或全丢。
- R5.3 `tool/result` 的 call id 取 `message.toolCallId`（非 `message.source.callId`）。
- R5.4 未知 / 未来事件类型必须 fail-open（DSH 仍处 rc 阶段，事件集会漂移）。
- R5.5 `buildHistory` 从「chunk 累积」改为「settled 消息折叠」。

### R4 门禁：让这类 bug 不再假绿

- R4.1 必须有一条测试能在**旧契约**下变红 —— 即断言 question 走的是 waterfall 注册，
  而不是「某个 provider 被登记」。仅断言「能问出答案」不足以区分两种实现。
- R4.2 `packages/dsh-neeko` 不在根门禁内（根 `AGENTS.md` 的「门禁豁免」），
  故本任务的验证入口是它自己的 `prepublishOnly`：`check && test && build && lint:package`。
- R4.3 启动 smoke：至少要有一条自动化断言覆盖「config 经 schema 校验后能构造出 bridge」，
  让 ① 这类 schema/patch 不一致在 CI 层面就红。

## Acceptance Criteria

- [ ] **AC1 真启动**：`dsh --profile neeko --no-spawn --port <p>` 不报错，端口进入 LISTEN，
      `curl http://127.0.0.1:<p>/neeko-health` 返回 200。
- [ ] **AC1b `--no-spawn` 意图生效**：该情形下 `autoSpawn` 必须真的为 `false`
      （原实现因读错键而恒为 true —— 即使不崩，也会错误地拉起 Neeko）。
- [ ] **AC2 WebSocket 可连**：连上 `/ws` 并完成 handshake，能收到 `session.init`。
- [ ] **AC3 question 走 waterfall**：单测断言注册的是 `user-questions/request` 监听器，
      且未接受时调用 `next()`（反证：改回 `registerProvider` 必红）。
- [ ] **AC4 既有 35 测试全绿**：`pnpm test` 无回归。
- [ ] **AC5 门禁通过**：`pnpm run prepublishOnly`（`check && test && build && lint:package`）全绿。
- [ ] **AC6 peer 诚实**：peer 范围覆盖实际运行版本；dev 依赖与 peer 同代（AC3 的类型假绿已消除）。
- [ ] **AC7 无副作用**：不产生未跟踪的 `pnpm-lock.yaml` 等副产物；
      `packages/dsh-neeko` 之外零改动（根门禁不覆盖本包，改动必须自限）。
- [ ] **AC8 翻译层契约对齐**：`assistant/chunk` 不再是任何代码路径的输入；
      实时 delta 只经 `agent/assistant-stream`；`buildHistory` 折叠 settled 消息。
- [ ] **AC9 双来源不重发**：同一条助手文本不会既经 live delta 又经日志回放重复发送。

## 明确不在本任务范围

- **Neeko 侧 DSH 通知接入**（消费 `:3081`、投影为 `NotificationSignal`、U7 定案）→ `10-16-notify-dsh`。
- `10-16-notify-dsh` 的 prd/design/implement 任何文件。
- 根仓库的 `src-tauri/**` / `src/**`。
- DSH 的 Web UI / ACP profile。
- 把桥改成支持多 dsh 版本（除非 R3 的结论必须如此，届时在 design 记账）。

## 风险

| 风险 | 对策 |
| --- | --- |
| waterfall answerer 的返回值形状与 `NeekoAdapter` 现有期望不符 | 先读 `dsh-client-ui-user-questions` 的 `answerQuestion` 实现对齐形状，再改 |
| `inject` 去掉 `userQuestions` 后，question 事件可能根本没人派发 | 用 AC2 的真实会话验证；若无事件，恢复 inject 并查 waterfall 作用域 |
| peer 上修后，旧版 dsh 用户被挡在门外 | R3.3 要求在 README 明示支持代际；这是有意的取舍，不是回归 |
| 本机已授予 `allow-version` 豁免，可能掩盖未修的 peer 声明问题 | AC6 以 `package.json` 文本为准，不以「本机能跑」为准 |
