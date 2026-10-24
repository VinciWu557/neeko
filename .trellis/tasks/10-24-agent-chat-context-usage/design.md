# 设计 — Agent Chat 上下文窗口用量显示（首期：进度条 + 缓存命中率）

## 0. 参考图还原目标

ZCode 弹层（用户提供）首期还原三块：

```
┌──────────────────────────────────────┐
│ 上下文容量              20.5万/100万（20.5%）│
│ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│ ──────────────────────────────────── │
│ 平均缓存命中率                    98.7% │
└──────────────────────────────────────┘
```

入口保持现状：`ChatComposer` 底部 `composer-left` 的环形按钮（模型选择器旁）。

## 1. 数据能力矩阵（调研结论，2026-10-24）

| 传输 | 用量数据源 | 首期结论 |
| --- | --- | --- |
| **PiRpc**（pi agent） | RPC `get_session_stats`：`contextUsage {tokens, contextWindow, percent}` + 累计 `tokens {input, output, cacheRead, cacheWrite}`；assistant message 亦带 per-turn `usage` | **全量支持**（含命中率） |
| **Acp**（claude-code/gemini/qoder/…） | RFDS `session-usage`（Completed 2026-06-05）：`session/update` 的 `usage_update` 变体主动推送 `used`/`size`，可选 `cost` | **支持**（无 cache 字段，命中率行降级） |
| Serve（opencode） | serve 事件流当前无 token 字段（events_v1/v2 均未解析） | 不采集，UI 降级 |
| Jsonl（DeepSeek harness） | 协议无 usage 事件 | 不采集，UI 降级 |

pi 关键语义（`pi docs rpc-commands.md` §get_session_stats）：

- `tokens` 是**会话累计**（含 tool 嵌套调用与 compaction 生成用量）；`input` **不含** cacheRead/cacheWrite（`totalTokens = input + output + cacheRead + cacheWrite`，session-format.md 实例佐证）。
- `contextUsage` 是**当前上下文占用估计**（compaction 与 footer 同源），压缩后到新响应前 `tokens/percent` 为 `null` —— 属正常降级，不视为错误。

## 2. 协议扩展（Contract C1，向后兼容）

`src-tauri/src/agent/chat/events.rs` 的 `Usage` 增加四个可选字段：

```rust
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// 当前上下文占用（pi `contextUsage.tokens`；compaction 后暂缺）。
    #[serde(default)]
    pub context_tokens: Option<u64>,
    /// 模型上下文窗口上限（pi `contextUsage.contextWindow`）。
    #[serde(default)]
    pub context_limit: Option<u64>,
    /// 会话累计缓存读取 token（pi `tokens.cacheRead`）。
    #[serde(default)]
    pub cache_read_tokens: Option<u64>,
    /// 会话累计缓存写入 token（pi `tokens.cacheWrite`）。
    #[serde(default)]
    pub cache_write_tokens: Option<u64>,
}
```

- 无新事件、无新事件名 —— `Meta` 事件与 `AGENT_CHAT_EVENT` 常量复用（红线 5 无涉）。
- `#[serde(default)]` 保证旧 adapter / 旧会话回放 JSON 反序列化不破。
- TS 镜像 `src/shared/types/agentChat.ts` 的 `Usage` 同步四个同名字段（snake_case）。

**缓存命中率口径**（会话累计）：

```
hitRate = cacheRead / (input + cacheRead + cacheWrite)
```

即「全部 prompt token 中命中缓存的比例」；分母为 0 时不显示。派生计算放前端
（`contextWindowOf`），协议只传原始计数 —— 口径变化时不动协议。

## 3. PiRpc 采集（adapter 层）

挂载点：`src-tauri/src/agent/chat/adapter/pi_rpc/session.rs` 的
`PiSession::next()` 进程事件分支。触发时机：pi `agent_settled`
（一个回合的**稳定终点**；文档明确一个 prompt 可能有多个 `turn_end`，不能用后者）。

分层约束（沿用该目录既定架构，见 session.rs 顶部注释）：

- `translate.rs` 是纯函数、不发起请求 —— 在其 `Translation` 结构上增加
  `settled: bool` 标记（与既有 `approval` 标记同模式），由它识别 `agent_settled`。
- `session.rs` 在 `next()` 里看到 `settled == true` 时：

```rust
// agent_settled → 拉取会话统计，发 Meta（失败只 debug 日志，不产 Error 事件：
// 统计拉不到不等于回合失败）
if let Ok(data) = self.proc.request(json!({"type": "get_session_stats"}), None).await {
    if let Some(meta) = meta_from_stats(&self.session_id, model, &data) {
        self.pending.push_back(meta);
    }
}
```

- `meta_from_stats`：纯函数（`serde_json::Value → Option<StreamEvent::Meta>`），
  单独可测。字段映射：`contextUsage.tokens → context_tokens`、
  `contextUsage.contextWindow → context_limit`、`tokens.input/output/cacheRead/cacheWrite → *`
  。`contextUsage` 整体缺失时仍发 Meta（只有累计 token 与缓存字段）。
- model 名取自 `get_session_stats` 无该字段时的会话当前模型（`CurrentSelection` 已在握手缓存）。

错误策略：stats 请求失败/超时 → `log::debug!` 跳过本次，**不发 Error 事件**
（遥测缺失不应打断对话流）。

## 3b. Acp 采集（adapter 层，2026-10-24 修订新增）

