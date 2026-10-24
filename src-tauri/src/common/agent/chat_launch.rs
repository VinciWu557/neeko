//! CHAT 进程的启动配置 —— 可执行文件 + 参数 + 环境变量。
//!
//! # 为什么不是枚举
//!
//! 启动一个 chat 进程，系统需要的全部信息就是 `(argv[0], argv[1..], env)` 三元组。
//! 历史上这部分被切成四份（`ChatStart` 枚举 / `ChatStart::Acp.args` /
//! `chat_command` / `chat_args`），再由每条传输各自拼装 —— 于是「N 个来源合并成
//! 一个命令行」产生 N-1 个语义歧义：`chat_command` 一旦设置就吞掉 `args`、
//! `Acp.args` 与 `chat_args` 谁先谁后无原则可依、`Serve` 干脆硬编码 `"opencode"`。
//!
//! 收敛成结构体后，「传输」只能从 token 流**推导**，没有地方可以存它 ——
//! 用户也就不需要在一个他无法改变的事实上做选择。

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};

/// 传输协议 —— **派生物**，由 [`ChatLaunch::transport`] 从启动命令识别。
///
/// 不从 `serde` 反序列化：`config.json` 里不存在这个字段，写进去即被视为
/// 用户想手动指定传输，那正是本类型要消除的东西。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatTransport {
    /// Agent Client Protocol over JSON-RPC stdio（唯一通用协议）。
    Acp,
    /// opencode serve：HTTP + SSE。
    Serve,
    /// JSON-Lines stdio（DeepSeek Harness 的私有协议）。
    Jsonl,
    /// Pi 的私有 rpc 协议（`pi --mode rpc`）。
    PiRpc,
}

impl ChatTransport {
    /// 全部变体 —— **唯一**变体清单。
    ///
    /// 新增传输时必须同步这里，否则 `rules::rule_for` 会得到「编译通过但
    /// 查不到」的运行时空洞。防线见 `transport_tests` 的前两条用例。
    pub const ALL: &'static [Self] = &[Self::Acp, Self::Serve, Self::Jsonl, Self::PiRpc];

    /// 稳定标识符（日志/错误信息/前端展示键用；**不是**持久化字段）。
    ///
    /// 取自规则表的 `id` —— 标识符只有一处来源。曾是 `match`，那意味着
    /// 「新增传输」要同时改枚举、match、识别规则三处，其中两处漏改不报错。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        rules::rule_for(self).id
    }
}

/// 传输**识别规则**表 —— 「哪些 argv token 表示哪种传输」的唯一来源。
pub(crate) mod rules {
    use super::ChatTransport;

    /// 一条判据。`predicate` 只看**完整 token**，禁止子串匹配。
    pub struct TransportRule {
        pub transport: ChatTransport,
        /// 稳定标识符（`as_str()` / 日志 / 前端展示键的唯一来源）。
        pub id: &'static str,
        pub predicate: fn(&[&str]) -> bool,
    }

    const fn rule(
        transport: ChatTransport,
        id: &'static str,
        predicate: fn(&[&str]) -> bool,
    ) -> TransportRule {
        TransportRule {
            transport,
            id,
            predicate,
        }
    }

    /// 表项顺序即**优先级**：`acp` 必须排在 `serve` 之前
    ///（`opencode serve acp` 以 acp 为准）。
    ///
    /// 这里只放纯数据，**不得**出现 `build` / `Box<dyn>` —— 那会把 adapter
    /// 的构造依赖拖进数据模型层并与 `agent::chat::adapter` 成环（见任务
    /// design §1.5「分层裁决」）。构造侧 Companion 表在 `agent/chat/registry.rs`。
    pub static TRANSPORT_RULES: &[TransportRule] = &[
        rule(ChatTransport::Acp, "acp", |t| t.contains(&"acp")),
        rule(ChatTransport::Serve, "serve", |t| t.contains(&"serve")),
        rule(ChatTransport::Jsonl, "jsonl", |t| {
            t.contains(&"--jsonl") || t.contains(&"stream-json")
        }),
        rule(ChatTransport::PiRpc, "pi-rpc", |t| {
            t.contains(&"rpc") || t.windows(2).any(|w| w == ["--mode", "rpc"])
        }),
    ];

