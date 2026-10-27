# DSH-Neeko 双向集成架构方案

## 一、核心设计原则

### 1.1 产品边界

| 产品 | 职责 | 独立性 |
|------|------|--------|
| **DSH** | AI 能力后端：agents、sessions、commands、llm、workspace、工具执行、安全沙箱 | 完全独立，不感知 Neeko 的存在 |
| **Neeko** | 桌面交互壳：文件编辑、Git 管理、终端、Agent Chat UI | 完全独立，DSH 只是可选后端之一 |
| **dsh-neeko** | 通信桥梁：协议翻译、会话状态管理、双向通信 | 中立组件，不决定谁启动谁 |

### 1.2 双向启动

```
谁先启动，谁拉起对方

DSH 启动 Neeko:
  dsh --profile neeko -> dsh-neeko 插件 -> spawn Neeko (--mode=dsh-agent)

Neeko 启动 DSH:
  用户点击 "DeepSeek" -> Neeko 检查 DSH health -> 未运行则 spawn("dsh --profile neeko daemon")
```

### 1.3 两种连接模式

| 模式 | 触发方式 | Neeko 行为 | DSH 检查 |
|------|---------|-----------|---------|
| `dsh-agent` | DSH 启动 Neeko | **立即进入** DSH Agent Chat | DSH 已运行（自己就是 DSH） |
| `on-demand` | Neeko 独立启动，用户点击 DeepSeek | **按需进入**，点击后才连接 | 点击时检查，未运行则启动 |

---

## 二、系统架构

### 2.1 整体拓扑

```
+-----------------------------------------------------------------+
|                      dsh-neeko (桥梁)                            |
|                                                                  |
|  WS 服务器: 127.0.0.1:3081  <- 非 3080，避免与 Web profile 冲突   |
|                                                                  |
|  +------------------------------------------------------------+  |
|  |                   Neeko 连接模式                            |  |
|  |                                                            |  |
|  |  模式 1: dsh-agent (DSH 启动)                              |  |
|  |    +-- Neeko 连接时携带 mode=dsh-agent                     |  |
|  |    +-- 桥梁直接进入 session 初始化 -> 推送历史 -> 进入聊天   |  |
|  |                                                            |  |
|  |  模式 2: on-demand (Neeko 独立启动)                        |  |
|  |    +-- Neeko 连接时携带 mode=on-demand                     |  |
|  |    +-- 桥梁等待用户点击 "DeepSeek" 后才初始化 session       |  |
|  |    +-- 未点击时保持空闲，不订阅事件                         |  |
|  +------------------------------------------------------------+  |
+-----------------------------------------------------------------+
                               |
              +----------------+----------------+
              |                |                |
     +--------+-------+       |       +--------+-------+
     |   DSH 进程      |       |       |   Neeko 进程     |
     |                |       |       |                  |
     |  Cordis 容器    |<----+-+----->|  WS 客户端       |
     |  agents/       |  双向通信    |  Agent Chat UI   |
     |  sessions/     |             |                  |
     |  commands/     |             |                  |
     +----------------+             +------------------+
              ^                              ^
              |                              |
     +--------+--------+          +----------+----------+
     | 路径 A:         |          | 路径 B:            |
     | dsh --profile   |          | Neeko 启动         |
     | neeko           |          |                   |
     |                 |          | 检查 bridge 是否运行 |
     | 1. 启动 bridge  |          | 如果没有:          |
     | 2. spawn Neeko  |          | spawn dsh --profile|
     | 3. Neeko 连接   |          | neeko daemon       |
     +-----------------+          | 等待 bridge 就绪   |
                                  | 连接 bridge        |
                                  +--------------------+
```

### 2.2 端口分配

| 服务 | 端口 | 说明 |
|------|------|------|
| `dsh --profile web` | **3080** | 默认 Web profile，不变 |
| `dsh --profile neeko` | **3081** | Neeko 专用，避免冲突 |
| Neeko 动态选择 | 3081 + n | 如果 3081 被占用，尝试 3082、3083... |

---

## 三、通信协议

### 3.1 连接握手

