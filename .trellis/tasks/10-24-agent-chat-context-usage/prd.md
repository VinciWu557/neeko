# Agent Chat 上下文窗口用量显示（进度条+缓存命中率）

## Goal

按参考图（ZCode 上下文容量弹层）升级 Agent Chat 输入框旁的上下文用量计量器：
弹层显示「上下文容量」标题、`已用/上限（百分比）`、用量进度条、平均缓存命中率。
首期范围**只做进度条 + 缓存命中率**；分项占比图例与底部趋势 sparkline 不做（用户已拍板）。

核心问题：现有 `ContextWindowMeter` 的数据链是断的 —— 协议里 `Meta`/`Usage` 已定义，
但**没有任何真实 adapter 发射它**（只有 mock），且 `Usage` 缺少窗口上限与缓存字段。
本任务打通「协议扩展 → adapter 采集 → 前端展示」全链路。

## Requirements

- R1 **协议扩展**：`Usage`（`src-tauri/src/agent/chat/events.rs`）增加可选字段
  `context_tokens`（当前上下文占用）、`context_limit`（窗口上限）、
  `cache_read_tokens`、`cache_write_tokens`。全部 `#[serde(default)]` 向后兼容；
  TS 镜像（`src/shared/types/agentChat.ts`）同步。
- R2 **PiRpc adapter 采集**：每回合结束后（`agent_settled`）调用 pi RPC
  `get_session_stats`，把 `contextUsage {tokens, contextWindow}` 与累计
  `tokens {input, output, cacheRead, cacheWrite}` 翻译为 `Meta` 事件发射。
- R2b **Acp adapter 采集**（2026-10-24 修订新增）：监听 `session/update` 的
  `usage_update` 变体（ACP RFDS session-usage，Completed 2026-06-05），
  `used → context_tokens`、`size → context_limit`，model 取会话当前模型。
  无 cache 字段 → 命中率行降级隐藏。旧 agent 不发该变体 → 无计量器（兼容）。
- R3 **前端弹层重设计**（`ContextWindowMeter`）：
  - 头部：「上下文容量」+ 右侧 `20.5万/100万（20.5%）` 格式；
  - 横向用量进度条，颜色分级沿用现有阈值（>70% 黄 / >90% 红）；
  - 分割线 + 「平均缓存命中率」行，值 = `ΣcacheRead / (Σinput + ΣcacheRead + ΣcacheWrite)`。
- R4 **分级降级（禁止假数据）**：
  - 无任何 usage → 计量器整体不渲染（现状行为不变）；
  - 有 usage 无 `context_limit` → 显示已用 token 数，不显示百分比与进度条；
  - 无 cache 字段 → 隐藏命中率行；
  - `context_tokens` 缺失时回退 `input_tokens` 作为已用值。
- R5 **mock 更新**：`useMockEventSchedule` 的 meta 事件携带新字段，供开发预览。

## Out of Scope（首期明确不做）

- 分项占比图例（消息/系统工具/MCP 工具/技能/系统提示词/其他）—— CLI 协议不提供，估算策略待后续任务决策
- 底部统计区与 sparkline 趋势图（参考图中被模糊的区域）
- ACP `usage_update` 的 `cost` 字段消费（协议无对应字段，未来扩展点）
- Serve(opencode) / Jsonl(DeepSeek) 两种传输的用量采集（协议侧无数据，后续按传输逐个评估）
- `ChatComposer` 入口位置调整（环形按钮保留在 composer-left）

## Acceptance Criteria

- [ ] Rust：`Usage` 新字段 roundtrip 测试 + 旧 JSON（无新字段）反序列化向后兼容测试通过
- [ ] Rust：pi_rpc `get_session_stats` 响应 → `Meta` 事件翻译的单元测试通过（含 `contextUsage` 缺失的降级）
- [ ] Rust：acp `usage_update` → `Meta` 事件翻译的单元测试通过（含 size 缺失时忽略、model 注入）
- [ ] 前端：`contextWindowOf` 新语义测试（`context_tokens` 优先、`context_limit` 缺失、cache 派生）通过
- [ ] 前端：`ContextWindowMeter` 渲染测试（万单位格式化、百分比、命中率行、降级隐藏分支）通过
- [ ] `pnpm check:quick` 通过
- [ ] 真实 pi 会话中弹层显示进度条与命中率（手动验证，截图记录）
- [ ] 真实 ACP agent（如 claude-code / gemini，需其版本支持 usage_update）中弹层显示进度条（手动验证）

## Notes

- 参考图：ZCode 上下文容量弹层（会话内提供），头部 `20.5万/100万（20.5%）` + 进度条 + 平均缓存命中率 98.7%。
- 缓存命中率定义采用会话累计口径（pi `tokens` 为 session 累计值），单轮口径在分项功能落地时再引入。
