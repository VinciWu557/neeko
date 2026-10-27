# DSH 通知生态调研（三个社区插件）

> 调研时间 2026-10-27。方法：三个仓库 `git clone --depth 1` 后**读真实源码**（非 README 推断），
> 并与本仓 `packages/dsh-neeko`、`src-tauri/src/agent/hooks/**`、`src-tauri/src/server/**` 对照。
> 目的：为 `research/dsh-consumption-decision.md`（U7 定案）提供外部证据。

## 0. 结论先行

| # | 结论 | 对任务的影响 |
| --- | --- | --- |
| 1 | 三个插件**全部是 cordis 进程内插件**，无一例外；DSH 确实没有 out-of-process hook 面 | 原 PRD「走源 A、不写 hook」的拓扑判断**正确**，可沿用 |
| 2 | DSH 侧事件面比 `dsh-neeko` 桥目前暴露的**更宽**：`turn/end`、`agent/status`、`agent/error`、`session/title` 都存在，桥没转发 | R2.1 的「会话结束/错误」不再是未知项，而是**桥的三处缺口** |
| 3 | `dsh-neeko` 自己起了独立的 `node:http` server（`:3081`） | 见 `dsh-transport-decision.md`：这是**必选**，不能改用 Neeko 的 server |
| 4 | 桌面端原生通知**只能由页面投递**，host 进程拿不到 Electron 通知 API | 若 Neeko 走桌面 native 通知，它作为 Rust 主进程**天然满足**这一点 |
| 5 | 「审批 waterfall 短路」是 DSH 客户端插件的普遍陷阱，但 Neeko **不受影响**（它自己就是 answerer） | 设计可简化，不必抄快照差分 |

## 1. 三个仓库的形态

| 仓库 | 版本 | 入口 | host 半侧 | browser 半侧 |
| --- | --- | --- | --- | --- |
| `ly6170/dsh-messager` | 0.3.6 | `src/index.ts` | **有真实逻辑**（唯一在 host 侧判断的） | RSS 设置页 |
| `chromoany/dsh-notify-me` | 1.14.3 | `lib/index.js` 368 行 | 仅窗口聚焦路由 | 3819 行 CJS，全部通知逻辑 |
| `printz1/dsh-notify` | 0.1.0 | `lib/index.js` **15 行空 apply()** | 无 | 1554 行 CJS，全部逻辑 |

三者都以 `cordis.patch.yml` 的一行 `insert` 挂进 profile 插件树，browser 半侧由
`package.json` 的 `dsh.client` 声明、经 `dsh-client-modules` 编入 Web bundle，以
`window.__ModuleLoader__.load({ id, factory })` 惰性 CJS 工厂格式执行。

## 2. 依赖了 DSH 哪些库

### `dsh-messager`：53 个 peerDep，但运行时只用 2 个

```
peerDependencies (53)，含：
  @deepseek-ai/cordis
  @deepseek-ai/dsh-agent / dsh-session / dsh-user-approval / dsh-user-questions
  @deepseek-ai/dsh-session-{persistence,projection,query,reference,title}
  @deepseek-ai/dsh-settings / dsh-host-webserver / dsh-client-connection
  @deepseek-ai/dsh-client-ui-{primitives,renderer,session,settings,slots,store,locale}
  @deepseek-ai/dsh-api-{gateway,remotes,session-controller}
```

**运行时（非 type-only）只有两个**：

- `@deepseek-ai/cosmokit` 的 `isVolatile`（`src/config.ts:19`）
- `@deepseek-ai/schemastery`（`Config` schema）

其余全为 `import type` —— 靠 ambient `declare module` 拿事件契约类型，使
`ctx.on('session/event', …)` 的 `event.type` 是字面量联合，**事件名写错 = 编译错误**。
这是它最值得借鉴的手法，但**只对 TypeScript 宿主有效**，Neeko（Rust）用不上。

其它运行时依赖：`node-notifier@^10`（系统通知）、`react@^18`（设置页）。

### `dsh-notify-me`：1 个 peerDep

```
peerDependencies: { "@deepseek-ai/dsh-client-locale": "^0.1.0-rc.6 || … <0.3.0-0" }
engines: { "node": ">=18" }
```

`lib/index.js` 运行时只 import `node:child_process` / `node:fs` / `node:url`；
client 半侧除 `require("react")` 外无任何 require。

**它刻意不用 DSH 类型**，代价写在 `lib/client.js:2158` 的注释里：反射 store 的**形状
变过一次**（`pendingInteractions` → `sessionStatus`），只能运行时探测：

```js
if (svc && isStore(svc.sessionStatus)) return { store: svc.sessionStatus, source: "sessionStatus" };
if (svc && isStore(svc.pendingInteractions)) return { store: svc.pendingInteractions, source: "pendingInteractions" };
```

且 `ctx.uiSession` 在未写进 `inject` 映射时会抛 `cannot get property "uiSession" without inject`，
必须走 `ctx.get()`。

### `dsh-notify`：零 peerDep、零依赖