    /// 查不到即程序 bug —— 表与枚举不同步时**响亮失败**，不给静默兜底。
    ///
    /// 为什么用它替代原来的 `match`：原来的 `match` 在漏 dispatched 分支时
    /// 编译报错，遍历表不会。这是表化的**已知代价**，由两道防线抵消：
    /// ① 本函数的 panic；② `every_transport_variant_has_a_rule` 测试。
    #[must_use]
    pub fn rule_for(transport: ChatTransport) -> &'static TransportRule {
        TRANSPORT_RULES
            .iter()
            .find(|r| r.transport == transport)
            .unwrap_or_else(|| {
                panic!(
                    "TRANSPORT_RULES 缺少 {transport:?} 的表项；新增 ChatTransport \
                     变体时必须同时加一条 TransportRule（common/agent/chat_launch.rs）"
                )
            })
    }
}

use rules::TRANSPORT_RULES;

/// 编译期防线：给 `ChatTransport` 加变体却忘了加规则时，这里直接编译失败。
///
/// 这比运行期 panic 早得多，也解释了为什么 `ALL` 与规则表必须放在同一文件。
const _: () = assert!(ChatTransport::ALL.len() == TRANSPORT_RULES.len());

/// CHAT 进程的启动配置。
///
/// 序列化为对象 `{"program": …?, "args": […]?, "env": {…}?}`（全空时写 `{}`）。
/// **旧格式的裸字符串由 [`Deserialize`] 迁移**，见下方 `deserialize`。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ChatLaunch {
    /// `argv[0]`。`None` = 沿用 [`super::types::AgentConfig::command`]
    ///（TUI 与 chat 同一个二进制）。空白字符串等同 `None`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    /// `argv[1..]`。空 = 无附加参数。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// **仅**注入给 chat 进程的环境变量（追加/覆盖，不替换继承）。
    ///
    /// 用 `BTreeMap` 而不是 `HashMap`：它会序列化到 `config.json`，`HashMap`
    /// 的迭代顺序随机 → 每次保存都产生无意义的 diff，测试断言也不稳定。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// 这个 chat 由**进程内实现**提供（`mockAgent`），不 spawn 子进程。
    ///
    /// # 为什么是显式字段而不是“命令行推为空”推断
    ///
    /// 「没有可执行文件」有两种互不相干的原因：
    /// 1. **设计如此** —— 进程内实现本来就不需要 `argv`；
    /// 2. **填漏了 / 暂时禁用** —— 用户清空了 `command` 却保留着 chat 声明。
    ///
    /// 按空推断会把情况 2 静默路由到进程内桩，得到一个「能连上但永远不回话」
    /// 的会话 —— 正是本类型要消灭的失败模式。两者只能靠声明区分。
    #[serde(default, skip_serializing_if = "is_false")]
    pub inprocess: bool,
    /// ACP 的帧格式。`None` = [`WireFormat::ContentLength`]（协议默认）。
    ///
    /// 不再由 `AcpAdapter::new` 按命令名推断 —— 见 [`WireFormat`] 的说明。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wire_format: Option<WireFormat>,
}

/// `skip_serializing_if` 助手（`bool` 没有现成的）。
const fn is_false(value: &bool) -> bool {
    !*value
}

/// JSON-RPC 帧格式 —— **配置项**，不再是推断结果。
///
/// # 为什么从 `agent/chat/adapter/acp.rs` 挪到这里
///
/// 帧格式决定「怎么把字节切成消息」，但它只有 ACP 在意。留在 adapter 里时它
/// 是 adapter 的私有实现细节，于是取值只能由 adapter 自己猜 —— 那就是
/// `AcpAdapter::new` 里那段按 `cmd[0]` 猜的逻辑。挪进 `ChatLaunch` 后它是
/// 用户可写的配置，adapter 只负责执行。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WireFormat {
    /// LSP 风格 `Content-Length` 分帧（协议默认）。
    ContentLength,
    /// 换行分隔 JSON。
    Ndjson,
}

