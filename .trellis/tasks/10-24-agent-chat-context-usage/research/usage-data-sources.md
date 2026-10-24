# 调研 — 各 chat 传输的 token 用量数据源（2026-10-24）

## 结论

首期（进度条 + 缓存命中率）：**PiRpc** 与 **Acp** 两条传输可采集（Acp 于 2026-10-24 二次调研修订，
见下）；opencode serve 与 DeepSeek jsonl 协议侧无数据，UI 走降级（计量器不渲染）。

> 修订记录：首版结论是「只有 PiRpc 可用」——基于 acp.rs 当时只解析到的
> session/update 变体。用户提供 ACP RFDS `session-usage`（Completed 2026-06-05）
> 后修订：协议已有标准化的 `usage_update` 推送。

## Acp — usage_update 推送（RFDS session-usage，Completed）

来源：https://agentclientprotocol.com/rfds/session-usage（`/rfds/session-usage.md`）。

agent 通过 `session/update` 通知**主动推送**（无需客户端请求）：

```json
{"method":"session/update","params":{"sessionId":"…","update":{
  "sessionUpdate":"usage_update","used":53000,"size":200000}}}
```

- `used`（required）：当前上下文占用 token（**含缓存 token** —— 缓存 token 也占窗口）；
- `size`（required）：窗口上限；无有意义上限的 agent **不发**该变体（无 null/省略态）；
- `cost`（optional `{amount, currency}`）：会话累计成本 —— 本期不消费（协议无对应字段，
  未来扩展点）；
- **无 cache 计数字段**（命中率相关度量拆分在另一份 draft RFD `end-turn-token-usage`）
  → 前端命中率行按缺失隐藏；
- 推送时机：session/new 后、resume/fork 后、每轮 prompt 后、状态显著变化时；
  连接到已有会话（session/load）时 agent 也应立即推一条。

映射：`used → context_tokens`、`size → context_limit`；model 载荷不携带，
取会话当前模型（`current_model_from_config`）。

## PiRpc（pi agent）— 全量可用

pi RPC 命令 `get_session_stats`（pi docs `rpc-commands.md`，1.4.x）：

```json
{"type": "get_session_stats"}
→ data: {
  "tokens": {"input":…, "output":…, "cacheRead":…, "cacheWrite":…, "total":…},
  "contextUsage": {"tokens":…, "contextWindow":…, "percent":…}
}
```

- `tokens`：**会话累计**（含 tool 嵌套与 compaction 生成用量）。
  `input` 不含 cacheRead/cacheWrite（`totalTokens = input + output + cacheRead + cacheWrite`，
  session-format.md 的 cache_warm 实例佐证：input=0, cacheRead=50000, totalTokens=50000）。
- `contextUsage`：**当前上下文占用估计**（compaction/footer 同源）。
  无模型或无窗口信息时整体省略；compaction 后到新 assistant 响应前 `tokens/percent` 为 null。
- per-turn `usage` 也在 assistant message 上（`message-types.md` §Usage：
  input/output/cacheRead/cacheWrite/cacheWrite1h?/reasoning?/totalTokens/cost），
  但不含窗口上限 —— 窗口数据只能走 `get_session_stats`。

命中率口径（本任务采用）：`cacheRead / (input + cacheRead + cacheWrite)`，会话累计。

## 其余传输 — 无数据

| 传输 | 检查点 | 结论 |
| --- | --- | --- |
| Acp | RFDS `session-usage`（Completed 2026-06-05）：`usage_update` 推送 used/size | **可采集**（无 cache 字段，命中率降级） |
| Serve(opencode) | `adapter/opencode/events_v1.rs / events_v2.rs / protocol.rs` | 无 token 字段解析；serve 事件流未见 usage（后续可再探 opencode 上游是否新增） |
| Jsonl(DeepSeek) | `adapter/deepseek.rs`（协议事件全集） | 协议未定义 usage 事件 |

## 前端现状（改造起点）

- `ContextWindowMeter.tsx`：环形按钮 + 弹层（已用/总量/剩余），`total` 语义误用
  （input+output 当上限，见 `messageModel.ts contextWindowOf` 注释 —— design.md 已知问题）。
- `meta` 事件唯一生产者是 `useMockEventSchedule.ts:339`（前端 mock）；Rust 侧无生产者。
- CSS：`src/styles/components/agent-chat.css` 的 `ctx-meter / ctx-pop-*` 系列。
