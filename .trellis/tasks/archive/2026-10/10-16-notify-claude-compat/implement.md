# Implement — OMP + Claude/CodeBuddy/Qoder 通知接入

> 子任务执行计划。跨子任务契约见父任务 `design.md`；本文件是**有序 checklist**。
> TDD 强制：Red → Green → Refactor。每个 Step 的测试先写。

---

## Step 0：Spike（阻塞后续，必须先做）

- [ ] **U1 OMP 事件面**：读 `~/.omp/agent/extensions/orca-agent-status.ts` 的 `pi.on(...)` 清单；
      对照 pi 模板的三条腿（`agent_end` / `tool_call` / `ui_prompt_start`）。
      结论：OMP 是否支持 `ui_prompt_start`？
      - 支持 → OMP 复用完整 pi 模板（`include_str!` 同一常量）
      - 不支持 → OMP 需要模板变体（或该腿不映射）
- [ ] **U2 node 前提**：`command -v node` + 检查用户机是否可能在无 node 环境跑 CLI。
      结论：shim 是否可用 node；无 node 的降级策略。
- [ ] **U3 Qoder 配置面**：确认 `~/.qoder/settings.json` 的 `hooks` 是否被 qodercli 读取；
      对比 `.qoder-plugin/qoder-hooks.json`。
      做法：手工写一条无害 hook（如 `echo`）→ 启动 qodercli → 观察是否触发。
      结论：写入目标文件路径。
- [ ] **U4 Claude `Notification` matcher**：在 `~/.claude/settings.json` 的 `Notification`
      下加一条 matcher=`permission_prompt` 的探针 → 触发权限提示 → 观察是否命中。
      结论：matcher 是否生效；不生效则**删该行**（宁缺勿误报）。
- [ ] Spike 结论写入 `.trellis/tasks/10-16-notify-claude-compat/research/cli-hook-spike.md`
- [ ] 回填本任务 `prd.md` R5.3 表格与 `design.md` §2 的 `CLAUDE_COMPAT_ENTRIES`

**Gate**：U1–U4 全部有结论才能进 Step 1。

---

## Step 1：事实表扩展（`targets.rs`）

- [ ] **先改既有断言**（否则新增行后测试必红）：
      `hook_targets_are_unique` 从 file_name 全局唯一 → `source` 唯一（T10）。
- [ ] Red：写测试 `claude_compat_sources_share_one_entries_table`
      —— 断言 claude / codebuddy / qoder 三行的 `shape` 是**同一个**
      `CLAUDE_COMPAT_ENTRIES` 指针（`std::ptr::eq`）。
- [ ] Red：写测试 `omp_reuses_pi_template` —— 断言 OMP 与 pi 的 `template` 是同一常量
      （`std::ptr::eq` 或字符串相等 + 注释锚点）。
- [ ] Red：写测试 `hook_entries_cover_four_semantic_classes`
      —— `CLAUDE_COMPAT_ENTRIES` 的 `event_key` 覆盖四个语义类（AC1/R5.1）。
- [ ] Green：定义 `InstallShape` / `HookEntry` / `CLAUDE_COMPAT_ENTRIES`；
      `HookTarget` 增 `shape` 字段；既有两行改 `shape: Standalone`。
- [ ] Green：加 4 个目录解析函数 + 4 行 `HOOK_TARGETS`
      （omp / claude / codebuddy / qoder），claude 三行指向同一 entries。
- [ ] Green：既有 `status_all` / `install_all` / `uninstall_all` 因新增行而自动覆盖
      （事实表驱动的既有收益，无需改代码）。
- [ ] 跑 `cargo test agent::hooks::targets` 全绿。

---

## Step 2：`merger.rs` 纯函数（TDD 核心）

- [ ] Red：`insert_preserves_foreign_entries_verbatim`
      —— 同事件下 orca `command` 条目 + superset `http` 条目必须逐字保留（AC3①）。
- [ ] Red：`insert_is_idempotent` —— 同 command 插两次，第二次 `Unchanged`（AC3③）。
- [ ] Red：`insert_converges_duplicate_own_entries` —— 两条自家 → 收敛到一条（AC3③）。
- [ ] Red：`remove_only_ours_and_prunes_empty_event`
      —— 只删自家；空数组删键；他人保留（AC3④）。
- [ ] Red：`malformed_config_is_never_destroyed`
      —— `hooks` 非对象 / 配置非对象 / 事件值非数组 → `Noop` 且原样（AC3②）。
- [ ] Red：`entry_shape_matches_cli_schema` —— schema 形状 + `matcher: None` 不写字段。
- [ ] Green：实现 `apply` / `build_entry` / `is_ours` / `MergeAction` / `MergeOutcome` /
      `SHIM_MARKER`。
- [ ] Refactor：`mod.rs` 加 `pub mod merger;` + `pub use merger::{...};`（仅此，红线 9）。
- [ ] 跑 `cargo test agent::hooks::merger` 全绿。

---

## Step 3：writers 分派 + 权限继承

- [ ] Red：`structured_install_writes_shim_and_entry`（tempdir 夹具）
      —— shim 文件存在 + 用户配置含一条自家条目。
- [ ] Red：`structured_install_is_idempotent` —— 第二次 `Unchanged`，不写盘。
- [ ] Red：`structured_install_skips_when_config_dir_absent`
      —— 目录不存在 → `Skipped`，**不创建**目录（R3.4）。
- [ ] Red（`#[cfg(unix)]`）：`structured_rewrite_preserves_file_permissions`
      —— 0600 配置改写后仍 0600（AC4）。
- [ ] Red：`structured_status_requires_shim_and_entry`
      —— 只有 shim 无条目 / 只有条目无 shim → `installed == false`（R3.5）。
