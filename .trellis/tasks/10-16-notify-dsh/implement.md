# Implement — DSH 通知接入（源 A 桥投影）

> 子任务执行计划。**与 hook 线正交，可并行。**
> **前置**：Step 0 定案（U7）后才能确定后续步骤形状。
> TDD 强制：Red → Green → Refactor。

---

## Step 0：Spike（阻塞，必须先做）

- [ ] **U7 消费侧归属**
      1. 读 `packages/dsh-neeko/docs/dsh-neeko-integration.md`：
         记录事件清单、握手协议、`session.init` 载荷、健康探针。
      2. 确认 `:3081` 启动条件：
         `dsh --profile neeko` 是否自动起 WebSocket server？
         还是需 daemon 模式（文档提到 `mode=dsh-agent` / `on-demand`）？
      3. **真实连接一次**：
         ```bash
         dsh --profile neeko   # 或 daemon 模式
         curl -s http://127.0.0.1:3081/neeko-health   # 健康探针
         # 观察端口是否在听
         lsof -nP -iTCP:3081 -sTCP:LISTEN
         ```
      4. 检查 `dsh-neeko` 是否送「会话结束 / 错误」类事件
         （决定 `prd.md` R2.1 后两行是否需要 `turn_completed` / `session_failed`）。
      5. 检查 `session.init` 是否带会话标题（决定 R4.2 的主题来源）。
      6. 定案：**A**（一等 Agent adapter）/ **B**（独立监听器）/ **C**（不实施）。
- [ ] 结论写入 `research/dsh-consumption-decision.md`（含原始证据：命令输出、协议片段）
- [ ] 回填 `prd.md` R1.1 / R2.1 / R4.2 与 `design.md`（删掉未选中分支）

**Gate**：U7 定案后才能进 Step 1。若定案 C → 直接进 Step 4 的「登记不实施」流程。

---

## Step 1（分支 A）：DSH 作为一等 Agent

- [ ] 先确认现有能力边界：
      `DeepSeekHarnessAdapter`（`agent/chat/adapter/deepseek.rs`）已实现 Jsonl stdio 协议，
      其 `ChatStart::Jsonl` 分支在 `adapter_for` 已存在 —— **是否已够用？**
      - 够用 → 只需 `AgentConfig` 一行数据（`ChatStart::Jsonl`）
      - 不够 → 新增 `ChatStart` variant（编译期强制处理，开闭）
- [ ] Red：`dsh_agent_config_is_registered`
      —— `builtin_configs()` 含 DSH 的 `AgentConfig`，且 `adapter_for` 能构造 adapter。
- [ ] Red：`dsh_adapter_maps_approval_request_to_request_approval`
      —— 给定 dsh-neeko 的 `approval.request` 载荷 → 得到 `StreamEvent::RequestApproval`。
- [ ] Red：`dsh_adapter_maps_question_request_to_user_input`
      —— `question.request` → `StreamEvent::UserInput`。
- [ ] Red：`dsh_adapter_ignores_unknown_events`
      —— 未知事件 fail-open（DSH 是 rc 版本，事件名会漂移）。
- [ ] Green：实现 adapter 映射（或复用 `deepseek.rs`）。
- [ ] **验证零新增通知代码**：`git diff` 中 `agent/chat/notify.rs` 与 `notification/**` 为空。
- [ ] 跑 `cargo test agent::chat` 全绿。

---

## Step 2（分支 B）：独立监听器

> 仅在 U7 定案 B 时执行。**必须在 `design.md` 记录相对 A 的代价。**

- [ ] Red：`dsh_listener_projects_approval_request`
      —— 给定 dsh-neeko 事件 → 期望的 `NotificationSignal`。
- [ ] Red：`dsh_listener_fails_open_on_disconnect`
      —— `:3081` 不可达时静默重试（或降级），不 panic、不影响启动。
