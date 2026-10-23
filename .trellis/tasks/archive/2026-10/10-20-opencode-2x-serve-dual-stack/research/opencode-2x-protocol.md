# opencode 1.19 / 2.0 serve 协议实测取证

调研时间：2026-10-20
调研对象：`.trellis/tasks/10-20-opencode-2x-serve-dual-stack`
事实来源：**本机双版本二进制实测**（不依赖二手文档）

| 版本 | 二进制 | 用途 |
| --- | --- | --- |
| 2.0.32 | `~/.opencode/bin/opencode`（`opencode --version` → `opencode v2.0.32`） | 故障现场版本 |
| 1.19.0 | `/opt/homebrew/bin/opencode`（`1.19.0`） | 需继续保持可用的版本 |

> 所有样本均在隔离的 `XDG_*` 目录下抓取，未触碰用户真实会话库；
> 唯一例外是「老会话在 2.0 下是否可见」，直接读 `~/.local/share/opencode/opencode.db`（只读）。

---

## 1. 就绪握手（当前故障点的直接原因）

**未**注入 `OPENCODE_SERVER_PASSWORD` 时，`opencode serve --hostname 127.0.0.1 --port 0` 的 stdout 逐字样本：

```
# 1.19.0
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
opencode server listening on http://127.0.0.1:4605

# 2.0.32
server listening on http://127.0.0.1:60656
server password Pv7ju-J23aVuaEqGanFIBu23XbM0jCQGiWgioRvKnf0
```

此外，**注入 `OPENCODE_SERVER_PASSWORD` 后两版的输出都只剩一行 URL**（2.0 不再打印密码行）：
```
# 2.0.32 + OPENCODE_SERVER_PASSWORD=pp
server listening on http://127.0.0.1:4643

# 1.19.0 + OPENCODE_SERVER_PASSWORD=mypass
opencode server listening on http://127.0.0.1:4633
```

三个事实：

1. 2.0 **去掉** `opencode ` 前缀 → 现有 `MARKER = "opencode server listening on "` 恒不命中，
   `read_listening_url` 一直读到 EOF/超时。
2. 2.0 在**未**注入 `OPENCODE_SERVER_PASSWORD` 时**新增**第二行 `server password <pwd>`（每进程随机），
   且**强制** Basic 认证；注入后该行消失、输出回到单行。
3. 两版**都**认 `OPENCODE_SERVER_PASSWORD`（1.19 未设时只警告 `server is unsecured`，2.0 未设时自动生成随机密码）。
   设置后两版都要求 `Authorization: Basic base64("opencode:<pwd>")`
   —— 用户名必须是 `opencode`，其他用户名一律 401（实测 `x:<pwd>` → 401，`opencode:<pwd>` → 200）。

**故就绪握手应统一到「主动注入密码」**：既让 2.0 的输出退回单行、又让 1.x 继续保持可用，
密码始终由 Neeko 持有，不必解析随机行。`server password ` 兜底解析只在「注入未生效」时才用得上。

---

## 2. 端点对照

| 能力 | 1.19.0 | 2.0.32 |
| --- | --- | --- |
| 建会话 | `POST /session?directory=<dir>` → `{"id":...}`（裸对象） | `POST /api/session` body `{"title","location":{"directory"}}` → `{"data":{"id":...}}`；**`?directory=` 被忽略**，落到 serve 进程 cwd |
| 首轮提问 | `POST /session/{id}/prompt_async` `{parts:[{type:"text",text}],model:{providerID,modelID}}` | `POST /api/session/{id}/prompt` `{text}`；**`model` 字段被静默忽略**（实测 step 仍是默认模型） |
| 切模型 | 无独立端点（per-prompt） | `POST /api/session/{id}/model` `{model:{providerID,id}}` → 204；裸 `id`，**不是** `modelID`（后者 400 `Missing key at ["model"]["id"]`） |
| 事件流 | `GET /event?directory=<dir>`（必须带 directory） | `GET /api/event`（**不接受**任何 query；按事件自带 `location.directory` 区分） |
| 权限回执 | `POST /session/{id}/permissions/{pid}` `{response:"once"|"reject"}` | `POST /api/session/{id}/permission/{rid}/reply` `{decision:"once"|"always"|"reject"}` |
| 提问回执 | `POST /question/{rid}/reply?directory=` `{answers:[["text"]]}` | `POST /api/session/{id}/form/{fid}/reply` `{answer:{"<key>":<value>}}` |
| 中断 | `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt`（`abort` 在 2.0 不存在） |
| 列表/读会话 | `GET /session`、`GET /session/{id}` | `GET /api/session`、`GET /api/session/{id}` |