```typescript
interface Handshake {
  type: 'handshake';
  payload: {
    version: string;           // 协议版本
    role: 'neeko';             // 连接方角色
    mode: 'dsh-agent' | 'on-demand';  // 连接模式
    active: boolean;           // 是否立即激活 session
    sessionId?: string;        // 恢复已有会话
  };
}
```

### 3.2 DSH -> Neeko 消息

```typescript
type DshToNeeko =
  | { type: 'session.init'; payload: { sessionId: string; history: any[] } }
  | { type: 'status.change'; payload: { status: 'idle' | 'thinking' | 'executing' | 'awaiting_human' } }
  | { type: 'text.delta'; payload: { chunk: string; messageId: string } }
  | { type: 'thinking.delta'; payload: { chunk: string } }
  | { type: 'tool.start'; payload: { taskId: string; toolName: string; args: unknown } }
  | { type: 'tool.stream'; payload: { taskId: string; streamType: 'stdout' | 'stderr'; chunk: string } }
  | { type: 'tool.end'; payload: { taskId: string; status: 'success' | 'failed'; result: unknown; diff?: { filePath: string; patch: string } } }
  | { type: 'approval.request'; payload: { requestId: string; toolName: string; reason?: string } }
  | { type: 'question.request'; payload: { requestId: string; question: string; options?: { id: string; label: string }[] } }
  | { type: 'error'; payload: { code: string; message: string } };
```

### 3.3 Neeko -> DSH 消息

```typescript
type NeekoToDsh =
  | { type: 'session.prompt'; payload: { sessionId: string; message: string } }
  | { type: 'session.steer'; payload: { sessionId: string; message: string } }
  | { type: 'session.cancel'; payload: { sessionId: string } }
  | { type: 'approval.respond'; payload: { requestId: string; decision: 'allowed' | 'rejected' } }
  | { type: 'question.respond'; payload: { requestId: string; answer: string } };
```

### 3.4 统一信封

```typescript
interface Envelope {
  rpcId: string;
  direction: 'dsh->neeko' | 'neeko->dsh';
  timestamp: number;
  message: DshToNeeko | NeekoToDsh | Handshake;
}
```


### 3.5 通知上报（独立于 WebSocket 协议）

通知**不走** WebSocket 协议，走 Neeko 的 hook ingest（源 B）。理由：通知是「知会」，
不需要往返；而 WS 那条链路要求 Neeko 已连接并持有会话，通知不该依赖它。

```
DSH host 事件
  ├─ 对话 → WS → Neeko chat          （既有通道，本图不变）
  └─ 通知 → POST /hook/dsh → Neeko ingest → NotificationCenter
```

**模块分工**（三层，互不越界）：

| 文件 | 职责 |
| --- | --- |
| `notify-reporter.ts` | **纯函数**：事件 → 语义键；`HookEvent` 请求体渲染 + 截断 |
| `notify-transport.ts` | **传输**：坐标发现 + fan-out + 失败清单（`DeliveryFailure[]`） |
| `notify-wiring.ts` | **挂载**：cordis 订阅 + 跨事件状态（`titles` / `running` / `lastTurn`） |

**两条运行腿都必须挂载**（真机事故）：`cordis.patch.yml` 里 `id: neeko` 那一行在 `--tui`
时是 `disabled` 的，故 `index.ts::start()`（headless）与 `tui/runner.ts`（TUI）**各自**
调用 `installNotifyReporter`。只挂一处 = 用户日常模式零通知、零日志。

**事件映射**（`src/notify-reporter.ts::notifyEventOf`，只覆盖 `session/event`）：

| DSH 事件 | 语义键 | 说明 |
| --- | --- | --- |
| `session/event` → `approval/asked` | `approval_requested` | **审计事件**，旁路可听、零副作用 |
| `session/event` → `tool/call` 且 `name === 'ask_user_question'` | `input_requested` | 提问 / 计划待审都经此工具 |
| `agent/status` 的 `running → idle` 边沿，**且**该轮 `turn/end.reason.kind === 'completed'` | `turn_completed` | 时机来自 `agent/status`，**原因**来自 `turn/end`（见下） |
| `agent/error` | `session_failed` | 附带错误消息（截断 300） |