- [ ] Red：`dsh_projection_shares_event_key_namespace`
      —— 投影出的 `event_key` 与 `agent/chat/notify.rs::event_keys` 同一命名空间
      （三层开关自动生效，父任务 R1.2）。
- [ ] Green：`agent/dsh/` 域（`mod.rs` 仅 mod + pub use，红线 9）+ `boot.rs` 域启动入口
      （与 `agent/hooks/boot.rs` 同形）+ `listener.rs` + `notify.rs`。
- [ ] Green：`app/boot.rs` 挂载（与既有四域 boot 对称）。
- [ ] 跑 `cargo test agent::dsh` 全绿。

---

## Step 3：归属与回流

- [ ] 分支 A：确认 `instance_id` = Neeko 会话 id → 回流（deep link `neeko://agent/{id}`）
      自动可用，无需额外工作。
- [ ] 分支 B：自造 `instance_id`（`dsh:{session_id}`）+ 回流映射。
- [ ] Red：`dsh_topic_falls_back_to_first_prompt`
      —— 无原生标题时走既有降级链（分支 A 自动；分支 B 需实现）。
- [ ] 确认**不使用** `attribution.rs`（源 B 的降级链，DSH 有完整上下文）。

---

## Step 4：实测与收尾

- [ ] 分支 C（不实施）路径：写 `research/dsh-consumption-decision.md` 记录理由
      → 跳过 Step 1–3 → 直接归档（R5.3 父任务允许缩小范围）。
- [ ] 分支 A/B 路径：
      - [ ] 实测（AC5）：DSH 会话触发审批/提问 → Neeko 失焦 → 收到系统通知。
      - [ ] `pnpm check:quick` **收尾一次**（已含全部静态检查 + 护栏 + 改动文件相关单测）。
            开发中不要每轮重跑，也不要单独再敲 `pnpm lint` / `pnpm test`。
      - [ ] 确认 `src-tauri/src/agent/hooks/**` 无 diff（AC3）。
      - [ ] 确认 `src-tauri/src/notification/**` 无 diff（AC4）。
      - [ ] 同步 spec（若 DSH 接入产生了可复用的模式）。
      - [ ] 归档子任务。

---

## 验证命令速查

```bash
# 收尾检查（整个任务一次；含静态检查 + 护栏 + 改动文件相关单测）
pnpm check:quick

# 定点：TDD 红绿 / 排查（这是观察，不是验证；开发中可跑）
cargo test --manifest-path src-tauri/Cargo.toml agent::chat   # 分支 A
cargo test --manifest-path src-tauri/Cargo.toml agent::dsh    # 分支 B

# 零耦合自证
git diff <base>..HEAD -- src-tauri/src/agent/hooks/         # 应为空（AC3）
git diff <base>..HEAD -- src-tauri/src/notification/        # 应为空（AC4）

# DSH 桥可达性（Step 0 spike）
lsof -nP -iTCP:3081 -sTCP:LISTEN
curl -s http://127.0.0.1:3081/neeko-health
```

> `pnpm check` 以及更细的 `pnpm lint` / `pnpm test` 不在本地开发流程内 —— push / CI 兜底。
> `pnpm check:quick` 是收尾动作，不是每次编辑的收尾动作。

---

## 回滚点

| 回滚点 | 触发 | 动作 |
| --- | --- | --- |
| Step 0 后 | U7 = C（`:3081` 不可用 / `dsh-neko` 未完成） | 登记不实施，归档本任务（R5.3 允许） |
| Step 0 后 | U7 = B 但代价过高 | 重新评估 A；A 也不可行则退 C |
| Step 1 后 | 发现必须改 `agent/chat/notify.rs` | 重新评估（可能是 DSH 事件无法归一为既有 `StreamEvent`） |
| 任意 | 发现必须改 `agent/hooks/**` | **停止** —— 说明拓扑判断有误（父任务 AC2），回父任务 design.md |
| 任意 | 发现必须改 `dsh-neeko` 包 | **停止** —— 另立任务（该包门禁豁免，走其 `prepublishOnly`） |