- [ ] Red：`structured_uninstall_removes_entry_and_shim`
      —— 关开关后配置里无自家条目、他人原样（AC5/R6.4）。
- [ ] Green：`install_at` / `uninstall_at` / `status_at` 按 `shape` match 分派；
      `Standalone` 分支**零改动**（对比 diff 确认）。
- [ ] Green：权限继承 —— stat 原权限 → temp+rename → 恢复。
- [ ] Green：`render_report_command` 接入（Step 4 完成后回填）。
- [ ] 跑 `cargo test agent::hooks::writers` 全绿。

---

## Step 4：shim + 平台命令渲染

- [ ] 新增 `templates/neeko-report.mjs`（照父任务 design.md §3 草案）。
- [ ] 新增 `platform/hook_command.rs`：`render_report_command(source, event_key) -> Option<String>`；
      Windows 与 POSIX 分支（红线 2/10）。
- [ ] `platform/mod.rs` 加 `pub mod hook_command;` + 索引表一行。
- [ ] Red：`report_template_keeps_contract_anchors`
      —— shim 含 `readdirSync` / `Promise.allSettled` / `ENV_KEY_PORT` / `ENV_KEY_TOKEN` /
      `TOKEN_HEADER` / `127.0.0.1` / `process.exit(0)`（与既有模板测试同形）。
- [ ] Red：`report_template_takes_event_key_from_argv`
      —— shim 不含任何 CLI 原生事件名（`PermissionRequest` / `Stop` 等）——
      这是 T9 的核心不变量（防有人把翻译逻辑塞回 shim）。
- [ ] Red：`render_report_command_quotes_paths`（平台测试，item 级门控，红线 10）。
- [ ] 跑 `cargo test` + 手工验证：`node neeko-report.mjs pi turn_completed < payload.json`
      → Neeko 收到通知（或日志确认 POST 到达）。

---

## Step 5：OMP 接入

- [ ] 依 U1 结论：OMP 复用 pi 模板（若支持全部三条腿）或新建变体模板。
- [ ] Red：OMP 目录解析测试（`~/.omp/agent/extensions`，`OMP_HOME` 可覆盖则一并支持）。
- [ ] 实测：装 OMP hook → 跑 `omp` → 完成一轮 → 失焦时收到系统通知。

---

## Step 6：语义补全（`notify.rs`）

- [ ] Red：`session_failed_event_maps_to_failed_class`
      —— `classify(SESSION_FAILED)` → `(Failed, "session_failed", "会话异常")`（R5.2）。
- [ ] Green：加 arm。
- [ ] 前端 `NOTIFIABLE_EVENTS` 加一行 `{ key: 'agent.session_failed', label: 'Agent 会话异常' }`。
- [ ] Red（双端镜像测试）：`event_keys` 与前端清单一一对应。

---

## Step 7：前端逐 CLI opt-in

- [ ] Red：`notification.ts` 类型测试 —— `cliHookSources` 默认 `{}`。
- [ ] Green：`cliHooks: boolean` → `cliHookSources: Record<string, boolean>`；
      更新 `DEFAULT_NOTIFICATION_SETTINGS`。
- [ ] Green：设置页 CLI 行**数据驱动**（从 `agent_hooks_status` 渲染），
      新增 CLI 无需改组件。
- [ ] Green：保存走既有串行链（设置保存 → `agent_hooks_apply`）。
- [ ] Red：`useNotificationSettings` 相关 hook 测试（若既有覆盖模式适用）。
- [ ] 跑 `pnpm type-check` + `pnpm test:fe`。

---

## Step 8：实测与收尾

- [ ] macOS 实测（AC6）：四个 CLI 各验证「等待审批」与「轮次完成」；
      记录到 `implement.md` 下方「实测记录」或任务 notes。
- [ ] **配置面安全检查**（AC3/AC5 的实测版）：
      开关开 → `diff <备份> <当前>` 确认只有自家条目新增；
      开关关 → 确认回到开启前语义。
- [ ] `pnpm check:quick` 每轮；收尾 `pnpm check` **一次**。
- [ ] 确认 `src-tauri/src/notification/**` 无 diff（AC8）。
- [ ] 同步 spec：`.trellis/spec/backend/` 中 hook 接入 / 客人义务相关文档
      （`InstallShape` 契约必须入 spec —— 这是本任务最有复用价值的产出）。
- [ ] 归档子任务。

---

## 验证命令速查

```bash
# 开发循环（每轮）
pnpm check:quick

# 本域单测
cargo test --manifest-path src-tauri/Cargo.toml agent::hooks

# 收尾全量（一次）
pnpm check

# 核心域零改动自证（AC8）
git diff <base>..HEAD -- src-tauri/src/notification/   # 应为空

# 配置面安全（手工）
diff ~/.claude/settings.json.neeko-backup ~/.claude/settings.json
```

---

## 回滚点

| 回滚点 | 触发 | 动作 |
| --- | --- | --- |
| Step 1 后 | 事实表改动导致既有测试大面积红 | 先只改断言（T10），确认绿后再加行 |
| Step 3 后 | 结构化合并损坏用户配置（实测发现） | 立即 `uninstall_all` + 从备份恢复；补 fail-safe 测试 |
| Step 4 后 | shim 阻塞 CLI（退出码非 0 / 超时） | shim 是纯新增，删掉即回滚；检查 `process.exit(0)` 是否被绕过 |
| 任意 | 发现必须改 `notification/**` | **停止** → 回父任务 design.md 重新拆解（AC8 是硬约束） |
| 任意 | U1–U4 结论推翻映射表 | 只改 `CLAUDE_COMPAT_ENTRIES` 数据，无代码回滚 |
