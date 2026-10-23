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
    /// 稳定标识符（日志/错误信息用；**不是**持久化字段）。
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Acp => "acp",
            Self::Serve => "serve",
            Self::Jsonl => "jsonl",
            Self::PiRpc => "pi-rpc",
        }
    }
}

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
}

/// `skip_serializing_if` 助手（`bool` 没有现成的）。
const fn is_false(value: &bool) -> bool {
    !*value
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

        let has = |wanted: &str| tokens.contains(&wanted);

        if has("acp") {
            return ChatTransport::Acp;
        }
        if has("serve") {
            return ChatTransport::Serve;
        }
        if has("--jsonl") || has("stream-json") {
            return ChatTransport::Jsonl;
        }
        // `--mode rpc`（相邻两 token）或裸 `rpc`。
        let mode_rpc = tokens.windows(2).any(|w| w == ["--mode", "rpc"]);
        if mode_rpc || has("rpc") {
            return ChatTransport::PiRpc;
        }
        // 默认 ACP：它是唯一通用协议，也是「没写特殊子命令的 CLI」最可能的行为。
        ChatTransport::Acp
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
        Ok(Self {
            program: chat_field(obj, "program")?,
            args: chat_field(obj, "args")?,
            env: chat_field(obj, "env")?,
            inprocess: chat_field(obj, "inprocess")?,
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
        Ok(launch)
    }

    /// 裸字符串形态的迁移映射（`Deserialize` 与 `RawAgentConfig` 共用）。
    pub(crate) fn from_legacy_str(s: &str) -> Result<Self, String> {
        Ok(match s {
            "acp" => Self::default(),
            "serve" => Self {
                program: Some("opencode".into()),
                args: vec!["serve".into()],
                env: BTreeMap::new(),
                inprocess: false,
            },
            "jsonl" => Self {
                program: None,
                args: vec!["--jsonl".into()],
                env: BTreeMap::new(),
                inprocess: false,
            },
            "pi-rpc" => Self {
                program: None,
                args: vec!["--mode".into(), "rpc".into()],
                env: BTreeMap::new(),
                inprocess: false,
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
        })
    }
}

#[cfg(test)]
mod transport_tests {
    use super::{ChatLaunch, ChatTransport};

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
    use super::ChatLaunch;
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
