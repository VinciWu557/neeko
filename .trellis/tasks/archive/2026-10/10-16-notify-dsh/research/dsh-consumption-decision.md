# U7 定案（修正确）：DSH 通知接入 = 源 B 上报腿，不是源 A adapter

> **⚠️ 本文件取代此前两个错误结论。** 2026-10-27 首版把问题理解成「给 Neeko 加一个 DSH chat
> adapter」并据此写了 `dsh-transport-decision.md` 的定案 —— **方向错误**，已全部作废。
>
> 正确的问题陈述（用户 2026-10-27 纠正）：
> **让 Neeko 支持 DSH 的通知能力 —— DSH 把相关事件推送给 Neeko，和其他 agent 一样。**
>
> 这**不是**「DSH 作为一等 Agent 接入 Neeko 的会话系统」，**是**「DSH 作为第 8 个上报源」。
> 前者要写 adapter（源 A / chat 会话），后者要写上报（源 B / hooks）。

## 1. 之前的错误在哪里

| 我之前的推理 | 错在哪 |
| --- | --- |
| 「DSH 无 out-of-process hook 面 → 只能走源 A」 | **把「CLI 没有内置 hook 机制」当成「CLI 不能上报」**。cordis 插件是任意 Node 代码，`dsh-neeko` 自己就 `createServer()`，它当然也能 `fetch()` 往外 POST |
| 「Neeko 有 server，所以不用 WS」 | 结论对（不用 WS），但我拿它去论证「要保留 DSH 自己起 server 给 Neeko 连」—— 方向反了。正确含义是：**DSH 往 Neeko 的 server POST，DSH 侧不需要任何 server** |
| 「必须写 `ChatTransport::Ws` + adapter」 | 那是**对话接入**的工作。用户要的是**通知**。既不需要 adapter，也不需要新增 transport，更不需要 DSH 侧监听 |

**根因**：我把任务标题里的「源 A 桥投影」当成了不可动摇的前提，然后拼命为它找理由。
实际上 PRD 自己在 Step 0 就写着「消费侧归属未定案」——**它允许结论是「其实这不是源 A」**。

## 2. 正确的拓扑：DSH 是第 8 个源 B 上报源

### 2.1 源 B 的真实形态（读 `agent/hooks/` 源码）

源 B 的契约是**「一个能跑任意代码的 CLI 扩展点 + 一个往 loopback POST 的 shim」**：

```
CLI 扩展点（opencode plugin / pi extension / claude settings.json hooks / codex notify）
   ↓ 调用
shim（neeko-report.mjs / neeko-pi-status.ts / …）
   ↓ POST http://127.0.0.1:{随机端口}/hook/{source}
   ↓ header: x-neeko-agent-hook-token
Neeko server（axum，bind :0）
   ↓ AuthGate
ingest/validation.rs::hook_source()  ← 查 HOOK_TARGETS 白名单
   ↓
HookEvent { agent_session_id, event, cwd, detail, title, hints }
   ↓
ingest/notify.rs → NotificationCenter
```

`HookEvent.event` 是**语义 event_key**（`turn_completed` / `approval_requested` /
`input_requested` / `session_failed`），与源 A `notify.rs::event_keys` **同一命名空间** →
三层开关/节流自动生效。

### 2.2 DSH 完全符合这个前提

| 源 B 前提 | DSH 满足情况 |
| --- | --- |
| 有可编程扩展点 | ✅ cordis 插件（`~/.dsh/profiles/<name>/` 的 patch layer + npm 包） |
| 扩展点能跑任意 Node 代码 | ✅ `dsh-neeko` 已在跑：`createServer()`、`spawn()`、`ctx.on()` 都在用 |
| 能读到会话 id / cwd / 标题 | ✅ `session.header.cwd`、`session.id`、`session/title` 事件都有（`dsh-session@0.2.0-rc.2`） |
| 能拿到通知相关事件 | ✅ `approval/asked`、`user-questions/request`、`turn/end`、`agent/status`、`agent/error` |

**结论：DSH 不是「没有 hook 面」，而是「hook 面是 cordis 插件而不是 `settings.json` 里的一段配置」。
对源 B 而言这恰恰是**最好**的形态 —— 比 Codex 的信任门、Claude 的 JSON 合并都干净。

### 2.3 「和其他 agent 一样」意味着什么

| | opencode | pi | claude | codex | **dsh（本任务）** |
| --- | --- | --- | --- | --- | --- |
| 接入形态 | `Standalone` | `Standalone` | `Structured` | `NotifyArgv` | **新形态：`PluginPackage`** |
| 落盘位置 | `~/.config/opencode/plugins/` | `~/.pi/agent/extensions/` | `~/.claude/settings.json` | `~/.codex/config.toml` | `~/.dsh/profiles/<p>/` + patch 行 |
| 上报模板 | `neeko-opencode-status-v2.js` | `neeko-pi-status.ts` | 共用 `REPORT_SHIM` | 共用 `REPORT_SHIM` | **新模板 `neeko-dsh-status.ts`** |
| Neeko 侧代码 | 加一行 `HookTarget` | 同 | 同 | 同 | **同（加一行）** |

