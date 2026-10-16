# Implement — Codex 通知接入（`notify` 通道）

> 子任务执行计划。**前置**：`10-16-notify-claude-compat` 已实施（shim + `InstallShape`
> 分派骨架 + `platform/hook_command`）。
> **⚠️ Step 0 spike 后重写**：原「TOML 合并 + 信任哈希」被实测否决，改为 `notify` 通道。
> 证据：`research/codex-trust-spike.md`。
> TDD 强制：Red → Green → Refactor。

---

## 实施状态（2026-10-16）

**Step 0–4 + e2e 已实施；`pnpm check` 30/30 全绿。**

| Step | 状态 | 产出 |
| --- | --- | --- |
| 0 Spike | ✅ | `research/codex-trust-spike.md`（3 处推翻规划：通道 / 信任哈希 / 能力面） |
| 1 shim 双来源 | ✅ | `neeko-report.mjs` 支持 argv[4] 与 stdin 二选一；字段提取改「候选名链」（Codex 是 kebab-case） |
| 2 `toml_merger.rs` | ✅ | 文本级顶点改 + **19 个单测**（含 TOML 表作用域回归钉子） |
| 3 `InstallShape::NotifyArgv` + 事实表行 | ✅ | 第三形态 + `codex_config_dir()`（`CODEX_HOME` 优先）+ 3 条 Codex 钉子 |
| 4 writers 第三分支 | ✅ | `install/uninstall/status_notify_argv` + `platform::hook_command::report_argv`（argv 形态） |
| 5 实测 | ✅ | **e2e 打通**（真实 Codex → shim → ingest POST，字段映射全对，见 spike 附录） |

### 实施期发现并修掉的两个真实 bug（最有价值的产出）

#### Bug 2（**用户实测发现**）：`NotifyArgv` 只写配置不写 shim 文件

**症状**：用户开 `cliHooks` 后 Codex 实测无通知。取证：`config.toml` 有条目、
`~/.codex/neeko-status.mjs` **不存在** → Codex 调用不存在的脚本。

**根因**：`install_notify_argv` 只改 `config.toml`，从未写 shim（对比 `install_structured` 会写）。
**回执却是 `Applied`** —— 比不报更糟。

**三个同类缺口**（安装 / 卸载 / 状态）：

| 环节 | 缺口 | 后果 |
| --- | --- | --- |
| `install_notify_argv` | 不写 shim | 配置指向不存在的脚本 |
| `uninstall_notify_argv` | 不删 shim | 孤儿文件 |
| `notify_argv_status` | 不查 shim 存在 | 谎报「已安装」，掩盖故障 |

**为什么原测试没抓住**：三条测试都只断言 `config.toml` 的**文本**，从未看 shim 是否存在 ——
「只测一个面」的盲区（与下面的 TOML 表作用域 bug 同类：oracle 覆盖面不全）。

**修法**：两个面都落盘（先 shim 后配置）；「配置已对但 shim 缺失」也要补写
（否则 merge 得 `Unchanged` 就提前返回，早期故障态永不修复）；
卸载两处都清；status 要求 shim 在位。**新增 4 条反证钉子。**

**用户机器上的修复**：shim 已按真实 `render()` 产物**逐字节**补写
（`v1.0.9+c87418ae76fc2d5f`，7946B，核验 BYTE-IDENTICAL）；重启 Neeko 走 reconcile 亦可。
端到端复验：真 Codex（沙箱）→ shim → ingest 收到 `turn_completed`。

#### Bug 1：TOML 表作用域：`toml_merger` 原实现把 `notify` 追加到**文件末尾** —— 而 TOML 的表作用域
延续到下一个表头，用户 `config.toml` 末尾是 `[hooks.state."…"]`，新键因此落进**那个表内部**。
`tomllib` 实证顶层根本没有 `notify` → **Codex 从不调用 shim**（而配置文件看起来是对的）。

修法：新增 `top_level_insert_offset()`，插入点改为**第一个 `[table]` 之前**。

**测试形态的教训**：原断言是**字符串包含**，抓不住这类语义错误。
新测试一律用 `toml::from_str` **回读解析**并断言顶层键存在、且不落进任何子表。
→ **配置文件改写类代码的 oracle 必须是「解析器回读」，不是「字符串包含」。**

### ⚠️ 事故（已恢复，已记录）

探测时 `codex exec -c <key>=<value>` **会写回** `~/.codex/config.toml`，
我的两次探测因此污染了用户真实配置（多了一个 `[projects."/private/tmp/codexprobe"]` 块
与一行指向不存在文件的 `notify`）。**已完全恢复到会话开始状态**
（1636B / 4 条 `hooks.state` / 无 `notify` / 0600），Codex 已复验可用。