/// **迁移期**帧格式推断 —— 与运行时推断有本质区别，务必读完再改。
///
/// | | 运行时推断（已删除） | 本函数（保留） |
/// | --- | --- | --- |
/// | 执行时机 | 每次 spawn | 只在读**没有 `wire_format` 键的旧配置**时一次 |
/// | 用户可见 | 否 | 是 —— 结果落进 `ChatLaunch`，下次会被序列化写出 |
/// | 改名 / 包装器 | **静默换协议** | 已持久化的值不受影响 |
///
/// 为什么不能直接删干净：老用户的自定义 `opencode acp` 配置里没有这个键，
/// 直接按 `ContentLength` 处理会对着期待 NDJSON 的服务发 `Content-Length`
/// 帧 —— 表现是握手无响应、无报错、UI 永远转圈。
///
/// 这里出现 `contains("opencode")` 是**刻意的**：它服务于协议兼容，且结果
/// 会被写回配置（用户看得见、改得动）。被删掉的那份是每次 spawn 都跑、
/// 用户看不见、改名即失效。
///
/// **实现只有这一份**（DRY），两个应用层各自处理自己能看到的歧义：
///
/// | 应用层 | 位置 | 能看到什么 | 处理什么 |
/// | --- | --- | --- | --- |
/// | 反序列化期 | `from_legacy_str` / `from_legacy_object` | 旧格式独有键（裸串 / `transport`） | 旧格式的 program 覆盖 |
/// | 装载期 | `AgentConfig::migrate_legacy_chat_wire_format` | 完整 `AgentConfig`（含 `command`） | 当前对象形态 + program 缺省（回落 command）—— 旧运行时推断看的是 `chat_cmd_vec()[0]`，program 缺省时是 command |
pub(crate) fn infer_legacy_wire_format(
    program: Option<&str>,
    explicit: Option<WireFormat>,
) -> Option<WireFormat> {
    if explicit.is_some() {
        return explicit; // 显式值优先，永远不被迁移覆盖
    }
    let exe = program.unwrap_or_default();
    (exe.contains("opencode") || exe.contains("kilo")).then_some(WireFormat::Ndjson)
}

impl ChatLaunch {
    /// 从 `program` + `args` 的**完整 token** 流识别传输。
    ///
    /// 只认完整 token，**禁止子串匹配** —— `--approval-mode` 含 "acp"、
    /// `--preserve` 含 "serve"，子串匹配会把它们全判错。
    ///
    /// 判定顺序即优先级：`opencode serve` 与 `opencode acp` 是互斥子命令，
    /// 同时出现时以 `acp` 为准。
    #[must_use]
    pub fn transport(&self) -> ChatTransport {
        let program = self.program.as_deref().unwrap_or_default();
        let tokens: Vec<&str> = std::iter::once(program)
            .chain(self.args.iter().map(String::as_str))
            .collect();

        // 表的顺序即优先级。
        TRANSPORT_RULES
            .iter()
            .find(|r| (r.predicate)(&tokens))
            .map_or(ChatTransport::Acp, |r| r.transport)
    }

    /// 去空白后非空的可执行文件覆盖。
    #[must_use]
    pub fn program_filtered(&self) -> Option<&str> {
        self.program
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    /// 非空的附加参数（过滤空串，它们会污染 `argv`）。
    pub fn args_filtered(&self) -> impl Iterator<Item = &String> {
        self.args.iter().filter(|a| !a.is_empty())
    }
}

/// 旧格式迁移：裸字符串 → [`ChatLaunch`]。
///
/// | 旧形态 | 映射 |
/// | --- | --- |
/// | `"acp"` | `{}` |
/// | `"serve"` | `{program: "opencode", args: ["serve"]}` |
/// | `"jsonl"` | `{args: ["--jsonl"]}` |
/// | `"pi-rpc"` | `{args: ["--mode","rpc"]}` |
/// | `"mock"` | `{}`（mock 已降级为测试桩，不再是传输） |
/// | `{"transport":"acp","args":[…]}` | `{args: […]}` |
///
/// **未知字符串报错**（旧实现静默兜底成 ACP）：拼错的 `"acpp"` 被当成 ACP
/// spawn，会得到「能开但完全不对」的会话，且没有任何提示。
///
/// # 判别式必须是「旧格式独有的键」
///
/// 反序列化要区分三种线上形态（旧字符串 / 旧对象 / 当前对象），判别式**只能**用
/// 旧格式独有的键，不能用当前格式的「可选键存在与否」。原因是一条序列化往返不变量：
/// 当前格式的三个字段全部可选（`program` 为 `None` 时 `skip_serializing_if` 直接
/// 不写键），所以 `{}` 与 `{"args":[…]}` 都是**我们自己的 `Serialize` 输出**。
///
/// 曾用「有没有 `program`」判别 → 这两份输出被判成旧对象而解析失败，即「保存后
/// 读不回来」：内置 `pi`（`{"args":["--mode","rpc"]}`）与 `mockAgent`（`{}`）
/// 一旦被用户覆盖保存，下次启动就被 `boot` 当作损坏条目静默丢弃。
///
/// 现在唯一判据是 `transport` 键 —— 只有旧格式 B 才会写它。
impl<'de> Deserialize<'de> for ChatLaunch {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;

        let value = serde_json::Value::deserialize(deserializer)?;

        // ① 旧格式 A：裸字符串。
        if let Some(s) = value.as_str() {
            return Self::from_legacy_str(s).map_err(D::Error::custom);
        }

