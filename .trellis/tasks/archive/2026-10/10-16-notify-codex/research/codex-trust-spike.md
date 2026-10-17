# Step 0 Spike — Codex 通知面实测（U5 / U6 + 通道选型）

> 任务：`10-16-notify-codex`，Step 0（阻塞 gate）。
> 日期：2026-10-16。方法：Codex **0.162.1** 真实运行（`codex exec`）+ 二进制静态取证。
> 全部结论附可复核命令。**不猜。**

---

## 结论先行（三处推翻了本任务的规划假设）

| # | 规划假设（`prd.md` / 父任务 design） | 实测结论 |
|---|---|---|
| **1** | Codex 走 `hooks.json` + 需写 `[hooks.state]` 信任哈希（U5 决定能否自动化） | **信任哈希不是可选项，且哈希输入无法反推** → 该通道**不可自动化**；改用 **`notify` 配置**（见 #2） |
| **2** | 上报通道 = hook（`hooks.json` 的结构化合并） | **`notify` 是更好的通道**：它**完全绕过信任门**，零信任写入，一个 config 键搞定 |
| **3** | 事件面含 `PermissionRequest` / `Stop` / `StopFailure`（对齐 Claude 兼容面） | `notify` 的**唯一事件类型**是 `agent-turn-complete`；**无审批事件**（见「能力边界」） |

**净效果**：本任务的实施量**大幅缩小**（从「JSON 合并 + TOML 信任哈希 + 信任 UX」缩为
「一个 config 键 + 复用既有 shim」），但**能力也缩小**（只能覆盖「轮次完成」，覆盖不了「等待审批」）。

---

## U5 — `trusted_hash` 的输入格式能否反推？

**结论：不可反推，且该通道本质上需要用户交互。故放弃 `hooks.json` 通道。**

### 证据 1：信任门是硬门（未信任的 hook 不执行）

探针：项目级 `.codex/hooks.json` 写一条 `Stop` hook 向文件追加内容。

```bash
cd /tmp/codexprobe && mkdir -p .codex
cat > .codex/hooks.json <<'EOF'
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo PROBE >> /tmp/codexprobe/out.txt"}]}]}}
EOF
codex exec --skip-git-repo-check -c model="gpt-5" "reply ok"
# 输出含 "hook: Stop / hook: Stop Completed"（那些是**已信任的用户级** superset hook）
# 但 /tmp/codexprobe/out.txt 不存在 → 我们的未信任 hook **没有执行**
```

对照组（证明探针机制本身有效）：

```bash
sh -c 'echo X >> /tmp/codexprobe/out.txt'   # → 文件正常创建
```

**结论**：`hook: <Name> Completed` 日志行只表示「已信任的 hook 跑完了」，
不能作为「任意 hook 都能跑」的证据。信任门是**执行级**拦截。

### 证据 2：`bypass_hook_trust` 不是可用的自动化解法

二进制内确认存在两处（`--dangerously-bypass-hook-trust` CLI flag + `bypass_hook_trust` 配置键）：

```
--dangerously-bypass-hook-trust
    Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
    Intended only for automation that already vets hook sources
```

实测三种注入方式**均无效**：

| 注入 | 结果 |
|---|---|
| `-c bypass_hook_trust=true` | ❌ 探针未触发 |
| `-c hooks.bypass_hook_trust=true` | ❌ 未触发 |
| `--dangerously-bypass-hook-trust` | ❌ 未触发 |

（`bypass_hook_trust` 疑为 **session-flags** 作用域 —— 二进制字符串把
`<session-flags>/config.toml` 与 `config.toml` 并列列出，暗示它来自 TUI 会话内的一次性开关，
而非可持久化的用户配置。未进一步验证：即使可用，它也是 per-invocation 的，
无法写进用户配置长期生效。）

### 证据 3：哈希输入无法反推

信任键格式已解出（`config.toml` 实测）：

```toml
[hooks.state."/Users/tomgs/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:db280472c83c007a2da0f12968527ab0ce075e72412b1048dcc1dd4ad0b9ba5f"
```