`package.json` 连 `dependencies` 都没有。自带 30 项断言的安装自检（`tools/verify-install.mjs`），
校验 `package.json name` == 插件树行名 == bundle 自报 `id`（三者逐字相同，否则浏览器半侧
**静默不加载**）。

## 3. 「怎么知道要通知」——三条互不相同的路

### 3.1 `dsh-messager`：订阅 host 侧 cordis 事件（唯一）

`src/index.ts` 的 `apply()` 三个订阅，纯函数抽在 `src/signals.ts`：

| DSH 事件 | 判据 | 信号 |
| --- | --- | --- |
| `session/event` → `approval/asked` | 落库审计事件 | `interaction: 'approval'` |
| `session/event` → `tool/call` 且 `name === 'ask_user_question'` | 工具名精确匹配 | `interaction: 'question'` |
| `session/event` → `turn/end` | 记录 reason | 供 completed 合并 |
| `agent/status` | `running → idle` 边沿 | `completed` |
| `agent/error` | `{agent, turn, step, error}` | `error` |

两个工程细节：

**① 子代理判别必须用 `origin === 'subagent'`，不能用 `parentSession`**（`index.ts:284` 注释）：

> 分叉会话（`sessions.fork`）的 header 也会携带 `parentSession`（指向源会话），但 `origin`
> 为空，仍是顶层会话，任务完成后应正常通知。

用错字段 = 分叉会话**永远不通知**。

**② `completed` 是两路合并的**：`turn/end` 给原因、`agent/status` 的 running→idle 给时机，
在 `notify.ts:116` 合并成一个信号，用 `pendingCompleted` 计时器窗口兜乱序。

### 3.2 `dsh-notify` / `dsh-notify-me`：订阅 browser 侧 React store

`dsh-notify/lib/client.js:13-20` 点破了为什么（**重要**）：

> 为什么审批/提问不监听 `approval/request` / `user-questions/request`：那两个是 Remote Event
> **瀑布**，内置的审批面板/提问面板会 await 用户决定并把结果当返回值返回，瀑布就此短路 ——
> 后注册的监听器（本插件）永远收不到。

**已核实**。cordis `waterfall`（`cordis/lib/index.js:317`）：

```js
waterfall(...args) {
  const cbs = this.dispatch("waterfall", args);
  const inner = args.pop();
  const next = () => (cbs.shift() ?? inner)(...args);
  args.push(next);
  return next();
}
```

`ApprovalService.decide()`（`dsh-user-approval/lib/index.js:176`）正是
`ctx.waterfall(…, "approval/request", req, () => Promise.resolve("unavailable"))`。
**第一个不调 `next()` 的监听器直接终结链** → 后注册者永远收不到。

所以两者都退到「待办快照」差分：`ctx.uiSession.pendingInteractions`（旧形状）/
`ctx.uiSession.sessionStatus`（0.1.6+），用 `pending.key` 去重。

## 4. 通知怎么发出去

| 插件 | 系统通知 | 关键代价 |
| --- | --- | --- |
| `dsh-messager`（host） | `node-notifier` | Win=PowerShell Toast / macOS=terminal-notifier（**需联网下载**）/ Linux=notify-send |
| `dsh-notify-me`（client） | `new Notification` / `swRegistration.showNotification` | 审批按钮**依赖 Service Worker** |
| `dsh-notify`（client） | `new Notification` | 权限被拒 → 降级**闪标题** |

`dsh-messager/src/environment.ts` 有一条对本任务极有价值的实测结论：

> 桌面版的原生系统通知**只能由窗口里的页面**投递。host 半边跑在 `ELECTRON_RUN_AS_NODE=1`
> 的子进程里，实测 `require('electron')` 返回 `MODULE_NOT_FOUND` —— 拿不到 Electron 的通知
> API，只剩 node-notifier（Windows 上是 SnoreToast，**署名与外观都不是应用本体**）。
> 所以桌面宿主下 `system` 通道默认关闭。

判定「桌面宿主」= `process.versions.electron` 存在 **且** 本进程有 IPC 通道 —— 两者缺一不可，
因为经桌面版自带 CLI 跑的 `dsh web` 同样是 Electron 二进制，但没有窗口。

**对 Neeko 的意义**：Neeko 是 Rust 主进程（Tauri），它**就是**那个「能投递原生通知的进程」，
不存在这条限制。`dsh-messager` 被迫绕过的坑，Neeko 天然没有。

## 5. 对 Neeko 的三个实证发现

### 发现一：桥不送 turn 边界 / 失败 / 标题（三处缺口）

核对 `packages/dsh-neeko/src/index.ts` + `dsh-adapter.ts`：

- `translateEvent()`（`dsh-adapter.ts:121`）**只处理 `tool/call` 和 `tool/result`**；
  `turn/end` 只出现在 `buildHistory()`（历史重建），**实时路径完全不发**
- `handleSessionEvent` 只转发 `tool.start` / `tool.end`
- `agent/status` 订阅了（`index.ts:162`），但只更新 `agentRunning` 布尔 → 算出
  `status.change` 的 `thinking/executing/idle`，**没有 turn 边界、没有失败原因**
