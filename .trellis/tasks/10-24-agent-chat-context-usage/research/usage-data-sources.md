# 调研 — 各 chat 传输的 token 用量数据源（2026-10-24）

## 结论

首期（进度条 + 缓存命中率）只有 **PiRpc** 传输能拿到全量数据；其余三种传输协议侧无数据，
UI 走降级（计量器不渲染，与现状一致）。

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
| Acp | `adapter/acp.rs`（session/update 全部变体解析） | 无 usage 变体 |
| Serve(opencode) | `adapter/opencode/events_v1.rs / events_v2.rs / protocol.rs` | 无 token 字段解析；serve 事件流未见 usage（后续可再探 opencode 上游是否新增） |
| Jsonl(DeepSeek) | `adapter/deepseek.rs`（协议事件全集） | 协议未定义 usage 事件 |

## 前端现状（改造起点）

- `ContextWindowMeter.tsx`：环形按钮 + 弹层（已用/总量/剩余），`total` 语义误用
  （input+output 当上限，见 `messageModel.ts contextWindowOf` 注释 —— design.md 已知问题）。
- `meta` 事件唯一生产者是 `useMockEventSchedule.ts:339`（前端 mock）；Rust 侧无生产者。
- CSS：`src/styles/components/agent-chat.css` 的 `ctx-meter / ctx-pop-*` 系列。