即 `<绝对路径>:<event_snake>:<group_idx>:<hook_idx>`。
但 **hash 的输入**尝试了 45 个候选（命令裸串 / 带换行 / 各种 JSON 序列化形态 / 多种 TOML
序列化形态 / 含 scope·event·index 的复合串 / 整文件 hash），**全部不匹配**。

二进制里唯一线索是：

```
internal error: entered unreachable code: normalized hook identity should serialize to TOML
```

说明哈希对某个「normalized hook identity」的 **TOML 序列化**取 sha256 ——
但该结构的字段集与序列化细节（字段顺序、可选字段省略、`ConfiguredHookHandler::Command`
的 6 字段形态）无法从二进制反推，且**它是内部实现，不是稳定契约**
（Codex 改序列化 = 我们的 hash 全错，且是静默失效）。

**决策**：不实现 hash 计算。理由不止「做不到」，更是「不该做」——
依赖未公开的内部序列化格式，是把 Neeko 绑到 Codex 的实现细节上（违反 T7 的「差异落数据」精神）。

### 证据 4（补充）：项目级 hooks 还需要项目信任

app-server 明确报错：

```
Project-local config, hooks, and exec policies are disabled in the following folders
until the project is trusted, but skills still load.
  1. /private/tmp/codexprobe/.codex
     To load project-local config, hooks, and exec policies, add /private/tmp/codexprobe
     as a trusted project in /Users/tomgs/.codex/config.toml.
```

即 `hooks.json` 通道有**两层**信任：① 项目信任（`projects.<path>.trust_level`）
② 每个 hook 的 `trusted_hash`。叠加成本远超收益。

---

## 通道选型：`notify` 配置（本任务采用的通道）

### 实测：`notify` 绕过信任门

```bash
cat > /tmp/codexprobe/notify.sh <<'EOF'
#!/bin/sh
{ echo "ARGS: $*"; } >> /tmp/codexprobe/out.txt
EOF
chmod +x /tmp/codexprobe/notify.sh

codex exec --skip-git-repo-check -c model="gpt-5" \
  -c 'notify=["/tmp/codexprobe/notify.sh"]' \
  "reply with the single word ok"
```

**结果**：`out.txt` 被创建，内容为：

```json
{"type":"agent-turn-complete",
 "thread-id":"01a14431-8a6f-7ed1-a71d-7405de7f3e47",
 "turn-id":"01a14431-8a8e-71d0-bdc7-dc33f28b158e",
 "cwd":"/private/tmp/codexprobe",
 "client":"codex_exec",
 "input-messages":["reply with the single word ok"],
 "last-assistant-message":"ok"}
```

**关键**：全程**未写任何 `[hooks.state]`**、**未做任何信任确认**、**未加 `--dangerously-*`**。

### 契约（实测）

| 项 | 值 |
|---|---|
| 配置键 | `notify`（TOML 数组，元素为可执行路径 + 参数） |
| 配置位置 | `~/.codex/config.toml`（用户级）—— **不是** `hooks.json` |
| 载荷投递 | **argv[1] 是 JSON 字符串**（实测 `$*` 即完整 JSON，无需读 stdin） |
| 事件类型 | `agent-turn-complete`（**唯一**实测到的类型） |
| 载荷字段 | `type` / `thread-id` / `turn-id` / `cwd` / `client` / `input-messages` / `last-assistant-message` |
| 触发时机 | 每轮 agent 结束（含 `codex exec` 非交互模式） |
| 信任门 | **无** |

二进制佐证（`hooks/src/legacy_notify.rs` + 字段名连排）：

```
legacy_notify agent-turn-complete thread-id turn-id cwd client input-messages last-assistant-message
```

### 字段映射（`notify` 载荷 → `HookEnvelope`）