- `protocol.ts` 的 `type: 'error'` 是 **bridge 自己的协议级错误** `{code, message}`，
  **不是 agent 失败**
- `session.init.payload` 只有 `{sessionId, history}`，**无标题**

对应 Neeko `agent/chat/notify.rs::project` 的映射表：

| `event_keys` | 需要的 StreamEvent | dsh-neeko 现状 |
| --- | --- | --- |
| `approval_requested` | `RequestApproval` | ✅ `approval.request` |
| `input_requested` | `UserInput` | ✅ `question.request` |
| `turn_completed` | `TurnEnd{Completed}` / `SessionDone{Completed}` | ❌ **缺** |
| `session_failed` | `Error` / `SessionDone{Error}` | ❌ **缺**（`error` 语义不符） |

DSH 侧这些数据**都拿得到**（`dsh-session@0.2.0-rc.2` 的 `known-event-types.js` 含
`turn/end`、`session/title`、`approval/asked`、`approval/decided`；`dsh-agent@0.2.0-rc.2`
的 `runtime-types.d.ts:252/402` 定义 `agent/status` 与 `agent/error`）。缺的是桥没转发。

### 发现二：桥会「抢走」审批，且无连接时会挂死

`index.ts:365` 的 `requestApproval()` 在 waterfall 里注册 **answerer**，`await` 一个 Promise
等 Neeko 回 `approval.respond`，期间**不调 `next()`** → DSH 内置审批面板在
`dsh-neeko` profile 下**已经失效**。

更严重：**没有连接时它仍然挂起**（`approvalWaiters.set` 后直接 `sendToConnection`，
而 `sendToConnection` 在 `connection === undefined` 时是 no-op）。对比
`answerQuestion()`（`index.ts:392`）有明确的 `canAnswerQuestions(connection !== undefined)`
守卫，**approval 这条路径没有等价守卫**。后果：Neeko 没连上时审批请求永久悬挂，直到
`signal` abort。

这是**缺陷**，不是设计选择（question 路径的注释明确写了「否则会永远挂住 agent」，
approval 路径漏了同一处理）。→ 见任务 `10-16-notify-dsh` 的 R5。

### 发现三：`spawnNeeko` 传的 `--mode=dsh-agent`，Neeko 侧不认识

`index.ts:533` 传 `--dsh-ws=<url> --mode=dsh-agent`，但全仓 `src-tauri/src` + `src`
grep `dsh-agent|dshAgent|dsh_agent` **零命中**。即桥的「autoSpawn 拉起 Neeko」这条腿
在 Neeko 侧**没有接收端**。

这不阻塞本任务（本任务是 Neeko 主动连 DSH，不是 DSH 拉起 Neeko），但记录在此：
若将来要做反向拉起，需另立任务。

## 5.5 修正（2026-10-27 晚间）

§5 的「三个实证发现」**事实正确**，但当时对它们的**影响判断错了**：

| 发现在 | 错误推论 | 正确含义 |
| --- | --- | --- |
| 桥不送 `turn/end` / `agent/error` / `session/title` | 「必须先补桥才能做通知」 | ❌ 通知走**源 B 上报**，直接听 DSH host 事件，**不经过桥**。这三处缺口只是 `dsh-neeko`（chat 面）的技术债 |
| 桥会抢走审批 | 「通知插件与桥不能共存」 | ❌ 通知用 `approval/asked`（**审计事件**），桥用 `approval/request`（**waterfall**），两者不冲突 |
| `--mode=dsh-agent` 无接收端 | （无关） | 仍然无关，仅记录 |

正确的定案见 [`dsh-consumption-decision.md`](./dsh-consumption-decision.md)。

## 6. 与本任务的直接关联（R2.1 / R4.2 定案依据）

| 原 PRD 疑问 | 本案结论 | 依据 |
| --- | --- | --- |
| R2.1「会话结束/错误」事件是否存在 | **存在**（`turn/end` / `agent/status` / `agent/error`），但桥未转发 | `known-event-types.js`、`runtime-types.d.ts:252/402`、`dsh-messager/src/index.ts:261-304` |
| R2.1 `tool.end` 是否映射 | **不映射**（单工具失败 ≠ 会话失败） | 三个插件均无此映射；Neeko `notify.rs` 的 `_ => return None` 已天然忽略 |
| R4.2 `session.init` 是否带标题 | **不带**；但 `session/title` 事件存在 | `protocol.ts:130`、`known-event-types.js`、`dsh-messager/src/index.ts:115-120` |
| R2.2「投影零新增代码」是否成立 | **成立，但有前提**：桥必须先补发 `TurnEnd` / `Error` / 标题 | `notify.rs::project` 已覆盖全部四个 key |

## 7. 不做的事

- 不改 `packages/dsh-neeko`（该包门禁豁免，走自己的 `prepublishOnly`；须另立任务）
- 不抄 `dsh-notify` 的「待办快照差分」——Neeko 是 waterfall answerer，不是旁观者
- 不抄 `dsh-notify-me` 的双形状运行时探测——那是「不用类型」的代价，Neeko 无此问题