固化教训：**任何会写配置的探测必须先设 `CODEX_HOME=<tempdir>`**。

### 待手工验证（AC4 实测版）

自动化已覆盖全部纯逻辑（19 + 12 条）。以下可选做：

```bash
# 真机安装后核对用户 config.toml 逐字不变（应只多一行 notify）
diff ~/.codex/config.toml.bak ~/.codex/config.toml
# 关闭某 CLI → notify 行消失、其余逐字不变
```

---

## Step 0：Spike（已完成）

结论全文：`research/codex-trust-spike.md`。三条推翻性结论：

- [x] **U5**：`trusted_hash` **不可反推**（45 个候选全不匹配）+ 信任门是执行级硬门
  （探针实证未信任 hook 不跑）+ `bypass_hook_trust` 三种注入均无效 → **放弃 `hooks.json` 通道**。
- [x] **通道选型**：`notify`（`config.toml` 数组键）**完全绕过信任门**，零信任写入。
- [x] **U6**：无需定案（`notify` 无 `Interrupt` 事件）。
- [x] **载荷形态**：JSON 在 **argv[3]**（非 stdin）→ shim 需双来源。
- [x] **能力边界**：`notify` 唯一事件 `agent-turn-complete` → **AC2 下调为仅「轮次完成」**。

**Gate 通过**：可进 Step 1。

---

## Step 1：shim 双来源（argv / stdin）

- [ ] Red：`report_shim_reads_payload_from_argv_when_present`
      —— shim 源码含 argv 载荷分支（`process.argv[4]` 或等价），且仍含 stdin 分支。
- [ ] Red：`report_shim_payload_source_is_dual`
      —— 断言「先试 argv，再回退 stdin」的顺序（防有人删掉一侧）。
- [ ] Green：改 `templates/neeko-report.mjs`：新增 `payloadFrom()`，
      取 `process.argv[4]`（若以 `{` 开头）否则 `readStdin()`。
      **`source` / `event_key` 的取法两路一致**（argv[2] / argv[3]）→ 零 per-CLI 知识不变。
- [ ] 手工验证两路：
  ```bash
  # Codex 面（argv 载荷）
  node neeko-report.mjs codex turn_completed '{"type":"agent-turn-complete","thread-id":"t1","cwd":"/x"}'
  # Claude 面（stdin 载荷）
  echo '{"session_id":"s1","cwd":"/x"}' | node neeko-report.mjs claude turn_completed
  ```
  两者都应产生 POST（或静默 fail-open，取决于 Neeko 是否在跑）。
- [ ] 跑 `cargo test agent::hooks::writers::tests::report_shim` 全绿。

---

## Step 2：`toml_merger.rs`（文本级，TDD 核心）

- [ ] Red：`insert_appends_key_when_absent` —— `notify` 键不存在 → 文件末尾追加一行数组。
- [ ] Red：`insert_preserves_everything_else_verbatim`（**AC4 核心**）
      —— 含 `[model_providers]` / token / 用户格式的 TOML，插入后除新增行外**逐字不变**
      （逐字节比较，非语义比较）。
- [ ] Red：`insert_is_idempotent` —— 同条目插两次 → `Unchanged`，文件零改写。
- [ ] Red：`insert_converges_duplicate_own_entries` —— 两条自家 → 收敛到一条。
- [ ] Red：`insert_preserves_foreign_entries_in_array`（**AC5**）
      —— 用户已有 `notify = ["/their/tool.sh"]` → 其元素逐字保留，自家条目追加在后。
- [ ] Red：`non_array_value_is_untouched`（fail-safe）
      —— `notify = "string"` 或 `notify = { k = 1 }` → `Noop` + 原样。
- [ ] Red：`multiline_array_is_not_supported`（fail-safe）
      —— 跨行数组 → `Noop`（宁可不装也不误改）。
- [ ] Red：`remove_only_ours_and_prunes_key_when_empty`
      —— 移除自家；数组变空 → 删除该键（不留 `notify = []`）。
- [ ] Red：`malformed_toml_is_never_destroyed` —— 无法定位/解析 → `Noop` + 原样。
- [ ] Green：实现 `apply_notify` + 最小 TOML 数组解析（双引号字符串、逗号、尾随逗号）。
- [ ] Refactor：`mod.rs` 加 `pub mod toml_merger;` + `pub use`（仅此，红线 9）。
- [ ] 跑 `cargo test agent::hooks::toml_merger` 全绿。

---

## Step 3：`InstallShape::NotifyArgv` + 事实表行