| Neeko `HookEnvelope` | 来源 | 备注 |
|---|---|---|
| `agent_session_id` | `thread-id` | Codex 的线程 id（稳定，可作 instance 身份） |
| `event` | 固定 `turn_completed` | `notify` 只有完成事件 |
| `cwd` | `cwd` | 归属链第 2/3 级原料（**直接可用**） |
| `detail` | `last-assistant-message` 首个非空行 | 截断交核心域 |
| `title` | `input-messages[0]` 首个非空行 | 会话主题（R7 降级链，与 pi 模板同策略） |
| `hints` | env（`NEEKO_SESSION_ID` / `NEEKO_PROJECT_ID`） | 与既有 shim 同 |

**`type` 字段必须校验**：只处理 `agent-turn-complete`，其余静默（fail-open）。

---

## 能力边界（诚实登记，AC2 需据此调整）

### ✅ 能覆盖

- **`turn_completed`**（Completed 类）：`notify` 的唯一事件，实测可靠。

### ❌ 不能覆盖（`notify` 通道）

- **`approval_requested`**（等待审批）：`notify` **无审批事件**。
  尝试构造审批场景（`sandbox_mode="read-only"` + 请求写操作）实测只得到
  `agent-turn-complete`（模型自行拒绝执行，未进入审批门）；
  `approval_policy="on-request"` + `workspace-write` 下命令**直接执行**（沙箱内允许）。
  二进制字符串里 `agent-turn-completeapproval-requestedplan` 虽连排出现，
  但**无法通过任何可配置路径触发**（疑为 TUI 专属或未接线），故**按不存在处理**。
- **`session_failed`**（会话异常）：`notify` 无错误事件。

### 若要覆盖审批 → 只能走 `hooks.json` 的 `PermissionRequest` 事件

但那需要：① 项目信任 + ② 逐 hook 的 `trusted_hash`（不可自动化）+ ③ 用户的 TUI 确认。
**本任务不做**，登记为遗留（见下）。

---

## 对 `prd.md` / `design.md` 的修订项

1. **通道改为 `notify`**（不是 `hooks.json` 结构化合并）：
   - 落点从 `targets.rs` 的 `InstallShape::Structured { settings_file: "hooks.json" }`
     改为**新的第三种形态** `InstallShape::NotifyArgv { config_file: "config.toml" }`
     （或等价表达：把「写进 TOML 的一个数组键」作为形态数据）。
   - **不需要** `toml_merger.rs` 的信任哈希部分；只需要「在 `config.toml` 里增删
     `notify = [...]` 数组元素」——仍是结构化合并，但目标键只有一个、语义是数组追加。
2. **U5 结论 = 不可自动化** → `prd.md` R2.3（UX 引导）**不再适用**（因为不走信任门了）。
   R2 整节可删，改为「`notify` 键的结构化合并」。
3. **U6（`Interrupt` 语义）= 无需定案**（`notify` 无该事件；`hooks.json` 通道已放弃）。
4. **AC2 需下调**：从「「等待审批」+「轮次完成」两类」改为「**仅「轮次完成」**」，
   并把「审批事件不可得」的理由与后续路径写进验收说明（诚实登记 > 假装覆盖）。
5. **AC3（无 node 时降级不破坏）改为**：`notify` 直接执行 shim，仍需要 node；
   无 node → `Skipped`（与 claude-compat 同判据）。
6. **AC4（TOML 内容保护）保留且更重要**：`config.toml` 含用户的敏感内容
   （本机有 `experimental_bearer_token`），必须只增删 `notify` 键、其余逐字不变。

## 复现命令（供复核）

```bash
# 1) 信任门：未信任的 hooks.json 不执行
mkdir -p /tmp/codexprobe/.codex
echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo P >> /tmp/codexprobe/out.txt"}]}]}}' \
  > /tmp/codexprobe/.codex/hooks.json
cd /tmp/codexprobe && codex exec --skip-git-repo-check -c model="gpt-5" "reply ok"
test -f /tmp/codexprobe/out.txt || echo "未触发（信任门生效）"

# 2) notify 绕过信任门
printf '#!/bin/sh\n{ echo "ARGS: $*"; } >> /tmp/codexprobe/out.txt\n' > /tmp/codexprobe/notify.sh
chmod +x /tmp/codexprobe/notify.sh
rm -f /tmp/codexprobe/out.txt
cd /tmp/codexprobe && codex exec --skip-git-repo-check -c model="gpt-5" \
  -c 'notify=["/tmp/codexprobe/notify.sh"]' "reply ok"
cat /tmp/codexprobe/out.txt   # → {"type":"agent-turn-complete", ...}
```

