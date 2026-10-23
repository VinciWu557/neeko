# Implement · ChatLaunch 收敛

> 顺序不可调换：Step 1 落地后每一步都可独立验证、独立回滚。
> 每步结束必须 `cargo test` 全绿再进下一步；Step 3 起加 `pnpm check:quick`。

---

## Step 1 · 类型与迁移（纯重构，行为零变更）

**目标**：`ChatStart` + `chat_command` + `chat_args` 三处合并为 `ChatLaunch`，旧配置可读。

- [x] 1.1 在 `src-tauri/src/common/agent/types.rs` 新增 `ChatLaunch { program: Option<String>, args: Vec<String> }`，`#[derive(Default)]`，字段带 `skip_serializing_if`。
- [x] 1.2 新增 `ChatTransport { Acp, Serve, Jsonl, PiRpc }`（`#[derive(Copy, PartialEq, Eq, Debug)]`）与 `impl ChatLaunch::transport()`，严格按 design §2.2 的 token 顺序判定。
- [x] 1.3 **先写测试**（Red）：`transport_recognises_each_launch_shape` 覆盖 design §5.2 全部边界，含 `["--preserve"] → Acp`（子串误判反例）与 `["serve","acp"] → Acp`（优先级）。
- [x] 1.4 实现 `transport()` 到测试转绿。
- [x] 1.5 **先写测试**（Red）：迁移矩阵 `legacy_chat_forms_migrate_losslessly`，`it.each` 覆盖 6 种旧形态，每条同时断言 `transport()` 与 `chat_cmd_vec()`。
- [x] 1.6 实现 `impl<'de> Deserialize for ChatLaunch`：字符串形态（含 `"mock"` → 默认）、`{"transport":"acp","args":[…]}` 形态、新对象形态三分支；未知字符串**报错**。
- [x] 1.7 用 `#[serde(from = "RawAgentConfig")]` 引入 `RawAgentConfig` 镜像旧结构（含影子 `chat_command` / `chat_args`），`From<RawAgentConfig> for AgentConfig` 里完成合并，然后删除 `AgentConfig::chat_command` / `chat_args` 字段。
- [x] 1.8 改写 `AgentConfig::chat_cmd_vec()` 为 design §2.3 实现；保留 `cmd_vec()` 不变。
- [x] 1.9 **先写测试**（Red）：`chat_cmd_vec_expansion_matrix` 覆盖 design §2.3 表格 4 个场景（与旧 `chat_cmd_vec` 逐条等价）。
- [x] 1.11 **先写测试**（Red）：env 合并矩阵 `chat_env_merges_global_then_launch`，覆盖 design §5.6 表格 5 行。
- [x] 1.12 实现 `AgentConfig::chat_env()`；`ChatLaunch.env` 用 `BTreeMap`（不是 `HashMap` —— 保证 `config.json` 输出稳定）。
- [x] 1.13 `RawAgentConfig` 必须**原样透传** `AgentConfig::env`（旧字段，不得清空）；加测试：喂入 `{env:{A:1}}` 的旧配置，断言加载后 `config.env` 不变。
- [x] 1.14 变异验证：把未知字符串兜底回 `Acp` → `legacy_chat_forms_migrate_losslessly` 必红；把 `transport()` 改子串匹配 → `--preserve` 用例必红；把 `acp` 判断移到 `serve` 之后 → 优先级用例必红；`chat_env()` 只返回 `launch.env` → 合并矩阵必红。逐条确认后还原。

**验收**：`cargo test` 全绿、用例数 ≥ 迁移前；`grep -rn "chat_command\|chat_args" src-tauri/src/` 仅剩 `RawAgentConfig` 与迁移代码；`grep -n "pub env" src-tauri/src/common/agent/types.rs` 仍命中（全局 env 保留）。

---

## Step 2 · adapter 分派与环境变量注入