- [ ] Red：`codex_target_uses_notify_shape`
      —— `HOOK_TARGETS` 含 `codex`，其 `shape` 是 `NotifyArgv { config_file: "config.toml", .. }`。
- [ ] Red：`codex_target_does_not_use_hooks_json`（**AC1 反证钉子**）
      —— 断言 Codex 行**不是** `Structured { settings_file: "hooks.json" }`
      （防有人回退到被否决的通道）。
- [ ] Red：`codex_config_dir_honors_codx_home`
      —— `~/.codex`；`CODEX_HOME` 绝对路径优先（相对值回落 home，与既有判据一致）。
- [ ] Green：加变体 + `codex_config_dir()` + 事实表一行。
- [ ] Green：`status_all` / `install_all` / `uninstall_all` 因事实表驱动自动覆盖（既有收益）。
- [ ] 跑 `cargo test agent::hooks::targets` 全绿。

---

## Step 4：writers 第三分支

- [ ] Red：`notify_install_writes_argv_entry`
      —— `config.toml` 得到 `notify = ["<node>", "<shim>", "codex", "turn_completed"]`。
- [ ] Red：`notify_install_skips_when_config_absent`
      —— 目录/文件不存在 → `Skipped`，**不创建**（客人义务）。
- [ ] Red：`notify_install_is_idempotent` —— 第二次 `Unchanged`，零改写。
- [ ] Red：`notify_install_skips_on_unsupported_shape`
      —— 非数组 `notify` → `Skipped` + detail（fail-safe 命中）。
- [ ] Red（`#[cfg(unix)]`）：`notify_install_preserves_config_permissions`
      —— 0600 的 `config.toml` 改写后仍 0600。
- [ ] Red：`notify_status_requires_entry` —— 无条目 → 未安装；有条目且 argv 一致 → 已安装且当前。
- [ ] Red：`notify_uninstall_removes_entry` —— 卸载后自家条目消失、他人保留。
- [ ] Green：`install_at` / `uninstall_at` / `status_at` 加第三分支。
- [ ] Green：`platform/hook_command` 补 **argv 形态**渲染
      （`report_argv(shim, source, event_key) -> Option<Vec<String>>`：
      `[node, shim, source, event_key]`；现有 `render_report_command` 是 shell 字符串形态，
      供 Claude 面用 —— 两者**共用** node 解析与 token 校验，不重复实现）。
- [ ] 跑 `cargo test agent::hooks::writers` 全绿。

---

## Step 5：实测与收尾

- [ ] **实测**（AC2，能力边界内）：Codex 跑一轮 → Neeko 失焦 → 收到「任务完成」。
  ```bash
  cd <某项目> && codex exec "reply ok"      # 或交互式 TUI 跑一轮
  ```
- [ ] **AC4 实测版**：`diff ~/.codex/config.toml.bak ~/.codex/config.toml`
      → 只有 `notify` 一行新增，其余逐字不变。
- [ ] **AC5 实测版**：若用户已有自己的 `notify`，确认其元素保留。
- [ ] 无 node 降级验证（AC3）：临时去掉 node → 回执 `Skipped` + 配置无部分写入。
- [ ] `pnpm check:quick` 每轮；收尾 `pnpm check` **一次**。
- [ ] 确认 `src-tauri/src/notification/**` 无 diff（AC7）。
- [ ] 同步 spec（`toml_merger` 的「文本级定点改用户配置」是可复用模式，入 spec）。
- [ ] 归档子任务。

---

## 验证命令速查

```bash
# 开发循环
pnpm check:quick

# 本域
cargo test --manifest-path src-tauri/Cargo.toml agent::hooks

# 收尾全量（一次）
pnpm check

# 核心域零改动（AC7）
git diff <base>..HEAD -- src-tauri/src/notification/   # 应为空

# 用户配置安全（手工）
diff ~/.codex/config.toml.bak ~/.codex/config.toml
```

---

## 回滚点

| 回滚点 | 触发 | 动作 |
| --- | --- | --- |
| Step 2 后 | `toml_merger` 无法保证逐字不变（AC4 测试红） | 缩小支持面（更多 `Noop` 分支），或改用 `toml_edit` 并重验 AC4 |
| Step 3 后 | 发现 `notify` 需非数组形态 | 回 Step 0 重新确认契约（实测优先于设计） |
| Step 4 后 | 实测发现 Codex 配置损坏 | 立即从 `.bak` 恢复；补 fail-safe 测试 |
| 任意 | 发现必须改 `notification/**` | **停止** → 回父任务 design.md（AC7 是硬约束） |
| 任意 | 发现必须改 `agent/hooks/server.rs` 或 `notify.rs` | 说明拓扑判断有误（应自动生效），回父任务 design.md |