## 未决 / 遗留

- **审批事件**：若产品确实需要「Codex 等待审批」通知，唯一路径是 `hooks.json` 的
  `PermissionRequest` + 用户 TUI 确认一次（信任哈希由 Codex 自己写入）。
  可作为**后续任务**：设置页给引导文案（「请在 Codex 中确认一次」），
  Neeko 只写 `hooks.json` 的条目、**不写** `trusted_hash`（让 Codex 自己算）。
- **`notify` 是否有其他事件类型**：本次只实测到 `agent-turn-complete`。
  若未来 Codex 增加类型（如审批），只需在 shim 的 `type` 映射里加一行数据。

---

## 附：实施期实测（2026-10-16，Step 4/5）

### ⚠️ 事故：我的探测脚本污染了用户真实的 `~/.codex/config.toml`

**已完全恢复**（文件回到会话开始时的 1636B / 4 条 `hooks.state` / 无 `notify` / 0600 权限），
Codex 已复验可用。记录在此以免重犯。

**机制**：探测时用了 `codex exec -c <key>=<value>`。这些 `-c` 覆盖**会**被 Codex 写回
`~/.codex/config.toml`（配置持久化，不是纯内存覆盖）。两次探测因此落盘：

1. `-c 'projects."/private/tmp/codexprobe".trust_level="trusted"'` → 写入了一个 `[projects."…"]` 块；
2. 后续某次 `notify=...` 探测 → 写入了一行 `notify = [...]`（指向不存在的 `~/.codex/neeko-status.mjs`）。

**教训（已固化到本任务流程）**：
- **任何会写配置的探测都必须设 `CODEX_HOME=<tempdir>`**（实测：`CODEX_HOME` 沙箱下
  `-c projects."…".trust_level=...` 正常生效且不触真实文件）。
- 若确实需要 `-c` 且无法沙箱化，探测后立即 `git diff` 式核对目标文件（本任务的
  AC4「逐字不变」精神同样适用于**我自己**的探测行为）。

### E2E：真实 Codex → shim → Neeko ingest（已打通）

**配方**（安全 —— 全程 `CODEX_HOME` 指向沙箱，不碰用户配置）：

```bash
# 沙箱：复制真实 config.toml（真实 provider 才能跑通模型调用）
mkdir -p /tmp/codexsbx && cp ~/.codex/config.toml /tmp/codexsbx/
cp <repo>/src-tauri/src/agent/hooks/templates/neeko-report.mjs /tmp/codexsbx/neeko-status.mjs
# 假 ingest 服务（或真实 Neeko）监听，endpoint 文件指向它
CODEX_HOME=/tmp/codexsbx node /tmp/codexsbx/neeko-status.mjs ...   # 手工验证 shim 单跑
CODEX_HOME=/tmp/codexsbx codex exec --skip-git-repo-check \
  -c "notify=[\"$(command -v node)\",\"/tmp/codexsbx/neeko-status.mjs\",\"codex\",\"turn_completed\"]" \
  "reply with the single word ok"
```

**捕获到的 POST**（`/hook/codex`）：

```json
{"agent_session_id":"01a14442-85a7-7310-b67e-1eb38a196cdd",
 "event":"turn_completed",
 "cwd":"/private/tmp/neekoprobe",
 "detail":"ok",
 "title":"reply with the single word ok",
 "hints":{"neeko_session_id":null,"project_id":null}}
```

字段映射全部正确：`thread-id` → `agent_session_id`、`last-assistant-message` → `detail`、
`input-messages[0]` → `title`、`cwd` → `cwd`。**AC2 的能力边界内已实证。**