**为什么不用 `approval/request` / `user-questions/request`**：那两个是 cordis **waterfall**
——第一个不调 `next()` 的监听器终结整条链。本插件（`agent-handlers.ts`）自己就是这两个
waterfall 的 answerer，再挂一个监听器会把内置审批面板挤掉或吞掉答案。

**为什么完成信号不用 `turn/end` 定时**：那是**历史重建**用的事件
（`dsh-adapter.ts::buildHistory`）；实时路径只保证事件被 append，不保证「一轮结束」
这个语义边界。`agent/status` 的边沿才是权威**时机**。

**但「结束」≠「完成」**：只取时机的话，失败轮（`agent/error` → 收敛到 idle）与
用户中止轮（`agent.cancel` → 收敛到 idle）都会被报成 `turn_completed`，于是
`session_failed` 与 `turn_completed` 两条互斥文案同时到达。原因在
`turn/end.reason.kind` 上：`notify-wiring` 记下它，`agent/status` 落到 idle 时消费并清零
（失败不污染下一轮）。与 `.trellis/spec/backend/agent-chat-transports.md` §4.6b 的
pi 判据同型（「失败不可被追认为完成」）。

**`agent/*` 的载荷是 `Agent`，不是 `Session`**：`Agent` 只有 `id`
（`@deepseek-ai/dsh-agent` 的 `types.d.ts`），`header` 在 `agent.session` 上
（`@deepseek-ai/dsh-session`）。把 `Agent` 当 `Session` 读**类型上完全合法**
（两边的 `id` 同名），运行时才暴露：子代理过滤失效 + `cwd` 恒 `null`。
归一集中在 `notify-wiring.ts::observedOf`，测试必须用真实 `Agent` 形状
（`{ id, session: { header } }`）—— 用 `{ id, header }` 会让缺陷在类型与单测上双双合法。

**载荷**（与 Neeko `agent/hooks/ingest/event.rs::HookEvent` 逐字段对齐）：

```jsonc
{
  "agent_session_id": "session-…",   // 必填；空则整条不发
  "event": "approval_requested",     // 语义键，与源 A 同命名空间
  "cwd": "/work/proj",               // 来自 session.header.cwd
  "detail": "bash — needs network",  // 工具名/原因/错误，截断 500
  "title": "Refactor the parser",    // 最近一次 session/title，截断 200
  "hints": { "neeko_session_id": null, "project_id": null }
}
```

**六个字段必须在位**（可为 `null`，键不能缺）：Neeko 的 `validate()` 对缺字段的载荷
静默丢弃，而 HTTP 仍回 204 —— 表现为「装了但没通知」。

**子代理过滤**：`session.header.origin === 'subagent'` 的会话不通知。
**不能用 `parentSession`**：分叉会话的 header 也带它，但 `origin` 为空，仍是顶层会话。

**坐标契约**（与 Neeko `agent/hooks/ingest/endpoint.rs` 同一契约的两端）：

```
~/.neeko/agent-hooks/endpoints/<instance_id>.env
  NEEKO_AGENT_HOOK_PORT=<随机端口>
  NEEKO_AGENT_HOOK_TOKEN=<uuid-v4>
```

多实例：扫全部 `*.env`，逐个 POST，单坐标失败不影响其余。
端点覆盖有两个 env，**都必须支持**（与既有 7 个源同契约）：

| env | 作用 |
| --- | --- |
| `NEEKO_AGENT_HOOK_ENDPOINT` | 指向单文件 → 只读它（调试 / 测试夹具，优先级最高） |
| `NEEKO_AGENT_HOOK_ENDPOINTS_DIR` | 指向目录 → 只扫它（把坐标根整体搬走的环境） |

只实现前者会让搬过坐标根的机器上 DSH 恒零请求，而其余源正常工作。

**失败策略**：800ms 超时、`Promise.allSettled`、任何异常吞掉、**永不 await**。
DSH 会 `await` 监听器，上报阻塞的用户可见后果是「会话卡住」，而不是「少一条通知」。

