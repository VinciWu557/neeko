# Design — dsh-neeko 桥修复

> 根因与实证见 `prd.md`。本文件只写**怎么修**与**为什么这样修**。
> 三条根因的修法相互独立，可分别验证；但 ① 不修则 ② 无法在真机上验证（桥起不来），
> 故实施顺序固定为 ① → ② → ③。

## 0. 一个必须先讲清的判断

`packages/dsh-neeko` **不是未完成品**，35 个测试全绿、传输层实测可用。
它是**在错误契约上验证过**的完成品：

```
类型检查看到的：  @deepseek-ai/dsh-user-questions  0.1.0-rc.8   （devDependencies）
运行时真实加载：  @deepseek-ai/dsh-user-questions  0.2.0-rc.2   （dsh CLI 自带 peer）
```

`registerProvider` 在 rc.8 存在、在 rc.2 已被移除，且 `UserQuestionProvider` 类型
在 rc.2 的公开导出里也没了。**`tsc` 通过因此毫无意义** —— 它检查的是一份运行时不存在的 API。

这决定了本任务的性质：不是「补功能」，是**把桥接到真实运行时上**。
也决定了 R4（门禁）的形态：光加「能问出答案」的测试不够，那在两种实现下都能绿。

## 1. 修 ①：`--no-spawn` 的解析（**已纠正初版误判**）

### 初版误判与纠正

初版 design 写「`cordis.patch.yml` 的 `spawnCommand` 缺兜底，schema 不接受 undefined」，
并计划改 YAML 与 schema。**实测推翻了它**：用真实 `Config` 验过 ——

```
spawnCommand 缺省    -> OK        ← schema 宽容缺键
spawnCommand=false   -> ERR       ← 只有 false 才炸
spawnCommand=string  -> OK
```

所以**不要改 `cordis.patch.yml`，也不要改 `Config`** —— 它们本来是对的。
改错地方会让真正的 bug 留在原处，还会把一个正确文件改坏。

### 真正的落点

`src/startup.ts:99-104`：

```ts
...(options.spawnEnabled === false ? { autoSpawn: false } : {}),        // ① 读不存在的键
...(options.spawn === undefined ? {} : { spawnCommand: options.spawn }), // ② false 灌进 string
```

`commander` 把两个 flag 归一到同一键 `spawn`（实测）：

```
['--no-spawn']          -> {"spawn":false}
['--spawn','/bin/true'] -> {"spawn":"/bin/true"}
[]                      -> {}
```

两个连锁错误：

| # | 错误 | 后果 |
| --- | --- | --- |
| ① | 读 `options.spawnEnabled`（commander 从不产出） | `autoSpawn` 恒不设 → `--no-spawn` 的**意图丢失**，即使不崩也会错误拉起 Neeko |
| ② | `options.spawn === false` 被写进 `spawnCommand` | schema 拒绝 → profile 条目完全不激活 |

② 是显性的（启动即崩）；① 是隐性的（崩不了时才发作）—— **两个都要修**，
只修 ② 会让 `--no-spawn` 变成一个谎。

### 修法

```ts
// 三态：false = 明确不 spawn；string = 自定义命令；undefined = 未指定
const spawnFlag = options.spawn
...(spawnFlag === false ? { autoSpawn: false } : {}),
...(typeof spawnFlag === 'string' ? { spawnCommand: spawnFlag } : {}),
```

类型上把 `spawn?: string` 改成 `spawn?: string | false`（commander 的 `--no-spawn` 语义），
让「可能是 false」在类型层可见 —— 原声明 `spawn?: string` 是 ② 能写下的直接原因。

**判据**：三条路径都要测（未指定 / `--no-spawn` / `--spawn <cmd>`），
只测 `--no-spawn` 会漏掉「兜底把合法值覆盖」的反向错误。

## 2. 修 ②：question 侧改用 Agent 作用域 waterfall

### 为什么是 waterfall

0.2.0-rc.2 的 `dsh-user-questions` 源码注释是权威说明：

> *"Service Definition for the user-questions capability seam (`ctx.userQuestions`): a UI-backed
> service for pausing an agent tool call until the human answers a question. …
> **UI packages compose answerers on the Agent-scoped Cordis waterfall.**"*

派发点（`dsh-user-questions/lib/index.js:681`）：

```js
this.ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", { ...request, agent }, noAnswerer)
```

其中 `noAnswerer` 是内层兜底，reject 一个 `NO_PROVIDER` 错误。

### 与 approval 侧同构（这是修法可信度的关键）

桥的 approval 侧**已经是对的**：