**目标**：分派依据换成 `transport()`；`Serve` 不再硬编码程序名；四个 adapter 统一用 `chat_env()`；删除 `Mock` 生产通道。

- [x] 2.1 `src-tauri/src/agent/chat/adapter.rs`：`adapter_for` 改为 design §2.6 实现；移除 `ChatStart::Mock` 分支。
- [x] 2.2 **先写测试**（Red）：`serve_adapter_uses_the_configured_program` —— 断言 `ServeAdapter` 收到的 cmd 来自配置而非字符串 `"opencode"`。
- [x] 2.3 `ServeAdapter::new()` → `new(cmd: Vec<String>, env: BTreeMap<String, String>)`；`connection.rs` 的 `serve_connection()` / `start_serve()` 改收这两个参数。
- [x] 2.4 **先写测试**（Red）：`user_env_cannot_override_the_serve_password` —— 把“合并 + 插入密码”抽成纯函数 `merged_env_for(config, password)`，断言用户写 `OPENCODE_SERVER_PASSWORD=wrong` 时实际值仍为内部生成值（不起真进程）。
- [x] 2.5 `connection.rs` 的 `spawn_with_env` 改传 `merged_env_for(...)` 的结果（需转换为 `&[(&str,&str)]` 视图）；确认路径内无 `env_clear()`（继承不被替换）。
- [x] 2.6 **先写测试**（Red）：`acp_and_jsonl_and_pi_rpc_spawn_with_the_chat_env` —— 三个 adapter 的 spawn 都把 `chat_env()` 传给了 exec。
- [x] 2.7 `acp.rs`、`deepseek.rs`、`pi_rpc/process.rs` 接入 env（见 Step 2b）。
- [x] 2.8 在 `ServeAdapter` 文档注释记录「`cmd` 只对首次 spawn 生效」的单例约束（design §2.6 引注）。
- [x] 2.9 `builtin/providers.rs`：`shell_agent()` 的 `chat` 参数类型改 `Option<ChatLaunch>`；opencode → `ChatLaunch { program: Some("opencode"), args: ["serve"], env: BTreeMap::new() }`；pi → `ChatLaunch { args: ["--mode","rpc"], ..Default::default() }`；mockAgent → `None`。
- [x] 2.10 **先写测试**（Red）：`builtin_agents_keep_their_transports_after_migration` —— opencode → `Serve`、pi → `PiRpc`、其余（含 mockAgent）无 chat。
- [x] 2.11 `builtin/tests.rs`：`ChatStart::PiRpc` / `Serve` / `Mock` 断言改为 `ChatLaunch` + `transport()`。
- [x] 2.12 `pi_rpc/adapter.rs` 与测试里的 `ChatStart::PiRpc` 文档/引用改写；`AcpAdapter::mock()` 的测试改为直接构造，不经 `adapter_for`。
- [x] 2.13 变异验证：`ServeAdapter` 硬编码改回 `"opencode"` → 2.2 与 2.10 必红；去掉密码的最后写入（改回先写用户 env）→ 2.4 必红；某 adapter 漏传 env → 2.6 必红。

**验收**：`grep -rn "ChatStart" src-tauri/src/` 无结果；`cargo test` 全绿。

---

## Step 2b · 合并 exec 的 spawn facade

**背景**：`core/exec.rs` 现有三个 spawn 入口，它们只是 `SpawnOptions` 的三种参数组合：

```rust
spawn(target, cmd, args)                      // kill_tree
spawn_with(target, cmd, args, cwd)            // kill_tree + cwd
spawn_with_env(target, cmd, args, env)        // kill_tree + env
```

而 `SpawnOptions` 本身就带 `current_dir` / `env` / `kill_tree` 三个可选项（`executor/types.rs`）。三个函数导致“cwd + env 同时要”的语法窟窿（pi_rpc 要 cwd 但无 env，serve 要 env 但无 cwd，chat 统一注入 env 后 pi_rpc 两者都要）。**不新增第四个函数，合并成一个。**