但「永不 reject」不等于「永不报告」：`postToEndpoints` 返回 `DeliveryFailure[]`
（`status === 0` = 连不上/超时，`>= 400` = 服务端拒绝），`NEEKO_NOTIFY_DEBUG=1` 时打到
stderr。丢弃状态码会让 401 / 白名单缺行与成功在代码里完全同形 —— 那正是「204 假绿灯」。

---

## 四、启动时序

### 4.1 路径 A：DSH 启动 Neeko（直接进入 Chat）

```
dsh --profile neeko
    |
    v
dsh-neeko 插件启动
    |-- WS 服务器: 127.0.0.1:3081
    |-- health 端点就绪
    +-- 检测: 非 daemon -> 自动拉起 Neeko
            |
            v
        spawn Neeko:
        open -a Neeko --args --dsh-ws=ws://127.0.0.1:3081 --mode=dsh-agent
            |
            v
        Neeko 启动
            |
            |-- 检测到 --mode=dsh-agent
            |-- 跳过正常首页，直接进入 DSH Agent Chat 页面
            |-- 连接 WS (携带 mode=dsh-agent)
            |
            v
        dsh-neeko 收到连接 (mode=dsh-agent)
            |
            |-- 立即初始化 session
            |-- 推送历史消息
            |-- 订阅 session/event
            +-- 进入双向通信
```

### 4.2 路径 B：Neeko 独立启动（按需进入 Chat）

```
用户打开 Neeko (无参数)
    |
    v
Neeko 正常启动
    |
    |-- 显示正常首页（文件编辑、Git 等）
    |-- 侧边栏有 "DeepSeek" 入口
    |
    v
用户点击 "DeepSeek"
    |
    v
Neeko 检查 DSH 是否运行
    |
    |-- HTTP GET http://127.0.0.1:3081/neeko-health
    |
    |-- 返回 200 -> DSH 已运行
    |   +-- 连接 WS (携带 mode=on-demand, active=true)
    |
    +-- 返回 error -> DSH 没运行
        |
        v
        spawn("dsh --profile neeko daemon")
        |
        v
        DSH daemon 启动
        |
        |-- dsh-neeko 加载
        |-- WS 服务器启动
        +-- health 就绪
        |
        v
        Neeko 等待 health 通过
        |
        v
        连接 WS (携带 mode=on-demand, active=true)
    |
    v
dsh-neeko 收到连接 (mode=on-demand, active=true)
    |
    |-- 初始化 session
    |-- 推送历史
    |-- 订阅事件
    +-- Neeko 切换到 DSH Agent Chat 页面
```

---

## 五、组件实现

### 5.1 dsh-neeko 插件（DSH 侧）

#### 项目结构

```
dsh-neeko/
+-- package.json
+-- cordis.patch.yml
+-- src/
|   +-- index.ts              # 主插件 (桥梁)
|   +-- ws-server.ts          # WebSocket 服务器
|   +-- protocol.ts           # 协议类型定义
|   +-- dsh-adapter.ts        # DSH 事件 -> 协议翻译
|   +-- neeko-adapter.ts      # 协议 -> DSH API 调用
|   +-- notify-reporter.ts    # 通知：事件 -> 语义键（纯函数）
|   +-- notify-transport.ts   # 通知：坐标发现 + POST fan-out + 失败清单
|   +-- notify-wiring.ts      # 通知：cordis 订阅 + 跨事件状态（titles/running/lastTurn）
+-- README.md
```

#### 核心职责

1. **WebSocket 服务器**：绑定 `127.0.0.1:3081`，接受 Neeko 连接
2. **Health 端点**：`GET /neeko-health`，Neeko 探测 DSH 是否存活
3. **协议翻译**：DSH 原始事件 ↔ 标准协议消息
4. **会话管理**：维护 session 状态，处理模式切换
5. **自动拉起 Neeko**：CLI 模式下 spawn Neeko 桌面应用
6. **通知上报**：把「需要注意」的 host 事件经 `POST /hook/dsh` 送到 Neeko（见 §3.5）

#### 模式检测逻辑