```ts
// src/index.ts:302-309
private setupAgent(agentCtx: Context, selection: ModelSelection): () => void {
  const modelDisposer = installModelSelection(agentCtx, { current: selection, assembled: undefined })
  const approvalDisposer = agentCtx.on('approval/request', (request: ApprovalRequest) => this.requestApproval(request))
  return () => { modelDisposer(); approvalDisposer() }
}
```

`dsh-user-approval` 的 `decide()` 同样走
`this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, ...)`。

所以 question 侧**照抄这个形状**即可 —— 同一处 setup、同一处 dispose、同一个作用域。
这不是架构改造，是补一个漏掉的对称分支。

### 修法

```ts
// 删除 src/index.ts:157（start() 里那行 registerProvider）

private setupAgent(agentCtx: Context, selection: ModelSelection): () => void {
  const modelDisposer = installModelSelection(agentCtx, { current: selection, assembled: undefined })
  const approvalDisposer = agentCtx.on('approval/request', (r: ApprovalRequest) => this.requestApproval(r))
  const questionDisposer = agentCtx.on('user-questions/request', (r: AskUserQuestionRequest, next: () => Promise<unknown>) =>
    this.answerQuestions(r, next))
  return () => { modelDisposer(); approvalDisposer(); questionDisposer() }
}
```

### answerer 契约（三条，缺一即错）

1. **接受 vs 让位**：本桥在 `on-demand` 且尚未激活会话时**不应**抢答 —— 此时必须 `next()`，
   让内层 `noAnswerer` 产生 `NO_PROVIDER`。无条件接管会让「用户没打开 Neeko」变成
   「问题永远悬着」。
2. **中止**：`request.signal` 已 abort 或中途 abort → 以 `ASK_ABORTED` reject，
   与既有 `askOneQuestion` 的语义保持一致（它已经这么做了）。
3. **返回形状**：`AskUserQuestionAnswer = { answers: { id, selected[], custom? }[] }`
   —— 与 `dsh-user-questions` 0.2.0-rc.2 的类型**逐字段一致**（已核对）。
   桥现有的 `askQuestion()` 产出的就是这个形状，**该函数可原样复用**，
   只把「入口」从 provider 换成 waterfall 监听器。

### `inject` 的处理

`inject` 当前含 `userQuestions`。改用事件注册后，`ctx.get('userQuestions')` 不再被调用，
但 **`user-questions/request` 事件仍由该服务派发** —— 若该服务不存在，事件永不发生，
桥会静默失去提问能力。

故：**保留 `userQuestions` 在 `inject` 里**，理由从「我要调它的方法」变成
「我要消费它派发的事件」。这条判断要在代码注释里写明，否则后人会以为是冗余依赖而删掉。

> 备选：若实测发现事件在服务缺席时也能触发（不可能，但留出验证口），再考虑移除。
> 默认取保守方案。

## 3. 修 ③：peer 范围与 dev 依赖同代
### 现状问题

```json
"peerDependencies": { "@deepseek-ai/dsh-user-questions": "^0.1.0-rc.6", ... }
"devDependencies":  { "@deepseek-ai/dsh-user-questions": "0.1.0-rc.8", ... }
```

两处都停在 0.1.x，而真实运行时是 0.2.0-rc.2。**dev 依赖停旧代是类型假绿的直接原因** ——
必须一起上修，只改 peer 不改 dev 等于没修。

### 修法

- `peerDependencies` 范围覆盖 0.2.x（具体下限取决于 ② 所依赖的 waterfall 契约在哪个版本稳定）。
- `devDependencies` 提到与 peer 目标同代，使 `tsc` 检查的就是运行时会加载的那份类型。
- README 注明支持的 dsh 代际（R3.3）。

**取舍**：上修会挡掉仍用 0.1.x 的用户。这是**有意**的 —— 0.1.x 下 `registerProvider` 存在
但 0.2.x 下不存在，一份代码无法同时正确；写宽范围才是撒谎。

### 实施记录：`dsh-attachment` 传递依赖

上修后 `tsc` 报 `dsh-llm@0.2.0-rc.2` 找不到 `@deepseek-ai/dsh-attachment`。
那不是我们的依赖，而是 `dsh-llm` 自己的 **devDependency**（`0.2.0-rc.2`），其 `.d.ts` 直接 import 它。
故 devDependencies 需补一条 `@deepseek-ai/dsh-attachment: 0.2.0-rc.2`（**精确版本**，不是 `^`）——
写成 `^0.0.1-rc.1`（当前 npm `latest`）会因导出不匹配而报 `has no exported member 'FileAttachmentRef'`。

## 4. 修 ④：翻译层迁移到 0.2.x 事件模型

### 为什么必须重写而非改名

`assistant/chunk` 在 0.2.0-rc.2 **不存在**。0.2.x 把 0.1.x 合二为一的流拆成**两个来源**：