- [x] 2b.1 定义参数结构（放在 `core/exec.rs`，与 facade 同层）：

  ```rust
  /// 可选参数的 bundle —— 避免 facade 出现 N 个 `Option` 位置参数。
  #[derive(Default, Clone, Copy)]
  pub struct SpawnSpec<'a> {
      /// 工作目录；`None` = 执行环境默认。
      pub cwd: Option<&'a str>,
      /// 额外环境变量（追加，不替换继承）。
      pub env: &'a [(&'a str, &'a str)],
      /// 是否连后代一起杀。默认 `false`；受管长驻进程应显式传 `true`。
      pub kill_tree: bool,
  }

  impl<'a> SpawnSpec<'a> {
      pub const fn new() -> Self { /* ... */ }
      pub const fn with_cwd(mut self, cwd: Option<&'a str>) -> Self { /* ... */ }
      pub const fn with_env(mut self, env: &'a [(&'a str, &'a str)]) -> Self { /* ... */ }
      pub const fn kill_tree(mut self) -> Self { /* ... */ }
  }
  ```

- [x] 2b.2 合并后的唯一入口（保留 `spawn` 名字，不改调用方心智）：

  ```rust
  /// Spawn a process on `target`. 所有可选参数走 `SpawnSpec`。
  pub async fn spawn(
      target: &ExecTarget,
      cmd: &str,
      args: &[&str],
      spec: SpawnSpec<'_>,
  ) -> Result<ExecChild, ExecError> {
      spawn_target(
          target,
          SpawnOptions::new(cmd, args)
              .with_current_dir_if(spec.cwd)
              .with_env(spec.env)
              .with_kill_tree_if(spec.kill_tree),
      )
      .await
  }
  ```

  需在 `executor/types.rs` 新增 `with_kill_tree_if(bool)`（与现有 `with_current_dir_if` 同形，已有先例）。

  > **已核实**：`SpawnOptions::with_kill_tree_if(bool)` 已存在于 `executor/types.rs:208`，无需新增。`with_current_dir_if`（:184）与 `with_env`（:193）也已就绪 —— **合并零新增 API**，只是删两个 facade 函数。

- [x] 2b.3 删除 `spawn_with` / `spawn_with_env` 两个 facade，**迁移 7 个调用点**：

  | 文件 | 旧 | 新 |
  | --- | --- | --- |
  | `agent/chat/adapter/acp.rs` | `spawn(target, program, &args)` | `spawn(target, program, &args, SpawnSpec::new().kill_tree())` |
  | `agent/chat/adapter/deepseek.rs` | 同上 | 同上 |
  | `agent/chat/adapter/pi_rpc/process.rs` | `spawn_with(.., Some(cwd))` | `spawn(.., SpawnSpec::new().with_cwd(Some(cwd)).kill_tree())` |
  | `agent/chat/adapter/opencode/connection.rs` | `spawn_with_env(.., &env)` | `spawn(.., SpawnSpec::new().with_env(&env).kill_tree())` |
  | `agent/chat/adapter/opencode/tests.rs` | 同 | 同 |
  | `dap/process.rs` | `spawn_with(target, .., Some(path))` | `spawn(.., SpawnSpec::new().with_cwd(Some(path)).kill_tree())` |
  | `dap/adapter/go.rs` | `spawn(Local, ..)` | `spawn(.., SpawnSpec::new().kill_tree())` |