```typescript
// 收到 Neeko 连接时
if (handshake.mode === 'dsh-agent') {
  // DSH 启动的 Neeko -> 立即激活 session
  activateSession(ws, handshake.sessionId);
} else if (handshake.mode === 'on-demand' && handshake.active) {
  // Neeko 用户点击了 DeepSeek -> 激活 session
  activateSession(ws, handshake.sessionId);
}
// mode=on-demand && !active -> 保持空闲，不订阅事件
```

#### CLI vs Daemon 模式

```typescript
// 检测启动模式
if (process.argv.includes('daemon')) {
  // daemon 模式：纯等待连接，不拉起 Neeko
  console.log('dsh-neeko: daemon mode, waiting for Neeko...');
} else {
  // CLI 模式：拉起 Neeko
  spawnNeeko('--mode=dsh-agent');
}
```

### 5.2 Neeko DSH 管理器（Neeko 侧）

#### Rust 侧（Tauri 命令）

```rust
#[tauri::command]
async fn check_dsh_health(port: u16) -> Result<DshHealth, String> {
    let url = format!("http://127.0.0.1:{}/neeko-health", port);
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    resp.json::<DshHealth>().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_dsh_daemon(port: u16) -> Result<(), String> {
    let child = Command::new("dsh")
        .args(["--profile", "neeko", "daemon"])
        .env("DSH_NEEKO_PORT", port.to_string())
        .env("DSH_NEEKO_AUTOSPAWN", "0")  // daemon 模式下不自动拉起 Neeko
        .spawn()
        .map_err(|e| format!("Failed to start DSH: {}", e))?;

    // 等待 health 通过
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if check_dsh_health(port).await.is_ok() {
            return Ok(());
        }
    }
    Err("DSH daemon failed to start".to_string())
}
```

#### React 侧（前端 Hook）

```typescript
function useDshConnection() {
  const [dshStatus, setDshStatus] = useState<'checking' | 'starting' | 'ready' | 'error'>('checking');

  // 路径 B: Neeko 主动检查并启动 DSH
  const initDsh = async () => {
    const port = 3081;
    try {
      await invoke('check_dsh_health', { port });
      setDshStatus('ready');
    } catch {
      setDshStatus('starting');
      try {
        await invoke('start_dsh_daemon', { port });
        setDshStatus('ready');
      } catch {
        setDshStatus('error');
      }
    }
  };

  // 用户点击 DeepSeek 时调用
  const handleDeepSeekClick = async () => {
    await initDsh();
    // 进入 DSH Agent Chat 页面
  };

  return { dshStatus, handleDeepSeekClick };
}
```

### 5.3 Neeko 前端入口

#### 路径 A：DSH 启动 Neeko

```typescript
// Neeko 启动时检测参数
const launchMode = getLaunchMode(); // 'normal' | 'dsh-agent'

if (launchMode === 'dsh-agent') {
  // 直接进入 DSH Agent Chat
  navigate('/dsh-agent-chat');
}
```

#### 路径 B：Neeko 独立启动

```typescript
// 侧边栏 DeepSeek 入口
function DeepSeekEntry() {
  const { dshStatus, handleDeepSeekClick } = useDshConnection();

  return (
    <div onClick={handleDeepSeekClick}>
      {dshStatus === 'idle' && <span>DeepSeek</span>}
      {dshStatus === 'checking' && <span>检查中...</span>}
      {dshStatus === 'starting' && <span>启动中...</span>}
      {dshStatus === 'ready' && <span>DeepSeek ✓</span>}
      {dshStatus === 'error' && <span>DeepSeek ✗</span>}
    </div>
  );
}
```

---

## 六、启动参数对照

| 场景 | 命令 | Neeko 参数 | 行为 |
|---|---|---|---|
| DSH 启动 Neeko | `dsh --profile neeko` | `--dsh-ws=ws://127.0.0.1:3081 --mode=dsh-agent` | Neeko 直接进入 Chat |
| Neeko 独立启动 | `neeko` | 无 | Neeko 正常首页 |
| Neeko 点击 DeepSeek | (用户操作) | 内部连接 `--mode=on-demand` | 检查/启动 DSH -> 进入 Chat |
| DSH daemon 模式 | `dsh --profile neeko daemon` | 无 | DSH 纯等待，不拉起 Neeko |