        let obj = value
            .as_object()
            .ok_or_else(|| D::Error::custom("chat must be a string or an object"))?;

        if obj.contains_key("transport") {
            Self::from_legacy_object(obj).map_err(D::Error::custom)
        } else {
            Self::from_current_object(obj).map_err(D::Error::custom)
        }
    }
}

/// 取对象字段并按其目标类型反序列化；字段缺省时用 `T::default()`。
///
/// 抽出来让两种对象形态共用同一套字段读取 —— 否则「缺省取默认」这条规则要写两遍，
/// 且类型错误（如 `"program": 42`）会被静默吞成默认值。
fn chat_field<T>(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<T, String>
where
    T: serde::de::DeserializeOwned + Default,
{
    match obj.get(key) {
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|e| format!("chat.{key}: {e}"))
        }
        None => Ok(T::default()),
    }
}

impl ChatLaunch {
    /// 当前形态：`{"program"?, "args"?, "env"?}` —— 三项**全可选**。
    ///
    /// 空对象 `{}` 是合法值（= 无可执行文件、无参数、无额外环境变量），
    /// 它是 `ChatLaunch::default()` 的序列化结果，也是内置 `mockAgent` 的形状。
    fn from_current_object(
        obj: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<Self, String> {
        // ⚠️ 这里**不能**做 wire_format 迁移 —— 见 `infer_legacy_wire_format`
        // 上方的往返不变量说明：当前形态也是「我们自己的输出」，对它推断会让
        // 「读回自己写的东西」产生新字段，保存一次就永久漂移。
        Ok(Self {
            program: chat_field(obj, "program")?,
            args: chat_field(obj, "args")?,
            env: chat_field(obj, "env")?,
            inprocess: chat_field(obj, "inprocess")?,
            wire_format: chat_field(obj, "wire_format")?,
        })
    }

    /// 旧格式 B：`{"transport":"acp", "args":[…]}`。
    ///
    /// `args` **追加**在 `transport` 映射出的参数之后（不覆盖）—— 旧配置里两者
    /// 都可能是用户填的，覆盖会静默丢参数。
    fn from_legacy_object(
        obj: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<Self, String> {
        let transport = obj
            .get("transport")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "chat.transport must be a string".to_string())?;
        let mut launch = Self::from_legacy_str(transport)?;
        launch.args.extend(chat_field::<Vec<String>>(obj, "args")?);
        // 旧对象自己也可能带 `wire_format`（升级到中间版本时写过）—— 它是
        // 显式值，必须参与推断的「优先短路」，否则会被 program 推断覆盖。
        launch.wire_format = infer_legacy_wire_format(
            launch.program.as_deref(),
            chat_field::<Option<WireFormat>>(obj, "wire_format")?.or(launch.wire_format),
        );
        Ok(launch)
    }

    /// 裸字符串形态的迁移映射（`Deserialize` 与 `RawAgentConfig` 共用）。
    pub(crate) fn from_legacy_str(s: &str) -> Result<Self, String> {
        let launch = match s {
            "acp" => Self::default(),
            "serve" => Self {
                program: Some("opencode".into()),
                args: vec!["serve".into()],
                env: BTreeMap::new(),
                inprocess: false,
                wire_format: None,
            },
            "jsonl" => Self {
                program: None,
                args: vec!["--jsonl".into()],
                env: BTreeMap::new(),
                inprocess: false,
                wire_format: None,
            },
            "pi-rpc" => Self {
                program: None,
                args: vec!["--mode".into(), "rpc".into()],
                env: BTreeMap::new(),
                inprocess: false,
                wire_format: None,
            },
            // mock 是进程内实现，不是传输：迁移成「无 argv + inprocess」。
            "mock" => Self {
                inprocess: true,
                ..Self::default()
            },
            other => {
                return Err(format!(
                    "unknown chat transport '{other}'; expected one of acp|serve|jsonl|pi-rpc|mock"
                ))
            }
        };
        // 旧字符串里没有 `wire_format`，按迁移期规则补齐（见函数上的对照表）。
        Ok(Self {
            wire_format: infer_legacy_wire_format(launch.program.as_deref(), launch.wire_format),
            ..launch
        })
    }
}

#[cfg(test)]
mod transport_tests {
    use super::rules::{rule_for, TRANSPORT_RULES};
    use super::{ChatLaunch, ChatTransport};