- [x] 2b.4 **先写测试**（Red）：`spawn_spec_combines_cwd_and_env` —— 同时传 cwd + env，断言子进程拿到的两者都生效（用 `sh -c 'echo $KEY; pwd'` 类夹具）。这是合并前**无法表达**的组合，也是本次合并的直接理由。
- [x] 2b.5 **先写测试**（Red）：`kill_tree_defaults_to_false` —— `SpawnSpec::new()` 不带 `kill_tree` 时行为与旧 `spawn` 之外的不该受影响的路径一致；显式 `.kill_tree()` 后才提升为进程组。
- [x] 2b.6 确认 `collect*` 系列不受影响（它们不收 `kill_tree`，短命令不该改进程组 —— 见 `exec.rs` 现有注释）。
- [x] 2b.7 变异验证：`spawn` 里 `.with_kill_tree_if(spec.kill_tree)` 改成无条件 `.with_kill_tree()` → 2b.5 必红；`spawn` 丢掉 `.with_env(spec.env)` → 2b.4 必红；`spawn` 丢掉 `.with_current_dir_if(spec.cwd)` → 2b.4 的 `pwd` 断言必红。

**验收**：`grep -rn "spawn_with\|spawn_with_env" src-tauri/src/ --include=*.rs` 无结果（除注释）；`cargo test` 全绿；`collect` 签名未变。

**为何用结构体而不是 `spawn(target, cmd, args, Option<cwd>, &env, bool)`**：三个位置参数里有俩是 `Option`/空 slice 常态，调用点会变成 `spawn(t, c, a, None, &[], true)` —— 读不出哪个是哪个，且加第四个可选项时又得改所有调用点。`SpawnSpec` 让调用点只写它关心的字段：`SpawnSpec::new().with_env(&env)`。

---

## Step 3 · 前端

**目标**：删除传输下拉，改为单个启动命令输入框。

- [x] 3.1 `src/shared/types/agent.ts`：`ChatStart` 联合类型 → `ChatLaunch` 接口（含 `env?`）+ `ChatTransport` 联合；`chatTransportOf` 改为 `transportOf(launch)`，规则与后端逐 token 一致。
- [x] 3.2 **先写测试**（Red）：`src/features/agent/components/__tests__/chatLaunch.test.ts` —— `buildChatLaunch` / `formatChatLaunch` 往返、空命令 → `null`、多空格归一。
- [x] 3.3 **先写测试**（Red）：`parseEnvText` 边界矩阵 —— design §4.2 表格全部 8 行（重点：`URL=http://x?a=b`、`KEY=#v`、`=v` 忽略）。
- [x] 3.4 `agentFormChat.ts`：删 `CHAT_OPTIONS` / `CHAT_HINTS` / `buildChatStart`，加 `buildChatLaunch` / `formatChatLaunch` / `parseEnvText` / `formatEnvText`。
- [x] 3.5 `agentFormState.ts`：`chat` / `acpArgsText` / `chatCommand` / `chatArgsText` 四字段 → `chatCommandLine: string` + `chatEnvText: string`；`toTextState` / `fromTextState` 相应改写。
- [x] 3.6 `AgentForm.tsx`：CHAT 区改为单输入框 + 识别结果一行 + env textarea；删 `t.chat === 'acp' ? … : …` 条件分支与 `CHAT_HINTS` 引用；删 `ChatLaunchFields` 引入。
- [x] 3.7 删除 `ChatLaunchFields.tsx`；`git rm` 并确认无残留引用。
- [x] 3.8 重写 `__tests__/chatTransportOptions.test.ts`：旧断言锁的是「下拉每一项都要在后端有 as_str 臂」，新设计下该前提消失。改为跨栈护栏 —— 读 Rust `types.rs`，断言前端的 token 字面量集合（`acp` / `serve` / `--jsonl` / `stream-json` / `--mode` / `rpc`）与后端 `ChatLaunch::transport()` 一致。
- [x] 3.9 **先写测试**（Red）：`AgentForm` 渲染断言 —— CHAT 区只有 1 个 `<input>` + 1 个 `<textarea>`、无 `<select>`、输入 `opencode acp` 后出现「ACP」提示。
- [x] 3.10 变异验证：前端 `transportOf` 删掉 `serve` 分支 → 3.8 护栏必红；`buildChatLaunch` 把 `program` 也塞进 `args` → 3.2 必红；`parseEnvText` 按所有 `=` 切分 → 3.3 必红。