**这就是「和其他 agent 一样」的准确含义**：新增一个 `HookTarget` 数据行 + 一份上报模板，
`writers` / `server` / `settings` / 设置页**零改动**（`data.rs:66` 的注释明确承诺）。

## 3. 但 DSH 有一个真实的形态差异，必须承认

### 3.1 DSH 的「扩展点」不是目录，是**包 + patch 行**

现有四种 `InstallShape` 都不覆盖它：

| 现有 shape | 落盘方式 | 能否表达 DSH |
| --- | --- | --- |
| `Standalone` | 写一个受管文件到目录 | ❌ 光有文件不生效，还要 patch 插行 |
| `Structured` | shim 文件 + 往用户 JSON 插条目 | ❌ DSH 是 YAML（`cordis.patch.yml`），且文件形态不同 |
| `NotifyArgv` | 往 TOML 写一条 argv 数组 | ❌ 语义不同（那条 argv 由 CLI 自己调） |

DSH 的安装需要**两件事**：
1. 把插件包放到 profile 的 `node_modules`（或声明为依赖）
2. 在 `~/.dsh/profiles/<name>/cordis.patch.yml` 里插一行 `- insert: [{ id, name }]`

**这是新 shape，必须新增 `InstallShape::PluginPackage`（或等价变体）** —— 这是本任务最重的
一块，也是与「加一行数据」承诺的唯一偏离。必须诚实登记。

### 3.2 YAML 合并是新代码

`config/` 下现有 `json.rs` / `toml.rs` / `toml/`，**没有 yaml**。而 `serde_yaml = "0.9"`
已在 `Cargo.toml:37` —— 依赖现成，但合并算法（保序、保注释、只动自家行）是新写。

**风险**：`cordis.patch.yml` 是用户的**主配置文件**（本机 14905 字节，含 llm-pi-ai 等大量
用户配置）。用 `serde_yaml` 读写会**丢失注释与格式** —— 对用户是数据破坏。
`Structured` 腿对 JSON 的处理是 `read_json` + 纯变换 + 原子写（`config/json.rs`），
YAML 若照抄会破坏用户文件。

→ **必须改为「行级插入」**（在文件末尾追加一段受管块），而不是「解析再序列化」。
这与 `toml.rs` 处理 Codex `config.toml` 的做法是否需要对齐，须在实现时核对。

## 4. DSH 侧能拿到什么（决定通知覆盖面）

`dsh-neeko` 已订阅（`src/index.ts:155/158/162`）：

| DSH 事件 | 可映射 event_key | 备注 |
| --- | --- | --- |
| `approval/asked`（session 审计事件） | `approval_requested` | 比 `approval/request` waterfall **更安全**：后者是瀑布，不调 `next()` 会抢走内置面板 |
| `tool/call` 且 `name === 'ask_user_question'` | `input_requested` | `dsh-messager` 的做法（`signals.ts`），已实证 |
| `agent/status`（`running → idle`） | `turn_completed` | `dsh-messager/src/index.ts:282` 的做法 |
| `agent/error` | `session_failed` | `dsh-messager/src/index.ts:293` 的做法 |
| `session/title` | 主题（`title` 字段） | 原生标题来源 |
| `session.header.cwd` | `cwd` 字段 | ✅ 已核实 `types.d.ts:69` `readonly cwd?: string` |
| `session.id` | `agent_session_id` 字段 | ✅ |

**关键选择：用 `approval/asked` 而不是 `approval/request`。**

`approval/request` 是 cordis **waterfall**，`dsh-neeko` 当前注册为 answerer 并 `await`
Neeko 的回复 —— 那是**对话接管**，会抢走 DSH 内置审批面板。而通知只需要**知道发生了审批**，
`approval/asked` 是 `session.append()` 的**落库审计事件**（`dsh-user-approval/lib/index.js:132`），
**旁路可听、无副作用**。这正是 `dsh-messager` 选择它的原因。

→ **通知插件与 `dsh-neeko` 桥可以共存**：前者听审计事件，后者管 answerer 角色。
（此前 `dsh-transport-decision.md` §5 说「两者不能共存」是错的，已作废。）