### 🐛 实测发现并修掉的真实 bug：TOML 表作用域

**症状**：`toml_merger` 把 `notify` 写到文件末尾后，配置文件**看起来写对了**，
但 Codex 从不调用 shim。

**根因**：TOML 的**表作用域延续到下一个表头**。用户的 `~/.codex/config.toml` 末尾是
`[hooks.state."…"]`，在文件末尾追加的 `notify` 落在**那个表内部**，不是顶层键。
`tomllib` 实证：

```
notify at EOF        → 顶层有 notify? False
   实际落在: /Users/…/hooks.json:user_prompt_submit:0:0 → ['/tmp/codexsbx/probe.sh']
notify before tables → 顶层有 notify? True
```

**修法**：新增 `top_level_insert_offset()` —— 插入点是**第一个 `[table]` 行之前**
（无表头则文件末尾，此时末尾确属顶层键区）。

**为什么原测试没抓住**：原断言是**字符串包含**（`after.starts_with(&before)` /
`after.ends_with(...)`）—— 字符串层面「看起来对」，语义层面已错。
新测试用 `toml::from_str` **回读解析**并断言 `parsed.get("notify").is_some()`
且**不落进任何子表**。这是本次最有价值的测试形态修正：
**配置文件改写类代码的 oracle 必须是「解析器回读」，不是「字符串包含」。**

回归钉子（三条）：`insert_lands_at_top_level_even_when_file_ends_with_a_table`（真实场景）、
`inserted_key_sits_before_the_first_table_header`、`insert_into_flat_file_without_tables`。

---

## 附 2：用户实测「装了但没通知」的根因（2026-10-16 第二轮）

### 症状

用户开 `cliHooks` 后用 Codex 实测无通知。取证发现：

```
~/.codex/config.toml  →  有 notify 条目（指向 ~/.codex/neeko-status.mjs）
~/.codex/neeko-status.mjs  →  **不存在**
```

配置写了，但 shim 从未落盘 → Codex 每次调用都失败 → 无通知。**而安装回执是 `Applied`。**

### 根因（我实现里的 bug）

`install_notify_argv` **只改了 `config.toml`，从未写 shim 文件**。
对比 `install_structured`（它写了 shim），`NotifyArgv` 分支漏了这一步。

连带两个同类缺口：

| 环节 | 缺口 | 后果 |
| --- | --- | --- |
| `install_notify_argv` | 不写 shim | 配置指向不存在的脚本；回执却 `Applied` |
| `uninstall_notify_argv` | 不删 shim | 留孤儿文件 |
| `notify_argv_status` | 不检查 shim 存在 | 只报「已安装」= 撒谎，掩盖该故障 |

**为什么原测试没抓住**：三个测试都只断言 `config.toml` 的**文本**（`read_notify` 解析出的条目），
从未断言 **shim 文件是否存在**。这是「只测一个面」的典型盲区 —— 与 TOML 表作用域那个 bug 同类：
**oracle 覆盖面不全**（一个只测字符串、一个只测配置面）。

### 修法

1. `install_notify_argv`：**先写 shim（幂等，内容寻址标记），再写配置**；
   并把「配置已 `Unchanged` 但 shim 缺失/过期」也视为需要写盘
   （否则早期故障态永不修复 —— 配置 merge 得 `Unchanged` 就提前返回了）。
2. `uninstall_notify_argv`：两处独立清理（条目 + shim），任一有动作即报 `Removed`。
3. `notify_argv_status`：`installed = shim 在位 && 条目在位`；
   `version_current = argv 一致 && shim 在位`。

### 新增的 4 条回归钉子（每条都能反证）

| 测试 | 反证什么 |
| --- | --- |
| `notify_install_writes_both_shim_file_and_config_entry` | 删掉 shim 写入 → 必红 |
| `notify_install_repairs_missing_shim_when_config_already_correct` | 只看 merge 结果就提前返回 → 必红（加入 `Applied` 分支的 shim 补写） |
| `notify_status_requires_shim_file_too` | status 不查 shim → 必红 |
| `notify_uninstall_removes_shim_file_too` | 卸载不删 shim → 必红 |