**验收**：`grep -rn "CHAT_OPTIONS\|CHAT_HINTS\|ChatLaunchFields" src/` 无结果；`pnpm check:quick` 18/18。

---

## Step 4 · 收尾

- [x] 4.1 `pnpm check:quick`（护栏 + lint_fe + lint_rust）。
- [x] 4.2 `cargo clippy --all-targets -- -D warnings`、`cargo fmt --check`。
- [x] 4.3 更新 `.trellis/spec/backend/agent-chat-transports.md`：删除 `ChatStart` 变体表，改为 `ChatLaunch` + 识别规则 + 迁移表格。
- [x] 4.4 全仓 `grep -rn "ChatStart" .` 确认无活引用（`docs/`、spec、注释一并清理）。
- [x] 4.5 检查 `src-tauri/AGENTS.md` 与 `src/AGENTS.md` 是否有 `ChatStart` 相关红线引用需同步。
- [x] 4.6 汇总变更清单交给用户，**不主动提交**。

---

## 验证命令

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm check:quick
pnpm type-check
```

## 回滚点

| 回滚到 | 影响 |
| --- | --- |
| Step 1 后 | 类型已收敛，UI 仍是下拉；旧配置可读，可安全回退 |
| Step 2 后 | 后端完全切换；前端下拉仍可写旧形态（被迁移层读取） |
| Step 3 后 | 完整落地 |

任一步失败：`git revert <该步 commit>`，旧配置格式始终可读（反序列化不重写文件）。

---

## Step 5 · neeko-check 复审修复（2026-08-25）

三处缺陷，病因同源：**把「显式数据」退化成「从其他字段推断」，于是推断规则覆盖了它本不覆盖的情况。**

- [x] 5.1 **序列化往返（阻塞级）**：`ChatLaunch::Deserialize` 的判别式由「有 `program` 键」改为「有 `transport` 键」。
  三个字段全部 `skip_serializing_if` 省略，所以 `{}` 与 `{"args":[…]}` 是**我们自己的 `Serialize` 输出**；
  旧判别式把这两份输出判成旧对象 → 内置 `pi` 与 `mockAgent` 一旦保存就再也读不回来
  （`boot` / `app_state` 只 `warn` + `continue`，表现为「配置静默消失」）。
- [x] 5.2 **进程内实现显式化**：`ChatLaunch` 新增 `inprocess: bool`，替换 `is_inprocess_chat()`
  的「命令行推为空」启发式。旧启发式会把「用户清空 command 却保留 chat 声明」静默路由到
  mock adapter（得到「能连上但永远不回话」的会话）。
- [x] 5.3 **前端往返**：`FormTextState` 新增 `chatInprocess`；`buildChatLaunch` 接收该参数，
  `formatChatLaunch` 对 inprocess 返回空串。否则 `mockAgent` 经表单往返退化成「无 CHAT 能力」。

**变异验证**（逐条已执行，确认变红后还原）：

| 变异 | 应红的测试 |
| --- | --- |
| 判别式改回「有 `program` 键」 | `every_launch_round_trips_through_its_own_output`、`builtin_launch_shapes_round_trip`、`every_builtin_agent_survives_a_persistence_round_trip` |
| `is_inprocess_chat` 改回「命令行推为空」 | `blank_command_without_declaration_is_not_inprocess` |
| `buildChatLaunch` 忽略 inprocess 参数 | `round-trips an in-process launch without inventing a command line` |

**遗留项已在本轮处理** —— 见下方 Step 6。

---

## Step 6 · argv 表单态改为数组（方案 C，2026-08-25）

**问题**：`argv ↔ 空格分隔一行文本` 这条投影不幂等 —— 每次「打开设置页 → 保存」都会静默改写
用户配置（`['--sys','hello world']` → `['--sys','hello','world']`）。影响 CHAT 启动命令，
以及 `prompt_args` / `post_prompt_args` / `model_list_args` 四个消费点（共用同一个 `splitArgs`）。

**为什么不是换库**（实测结论）：

| 候选 | 结论 |
| --- | --- |
| `shell-quote` | 做 shell 展开（`$HOME/x` → `/x`、`&&` → 运算符节点）。而 argv 是**直传进程**的（WSL/SSH 路径由 `join_quoted_command` 单引号转义），语义不对 |
| `string-argv` | 语义正确但**没有 formatter**；引号内不反转义，同时含两种引号的值无法表达。仍是有损投影 |
| 自写带引号分词器 | 只是把损失减小；载体仍不承载边界 |

判据：**投影是否单射**。换载体（数组）才从根上消除问题。

- [x] 6.1 **先写测试**（Red）：`__tests__/argList.test.ts` —— 5 个纯操作 + 往返不变量。
- [x] 6.2 新增 `argList.ts`：`setArgAt` / `appendArg` / `removeArgAt` / `trimArgList` / `isValidArgList`
      （全部纯函数、不 mutate 入参）。
- [x] 6.3 新增 `ArgListEditor.tsx`：一行一个输入框 + 删除 + 追加，替代五处单行 `<input>`。
- [x] 6.4 `agentFormState.ts`：`FormTextState` → `FormState`，五个 argv 字段改 `string[]`；
      `toTextState` → `toFormState`；新增 `toNullableArgs`（空数组 → `null`，后端契约）。
- [x] 6.5 `agentFormChat.ts`：`buildChatLaunch` / `formatChatLaunch` / `chatTransportLabel`
      全改收 `readonly string[]`，删掉 `splitArgs` 参数（形态转换只剩"数组首项 ↔ program"）。
- [x] 6.6 删除 `agentFormArgs.ts`（`splitArgs` / `splitCsv` / `argsTextOf` / `argsFromText` 全部消失）。
- [x] 6.7 `AgentForm.tsx`：五处控件换 `ArgListEditor`；提交边界 `trimArgList`。
- [x] 6.8 **先写测试**（Red）：`__tests__/ArgListEditor.test.tsx` —— 含空格的参数原样进数组、
      删除只删一个、不 mutate 入参、disabled 全覆盖。
- [x] 6.9 反回潮护栏（`chatLaunch.test.ts` 两个 describe）：
      「argv 不得被压回一行」（源码级断言无 `split(/\s+/)` / `.join(' ')`）+
      「五个字段共用同一控件」（`<ArgListEditor` 出现 5 次）。
- [x] 6.10 更新 PRD R6/R7：R6 改为列表编辑器（附推翻旧方案的判据与两个库的实测结论），
      R7 从「分隔符统一」改为「参数形态统一」。

**变异验证**：

| 变异 | 应红的测试 |
| --- | --- |
| `buildChatLaunch` 前把 argv `join(' ')` 再 split | `preserves an argument that contains spaces` |
| `trimArgList` 改成一并过滤所有空串 | `should keep an empty slot that sits between values` |
| `setArgAt` 直接 mutate 入参 | `should not mutate the input array` |
| 某个字段换回单行 `<input>` | `the ArgListEditor is the shared control for every argv field` |

**环境变量为何保持文本态**：`KEY=value` 多行 → 对象的投影是**幂等**的（除设计上就要 trim 的
首尾空白），且它承载的是"多行"这个天然布局，不是一个会丢边界的有序序列。

---

## Step 7 · neeko-check 复审修复（第三轮，2026-08-25）

### 7.1 判据分裂：预览说「有 CHAT」，落库却是 `null`（功能缺陷）

表单里"有没有 CHAT 能力"曾有 **4 处**独立实现，其中 3 处用 `chatArgv.length > 0`、
落库那一处用 `trimArgList(...)`。两者在「槽位全是空白」时结论相反：

```
chatArgv = ['   ']  →  length > 0 ⇒ 预览显示「有 CHAT」
trimArgList → []    ⇒  chat = null ⇒ 实际没有任何能力
```

后果：`command` 为空 + `chatArgv = ['']` 时提交校验**通过**，落库一个
CLI/CHAT/Headless 三能力全空的 agent，且**无任何报错** —— 而那个校验正是为此存在。

- [x] 7.1.1 判据改为**从落库值派生**：`builtChat = buildChatLaunch(trimArgList(...))`，
      预览 `chat: builtChat !== null`、校验 `builtChat === null`、env 区显隐复用同一值。
- [x] 7.1.2 先抽了 `declaresChat()` 作为"唯一判据"，但它仍是第二套规则
      （`inprocess || trim().length`）→ **删掉**，`builtChat !== null` 本身就是唯一真相。
- [x] 7.1.3 回归测试 `chat capability predicate matches the persisted value`（5 用例）。

### 7.2 输入控件绕开 `ui/` 原语 → 丢失三重保护

AgentForm 有 8 个裸文本 `<input>` + 1 个裸 `<textarea>`，`ArgListEditor` 也是裸标签。
绕开 `ui/Input` 等于丢掉：IME 分词空格守卫、`noAutocorrectProps`、统一 focus/disabled 样式。
**这三条都难以在裸标签上被单测捕获**（渲染出来都是 textbox），所以此前无人发现。

- [x] 7.2.1 **先写测试**（Red）：`ui/__tests__/Input.test.tsx` 新增 `size` 变体用例。
- [x] 7.2.2 `ui/Input.tsx` 用 `cva` 新增 `size`（`default` / `sm`），与 `Button` 同模式。
      逐项核对：默认变体的类集合与改动前**完全等价**（既有 36 个消费点视觉零变化）。
- [x] 7.2.3 AgentForm 8 个文本输入 → `<Input size="sm">`，textarea → `<Textarea>`；
      `fieldCls` 删除（已无消费点）。裸 `<input>` 只剩 2 个 checkbox。
- [x] 7.2.4 `ArgListEditor` → `<Input size="sm">`，不再自己接 `useImeSpaceGuard`（复用继承）。
- [x] 7.2.5 变异验证：`sm` 变体漏掉 `py-0`／删掉 guard 接线 → 对应用例必红。
      其中 guard 那条最初**没变红**（旧测试只断言了源码 import），补了真正驱动
      composition 事件的用例后才红 —— 记在下面「假护栏」一栏。

### 7.3 可访问性：`label` 关联断裂

`<label>` 包自定义 `<Input>` 时 `jsx-a11y/label-has-associated-control` 报错
（静态分析看不到 `Input` 内部渲染的 `<input>`），读屏软件同样无法关联。

- [x] 7.3.1 9 处 `label > span` 改为 `label htmlFor` + 控件 `id`。
- [x] 7.3.2 新增 `__tests__/AgentForm.a11y.test.tsx`：裸 input 计数、`getByLabelText`
      全覆盖、id 唯一性。
- [x] 7.3.3 变异验证：任一处改回裸 `<input>` → 三条 a11y 用例全红。

### 7.4 自我纠错：一条假护栏

第一版用「rerender 两次比 DOM 节点身份」验证 `React.memo` 生效 —— **去掉 memo 后它依然通过**
（React 对相同元素类型本就复用 DOM）。已替换为源码级断言（父组件不得传内联回调/内联数组），
两个变异都验证过变红。

### 7.5 撤回一条错误判断

我在上一轮审查里说「`fieldCls` 等 4 个 class 字符串每次渲染重建」。**这是误判**：
`cn()` 两次调用对相同内容返回**同一个字符串引用**（V8 驻留），React 浅比较通过，
无任何实际成本；且 `cn` 本身是必要的类合并。真正失效的是**数组/对象字面量**
（`placeholders={[…]}` / `onChange={() => …}` / `agent={{ … }}`），只有这些才让 memo 失效。

