> # ⛔ 本文档结论已作废（2026-10-27）
>
> **用户纠正后的正确方向是「DSH 往 Neeko 上报」（源 B）**，见
> [`dsh-consumption-decision.md`](./dsh-consumption-decision.md)。
>
> 本文件里以下结论**全部错误**，不要引用：
> - §1「必须保留 WS 客户端」
> - §4「否决 DSH POST 到 Neeko server」的三条理由
> - §5.1「选 A」、§5.2「不要加 `/dsh` 路由组」
>
> 仍然有效的**事实**（已吸收进 `dsh-consumption-decision.md` §2 与 `design.md`）：
> - Neeko `server/` 是入站 axum，只有 `POST /hook/{source}`，**无出站能力**
> - `HookEvent` 字段与 `HOOK_TARGETS` 白名单机制
> - `dsh-neeko` 的 `PORT_RETRY_BUDGET = 9` 端口漂移
> - `dsh-host-webserver` 有 `registerUpgrade`
>
> 保留本文件仅为追溯错误推理链条。

# U7 传输定案：为什么「Neeko 已有 HTTP server」不能取代 DSH 的 WebSocket

> 本文件回答用户在 2026-10-27 提出的问题：
> **「当前系统已经集成了 web server 服务了，像 dsh 的 websocket 还有必要做监听让 neeko 去连吗？」**
>
> 结论：**有必要，且是必选**。但理由不是「WebSocket 比 HTTP 好」，而是**连接方向**——
> 现有 server 只能被上报方**主动 POST**，它无法让 Neeko 拿到 DSH 侧的**双向**交互
> （审批应答）+ **主动推送**（turn 结束 / 出错）。下面逐条给证据。

## 0. 两个 server 是不同的东西（先消除命名混淆）

| | Neeko 的 server | `dsh-neeko` 的 server |
| --- | --- | --- |
| 实现 | `src-tauri/src/server/`（axum 0.8 + tower） | `packages/dsh-neeko/src/ws-server.ts`（`node:http` + `ws`） |
| 绑定 | `127.0.0.1:0`（**随机端口**，OS 分配） | `127.0.0.1:3081`（可配，占用则 +1…+9） |
| 启动 | `agent/hooks/boot.rs`，**无条件启动**（`want_cli_hooks` 只控制「装不装 hook 文件」） | DSH 侧 cordis 插件 `apply` 时启动 |
| 用途 | 接收 CLI hook 上报（源 B） | 与 Neeko 交换 Agent 会话协议（源 A） |
| 鉴权 | `AuthGate` + `x-neeko-agent-hook-token` | `Handshake` 帧（`PROTOCOL_VERSION`） |
| 双向性 | **单向**（上报方 → Neeko） | **双向**（含 `session.prompt` / `approval.respond`） |

**用户说的「已集成 web server」= 左边那个。** 它的存在是真实的、可复用的，但它解决的问题
和本任务要解决的问题**不是同一个**。

## 1. 决定性约束：连接方向

### 1.1 现有 server 是「被动接收」，DSH 的事件是「主动发生」

`agent/hooks/ingest/handlers.rs:53` 的路由只有一条：

```rust
let router = Router::new()
    .route("/hook/{source}", post(ingest_hook))
```

形态是 `POST /hook/{source}`，body 为 `HookEvent`（`agent/hooks/ingest/event.rs`）。
它**只能**被一个**知道端口和 token 的第三方**主动调用。而端口是 `bind :0` 随机分配的，
上报方通过读坐标文件发现它（`ingest/endpoint.rs`）：

```text
NEEKO_AGENT_HOOK_PORT=53124
NEEKO_AGENT_HOOK_TOKEN=<uuid-v4>
```

这套机制的前提是：**上报方是一个能读文件、能发 HTTP 的独立进程**（pi/opencode 的 hook shim）。

### 1.2 DSH 侧没有这个前提

`dsh-neeko` 是 cordis 插件，跑在 DSH 进程内。它确实能发 HTTP（`node:http` 可用），
所以「让桥改成 POST 到 Neeko」在**传输上**可行。但这就引出第 2 节的问题。

## 2. 不可替代的三件事

### 2.1 审批应答必须反向（这是硬约束）

Neeko 侧 `agent/chat` 的审批流程是：adapter 发 `StreamEvent::RequestApproval` →
用户在 Neeko UI 点「同意/拒绝」→ **Neeko 必须把决定送回去**，且这个决定是 DSH
waterfall 的**返回值**（见 `research/dsh-notify-prior-art.md` §3.2：`ApprovalService.decide()`
`await` 监听器的返回值）。

在 `dsh-neeko` 协议里，这一来一回是：

```
DSH → Neeko : approval.request   { requestId, toolName, reason }
Neeko → DSH : approval.respond   { requestId, outcome }
```

现有 Neeko server **没有任何「向 DSH 发送」的能力**：它是 axum 的入站路由，没有出站客户端，
也没有 DSH 的地址。要让审批走 HTTP，就得：