ACP 是 **agent 主动推送**（与 pi 的「回合后拉取」相反）：`session/update` 通知的
`usage_update` 变体（RFDS session-usage，Completed 2026-06-05；旧 agent 不发，
`_ => None` 兜底天然兼容）。落点：`src-tauri/src/agent/chat/adapter/acp.rs` 的
`translate_notification` 加一个分支：

- 映射：`update.used → context_tokens`、`update.size → context_limit`；
- `used`/`size` 均为 required：缺任一返回 `None`（忽略该条，与其它分支容错一致）；
  数值解析容忍 float（JSON number 若由浮点类型产生，`as_u64` 会失败，静默丢
  更新的失败模式难排障 —— `as_u64` 失败后回退 `as_f64` 截断）；
- model 载荷不携带：`translate_notification` 增参 `current_model: Option<&str>`，
  由调用点 `handle_inbound` 从 `acp_config::current_model_from_config(&configs)`
  传入（与 pi_rpc 同源同函数，模型切换后保持新鲜）；
- `cost` 字段本期忽略（协议无对应字段，记为未来扩展点）；无 cache 字段 →
  前端命中率行按既有降级隐藏。

## 4. 前端重设计

### 4.1 数据派生（`messageModel.ts`）

```ts
export interface ContextWindow {
  used: number;            // context_tokens ?? input_tokens（回退）
  limit: number | null;    // context_limit，未知为 null
  model: string;
  cache?: {
    read: number; write: number; input: number;
    hitRate: number;       // read / (input + read + write)，三值齐备才有
  };
}
```

`contextWindowOf` 新语义（替换现有 input+output 误用 `total` 的实现）：
`usage` 全空仍返回 `null`（不渲染计量器）。

### 4.2 组件（`ContextWindowMeter.tsx`）

弹层结构（替换现有 ctx-pop 三行 stats 布局）：

- 头部：`上下文容量` + 右侧 `formatWan(used)/formatWan(limit)（pct%）`
- 进度条：`limit` 非 null 才渲染；填充色沿用阈值（>90 红 / >70 黄 / 其余绿）；
  无 limit 时该区域显示 `已用 X tokens`（无条无百分比）
- 分割线 + `平均缓存命中率` + 右侧 `xx.x%`；`cache` 缺失整行隐藏
- 底部提示行保留现有文案（容量充足/用量偏高/接近上限）

`formatWan`：`≥ 1万 → `万` 单位一位小数（20.5万），`< 1万 → 千分位原值`。
环形按钮入口（外圈 + pct 标签）不变；按钮 pct 在无 limit 时显示 `∞` 不合适 ——
显示 `used 万单位`（如 `20.5万`），有 limit 时维持百分比。

### 4.3 样式

`src/styles/components/agent-chat.css`：重写 `ctx-pop-*` 系列
（头部双栏、进度条 `ctx-pop-bar/-fill`、命中率行复用 `ctx-pop-row`），
色值走既有 CSS 变量（`--accent-green/yellow/red`、`--border`）。

### 4.4 mock

`useMockEventSchedule.ts` 的 meta 事件补 `context_tokens: 205000,
context_limit: 1_000_000, cache_read_tokens: 197_400, cache_write_tokens: 1_200`
（命中率 ≈ 98.7%，对齐参考图）。

## 5. 降级矩阵（R4 的展开）

| 数据形态 | 按钮入口 | 弹层表现 |
| --- | --- | --- |
| 无 usage（Acp/Serve/Jsonl 传输） | 不渲染 | — |
| 有 usage 无 context_limit | 显示已用量 | 头部右侧只显 `20.5万`，无进度条 |
| context_tokens 缺失（compaction 后） | 同上（回退 input_tokens） | 同上 |
| 无 cache 字段 | 正常 | 隐藏命中率行 |

原则：**每一块 UI 只渲染有真实数据支撑的内容**，禁止占位假数据。

## 6. 测试策略（TDD）

| 层 | 用例 |
| --- | --- |
| Rust events.rs | 新字段 roundtrip；旧 JSON（无新字段）反序列化为 None（向后兼容红线） |
| Rust session.rs | `meta_from_stats`：全量映射 / `contextUsage` 缺失 / `tokens` 缺失返回 None |
| Rust translate.rs | `agent_settled` → `settled: true` 标记 |
| FE messageModel | `contextWindowOf`：全量 / context 回退 input / limit null / cache 派生 / 全空 null |
| FE ContextWindowMeter | formatWan 边界（9999/10000/205000）、命中率行渲染与隐藏、无 limit 分支、进度条阈值色 |

每步 Red → Green → Refactor；`pnpm check:quick` 收口。

## 7. 风险与边界

- **pi 版本差异**：`get_session_stats` 为 pi 1.4.x 已有命令（docs 佐证）；旧 pi 无此命令时
  request 失败 → debug 日志跳过，行为回到「无计量器」，无害。
- **`request()` 并发**：`next()` 与请求 pump 共享 `proc`（`Arc`）；`request` 内部有
  pending 表配对响应，回合结束后调用无并发窗口（pump 只处理页面请求）。
- **大数值精度**：token 计数 `u64`/number，前端展示万单位一位小数，无精度问题。
- **`percent` 字段不复用**：pi 的 `contextUsage.percent` 与本地计算可能舍入不一致，
  统一前端自算（单一真相）。