    /// **穷举防线 ①**：每个 `ChatTransport` 变体都必须有规则表项 ——
    /// 否则 `rule_for` panic（`as_str()` 一调用就炸，而不是静默走错传输）。
    ///
    /// 这是表化交付的那份编译期保障的替代品：原来 `match` 漏分支编译报错，
    /// 现在由本用例在测试期等价兜住。
    ///
    /// 变异验证：从 `TRANSPORT_RULES` 删掉任一表项 → 本用例红。
    #[test]
    fn every_transport_variant_has_a_rule() {
        for &t in ChatTransport::ALL {
            let rule = rule_for(t);
            assert_eq!(rule.transport, t);
            assert!(!rule.id.is_empty());
        }
    }

    /// **穷举防线 ②**：表里不能有 `ALL` 之外的重复/遗漏项。
    ///
    /// 只看防线 ① 会让「表里多塞一条重复项」静默通过，而重复项会造成
    /// 优先级歧义（两条都命中时以先出现的为准，无人能解释为什么）。
    ///
    /// 变异验证：往 `TRANSPORT_RULES` 加一条重复的 Serve → 本用例红。
    #[test]
    fn rule_table_has_no_extra_entries() {
        assert_eq!(
            TRANSPORT_RULES.len(),
            ChatTransport::ALL.len(),
            "TRANSPORT_RULES 与 ChatTransport::ALL 必须逐项一一对应"
        );
    }

    /// `as_str()` 必须给出与规则表**同一个** id —— 它是前端展示键与日志
    /// 标识的唯一来源，两个地方讲同一个名字就是两份真相。
    ///
    /// 变异验证：把 `TRANSPORT_IDS` 的某一项写错 → 本用例红。
    #[test]
    fn as_str_agrees_with_the_rule_table() {
        for &t in ChatTransport::ALL {
            assert_eq!(t.as_str(), rule_for(t).id, "{t:?}");
        }
    }

    /// **顺序即优先级**必须被机器钉住：`acp` 判定排在 `serve` 之前，
    /// 否则 `opencode serve acp` 会静默走错传输。
    ///
    /// 这条断言的是语义（谁在前），不是表项顺序本身 —— 后者由
    /// `acp_wins_over_serve` 用真实 argv 端到端验证。
    #[test]
    fn acp_rule_precedes_serve_rule() {
        let acp_at = TRANSPORT_RULES
            .iter()
            .position(|r| r.transport == ChatTransport::Acp)
            .expect("acp rule");
        let serve_at = TRANSPORT_RULES
            .iter()
            .position(|r| r.transport == ChatTransport::Serve)
            .expect("serve rule");
        assert!(acp_at < serve_at, "acp 必须先于 serve 判定");
    }