**关键陷阱**：2.0 对未匹配的路由回落 SPA `index.html`（`200 text/html`），
旧 `GET /event`、`GET /session` 在 2.0 下都是 **200 + HTML**，不报错。
`POST /session` 因为方法不匹配返回 **405**。任何「只看状态码」的判定都会误判为成功。

---

## 3. 协议探测判据（唯一可靠信号）

| 请求 | 1.19.0 | 2.0.32 |
| --- | --- | --- |
| `GET /api/info`（带 Basic） | `200 text/html`（SPA 回落，路由不存在） | `200 application/json` → `{"version":"2.0.32","pid":…,"capabilities":{"persistentPty":true}}` |
| `GET /openapi.json` | `200 text/html`（SPA 回落） | `200 application/json`（119 条路径） |

**用 `GET /api/info` 的 `Content-Type` 判别**：JSON → v2，HTML → v1。
不要用版本号字符串（用户可能装任意 1.18.x/1.19.x，且 `--version` 输出格式两版不同：
1.19 是 `1.19.0`，2.0 是 `opencode v2.0.32`）。

注意 1.19 **已经**存在部分 v2 路由（`POST /api/session` 200、`GET /api/event` 200），
所以「`/api/*` 能通」不构成 v2 判据；`/api/session/{id}/prompt` 在 1.19 返回 **400**。

---

## 4. 事件面差异（SSE `data:` 逐字样本）

包络：1.19 `{id,type,properties}`；2.0 `{id,created,type,location,data,durable}`。

### 4.1 2.0 才有的事件

```jsonc
{"type":"session.execution.started",   "data":{"sessionID":"ses_…"}}
{"type":"session.execution.succeeded", "data":{"sessionID":"ses_…"}}
{"type":"session.execution.failed",    "data":{…}}
{"type":"session.execution.interrupted","data":{…}}
{"type":"session.text.started",  "data":{"sessionID":"…","assistantMessageID":"…","ordinal":0}}
{"type":"session.text.delta",    "data":{"sessionID":"…","delta":"Hi there, friend!"}}
{"type":"session.text.ended",    "data":{"sessionID":"…","text":"Hi there, friend!"}}
{"type":"session.reasoning.started|delta|ended", "data":{"…","delta":"…"}}
{"type":"session.step.started",  "data":{"sessionID":"…","agent":"build","model":{"id":"big-pickle","providerID":"opencode"},"started":…}}
{"type":"session.step.ended",    "data":{"…","finish":"stop","cost":0,"tokens":{"input":2346,"output":7,"reasoning":5,"cache":{"read":4672,"write":0}}}}
{"type":"session.usage.updated", "data":{"sessionID":"…","cost":0,"tokens":{"input":201,"output":129,"reasoning":184,"cache":{"read":6848,"write":0}}}}
{"type":"session.tool.input.started","data":{"sessionID":"…","id":"766c…","name":"write"}}
{"type":"session.tool.input.ended",  "data":{…}}
{"type":"session.tool.called",  "data":{"sessionID":"…","id":"766c…","input":{"path":"…","content":"hi"},"executed":false}}
{"type":"session.tool.progress", "data":{…}}
{"type":"session.tool.success", "data":{"sessionID":"…","id":"766c…","content":[{"type":"text","text":"Created file successfully: zz.txt"}],"metadata":{"truncated":false}}}
{"type":"session.tool.failed",  "data":{…}}
{"type":"form.created", "data":{"form":{"id":"frm_…","sessionID":"…","title":"Questions","metadata":{"kind":"question","tool":{"id":"call_…"}},"fields":[{"key":"q0","title":"Favorite color","description":"What is your favorite color?","type":"string","options":[{"value":"Blue","label":"Blue"}],"custom":true}]}}}
```

### 4.2 2.0 已消失的事件

- `message.part.updated` / `message.part.delta`（改成 `session.text.*` / `session.tool.*`）
- `session.idle`（改成 `session.execution.succeeded`）—— 4 次实测抓包中 `session.idle` 命中数为 **0**
- `question.asked`（改成 `form.created` 且 `metadata.kind == "question"`）
- `todo.updated`（二进制中已无该字面量；`todowrite` 工具仍在，但没有 todos 快照事件）

### 4.3 两版都在的事件

