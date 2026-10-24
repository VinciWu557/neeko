# 实施计划 — Agent Chat 上下文窗口用量显示（首期）

前置：动手前必读 `src-tauri/AGENTS.md`（Rust 侧红线）与 `src/AGENTS.md`（前端红线）。
相关 spec：`.trellis/spec/backend/agent-chat-transports.md`（传输协议）、
`.trellis/spec/frontend/component-guidelines.md`。

## Step 1 — 协议扩展（Rust，Red→Green）

- [x] `src-tauri/src/agent/chat/events.rs`：`Usage` 增
      `context_tokens / context_limit / cache_read_tokens / cache_write_tokens`
      （全 `#[serde(default)]`，doc comment 说明数据源语义）
- [x] 测试：新字段 roundtrip；旧 JSON 反序列化四个新字段为 `None`
- [x] 验证：`cargo test -p neeko agent::chat::events`（或对应过滤）

## Step 2 — PiRpc 采集（Rust，Red→Green）

- [x] `translate.rs`：`Translation` 增 `settled: bool`；`agent_settled` 置 true
      （测试：该事件标记 true，其余 false）
- [x] `session.rs`：新增纯函数 `meta_from_stats(session_id, model, &Value) -> Option<StreamEvent>`
      （字段映射见 design §3；`contextUsage` 缺失仍产出；`tokens` 缺失返回 None）
- [x] `session.rs`：`next()` 的 `settled` 分支拉取 `get_session_stats` 并入队 Meta；
      失败 `log::debug!` 跳过（不发 Error）
- [x] 测试：`meta_from_stats` 三分支；`next()` 在 agent_settled 后产出 Meta
      （用 `PiRpcProcess::from_split` 喂伪响应，参照既有 tests 模式）
- [x] 验证：`cargo test pi_rpc`

## Step 3 — 前端类型与派生（Red→Green）

- [x] `src/shared/types/agentChat.ts`：`Usage` 镜像四字段
- [x] `messageModel.ts`：`ContextWindow` 改 `{ used, limit: number | null, model, cache? }`；
      `contextWindowOf` 按新语义实现（design §4.1）
- [x] 测试：`contextWindowOf` 五分支（design §6 表）
- [x] 验证：`pnpm test:fe -- messageModel`（或 vitest 过滤）

## Step 4 — 弹层 UI（Red→Green）

- [x] `ContextWindowMeter.tsx`：弹层重写（头部/进度条/命中率行/提示行，
      降级分支 design §5）；`formatWan` 工具函数（导出以便测试）
- [x] `src/styles/components/agent-chat.css`：`ctx-pop-*` 重写
- [x] 更新 `ContextWindowMeter.test.tsx`（旧断言按新 UI 调整 + 新分支用例）
- [x] 验证：`pnpm test:fe -- ContextWindowMeter`

## Step 5 — mock 与收口

- [x] `useMockEventSchedule.ts` meta 事件补新字段（design §4.4 数值）
- [x] `pnpm check:quick` 全绿
- [ ] 手动：pi 会话跑一轮，弹层显示进度条 + 命中率（截图记录到任务 notes）——待用户真机验证

## 回滚点

每步独立可回滚（协议字段向后兼容，UI 组件独立）。整体回滚 = revert 涉及文件，
无数据迁移、无存储格式变更。

## 审查门

- 红线自查：#5（无新事件名）/ #6（未动 Command 层）/ #15（无 language_id 分支）
- 语义自查：`total` 旧误用已移除；前端不再显示 `input+output` 当上限