    fn launch(program: Option<&str>, args: &[&str]) -> ChatLaunch {
        ChatLaunch {
            program: program.map(str::to_string),
            args: args.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    /// 空配置 = 无附加参数 → 默认 ACP（唯一通用协议）。
    #[test]
    fn empty_launch_defaults_to_acp() {
        assert_eq!(ChatLaunch::default().transport(), ChatTransport::Acp);
    }

    #[test]
    fn recognises_acp() {
        assert_eq!(
            launch(Some("opencode"), &["acp"]).transport(),
            ChatTransport::Acp
        );
    }

    #[test]
    fn recognises_serve() {
        assert_eq!(
            launch(Some("opencode"), &["serve"]).transport(),
            ChatTransport::Serve
        );
    }

    #[test]
    fn recognises_jsonl() {
        assert_eq!(launch(None, &["--jsonl"]).transport(), ChatTransport::Jsonl);
        assert_eq!(
            launch(None, &["stream-json"]).transport(),
            ChatTransport::Jsonl
        );
    }

    #[test]
    fn recognises_pi_rpc() {
        assert_eq!(
            launch(None, &["--mode", "rpc"]).transport(),
            ChatTransport::PiRpc
        );
        assert_eq!(launch(None, &["rpc"]).transport(), ChatTransport::PiRpc);
    }

    /// `acp` 优先于 `serve`：两者都是 opencode 的互斥子命令，写了 acp 就是 ACP。
    /// 这条顺序必须锁住 —— 交换判定顺序会让 `opencode serve acp` 静默走错传输。
    #[test]
    fn acp_wins_over_serve() {
        assert_eq!(
            launch(Some("opencode"), &["serve", "acp"]).transport(),
            ChatTransport::Acp
        );
    }

    /// **子串匹配反例**：`--preserve` 含 "serve"，按子串判会错认成 Serve。
    #[test]
    fn does_not_match_substrings() {
        assert_eq!(
            launch(Some("foo"), &["--preserve"]).transport(),
            ChatTransport::Acp
        );
        // `--approval-mode` 含 "acp"；判成 Acp 是默认值，不是子串命中的证据。
        // 真正的反例要挑一个「子串命中会把结果改成非默认值」的：
        // `--observe` 含 "serve" → 子串匹配会误判成 Serve。
        assert_eq!(
            launch(Some("foo"), &["--observe"]).transport(),
            ChatTransport::Acp
        );
    }

    /// `--mode json` 不是 rpc；必须要求完整 token 对。
    #[test]
    fn mode_json_is_not_pi_rpc() {
        assert_eq!(
            launch(Some("pi"), &["--mode", "json"]).transport(),
            ChatTransport::Acp
        );
    }

    /// program 本身也参与识别（`pi-acp` 这类包装器可能把子命令写在程序名里）。
    #[test]
    fn program_token_participates() {
        assert_eq!(
            launch(Some("opencode"), &[]).transport(),
            ChatTransport::Acp
        );
    }

    #[test]
    fn transport_str_round_trips_through_the_recogniser() {
        for (program, args, want) in [
            (Some("opencode"), vec!["acp"], ChatTransport::Acp),
            (Some("opencode"), vec!["serve"], ChatTransport::Serve),
            (None, vec!["--jsonl"], ChatTransport::Jsonl),
            (None, vec!["--mode", "rpc"], ChatTransport::PiRpc),
        ] {
            let got = launch(program, &args).transport();
            assert_eq!(got, want);
            assert_eq!(got.as_str(), want.as_str());
        }
    }
}

#[cfg(test)]
mod migration_tests {
    use super::{ChatLaunch, WireFormat};
    use std::collections::BTreeMap;

    fn parse(json: &str) -> ChatLaunch {
        serde_json::from_str(json).expect("migrate")
    }

    /// R4 迁移矩阵 —— 旧 `config.json` 的六种形态必须无损映射。
    #[test]
    fn legacy_bare_strings_migrate_losslessly() {
        assert_eq!(parse(r#""acp""#), ChatLaunch::default());

        assert_eq!(
            parse(r#""serve""#),
            ChatLaunch {
                program: Some("opencode".into()),
                args: vec!["serve".into()],
                // 旧串没有 wire_format → 按 program(opencode) 迁移出 Ndjson。
                wire_format: Some(WireFormat::Ndjson),
                ..Default::default()
            }
        );
        assert_eq!(parse(r#""serve""#).transport().as_str(), "serve");

        assert_eq!(
            parse(r#""jsonl""#),
            ChatLaunch {
                program: None,
                args: vec!["--jsonl".into()],
                ..Default::default()
            }
        );

        assert_eq!(
            parse(r#""pi-rpc""#),
            ChatLaunch {
                program: None,
                args: vec!["--mode".into(), "rpc".into()],
                ..Default::default()
            }
        );
        assert_eq!(parse(r#""pi-rpc""#).transport().as_str(), "pi-rpc");

        // `mock` 是**进程内实现**，不是传输：迁移成「无 argv + inprocess 声明」。
        // 这与 `"acp"`（无 argv 但要 spawn）必须区分 —— 旧枚举靠变体区分，
        // 新结构体靠 `inprocess` 字段区分。
        assert_eq!(
            parse(r#""mock""#),
            ChatLaunch {
                inprocess: true,
                ..Default::default()
            }
        );
    }

    /// 旧对象形态 `{"transport":"acp","args":[…]}` —— 用户亲手配过 ACP 子命令的形态。
    #[test]
    fn legacy_object_form_migrates_to_args() {
        let got = parse(r#"{"transport":"acp","args":["--acp","--verbose"]}"#);
        assert_eq!(got.program, None);
        assert_eq!(got.args, vec!["--acp", "--verbose"]);
        assert_eq!(got.transport().as_str(), "acp");
    }

    /// 旧对象形态的参数要**追加**在 `transport` 映射出的参数之后，不覆盖。
    #[test]
    fn legacy_object_form_appends_transport_args() {
        let got = parse(r#"{"transport":"pi-rpc","args":["--provider","x"]}"#);
        assert_eq!(got.args, vec!["--mode", "rpc", "--provider", "x"]);
    }

    /// **未知字符串必须报错**（D1）。旧实现静默当 ACP，会 spawn 出错误进程。
    #[test]
    fn unknown_transport_string_is_rejected() {
        let err = serde_json::from_str::<ChatLaunch>(r#""acpp""#).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("acpp"),
            "error must name the offending value: {msg}"
        );
    }

    #[test]
    fn non_string_non_object_is_rejected() {
        assert!(serde_json::from_str::<ChatLaunch>("42").is_err());
        assert!(serde_json::from_str::<ChatLaunch>("[1]").is_err());
    }

    /// 新格式往返：program + args + env 三项都要保住。
    #[test]
    fn round_trips_new_form() {
        let mut env = BTreeMap::new();
        env.insert("KEY".to_string(), "value".to_string());
        let original = ChatLaunch {
            program: Some("opencode".into()),
            args: vec!["acp".into()],
            env,
            ..Default::default()
        };
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(serde_json::from_str::<ChatLaunch>(&json).unwrap(), original);
    }

    /// **序列化往返不变量**：每个合法的 `ChatLaunch` 都必须能被自己的输出读回。
    ///
    /// 这条不变量比“能读旧配置”更重要 —— 读不回来意味着「用户保存一次就永久损坏」：
    /// `skip_serializing_if` 会让 `program: None` 不写键，所以 `{}` 与
    /// `{"args":[…]}` 是**我们自己写出的**合法形态，不是旧格式。
    ///
    /// 变异验证：把判别式改回「有 `program` 键 → 当前格式」→ `program: None`
    /// 的两个用例（`args_only` / `empty`）必红。
    #[test]
    fn every_launch_round_trips_through_its_own_output() {
        let cases = [
            ("empty", ChatLaunch::default()),
            (
                "args_only",
                ChatLaunch {
                    args: vec!["--mode".into(), "rpc".into()],
                    ..Default::default()
                },
            ),
            (
                "env_only",
                ChatLaunch {
                    env: BTreeMap::from([("K".to_string(), "v".to_string())]),
                    ..Default::default()
                },
            ),
            (
                "program_only",
                ChatLaunch {
                    program: Some("gemini".into()),
                    ..Default::default()
                },
            ),
            (
                "all_set",
                ChatLaunch {
                    program: Some("opencode".into()),
                    args: vec!["serve".into()],
                    env: BTreeMap::from([("A".to_string(), "1".to_string())]),
                    ..Default::default()
                },
            ),
            (
                "inprocess",
                ChatLaunch {
                    inprocess: true,
                    ..Default::default()
                },
            ),
        ];
        for (name, original) in cases {
            let json = serde_json::to_string(&original).expect("serialize");
            let back = serde_json::from_str::<ChatLaunch>(&json)
                .unwrap_or_else(|e| panic!("{name}: own output {json} is unreadable: {e}"));
            assert_eq!(back, original, "{name}: {json}");
        }
    }

    /// 内置定义全表往返 —— 它们是真实写在 `builtin_configs()` 里的形状，
    /// 不做单独列举就不会有人想到 `pi` / `mockAgent` 属于“无 program”那一类。
    #[test]
    fn builtin_launch_shapes_round_trip() {
        for cfg in crate::agent::builtin::builtin_configs() {
            let Some(launch) = cfg.chat else { continue };
            let json = serde_json::to_string(&launch).expect("serialize");
            let back = serde_json::from_str::<ChatLaunch>(&json)
                .unwrap_or_else(|e| panic!("{}: {json} unreadable: {e}", cfg.id));
            assert_eq!(back, launch, "{}: {json}", cfg.id);
        }
    }

    /// 字段类型错误必须报错，不能被“缺省取默认”静默吞掉。
    #[test]
    fn wrong_field_type_is_rejected() {
        let err = serde_json::from_str::<ChatLaunch>(r#"{"program":42}"#).unwrap_err();
        assert!(err.to_string().contains("chat.program"), "{err}");
    }

    /// 空 `ChatLaunch` 序列化为 `{}` —— 不制造无意义的键。
    #[test]
    fn empty_launch_serialises_to_empty_object() {
        assert_eq!(serde_json::to_string(&ChatLaunch::default()).unwrap(), "{}");
    }

    /// **迁移不得作用于「我们自己的输出」** —— 这三条形态是 `Serialize` 的真实产物。
    #[test]
    fn wire_format_migration_does_not_touch_current_form() {
        for json in [
            r#"{"program":"opencode","args":["serve"]}"#,
            r#"{"program":"opencode","args":["acp"]}"#,
            r#"{"program":"opencode"}"#,
        ] {
            let got = serde_json::from_str::<ChatLaunch>(json).expect("read");
            assert_eq!(got.wire_format, None, "{json}");
        }
    }

    /// **旧格式（没有 `wire_format` 键）按可执行文件补 NDJSON。**
    ///
    /// 这是老用户的 `opencode acp` 升级后不失效的唯一保障：没有它就向期待
    /// NDJSON 的服务发 `Content-Length` 帧 —— 握手无响应、无报错、UI 永远转圈。
    ///
    /// 两条前提，缺一不可：
    /// ① 只作用于**真正的旧形态**（裸串 / `{"transport":…}`）。当前对象形态
    ///    是我们自己的序列化输出，对它推断会让「读回自己写的」凭空多出一个字段
    ///    —— 与当初 ChatStart→ChatLaunch 迁移踩过的判别式事故同型。
    /// ② 结果必须被持久化（`Serialize` 会写出它），这样用户看得见、改得动。
    ///
    /// 变异验证：删掉 `from_legacy_str` / `from_legacy_object` 里的
    /// `infer_legacy_wire_format` 调用 → 本用例红。
    #[test]
    fn legacy_forms_infer_wire_format_from_the_program() {
        // 旧对象形态 —— 受影响最广的一类（`transport` 键独占，绝不会与我们
        // 自己的输出混淆，这正是判别式选它的理由）。
        let got = parse(r#"{"transport":"acp","args":["--x"]}"#);
        assert_eq!(got.wire_format, None, "program 为空时不推断");

        // 旧字符串形态：`"serve"` 迁移出 `program: Some("opencode")`。
        assert_eq!(parse(r#""serve""#).wire_format, Some(WireFormat::Ndjson));
        // `"acp"` 的 program 是 None → 保持默认。
        assert_eq!(parse(r#""acp""#).wire_format, None);
        assert_eq!(parse(r#""jsonl""#).wire_format, None);
        assert_eq!(parse(r#""pi-rpc""#).wire_format, None);
    }

    /// **显式值永远优先** —— 迁移只能补缺失，不能改写用户的选择。
    ///
    /// 必须走**真正的迁移路径**（旧串 / `transport` 键）：当前形态不参与迁移，
    /// 用它测这条规则等于测了个空 —— 变异（删掉 `explicit.is_some()` 短路）
    /// 说明它曾经完全抓不住。
    ///
    /// 用户明确写了 `content-length` 时，即使程序名是 opencode 也要尊重它：
    /// 他可能在测一个新版本，或者那个二进制只是恰好叫这个名字。
    #[test]
    fn explicit_wire_format_is_never_overridden() {
        // 旧对象形态：program 经 `transport:serve` 推出 opencode，本会推断成
        // Ndjson —— 但显式值必须赢。
        let got = parse(r#"{"transport":"serve","wire_format":"content-length"}"#);
        assert_eq!(got.program.as_deref(), Some("opencode"));
        assert_eq!(got.wire_format, Some(WireFormat::ContentLength));
    }

    /// 迁移补出来的值必须**持久化** —— 否则用户永远看不见它，也就改不动。
    ///
    /// 这是「迁移期推断」区别于「运行时推断」的关键：前者结果落盘。
    #[test]
    fn inferred_wire_format_survives_a_round_trip() {
        // 旧串 `"serve"` → program=opencode → Ndjson。
        let got = parse(r#""serve""#);
        let json = serde_json::to_string(&got).expect("serialize");
        assert!(
            json.contains("wire_format"),
            "迁移结果必须落盘（用户要看得见、改得动）：{json}"
        );
        assert_eq!(got.wire_format, Some(WireFormat::Ndjson));
    }

    /// 对象里缺 `env` 字段时默认空 map（旧配置没有这个字段）。
    #[test]
    fn missing_env_defaults_to_empty() {
        let got = parse(r#"{"program":"pi","args":["--mode","rpc"]}"#);
        assert!(got.env.is_empty());
    }

    /// `program` 显式写 null 等价于省略。
    #[test]
    fn explicit_null_program_is_none() {
        let got = parse(r#"{"program":null,"args":["acp"]}"#);
        assert_eq!(got.program, None);
        assert_eq!(got.args, vec!["acp"]);
    }
}

#[cfg(test)]
mod helper_tests {
    use super::ChatLaunch;

    #[test]
    fn blank_program_is_filtered_out() {
        let l = ChatLaunch {
            program: Some("   ".into()),
            ..Default::default()
        };
        assert_eq!(l.program_filtered(), None);
    }

    #[test]
    fn args_filter_drops_empty_strings() {
        let l = ChatLaunch {
            args: vec!["a".into(), String::new(), "b".into()],
            ..Default::default()
        };
        let got: Vec<&str> = l.args_filtered().map(String::as_str).collect();
        assert_eq!(got, vec!["a", "b"]);
    }
}