## 5. 修正后的落点地图

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `src-tauri/src/agent/hooks/targets/shape.rs` | **改** | 新增 `InstallShape::PluginPackage` 变体（profile 根 / patch 文件 / 包名） |
| `src-tauri/src/agent/hooks/targets/dirs.rs` | **改** | `dsh_profiles_dir()`（`~/.dsh/profiles`，支持 `DSH_HOME` 覆写？需核） |
| `src-tauri/src/agent/hooks/targets/data.rs` | **改** | `HookTarget { source: "dsh", … shapes: &[InstallShape::PluginPackage { … }] }` |
| `src-tauri/src/agent/hooks/templates/neeko-dsh-status.ts` | **新增** | cordis 插件模板：订阅上述事件 → POST `/hook/dsh` |
| `src-tauri/src/agent/hooks/templates.rs` | **改** | `pub const DSH_TEMPLATE: &str = include_str!(…)` |
| `src-tauri/src/agent/hooks/install/shape/plugin_package.rs` | **新增** | 安装腿：包落位 + patch 行插入/移除 |
| `src-tauri/src/agent/hooks/install/config/yaml.rs` | **新增** | **行级** patch 块增删（不解析再序列化） |
| `src-tauri/src/agent/hooks/install/dispatch.rs` | **改** | 新 shape 的分派（`enum + match`，编译期强制） |
| `src-tauri/src/agent/hooks/install/status.rs` | **改** | 新 shape 的就绪探测 |
| `src-tauri/src/notification/**` | **零改动** | AC4 |
| `src-tauri/src/server/**` | **零改动** | 不需要新路由（`/hook/{source}` 已通用） |
| **`agent/chat/**`** | **零改动** | ← 与首版方案的关键差异：**不碰 chat 层** |
| **`common/agent/chat_launch.rs`** | **零改动** | 不新增 `ChatTransport` |
| **`packages/dsh-neeko`** | **零改动** | 通知插件与桥**互相独立**（§4） |

## 6. 与首版方案的成本对比

| | 首版（错误：源 A adapter） | 修正（正确：源 B 上报） |
| --- | --- | --- |
| 新增传输 | `ChatTransport::Ws` + 两张表 + 前端一行 | **无** |
| 新增 adapter | `dsh_ws.rs`（握手 + 帧翻译 + SessionRequest 编码） | **无** |
| 新增依赖 | `tokio-tungstenite` | **无**（`serde_yaml` 已有） |
| 改动 Neeko 会话层 | 大量（adapter 契约、capabilities、resume…） | **零** |
| 与「通知」目标的关系 | 顺带产物（要先跑通整个对话） | **直接命中** |
| 依赖 DSH 侧改动 | 要补桥的三处缺口 + 修 approval 挂死 | **无**（事件全在 host 侧可听） |
| 用户可见形态 | 多一个 chat agent | 多一个「已安装 hook」的 agent（与其他 7 个一致） |

**结论：修正方案的代码量约为首版的 1/5，且不触碰 chat / 会话 / 传输层。**

## 7. 剩余问题（需实测确认）

- [ ] **P1** `~/.dsh/profiles/<name>` 的判定：只装默认 profile？还是扫全部？（本机有
      `neeko` / `neeko-acp` / `web` / `tui` / `cc-tui` / `pi-tui` 六个）
- [ ] **P2** 包落位方式：`link:` 本地路径（本机现状）/ npm 包名 / 直接写进 profile 的
      `node_modules`？三种的可卸载性不同。
- [ ] **P3** patch 行插入位置：`cordis.patch.yml` 末尾追加 vs 按 `id` 定位插入。
      用户文件 14905 字节，误改风险高。
- [ ] **P4** `dsd` 的 `session/event` 在**恢复的旧会话**上是否重放（影响是否重复通知）：
      `dsh-messager` 的 `sessionTitleOf` 注释说日志含重放历史 → 可能导致重启后补发一批通知。
- [ ] **P5** 插件模板的语言：`.ts`（pi/omp 风格，靠 CLI 自己转译）vs `.mjs`（claude 风格）。
      DSH 的 loader 是否接受 TS？`dsh-neeko` 是 TS + `tsdown` 构建产物，故可能要**预构建**。

## 8. 作废文件说明

- `research/dsh-transport-decision.md` —— **§1/§4/§5 的结论全部作废**。
  其中仍然有效的**事实**（Neeko `server/` 是入站 axum、`HookEvent` 字段、`PORT_RETRY_BUDGET`）
  已吸收进本文件 §2；其余论述（「必须保留 WS 客户端」「不能共存」）是错的。
- `research/dsh-notify-prior-art.md` —— **事实部分仍然有效**（三个仓库源码调研、DSH 事件面、
  桥的三处缺口、approval waterfall 短路机制），但 §6 的「对本任务的直接关联」需按本文件重读：
  那些缺口现在**只影响 `dsh-neeko` 桥**，**不影响**通知插件（通知插件直接听 host 事件）。