| 关注点 | 来源 | 契约 |
| --- | --- | --- |
| 实时 delta | `agent/assistant-stream`（agent 作用域） | `start`（带 turn/step）/ `chunk`（带 `StreamChunk`）/ `end` |
| 落盘助手消息 | `session.snapshotEvents()` | `assistant/message`（`message` + 紧凑 `stream` + `usage` + `interrupted`） |

**核心不变量**：落盘日志**不得**被当作 delta 源。否则：
- 若两边都发 → 每个 token 双发；
- 若只依赖日志 → 助手文本全丢（因为日志里根本没有增量行）。

### 修法

1. `translateEvent`（日志侧）只处理 `tool/call` / `tool/result`；
   `assistant/message` 返回空 —— 它已由 live delta 送达。
2. 新增 `translateStreamFrame(start, frame)`：只把 `text-delta` / `reasoning-delta` 映射为
   `text.delta` / `thinking.delta`；`tool-call-delta` 不发（`tool/call` 日志行携带完整 arguments）。
3. `start` 帧是 turn/step 的唯一来源 —— 没收到 `start` 就丢弃 chunk（不能猜）。
4. `buildHistory` 从「chunk 累积 + 兜底」改为「settled 消息折叠」。
5. `tool/result` 的 call id 改取 `message.toolCallId`。
6. 桥在 `start()` 里订阅 `agent/assistant-stream`，与 `session/event` 并列；
   用 `streamStart` 字段记住当前 attempt 的 turn/step。

### 为什么不留 0.1.x 兼容分支

两代的实时流来源根本不同（日志事件 vs 独立通道）。写兼容分支等于在两个不同拓扑间切换，
且 0.1.x 分支无法测试（本机只有 0.2.0-rc.2 运行时）。故 peer 范围如实收窄到 0.2.x。

## 5. 门禁：让 ② 这类 bug 不再假绿

`packages/dsh-neeko` 不在根门禁内（根 `AGENTS.md`「门禁豁免」），验证入口是它自己的
`prepublishOnly` = `check && test && build && lint:package`。

要补的测试（**反证导向**，不是覆盖率导向）：

| 测试 | 反证什么 |
| --- | --- |
| `registers_a_waterfall_listener_for_user_questions` | 把实现改回 `registerProvider` → 必红（该 API 在 dev 依赖同代后根本不存在，编译即失败） |
| `declines_when_inactive_and_calls_next` | 无条件接管请求 → 必红 |
| `aborts_pending_question_on_signal` | 忽略 `request.signal` → 必红 |
| `config_accepts_spawn_command_absent_and_present` | ① 的兜底改成只覆盖一侧 → 必红 |

第一条是关键：它在**同代类型**下把「用错 API」变成编译错误，而不是运行时崩溃。

## 6. 红线合规（根 `AGENTS.md`）

| 约束 | 落点 |
| --- | --- |
| `packages/` 门禁豁免 | 本任务只动 `packages/dsh-neeko/**`；根 `lint`/`test`/`check` 不覆盖它，验证走 `prepublishOnly` |
| 根仓库零改动 | 不碰 `src-tauri/**` / `src/**` / 根 `package.json` |
| 不动 `10-16-notify-dsh` | 那是 Neeko 侧接入，与本任务正交 |

## 7. 风险与回滚

| 风险 | 对策 / 回滚 |
| --- | --- |
| waterfall 监听器签名与预期不符（`next` 的位置/形态） | 以 `dsh-client-ui-user-questions` 的 `ctx.remote.$on(..., (request, next) => ...)` 为准；host 侧 `ctx.on` 传参同形 |
| 上修 peer 后 35 条既有测试因类型变化而红 | 逐条看是否暴露了别的旧契约依赖 —— 那正是本任务要清的账；不盲目改断言迁就 |
| 本机 `allow-version` 豁免掩盖 peer 声明问题 | AC6 以 `package.json` 文本为准；验证时**撤销豁免**再跑一次，确认新范围无需豁免即可加载 |
| 修完桥仍起不来（还有第三、四个 bug） | 每修一条立刻真机复跑；若发现新阻断点，登记到 `implement.md` 再决定是否扩大范围 |

## 8. 验证顺序（不可交换）

```
① 修 spawnCommand 兜底
   → dsh --profile neeko --no-spawn --port N   （能过 config 校验，会露出 ②）
② 修 question waterfall
   → dsh --profile neeko --no-spawn --port N   （端口 LISTEN + health 200）
   → 连 /ws 完成 handshake，收到 session.init
③ 上修 peer + dev 依赖
   → 撤销 allow-version 豁免后重跑，确认无需豁免
   → pnpm run prepublishOnly 全绿
```