1. 在 Neeko 侧新增一个到 DSH 的 HTTP 客户端
2. 在 DSH 侧新增一个「接收审批」的 `webServer.register` 路由
3. 两侧都要维护「哪个 requestId 属于哪个连接」的关联

这三步**比 WebSocket 更重**，而且第 2 步在 DSH 侧本来就已被 `dsh-host-webserver` 提供 ——
见 §3，那正是「没必要自建 server」的真正论据，但它指向的是**另一个结论**。

### 2.2 turn 结束 / 出错是**推送**，不是**拉取**

发现一（`dsh-notify-prior-art.md` §5）已确认：桥当前**不发送** `turn/end`、`agent/error`。
要补上这处缺口，数据源是 host 侧 cordis 事件：

```ts
ctx.on('agent/status', ({ agent, status }) => { /* running -> idle */ })
ctx.on('agent/error',  ({ agent, turn, step, error }) => { /* ... */ })
```

这是**事件**，不是可轮询的状态。要让 Neeko 通过现有 server 拿到它，报方（桥）必须在事件
发生时**主动 POST**。也就是说：**即使改用 HTTP，方向仍然是「DSH 主动推给 Neeko」**——
和 WebSocket 的方向完全一样，只是换了传输。所以「Neeko 已有 server」并不改变方向问题。

### 2.3 一个连接 = 一个会话的生命周期

`dsh-neeko` 的 `handleConnection`（`index.ts:198`）实现了「新连接取代旧连接」：

```ts
if (this.connection !== undefined && this.connection !== connection) {
  this.connection.close(4000, 'superseded by a new Neeko connection')
}
```

并且 `stop()` 时要 `cancelAllApprovals()` / `cancelAllQuestions()` 把挂起的 waiter 结算掉。
这套「连接即会话」的语义需要**持久连接**来表达「断线 = 会话不可交互」。HTTP 无状态，
要表达同样语义得自己做会话表 + 心跳 + 超时回收 —— 又是比 WebSocket 更重。

## 3. 真正的可简化点：DSH 侧的 server 可以不自建

这是调研中最有价值的发现，但它**降低的是 DSH 侧的成本，不是 Neeko 侧的**。

`dsh-host-webserver@0.2.1-rc.2` 的 `WebServer` 接口（`lib/types/index.d.ts:160-200`）提供：

```ts
register(route: WebRoute): () => void              // exact / prefix HTTP 路由
registerUpgrade(route: WebUpgradeRoute): () => void // ← 精确路径的 HTTP upgrade
registerFallback(handler): () => void
getOrigin(): string
```

`WebUpgradeRoute` 的定义（`lib/types/index.d.ts:48-55`）：

```ts
export interface WebUpgradeRoute {
  path: string;
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
```

README 明确：「`registerUpgrade(route)` adds an upgrade route for an exact pathname …
upgrades match exactly and unmatched connections are closed.」

**意味着**：`dsh-neeko` 完全可以不再 `createServer()` 自建 `:3081`，而是
`ctx.inject(['webServer'], …)` 后在 DSH 现有监听器上注册 `/neeko/ws` 的 upgrade 路由，
复用 DSH 的端口、TLS、生命周期。

### 3.1 但这**不改变** Neeko 侧要做的事

即使桥迁到 `registerUpgrade`：

| 项 | 自建 `:3081` | 用 `webServer.registerUpgrade` |
| --- | --- | --- |
| 谁监听 | 桥（独立端口） | DSH 主 server（3080） |
| 谁连接 | **Neeko** | **仍是 Neeko** |
| 协议 | WebSocket | 仍是 WebSocket（upgrade 之后自己谈） |
| Neeko 侧代码 | 需要 WS 客户端 | **零改动**（只是 URL 从 `:3081` 变 `:3080/neeko/ws`） |
| 端口发现 | 桥的 `PORT_RETRY_BUDGET` 扫描 | 需从 `getOrigin()` 或插件的 stderr 拿 |

也就是说：**这是一个「让 DSH 侧更干净」的重构，不是「让 Neeko 侧省掉客户端」的方案**。
Neeko 仍然需要一个 WS 客户端 + 事件循环。

### 3.2 且它引入新的耦合代价

- 桥要 `inject: ['webServer']` → headless profile（无 `webServer` 服务）下**桥不可用**。
  当前 `cordis.patch.yml` 的 neeko 行没有这个依赖，加了就得处理「无 webServer」降级。
- 端口不再是固定 3081 → Neeko 侧的「猜端口」逻辑（若做）失效，必须走 `getOrigin()` 或
  坐标文件。
- 这是 `packages/dsh-neeko` 的改动 → **门禁豁免、须另立任务**（原 PRD 已明确排除）。

**建议**：作为后续优化登记，**不作为本任务的前置**。本任务按现有 `:3081` 做，
因为 `dsh-neeko` 的 `ws-server.ts` 已经稳定且实测可用（`10-17-dsh-neeko-bridge-fix` 的
证据：`bridge listening on ws://127.0.0.1:3197/ws` + `/neeko-health` 200）。

## 4. 「让 DSH 往 Neeko 的 server POST」这条路为什么也否掉