---

## 七、DSH 事件 -> 协议翻译

| DSH 原始事件 | 协议消息 | 说明 |
|---|---|---|
| `assistant/chunk` | `text.delta` | 大模型流式输出 |
| `tool/call` | `tool.start` | 工具调用开始 |
| `tool/result` | `tool.end` | 工具调用结束 |
| `approval/asked` | `approval.request` | 请求人工审批 |
| `approval/decided` | (内部处理) | 审批已决定 |
| `turn/start` | `status.change` | 新一轮对话开始 |
| `agent/inbox/spliced` | `status.change` | 收件箱插入 |

---

## 八、渐进式实现路线

### Phase 1: MVP（1-2 天）

**DSH 侧（dsh-neeko 插件）**：
- [ ] WebSocket 服务器（端口 3081）
- [ ] Health 端点（`/neeko-health`）
- [ ] 基础握手协议（mode 检测）
- [ ] DSH 事件 -> 协议翻译（text.delta, tool.start/end）
- [ ] Neeko 消息 -> DSH API（session.prompt, session.cancel）
- [ ] CLI 模式自动拉起 Neeko
- [ ] Daemon 模式等待连接

**Neeko 侧**：
- [ ] Rust: `check_dsh_health` Tauri 命令
- [ ] Rust: `start_dsh_daemon` Tauri 命令
- [ ] React: `useDshConnection` Hook
- [ ] React: DeepSeek 入口组件
- [ ] React: DshAgentChat 页面（基础消息收发）

### Phase 2: 完善（1 周）

**DSH 侧**：
- [ ] 完整事件翻译（thinking, approval, question）
- [ ] 断线重连支持
- [ ] WS 认证 token
- [ ] 多 session 切换
- [ ] 动态端口分配

**Neeko 侧**：
- [ ] DSH 崩溃自动重启
- [ ] 文件 diff 渲染（tool.end 中的 diff 字段）
- [ ] xterm 日志流（tool.stream）
- [ ] Approval/Question 交互 UI
- [ ] 连接状态指示器

### Phase 3: 生态（可选）

- [ ] 发布 `dsh-neeko` npm 包
- [ ] `dsh plugin --profile neeko add dsh-neeko` 一键安装
- [ ] 标准化 daemon 模式（供 VS Code、JetBrains 等复用）

---

## 九、关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 传输协议 | WebSocket | 双向实时，聊天场景天然匹配 |
| 端口 | 3081（可配置） | 避免与 Web profile 3080 冲突 |
| 健康检查 | HTTP `/neeko-health` | Neeko 探测 DSH 是否存活 |
| 自动拉起 | 双方都支持 | 谁先启动谁拉起对方 |
| 模式区分 | `--mode=dsh-agent` / `--mode=on-demand` | 区分"直接进入"和"按需进入" |
| 协议翻译 | dsh-neeko 插件内 | 桥梁负责翻译，双方只需理解标准协议 |
| 会话状态 | dsh-neeko 维护 | 桥梁是状态的中心枢纽 |
| 产品边界 | DSH 不知道 Neeko 存在 | 保持 DSH 的纯净性 |

---

## 十、与之前方案的对比

| 维度 | 之前：dsh-neeko 拉起 Neeko | 现在：双向启动 + 桥梁 |
|------|---|---|
| 控制权 | DSH 插件 spawn Neeko | 双方各自启动对方 |
| DSH 对 Neeko 的认知 | 需要知道 Neeko 二进制路径 | **完全不知道 Neeko 存在** |
| Neeko 独立性 | 依赖 DSH 插件启动自己 | **完全独立，可单独运行** |
| 启动入口 | 只有 `dsh --profile neeko` | DSH 或 Neeko 都可以 |
| UX | 单一模式 | **两种模式：直接进入 / 按需进入** |
| 通信桥梁 | 插件即控制层 | **dsh-neeko 是纯协议层，中立** |
| 生态价值 | Neeko 是 DSH 的附属 | **Neeko 是 DSH 的生态合作伙伴** |
| 可复用性 | 仅 Neeko 可用 | **任何客户端都可复用 daemon 模式** |