- `permission.asked`，但载荷形状变了：
  ```jsonc
  // 2.0
  {"type":"permission.asked","data":{
    "id":"per_…","sessionID":"ses_…","action":"edit","resources":["pp.txt"],"save":["*"],
    "metadata":{"files":[{"file":"pp.txt","patch":"Index: pp.txt\n…","status":"added","additions":1,"deletions":0}]},
    "source":{"type":"tool","messageID":"msg_…","id":"call_…"}}}
  ```
  1.x 是 `{id, permission, patterns[], metadata.command}`；2.0 是 `{id, action, resources[], metadata.files[].patch}`。
  **`metadata.files[].patch` 是现成的 unified diff**，可直接填 `RequestApproval.diff`（1.x 路径没有）。

---

## 5. 建会话时的权限规则（confirm 模式）

| 版本 | 字段 | 形状 | 实测结论 |
| --- | --- | --- | --- |
| 1.19 | `permission` | `[{permission,pattern,action}]` | 生效 |
| 2.0 | `permissions` | `[{action,resource,effect:"allow"|"deny"|"ask"}]` | 生效 |

**陷阱**：2.0 收到 1.x 的 `permission` 字段 → **200 且静默丢弃**
（回读 session，`permissions` 字段为 `ABSENT`）。即「confirm 模式在 2.0 下变成 auto」，
用户在无人审批的情况下被直接改文件。反过来 2.0 的 `permissions` 在 1.19 会 400
（`Expected Permission.Ruleset` 是 2.0 的错误文案，1.19 上字段未知）。

---

## 6. 模型列表来源

| 命令 | 1.19.0 | 2.0.32 |
| --- | --- | --- |
| `opencode models` | ✅ slug 行 | ✅ slug 行（**但**无外部 service 时会尝试拉起 managed service，端口冲突即 exit 1） |
| `opencode models --verbose` | ✅ slug 行 + NDJSON 明细（`id/providerID/name/limit.context/variants/cost`） | ❌ `ERROR Unrecognized flag: --verbose in command opencode models`（exit 1） |
| `opencode models --standalone` | ❌ `Unrecognized flag`（exit 1） | ✅ slug 行（无明细） |
| `GET /api/model` | ✅ `{location,data:[{id,providerID,name,api,request,variants,…}]}` | ✅ `{location,data:[{id,modelID,providerID,name,package,settings,capabilities,limit:{context},cost,…}]}` |

真实日志佐证（`~/.neeko/neeko.log`，2026-10-20 18:00:15）：

```
[discover_opencode_models] Executing: opencode models --verbose
[discover_opencode_models] Exit code: 1, stdout length: 967, stderr length: 65
[discover_opencode_models] Command failed (code 1): ERROR
  Unrecognized flag: --verbose in command opencode models
```

---

## 7. 会话可见性（迁移是单向的）

- 2.0 新会话写入 `session_v2` + `session_message`（**不写** `session` / `message` / `part`）。
  全新 2.0 数据目录里 `session` 表**不存在**。
- 1.x 的 `session` 行在升级后会被迁移进 `session_v2`（用户真实库里 666 → 670），
  但 2.0 serve 用 `GET /api/session/{id}` 查这些历史 id 仍 **404 SessionNotFoundError**
  （`directory` query 也救不回来，`GET /api/session?directory=…` 返回空数组）。
  即：**1.x 老会话在 2.0 下不可 resume**。

> 本条只影响 `resume` 与历史列表，不影响新会话 —— 但 resume 失败必须给明确错误，
> 不能挂起（现有实现 `attach_streaming` 不校验会话存在性，只会静默等 SSE）。

---

## 8. 与本次故障对应的真实日志

`~/.neeko/neeko.log`（2.0.32 已装、Neeko 运行中）：

```
[ServeAdapter] starting `opencode serve`
[ServeAdapter] serve stdout: server listening on http://127.0.0.1:64950
[ServeAdapter] serve stdout: server password p4gZExo7C1OL9v5vFVEyW6sha5U38WbTJylh0EpjL0k
[ServeAdapter] starting `opencode serve`          ← 10 秒后重来，没有 "listening at"
```

- `[ServeAdapter] … listening at` 出现次数：**0**
- `starting opencode serve` 出现次数：10，间隔严格 10s（= `STARTUP_TIMEOUT`）
- `serve POST /session` 出现次数：**0**（从未走到建会话）
- 触发方是 `[translation_stream]`（注释翻译复用 chat 链路），所以表现为「翻译与 chat 全挂」。