这是用户问题最直接的读法：**既然 Neeko 有 server，为什么不让 DSH 上报给它？**

技术上可行（桥是 Node 进程，能读坐标文件、能发 HTTP），但否决理由有三条，且都很硬：

### 4.1 它会逼 Neeko 重新实现一遍 Agent 会话

`agent/chat` 的 adapter 契约是 `AgentAdapter`（`create` / `next` / `send` / `cancel`），
产出 `StreamEvent` 流。若 DSH 走 `POST /hook/dsh`，进来的是 `HookEvent`
（`{agent_session_id, event, cwd, detail, title, hints}`）——**它没有 tools、没有 text delta、
没有 approval 的 requestId、没有会话状态机**。

要把 `HookEvent` 变成 `StreamEvent`，等于在 Neeko 侧**重建** `dsh-adapter.ts` 已经做好的
翻译层，而且丢失了双向能力。这是「第二个 `dsh-neeko`」，违反父任务 AC3（无重复实现）。

### 4.2 它会把 DSH 塞进「源 B」，破坏拓扑分类

原 PRD 的整个价值主张是：**DSH 属源 A（adapter 归一），不属源 B（hook 上报）**。
理由（`research/dsh-notify-prior-art.md` §0 结论 1）：DSH 的事实产生在**进程内**，
桥**已经在**归一它。让它再走一遍源 B 的 HTTP 通道，等于：

- 绕过 `agent/chat/notify.rs::project` → 失去「零新增投影代码」（R2.2）
- 逼 Neeko 写一套与 `notify.rs` 同形的投影 → R2.3 记账的 B 分支代价，**一模一样**
- 触发 R3.3 的停止条件（拓扑判断有误）

### 4.3 `hook/{source}` 的白名单是编译期常量，加 DSH 要动源 B 的注册表

`ingest/validation.rs:62` 的 `hook_source()` 从 `HOOK_TARGETS` 查：

```rust
match HOOK_TARGETS.iter().find(|target| target.source == source) { … }
```

而 `HOOK_TARGETS`（`agent/hooks/targets/data.rs`）当前 7 条：`opencode` / `pi` / `omp` /
`claude` / `codebuddy` / `qoder` / `codex` ——**全是源 B 的 CLI**。

加一个 `dsh` 进去，等于在源 B 的注册表里声明「DSH 是 CLI hook 源」，与整个任务的拓扑分类
直接冲突。**这是 R3.1「不新增 HookTarget」的字面违反。**

## 5. 定案

### 5.1 传输选择

| 候选 | 判定 | 理由 |
| --- | --- | --- |
| **A. Neeko 连 DSH 的 WS（现状方向）** | ✅ **选它** | 双向、推送、连接即会话；`ws-server.ts` 已实测可用 |
| B. DSH POST 到 Neeko 现有 server | ❌ 否 | §4：重造会话层 + 破坏源 A 拓扑 + 违反 R3.1 |
| C. 桥迁到 `webServer.registerUpgrade` | ⏸ 后续优化 | §3：只降 DSH 侧成本，Neeko 侧仍要 WS 客户端；且须另立任务 |

**结论：WebSocket 监听是必要的，不是可以省掉的。**

但用户的直觉并非全错 —— 有一个真实的可简化点：

### 5.2 真正该省的是「Neeko 侧不要新增 server」

`dsh-neeko` **已经是** server（`:3081`），Neeko 只需要做**客户端**。所以：

- **不要**在 Neeko 侧新起任何监听器（`agent/dsh/` 不应有 `boot.rs` 里的 `TcpListener`）
- **不要**给 Neeko 的 `server/` 加一个 `/dsh` 路由组（那会落入 §4）
- Neeko 侧只需要：一个 WS 客户端任务 + 事件翻译（`DshEvent → StreamEvent`）+ 复用 `notify::project`

这正是 `design.md` 分支 A 的形状，但需要修正一处：原设计假设「复用
`DeepSeekHarnessAdapter`」——**不成立**（见 `design.md` §2 的修正）。

### 5.3 端口发现问题（影响实测）

`ws-server.ts:30` 的 `PORT_RETRY_BUDGET = 9` 意味着 3081 被占时会静默漂移到 3082…3090。
`implement.md` 里写死 `:3081` 的 spike 命令会漏。**实测必须从桥的 stderr 读
`bridge listening on ws://…` 行**，而不是假设端口。

## 6. 待办（写回 prd/implement）

- [ ] `prd.md` R1.1：A/B/C 收敛为「A，但 adapter 不可复用」
- [ ] `prd.md` R2.1：`turn_completed` / `session_failed` 改为「桥补发后才能覆盖」，登记为前置
- [ ] `prd.md` R4.2：标题来源 = `session/title` 事件（桥需转发）
- [ ] 新增 R5：桥的 approval 无连接时会挂死（缺陷，须另立任务修 `dsh-neeko`）
- [ ] `implement.md` Step 0：spike 命令改为从 stderr 读端口，不写死 3081
- [ ] `implement.md` Step 1：删掉「可能复用 `DeepSeekHarnessAdapter`」的假设
