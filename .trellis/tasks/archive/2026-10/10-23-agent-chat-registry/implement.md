# Implement · Chat 传输注册表

> **实施完成（2026-10-23）**。已按 TBR 评审修订，**[R#]** 标注对应评审条目。
>
> 实施期与设计的两处偏差，已记录在 design §1.5 与 §2.2.1：
> ① 含 `build` 的表**不能**进 `common/`（会成环）→ 拆成两张表，代价从 2 处变 3 处；
> ② `wire_format` 迁移**不得**作用于「我们自己的输出」（`from_current_object`），
>    只对真正的旧形态（裸串 / `transport` 键）生效 —— 这是实施中被测试抓出来的，
>    与当初 ChatStart 迁移的判别式事故同型。
> Step 1 的「诚实结论」与 Step 3 的「迁移」是两个最容易做错的地方；
> Step 7 的「出厂协议保护」与「三态往返」是最易静默出错处。

---

## Step 1 · 注册表基础设施 + 穷举防线

- [x] 1.1 **先写测试**（Red）：`chat/registry.rs` 单测
  - **穷举防线** [R1]：`for &t in ChatTransport::ALL { protocol_of(t) }` 不 panic
  - **穷举防线** [R1]：`PROTOCOLS.len() == ChatTransport::ALL.len()`
  - `PROTOCOLS[0].transport == Acp`（**顺序即优先级**的机器钉子）
  - `recognize` 用完整 token：`&["--preserve"]` 不命中 serve，`&["--approval-mode"]` 不命中 acp
  - `["serve","acp"]` → 命中 Acp（优先级，**不依赖表顺序的权威断言**）
- [x] 1.2 实现 `LaunchMode` 枚举 + `LaunchSpec`（design §2.1）
  - `LaunchMode::{Process{cmd}, InProcess}` 让「进程内却有 argv」不可构造 [R7]
  - `LaunchSpec::cmd()` 访问器
- [x] 1.3 `AgentConfig::chat_launch_spec(&self, launch)` —— 唯一构造入口。
- [x] 1.4 实现 `ProtocolDef` + `PROTOCOLS` + `protocol_of()`（design §2.2）
  - `protocol_of` 失败为 `panic!` 且消息指向 `registry.rs`（design §2.2 已裁决）
- [x] 1.5 `ChatTransport::ALL` 常量（单一变体列表）。
- [x] 1.6 `ChatLaunch::transport()` 改为遍历 `PROTOCOLS`；加 `tokens()` 迭代器（零分配）[R8]。
- [x] 1.7 `ChatTransport::as_str()` 改为 `protocol_of(self).id`。
- [x] 1.8 跑既有测试：`chat_launch.rs` 的 8 条 transport 测试应全绿（行为零变更）。
- [x] 1.9 变异验证：
  - 把 `PROTOCOLS` 里 Acp 与 Serve 对调 → 1.1 的顺序断言红
  - 从 `PROTOCOLS` 删掉 Serve 项 → 1.1 的穷举断言红（**验证防线真的有效**）

**验收**：`cargo test` 全绿；`grep -c "ChatTransport::" chat_launch.rs` 只剩 `ALL` / 注释 / 默认值。

---

## Step 2 · `adapter_for` 切到注册表

- [x] 2.1 **先写测试**（Red）：源码护栏
  - `adapter_for` 函数体内**不含** `ChatTransport::`
  - 只有 2 条前置早退（无 chat / 被关闭）
- [x] 2.2 **先写测试**（Red）：5 种情形都能构造 adapter
  （acp / serve / jsonl / pi-rpc / inprocess —— inprocess 走 Acp 的 `build`）。
- [x] 2.3 `adapter_for` 按 design §2.4 改写。
- [x] 2.4 `AcpAdapter` 的 `build` 内处理 `LaunchMode::InProcess` → `mock()`。
- [x] 2.5 删除 `is_inprocess_chat()` 在 adapter 层的使用（字段判据保留，分派不再判）。
- [x] 2.6 **[R14 已核实，无需改动]** 确认 `adapter_for` 在 `Mutex<AgentManager>` **锁外**：
      `resolve_agent_config`（`chat/commands.rs:69-77`）锁内 `clone()` 后释放，
      `adapter_for` 收到已独立的 `AgentConfig`。在 `implement.md` 完成勾选时附上该结论。
- [x] 2.7 变异验证：把 `adapter_for` 改回 `match` 4 分支 → 2.1 源码护栏红。

**验收**：`adapter_for` 零 `ChatTransport::` 分支；6 个调用点零改动（签名不变）。

---

## Step 3 · `wire_format` + **反序列化期迁移**（评审 [R3]，关键）

> 这一步做错 = 现有自定义 `opencode acp` 用户升级后握手永远转圈，且无任何报错。

- [x] 3.1 **先写测试**（Red）：迁移
  - `{"program":"opencode","args":["acp"]}`（**无** `wire_format`）→ `wire_format == Some(Ndjson)`
  - `{"program":"kilo"}` → `Some(Ndjson)`
  - `{"program":"gemini"}` → `None`
  - 显式 `{"wire_format":"content-length","program":"opencode"}` → **显式值优先**，不被迁移覆盖
- [x] 3.2 **先写测试**（Red）：`AcpAdapter::new` 不再含命令名判断
      （源码断言：文件内无 `contains("opencode")` / `contains("kilo")`）。
- [x] 3.3 **先写测试**（Red）：`wire_format: Some(Ndjson)` 时 NDJSON 分帧；`None` 时 Content-Length。
- [x] 3.4 `WireFormat` 从 `acp.rs` 挪到 `chat_launch.rs`；`ChatLaunch` 加
      `wire_format: Option<WireFormat>`（`#[serde(default, skip_serializing_if)]`）。
- [x] 3.5 在 `ChatLaunch` 的**手写 `Deserialize`**（`chat_launch.rs:161`）里接入迁移。
      已核实的三个入口（design §2.5）：
  - `from_current_object`（**最重要** —— 旧配置的 `chat` 多是这个形态但无 `wire_format` 键）
  - `from_legacy_object`
  - `from_legacy_str`
  **注意**：推断代码里出现 `contains("opencode")` 是**刻意的**，与 3.2 的源码护栏不冲突
  （护栏只扫 `adapter/`，迁移在 `common/agent/`）—— 在迁移函数上写明这个区别，否则
  下一个人会认为 bug 又回来了。
- [x] 3.6 `AcpAdapter::new(spec)` 改用 `spec.wire_format`；删除推断。
- [x] 3.7 内置 `opencode`（走 serve）不受影响，确认无需改动；若有 `wire_format` 需求显式声明。
- [x] 3.8 变异验证：删掉 `infer_legacy_wire_format` 调用 → 3.1 必红。

**验收**：`grep -rn 'contains("opencode")' src-tauri/src/agent/chat/adapter/` 无结果
（**注意路径限定 `adapter/`** —— 迁移在 `common/agent/`）。

---

## Step 4 · 前端单表化 + 生成物护栏

- [x] 4.1 后端 `#[test] validate_and_export_protocols()` 写
      `src-tauri/Cargo.toml` 的 `../src/generated/protocols.json`（design §2.6.1）。
- [x] 4.2 把 `src/generated/protocols.json` 提交进 git（它是契约快照，不是构建产物）。
- [x] 4.3 **先写测试**（Red）：`shared/types/__tests__/transports.test.ts`
  - `transportOf` 对 4 种 argv 各返回正确 id
  - `TRANSPORT_LABELS` 覆盖所有 id
  - `--mode rpc` 两 token 组合被识别
  - **与 `generated/protocols.json` 的有序 id 列表逐项相等**
- [x] 4.4 `shared/types/agent.ts`：加 `TRANSPORTS` 表 + `transportOf` / `TRANSPORT_LABELS` 派生。
- [x] 4.5 `agentFormChat.ts` 的 `TRANSPORT_LABELS` 改为 re-export（删本地副本）。
- [x] 4.6 **删除**旧的 `agrees with the backend recogniser on every token`（读源码 + 正则），
      由 4.3 的生成物断言取代 [R9]。
- [x] 4.7 `package.json` 的 `check:quick` / CI 加 `git diff --exit-code src/generated/`
      （防止本地生成后忘记提交）。
- [x] 4.8 变异验证：
  - 前端 `TRANSPORTS` 里 `serve`/`acp` 对调 → 4.3 生成物断言红
  - 后端加一条假 `ProtocolDef` 但不重新生成 → 4.7 的 diff 检查红

**验收**：`grep -rn "includes('acp')\|includes('serve')" src/` 无结果。

---

## Step 5 · 后端协议锁定

- [x] 5.1 **先写测试**（Red）：`is_chat_agent()`
  - `chat_enabled = Some(false)` → false
  - `chat_enabled = None` + 有 chat → true
  - `chat = None` → false（无论 `chat_enabled`）
- [x] 5.2 `AgentConfig` 加 `chat_enabled: Option<bool>` + 改 `is_chat_agent()`。
- [x] 5.3 **先写测试**（Red）：`enabled` × `chat_enabled` 四组合（design §3.1 表）
  —— 每条都要断言 `list_chat_agents` 是否包含该 agent。
- [x] 5.4 **先写测试**（Red）：`restore_overrides` 保护 `chat`
  - 覆盖层塞入不同的 `chat` → 恢复后仍是出厂值
  - `chat_enabled` 来自覆盖层
  - `command` / `args` / `deploy` 仍来自覆盖层（回归）
- [x] 5.5 **先写测试**（Red）：`restore_overrides` **幂等性** [Q2]
  —— 连续调用两次，结果与一次相同。
- [x] 5.6 实现 `restore_overrides` 的 `factory_chat` 注入（design §3.2）。
- [x] 5.7 `adapter_for` 加 `chat_enabled == Some(false)` 早退。
- [x] 5.8 `list_chat_agents` 过滤改 `a.enabled && a.is_chat_agent()`。
- [x] 5.9 变异验证：去掉 `applied.chat = factory_chat` → 5.4 红；
      把 `is_chat_agent` 改成只看 `chat.is_some()` → 5.1 红；
      过滤去掉 `a.enabled` → 5.3 红。

**验收**：`grep "chat.is_some()" src-tauri/src/agent/commands.rs` 无结果。

---

## Step 6 · 前端判据收口 + `useChatAgents`

- [x] 6.1 **先写测试**（Red）：`shared/types/__tests__/isChatEnabled.test.ts`（3 条）。
- [x] 6.2 `shared/types/agent.ts`：加 `chat_enabled?: boolean | null` + `isChatEnabled()`。
- [x] 6.3 `agentCapabilities()` 的 `chat` 改用 `isChatEnabled()`。
- [x] 6.4 `shared/utils/agents.ts`：`TranslatableAgentShape` 加 `chat_enabled`。
- [x] 6.5 **`CapabilityBadges.tsx` 的 `Pick<>` 加 `'chat_enabled'`**（漏了读不到字段）。
- [x] 6.6 CHAT 徽标改**灰态**：`chat` 有但 `chat_enabled === false` 时降透明度 +
      `title="CHAT is disabled"`（用户要能区分「本来没有」与「被关了」）。
- [x] 6.7 **先写测试**（Red）：徽标 —— 关掉的 chat 仍渲染（灰态）；`chat: null` 不渲染。
- [x] 6.8 **[R5] `useChatAgents` 接入 `agentStore`**（本方案原漏项）：
  - **先写测试**（Red）：`agentStore.agents` 更新后，hook 返回的 `chatAgents` 同步变化
    （现状是空依赖 `useEffect`，此测试必然红）
  - 再加一条：某 agent 的 `chat_enabled` 变 `false` → 该 agent 从 `chatAgents` 消失
  - 实现：`const all = useAgentStore(s => s.agents)` + `useMemo(() => (all ?? []).filter(isChatEnabled))`
  - 若保留后端权威列表，则订阅 `agentStore` 的 `version` 作重拉触发；**禁止空依赖 `useEffect`**
- [x] 6.9 变异验证：`isChatEnabled` 恒返回 `Boolean(agent.chat)` → 6.1 的 false 用例红；
      徽标改回 `caps.chat &&` → 6.7 红；
      `useChatAgents` 改回独立 `useState` + 空依赖 → 6.8 红。

**验收**：`grep -rn "Boolean(.*\.chat)" src/` 无结果；`useChatAgents` 无空依赖 effect。

---

## Step 7 · 表单分叉（用户可见成果）

- [x] 7.1 **先写测试**（Red）：三条渲染路径
  - 内置 opencode：**无** argv 编辑器；有只读协议文案（含 `serve`）+ 勾选的 `Enable chat`
  - 内置 gemini：**无**任何 chat 输入；有「no built-in chat protocol」+ ACP 引导
  - 自定义：argv 编辑器 + in-process 复选框 + env textarea
- [x] 7.2 `agentFormChat.ts`：加 `ChatEnabledChoice` 三态类型 [R4]。
- [x] 7.3 `agentFormState.ts`：`chatEnabled: ChatEnabledChoice`；
      `toFormState` 按 design §3.4 投影；**内置 agent 仍填充 `chatArgv`/`chatEnvText`**
      （只读展示协议标签需要）。
- [x] 7.4 `AgentForm.tsx`：CHAT 区按 `initial?.is_builtin` + `initial.chat` 分三条渲染路径。
      只读协议标签来自 `TRANSPORT_LABELS[transportOf(initial.chat)]`，禁止硬编码。
- [x] 7.5 **先写测试**（Red）：**三态往返** [R4]
  - 内置 opencode（出厂 `chat_enabled = None`）→ 打开表单 → **直接保存** →
    `chat_enabled` **仍为 `null`**（不得变 `Some(true)`）
  - 点 Reset to default → 保存 → `null`
- [x] 7.6 **先写测试**（Red）：**开关交互**
  - 取消勾选 → 保存 → `chat_enabled === Some(false)` 且 `chat` 与 `initial.chat` 深相等
- [x] 7.7 **先写测试**（Red）：**出厂 `chat` 不被表单往返改写**
  - 内置 `pi`（出厂 `chat = { program: None, args: ["--mode","rpc"] }`）
  - 打开表单 → 直接保存 → 断言 `chat.program` **仍为 `None`**
  - 这是 design §3.5 的核心：`formatChatLaunch` 会填 `command`，用 `builtChat` 提交会把
    `program` 变成 `Some("pi")`（语义从「沿用 command」→「显式 pi」）
- [x] 7.8 **先写测试**（Red）：**通用往返不变性** [R12]
  - 内置 agent 打开表单直接保存 → `command` / `args` / `prompt_args` / `post_prompt_args` /
    `model_list_args` / `deploy` / `detection` **逐字段深相等**
  - 比只盯 `chat` 更省用例，且能抓住同类投影 bug
- [x] 7.9 **先写测试**（Red）：**内置无 chat 被写入 chat 时抛错** [R6]
  - `initial.chat == null` 且内置 → 保存时抛 `AgentFormError`，提示创建自定义 agent
- [x] 7.10 `buildConfig()`：按 design §3.5 实现（含 7.9 的抛错分支）。
- [x] 7.11 自定义 agent 的 ACP 引导：`chatArgv` 为空时编辑器给占位提示 `acp`，
      **不自动填入**（不预声明一个可能不存在的协议）。
- [x] 7.12 变异验证：
  - `buildConfig` 内置分支改用 `builtChat` → **7.7 必红**（本任务最重要的一条护栏）
  - `chatEnabled` 改回 `boolean` → 7.5 红
  - 删掉 7.9 的抛错 → 7.9 红

**验收**：三条渲染路径 + 五条交互测试全绿；三条变异全部确认变红。

---

## Step 8 · `!VAR` 引用 + 收尾

- [x] 8.1 **先写测试**（Red）：`KEY=!VAR` 解析 [R9]
  - 配置里存 `!VAR` 字面量（序列化后仍是 `!VAR`，不落明文）
  - spawn 时展开为父进程 `VAR` 的值
  - `VAR` 不存在 → **报错**（不静默传空串）
  - `KEY=!VAR` 里的 `!` 不是开头（如 `KEY=a!b`）→ 按普通值处理
- [x] 8.2 `chat_launch.rs`（或 `chat_env()` 所在处）实现引用解析。
- [x] 8.3 表单 env textarea 的 placeholder 提示 `KEY=!VAR` 语法。
- [x] 8.4 `pnpm check:quick`。
- [x] 8.5 `cargo test`（2131 + 新增）。
- [x] 8.6 更新 `.trellis/spec/backend/agent-chat-transports.md`：
  - §4「新增一条传输必须改的落点」：4 处 → **2 处**（后端 `PROTOCOLS` 一行 + 前端 `TRANSPORTS` 一行），
    并写明生成物护栏如何钉住两端；
  - 新增「**表顺序即优先级**」约定 + `protocol_of` 的 panic 语义；
  - 新增「**表化不恢复编译期穷举**」的诚实结论（§R1.1）+ 两道防线；
  - `wire_format` 的**迁移期推断 vs 运行时推断**区别（这是本任务最容易被误读成"bug 回来了"的地方）；
  - §10.2「五个已知断点」表同步更新（注册表改变了断点 1 的形态）[R11]；
  - `!VAR` 环境变量引用语法 + 明文暴露面的已知限制。
- [x] 8.7 更新 `.trellis/spec/frontend/state-management.md`：
  `isChatEnabled()` 是唯一判据；`useChatAgents` 必须订阅 `agentStore`；
  `chatEnabled` 表单态**三态禁止压成 boolean**。
- [x] 8.8 更新 `check_agent_config_single_source.py`：加一条
      「`adapter_for` 不得含 `ChatTransport::` 分支」。
- [x] 8.9 汇总变更，**不主动提交**。

---

## 验证命令

```bash
cargo test --manifest-path src-tauri/Cargo.toml
git diff --exit-code src/generated/          # 生成物已提交且同步
pnpm check:quick
npx vitest run src/shared/types src/features/agent src/features/agent-chat
```

---

## Step 9 · neeko-check 评审修复（2026-10-24）

> 审核报告：15 条红线零违规；1 Block（wire_format 迁移与验收 #6 矛盾）+ 3 Warning + 3 Nit。
> 修复的最终裁决记录在 design §7（as-built），与上文冲突处以 §7 为准。

- [x] 9.1 **[Block]** `wire_format` 装载期迁移：`AgentConfig::migrate_legacy_chat_wire_format`
      （含 **command 回落** —— 旧运行时推断看 `chat_cmd_vec()[0]`，program 缺省时是 command）；
      `agent/boot.rs::migrate_agent_wire_format` 挂进既有迁移编排（写回配置 JSON +
      `outcome.migrated` 记账 → 调用方落盘）。验收 #6 由此满足；serde 往返不变量保持。
      测试：types ×3 + boot ×3（端到端 / command 回落 / 显式值保护）。
- [x] 9.2 **[Block·UI]** `ChatLaunchEditor` 对 ACP 传输暴露 Wire Format 选择器；
      `buildChatLaunch` 增 `wireFormat` 参数（仅 ACP 携带）；`FormState.chatWireFormat`。
      显式 `content-length` 落盘 = opencode 命名配置固定帧格式的唯一表达。
      测试：chatLaunch.test（落库 / 门控）+ builtinChat.test（选择器显隐 ×3）。
- [x] 9.3 **[Warning]** 跨栈护栏维持读源码方案，design §2.6.1 生成方案否决（§7.1）。
- [x] 9.4 **[Warning]** `AgentForm` 稳定回调 `chatSetters`（3 处内联箭头清零）；
      `ArgListEditor.test` memo 护栏扩展覆盖 `BuiltinChatSection` / `ChatLaunchEditor`。
- [x] 9.5 **[Warning]** `BuiltinChatSection` Reset 按钮移出 `<label>`（内容模型 + 可访问名）。
- [x] 9.6 **[Nit]** 删除死代码 `listChatAgents`（前端 wrapper + 后端命令 + 注册 + 测试 mock）。
- [x] 9.7 **[Nit]** 护栏脚本 `check_agent_config_single_source`：单次 `search`（walrus）+ 判据编号修正。
- [x] 9.8 **[Nit]** 内置无出厂 chat 提交 `chat_enabled: null`（测试钉住）。
- [x] 9.9 **[Nit·补漏]** `TRANSPORT_LABELS` 双副本去重（`agentFormChat.ts` re-export shared）；
      `chatTransportLabel` 删除，`AgentForm` 单一 `transport` memo（识别一次，三处消费）；
      内置分支协议标签从 `initial.chat` 直接识别（inprocess 投影为空 argv 会误判）。
- [x] 9.10 env placeholder 提示 `!VAR` 语法（implement 8.3 的承诺此前未兑现）。
- [x] 9.11 更新 `.trellis/spec/backend/agent-chat-transports.md`（wire_format 三层迁移 + 判据收口）。


---

## 归档记录（2026-10-26）

**状态：完成。** 全部步骤已勾选（82 条），验收标准逐条可核。

落地提交：
- `c612f20d` feat(agent): rebuild chat transport plumbing around a registry
- `837420d6` test(guards): require chat capability checks to honor chat_enabled

本任务的 `PROTOCOLS` 注册表是后续所有 transport 改动的基座：`10-24-composer-token-editor`
的 opencode `/api/command` 接线（`4f163ddd`）正是往这张表里加一条记录 + 前端 `TRANSPORTS`
一行，符合 AC2 定义的「新增协议 = 两处各一行」。