### 固化教训（写入 spec）

**「配置面 + 文件面」类安装的 oracle 必须断言**两个面**（配置条目 **与** 落盘文件），
不能只断言配置文本。** —— 与「配置文件改写用解析器回读」并列，构成该场景的两条测试纪律。

### 用户机器上的修复

- shim 已按真实 `render()` 产物**逐字节**补写（`v1.0.9+c87418ae76fc2d5f`，7946B，已核验 BYTE-IDENTICAL）；
- 重启 Neeko 后 `reconcile` 也会自动补写（新逻辑已含该路径），两条路等价。
- 端到端复验：真 Codex（沙箱）→ shim → 假 ingest 收到 `turn_completed`，字段全对。

---

## 附 3：Codex 通知面全景（2026-10-16 第三轮调研，用户问「审批通知支持吗」）

用户问「只能完成后才提示吗？如果有权限确认的通知呢」。以下为本轮实测/取证结论。

### Codex 有 **三条**独立的通知/事件通道（不是一条）

| # | 通道 | 事件面 | 能否外接 | 信任门 | 实测结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | `notify`（`config.toml` 的 argv 数组） | **仅 `agent-turn-complete`** | ✅ 已接（本任务） | 无 | 已完成 ✅ |
| 2 | `hooks.json` 的 hook 面 | **12 个事件，含 `PermissionRequest`** | ✅ 可接 | **有（两层）** | 见下 |
| 3 | `[tui.notifications]`（`config.toml`） | Codex 自己的 TUI 通知 | ❌ 不外接（走系统通知，不调我们） | 无 | 与 Neeko 无关 |

**关键**：#3 说明 Codex **自己就有**「审批 / 计划 / 提问」的通知（二进制里 4 个 notice 变体：
`agent-turn-complete` / `approval-requested` / `plan-mode-prompt` / `async-question`，
文案 `"Approval needed in "` / `" needs your approval."`），但它是 **TUI 内建行为**，
配置为 `[tui.notifications] notification_method/notification_condition ∈ {unfocused, always}` —— 
**不经过我们的 shim，Neeko 拿不到**。

### `hooks.json` 能否作为审批通知通道？（本轮实测）

**能触发，且投递完整 JSON**。实测（用户级 `hooks.json` + `--dangerously-bypass-hook-trust`）：

```json
{"session_id":"01a14476-...","turn_id":"01a14476-...",
 "transcript_path":".../rollout-....jsonl","cwd":"/private/tmp",
 "hook_event_name":"Stop","model":"...","permission_mode":"bypassPermissions",
 "stop_hook_active":false,"last_assistant_message":"..."}
```

→ `Stop` hook 真实执行、载荷是**完整 Claude 兼容 JSON**（含 `hook_event_name`、`session_id`）。

**但信任门不可自动化**（本轮再次确认，且更精确）：

| 尝试 | 结果 |
| --- | --- |
| `hooks.json` 无信任 → 不执行 | ❌（第二轮已证） |
| `bypass_hook_trust = true` 作为 config.toml **顶层键** | ❌ 无效 |
| `bypass_hook_trust = true` 落在 `[hooks.state]` 表内 | ❌ 无效（且被 schema 忽略） |
| CLI `--dangerously-bypass-hook-trust` | ✅ 有效，但**仅限该次调用**，不可持久化到 config |

二进制佐证：`bypass_hook_trust` 只出现在 **`exec/src/lib.rs`（CLI 参数）** 与
**`app-server/src/config_manager.rs`（config 加载但要求 boolean override）**，
即它是 **session-flags 作用域的一次性开关**，不是可持久化设置。

### 为什么 `exec` 模式下审批不触发

`codex exec` 对**已策略允许**的命令自动批准，故不进审批门。实测：
`approval_policy=on-request` + `sandbox_mode=workspace-write` → 命令直接执行、无 `PermissionRequest`。
`approval_policy=untrusted` 已废弃（`no longer supported`）。
TUI 需要真实 tty（`stdin is not a terminal`），无法非交互驱动。

→ **审批事件的真实触发面是交互式 TUI**，而 `hooks.json` 的 `PermissionRequest`
在 TUI 下能触发（前提：该 hook 已信任）。

### 结论：Codex 审批通知的两条路

| 方案 | 可行性 | 代价 |
| --- | --- | --- |
| **A. `hooks.json` 的 `PermissionRequest`** | 机制可行（实测 hook 会执行、载荷完整） | 需要用户**在 Codex TUI 里确认一次**（信任哈希由 Codex 自己写）；或用户每次加 `--dangerously-bypass-hook-trust`（不可接受） |
| **B. `notify` 扩展** | ❌ 不可能 | `notify` 只有 `agent-turn-complete`（二进制 `legacy_notify.rs` 只认识它） |
| **C. Codex 自己的 `[tui.notifications]`** | ❌ 拿不到 | 走系统通知，不经过 Neeko |

**D（推荐，待用户决策）**：**A + 一次性 UX 引导** ——
Neeko 写 `hooks.json` 的 `PermissionRequest` 条目（**不写** `trusted_hash`），
设置页提示「请在 Codex 中确认一次以便启用审批通知」；Codex 首次运行时会展示待信任的 hook
并让用户确认，之后哈希由 Codex 写入，审批通知即生效。

这比「完全不支持」好，但**不是零交互** —— 诚实告知用户这一点。

---

## 附 4：A 方案可行性实测（2026-10-16 第四轮，已确认实施）

### 实测证据（pty 驱动真实 TUI）

**`PermissionRequest` 在交互式 TUI 下确实触发**：

```
场景：codex --dangerously-bypass-hook-trust --ask-for-approval on-request --sandbox read-only \
      "Run exactly this shell command: touch /tmp/cxS/BLOCKED"
TUI 状态行： [ ! ] Action Required | Run blocked shell command
probe.log ： CALLED approval        ← PermissionRequest hook 真实执行 ✅
BLOCKED   ： 未创建                 ← 确实需要用户批准
```

**未信任条目静默跳过、不报错**（关键安全性）：

```
无 hooks.json 信任 + 无任何 bypass flag → 跑一轮 exec
结果：正常完成，probe.log 未创建，无任何错误/警告/卡顿
```

→ **可以安全写入未信任条目** —— Codex 忽略它，不会让用户的应用出错。

**`hooks.json` schema 与 Claude 同形**（决定能否复用 `CLAUDE_COMPAT_ENTRIES`）：

| 形态 | 是否被接受 |
| --- | --- |
| `PermissionRequest` 无 `matcher` | ✅ 接受（无 schema 警告） |
| `PermissionRequest` + `matcher: "*"` | ✅ 接受 |
| `StopFailure` | ✅ 接受 |

→ **可以直接复用 `CLAUDE_COMPAT_ENTRIES`**（`PermissionRequest`/`Stop`/`StopFailure`），
零新增数据表。

### 用户确认流程的 TUI 文案（二进制取证）

```
Managed / New hook - review required / Trusted /
Modified since last trusted - review required / Trust / No hooks installed for this event. details
```

即：Codex TUI **有内建的 hook 审查 UI**，用户能看到「New hook - review required」并点击
`Trust`。这正是我们引导用户做的动作。相关 TUI action：
`TrustHook` / `SetHookEnabled` / `SetHookEnabledTrustHooks`（二进制 action 枚举）。

### 结论：A 方案定稿

| 项 | 决定 |
| --- | --- |
| 通道 | `~/.codex/hooks.json` 的 `hooks.<Event>[]`（与 Claude 同形） |
| 复用 | `InstallShape::Structured { settings_file: "hooks.json", entries: CLAUDE_COMPAT_ENTRIES }` —— **零新增形态** |
| 不写 | `[hooks.state]` 的 `trusted_hash`（不可反推，且是 Codex 内部契约） |
| 用户动作 | 一次：Codex TUI 里看到「New hook - review required」→ 点 `Trust` |
| 与 `notify` 的关系 | **两者并存**：`notify` = 完成（零交互、即装即用）；`hooks.json` = 审批/失败（需一次确认）|
| 状态展示 | `installed` 用既有双面检查（shim 在 + 条目在）；`version_current` 需知「信任与否」—— 见下 |

**新增待办**：`HookInstallStatus` 可能需要表达「已安装但未信任」（否则用户看到「已安装」
却收不到审批通知 = 又一次「装了但没通知」）。这需要一个**只读探测**：
读 `config.toml` 的 `[hooks.state]` 里是否有对应键（有键 = 用户已确认过）。
这是**读**而非写，且判据简单（键存在即已信任）。

---

## 附 5：用户实测「第一次通知后不再通知」的根因（2026-10-16 第六轮）

### 症状

用户：Codex 通知**不能持续** —— 第一次通知后，后续执行都不再发通知。

### 取证（决定性对照实验）

运行中的 Neeko = `/Applications/Neeko.app/.../neeko`，**15:19 构建**，PID 11466，监听 `127.0.0.1:64175`。

用**同一个 token / 同一份 body** 打两个路由：

| 路由 | HTTP | 实际投递（`UN accepted` 增量） |
| --- | --- | --- |
| `/hook/pi` | 204 | **+1** ✅ |
| `/hook/codex` | 204 | **0** ❌ |

→ **`/hook/codex` 不在运行中二进制的路由白名单里**，被 `hook_source()` 判为未知 →
`ingest()` 走 fail-open 分支返回 204（**设计如此**：未知 source 静默吞掉，不报错）。

### 根因

**运行中的二进制早于 `codex` 那一行被加入 `HOOK_TARGETS`。**

- 打包版构建：**15:19**
- `codex` 行加入 `targets.rs`：**19:39**（本轮实施）
- `HOOK_TARGETS` 是**编译期常量**（`&'static [HookTarget]`），路由白名单由它派生
  （`server.rs::hook_source`）—— 加一行必须**重新构建并重启**才生效。

那 3 次成功投递（19:57 / 20:01 / 20:04）来自当时运行的新代码实例（dev 版），
它退出后，只剩旧的打包版 → 后续全部静默丢弃。

### 这不是 bug，是**部署时序**问题

代码行为**完全正确**：
- `204` 是 fail-open 的正确返回（未知 source 不该让 CLI 侧出错）；
- 路由白名单从事实表派生（加行自动生效）—— 但「自动」的前提是**重新编译**。

**用户需要做的**：重新构建 / 重启 Neeko（`pnpm tauri dev` 或重新 `tauri build`）。
本次任务全程跑 `cargo test`，只重建了 `target/debug/neeko` 与 dev-bundle，
**没有重装 `/Applications/Neeko.app`**。

### 教训（值得固化）

**「编译期事实表 + 运行中进程」的时序**：验证新 CLI 接入时必须确认
「跑的是含新代码的进程」。诊断锚点：

```bash
# 运行中的二进制构建时间 vs 代码改动时间
stat -f '%Sm' /Applications/Neeko.app/Contents/MacOS/neeko
# 路由白名单是否认识该 source（决定性对照）
curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:<port>/hook/<source> -H "x-neeko-agent-hook-token: <token>" -d '...'
# 已知 source → 投递；新 source → 204 但不投递
```

**诊断判据**：`204` 有两种语义 —— 「受理但静默丢弃（未知 source / 畸形载荷）」与
「受理并投递」。仅看 HTTP 状态**无法区分**。要看日志里的下游痕迹
（本项目 = `[notify] macOS: UN accepted ...`）。

这暴露一个**可观测性缺口**：未知 source 静默丢弃时**没有任何日志**，
使「路由未注册」与「载荷非法」无法区分。已在代码里补 warn 日志（见实施）。
