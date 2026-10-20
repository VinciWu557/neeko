//! ACP **session config options** —— 解析与定位。
//!
//! # 协议背景
//!
//! ACP 的模型选择不是独立字段，而是 `session/new` 响应里 `configOptions` 数组中的
//! 一项，靠 `category` 区分用途（见 `research/acp-model-selection.md`）：
//!
//! | category | 语义 |
//! | --- | --- |
//! | `model` | 模型选择器 |
//! | `model_config` | 模型相关配置参数（上下文大小、速度/质量取舍） |
//! | `thought_level` | 推理档位（`model_config` 的历史特例） |
//! | `mode` | 会话模式（plan/build） |
//!
//! # 为什么按 `category` 而不是 `id` 定位
//!
//! 规范原文（`SessionConfigOptionCategory`）：
//!
//! > It MUST NOT be required for correctness. Clients MUST handle missing or
//! > unknown categories gracefully.
//!
//! 实测 Claude / Codex / OpenCode / Qwen 的 `id` 碰巧都叫 `"model"`，但这是**惯例
//! 而非规范**；同一类能力的命名并不统一（Codex 的 `reasoning_effort` vs OpenCode
//! 的 `effort`）。所以定位顺序是 `category` → `id` 兜底 → 放弃，三条都要能跑通。
//!
//! # 本模块是纯函数
//!
//! 不持有会话、不发 IO。解析与请求体构造都可以脱离运行时直接断言（见文件末测试）。

use serde::{Deserialize, Serialize};

/// `category` 取值：模型选择器。
pub const CATEGORY_MODEL: &str = "model";
/// `category` 取值：模型相关配置参数。
pub const CATEGORY_MODEL_CONFIG: &str = "model_config";
/// `category` 取值：推理档位（`model_config` 的历史特例，保留向后兼容）。
pub const CATEGORY_THOUGHT_LEVEL: &str = "thought_level";

/// 规范里的惯例 `id`，仅在 `category` 缺失时作为兜底判据；
/// 也是 `session/set_config_option` 的 `configId`（各家实测都用它）。
const LEGACY_MODEL_ID: &str = "model";

/// 一个 select 选项的取值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionConfigSelectOption {
    /// 值标识。对模型项而言就是模型 ID —— **不同 agent 语义不同**：
    /// OpenCode 是 `provider/model` 复合串，Claude 可能是 `default` 这类别名。
    /// 本模块一律当作不透明字符串传递，不解析。
    pub value: String,
    /// 展示名。
    pub name: String,
    /// 可选说明。
    #[serde(default)]
    pub description: Option<String>,
}

/// 分组形态的选项（schema 允许扁平数组或分组数组，同一数组中不可混用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionConfigSelectGroup {
    /// 分组标识。
    pub group: String,
    /// 分组展示名。
    pub name: String,
    /// 该组内的选项。
    pub options: Vec<SessionConfigSelectOption>,
}

/// `options` 的两种线上形态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SessionConfigSelectOptions {
    /// 扁平列表。
    Ungrouped(Vec<SessionConfigSelectOption>),
    /// 分组列表。
    Grouped(Vec<SessionConfigSelectGroup>),
}

/// `currentValue` 的两种形态：select 是字符串，boolean 是布尔。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SessionConfigValue {
    /// select 形态的值标识。
    Text(String),
    /// boolean 形态的值。
    Flag(bool),
}

impl SessionConfigValue {
    /// 取文本值（boolean 返回 `None`）。
    #[must_use]
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(value) => Some(value),
            Self::Flag(_) => None,
        }
    }

    /// 取布尔值（select 返回 `None`）。
    #[must_use]
    pub const fn as_flag(&self) -> Option<bool> {
        match self {
            Self::Text(_) => None,
            Self::Flag(value) => Some(*value),
        }
    }
}

/// 一个会话配置项（`SessionConfigOption`）。
///
/// 判别器 `type` 在 select 形态下**可以缺省**（缺省按 value_id 解析），因此这里用
/// `Option<String>` 而不是枚举——用枚举会在缺省时整条解析失败，进而丢掉整个列表。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionConfigOption {
    /// 配置项标识（`session/set_config_option` 的 `configId`）。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// 可选说明。
    #[serde(default)]
    pub description: Option<String>,
    /// 语义分类。**可选** —— 规范明确说它不用于正确性判定。
    #[serde(default)]
    pub category: Option<String>,
    /// `"select"` / `"boolean"`；缺省视为 select。
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    /// 当前值：select 是字符串，boolean 是布尔。
    ///
    /// 线上字段名是 **camelCase**（`currentValue`）。漏了 `rename` 的后果不是编译
    /// 错误，而是**静默**：真实 agent 的响应里该字段永远解析不到 → `current_model()`
    /// 恒为 `None` → 「已是当前值就不重发」永不生效，每次切模型都多一次冗余往返。
    #[serde(default, rename = "currentValue")]
    pub current_value: Option<SessionConfigValue>,
    /// select 形态的选项集合；boolean 形态没有。
    #[serde(default)]
    pub options: Option<SessionConfigSelectOptions>,
    /// 扩展字段（各家私有）。
    #[serde(default)]
    pub _meta: Option<serde_json::Value>,
}

impl SessionConfigOption {
    /// 该配置项的全部可选值（boolean 形态返回空）。
    #[must_use]
    pub fn select_options(&self) -> Vec<SessionConfigSelectOption> {
        match self.options.as_ref() {
            Some(SessionConfigSelectOptions::Ungrouped(items)) => items.clone(),
            Some(SessionConfigSelectOptions::Grouped(groups)) => groups
                .iter()
                .flat_map(|group| group.options.iter().cloned())
                .collect(),
            None => Vec::new(),
        }
    }

    /// 当前选中的值（select 形态）。
    #[must_use]
    pub fn current(&self) -> Option<&str> {
        self.current_value
            .as_ref()
            .and_then(SessionConfigValue::as_text)
    }
}

/// 解析 `session/new`（或 `set_config_option`）响应里的 `configOptions`。
///
/// **不返回 Result**：解析失败要降级成空列表，而不是让会话建立失败。老 agent
/// （Gemini / Kimi 实测）根本不发这个字段，缺失是正常情况。
#[must_use]
pub fn parse_config_options(response: &serde_json::Value) -> Vec<SessionConfigOption> {
    response
        .get("configOptions")
        .and_then(|value| serde_json::from_value::<Vec<SessionConfigOption>>(value.clone()).ok())
        .unwrap_or_default()
}

/// 按 `category` 找配置项。
#[must_use]
pub fn find_by_category<'a>(
    options: &'a [SessionConfigOption],
    category: &str,
) -> Option<&'a SessionConfigOption> {
    options
        .iter()
        .find(|option| option.category.as_deref() == Some(category))
}

/// 定位模型选择器：先按 `category`，再按惯例 `id` 兜底。
///
/// 返回 `None` 表示该 agent 不支持模型选择 —— 调用方应静默降级，**不要报错**。
#[must_use]
pub fn find_model_option(options: &[SessionConfigOption]) -> Option<&SessionConfigOption> {
    find_by_category(options, CATEGORY_MODEL)
        .or_else(|| options.iter().find(|option| option.id == LEGACY_MODEL_ID))
}

/// 模型项的 `configId` —— 写请求需要的**真实**标识。
///
/// 与 [`find_model_option`] 同源：读和写必须用同一套定位逻辑，否则会出现
/// 「列得出来但切不动」—— 一个 `category: "model"` 但 `id` 不叫 `"model"` 的
/// agent 正是这种情形。硬编码 `"model"` 就踩这个坑。
#[must_use]
pub fn model_config_id(options: &[SessionConfigOption]) -> Option<&str> {
    find_model_option(options).map(|option| option.id.as_str())
}

/// 会话配置项的可变状态，读侧与写侧共享。
///
/// # 为什么需要它
///
/// `configOptions` 不是一次性事件载荷 —— 它是**会话状态**：
///
/// - 读：`session/new` 响应解析出初值；`config_option_update` 通知整体替换；
/// - 写：`set_config_option` 需要从当前状态里取**真实 `configId`**，并据此判断
///   「值是否已经等于目标」以避免无意义的往返。
///
/// 只把它塞进 `SessionStart` 事件然后丢弃，会让写侧只能靠猜（旧实现硬编码
/// `"model"`），而对 `id` 不叫 `"model"` 的 agent 就切不动。
#[derive(Debug, Default)]
pub struct ConfigOptionsState {
    options: std::sync::Mutex<Vec<SessionConfigOption>>,
}

impl ConfigOptionsState {
    /// 用一组新选项初始化。
    #[must_use]
    pub const fn new(options: Vec<SessionConfigOption>) -> Self {
        Self {
            options: std::sync::Mutex::new(options),
        }
    }

    /// 当前快照（克隆，避免锁外持有引用）。
    #[must_use]
    pub fn snapshot(&self) -> Vec<SessionConfigOption> {
        self.options
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// 整体替换。
    ///
    /// 协议规定 `set_config_option` 的响应与 `config_option_update` 通知都携带
    /// **全量**配置 —— 换模型可能连带改变 `thought_level` 的可选项，局部合并会
    /// 留下与真实状态不符的陈旧项。
    pub fn replace(&self, options: Vec<SessionConfigOption>) {
        if let Ok(mut guard) = self.options.lock() {
            *guard = options;
        }
    }

    /// 「切到目标模型」需要的帧；已经是要切的值时返回空。
    ///
    /// # 为什么收成一个函数
    ///
    /// 换模型有两个入口需要「按语义定位 `configId`」：**新会话首轮**（`create`）与
    /// **后续轮次**（`Turn`）。它们共享同一件事：从当前状态取真实 `configId`、判断是否
    /// 已经是要切的值、构造请求帧。分散实现必然漂移 —— 实测漏过两处（硬编码 `"model"`、
    /// 以及 `create` 路径整条缺失）。
    ///
    /// popover 里的 `SetConfigOption` 不在此列：它的 `configId` 由前端从渲染时那份
    /// `configOptions` 直接给出，已经是正确的真实标识。
    ///
    /// # 一次快照
    ///
    /// `configId` 与「当前值」必须来自**同一版本**的状态。分两次加锁取，中间若被
    /// 事件泵 `replace`（agent 主动换模型），会拿旧 configId 配新当前值做判断。
    #[must_use]
    pub fn switch_model_frames(&self, rpc_id: i64, session_id: &str, target: &str) -> ModelSwitch {
        let options = self.snapshot();

        // 判据是「有没有模型**项**」，不是「有没有当前**值**」。
        //
        // 两者是不同的东西：`current_model_from_config` 在没有模型项、以及有模型项但
        // `currentValue` 缺失时都返回 `None`。用它当判据会把后者误判成「不支持」，
        // 表现为「有下拉、点了没反应」—— 而 `currentValue` 缺失是正常情况（老 agent、
        // 或初次握手尚未确定）。
        let Some(option) = find_model_option(&options) else {
            return ModelSwitch::Unsupported;
        };

        // 只在「当前值明确等于目标」时跳过。当前值缺失 → 必须发，因为我们无法
        // 断言它已经是目标模型。
        if option.current() == Some(target) {
            return ModelSwitch::AlreadySet;
        }

        ModelSwitch::Frame(set_config_option_request(
            rpc_id,
            session_id,
            &option.id,
            &SessionConfigValue::Text(target.to_string()),
        ))
    }
}

/// [`ConfigOptionsState::switch_model_frames`] 的结果。
///
/// 三态而不是 `Option`：调用方需要区分「已是要切的值」（正常，无需动作）与
/// 「该 agent 不支持」（也是正常，但语义不同），混在一起会让日志无法排查。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelSwitch {
    /// 需要发这一帧。
    Frame(serde_json::Value),
    /// 目标值已经是当前值，无需动作。
    AlreadySet,
    /// 该 agent 没有模型选择器，静默降级。
    Unsupported,
}

impl ModelSwitch {
    /// 取要发的帧（`AlreadySet` / `Unsupported` → `None`）。
    #[must_use]
    pub fn into_frame(self) -> Option<serde_json::Value> {
        match self {
            Self::Frame(frame) => Some(frame),
            Self::AlreadySet | Self::Unsupported => None,
        }
    }
}

/// 当前模型 ID。
#[must_use]
pub fn current_model_from_config(options: &[SessionConfigOption]) -> Option<String> {
    find_model_option(options)
        .and_then(SessionConfigOption::current)
        .map(str::to_string)
}

/// 构造 `session/set_config_option` 请求体。
///
/// `value` 为文本时按 value_id 形态发送（`type` 缺省即此语义）；为布尔时必须显式带
/// `type: "boolean"` —— 否则 agent 会把 `true` 当成字符串。
#[must_use]
pub fn set_config_option_request(
    rpc_id: i64,
    session_id: &str,
    config_id: &str,
    value: &SessionConfigValue,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "sessionId": session_id,
        "configId": config_id,
    });

    match value {
        SessionConfigValue::Text(text) => {
            params["value"] = serde_json::json!(text);
        }
        SessionConfigValue::Flag(flag) => {
            params["type"] = serde_json::json!("boolean");
            params["value"] = serde_json::json!(flag);
        }
    }

    serde_json::json!({
        "jsonrpc": "2.0",
        "id": rpc_id,
        "method": "session/set_config_option",
        "params": params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn select_option(category: Option<&str>, id: &str) -> serde_json::Value {
        json!({
            "id": id,
            "name": "Model",
            "category": category,
            "type": "select",
            "currentValue": "a",
            "options": [
                { "value": "a", "name": "Model A" },
                { "value": "b", "name": "Model B", "description": "faster" }
            ]
        })
    }

    // ── category 优先于 id ────────────────────────────────────────────────

    /// 核心判据：`category` 说它是模型就是模型，哪怕 `id` 完全不叫 "model"。
    #[test]
    fn finds_model_by_category_even_when_id_differs() {
        let options = vec![SessionConfigOption {
            id: "primary-model-selector".into(),
            name: "Model".into(),
            description: None,
            category: Some(CATEGORY_MODEL.into()),
            kind: Some("select".into()),
            current_value: Some(SessionConfigValue::Text("a".into())),
            options: Some(SessionConfigSelectOptions::Ungrouped(vec![
                SessionConfigSelectOption {
                    value: "a".into(),
                    name: "Model A".into(),
                    description: None,
                },
            ])),
            _meta: None,
        }];

        let found = find_model_option(&options).expect("category should win");
        assert_eq!(found.id, "primary-model-selector");
    }

    /// `category` 缺失时按惯例 `id` 兜底（老 agent 可能不填 category）。
    #[test]
    fn falls_back_to_conventional_id_when_category_missing() {
        let options: Vec<SessionConfigOption> =
            serde_json::from_value(json!([select_option(None, "model")])).unwrap();
        assert!(find_model_option(&options).is_some());
    }

    /// 两者皆无 → 不支持，不是错误。
    #[test]
    fn returns_none_when_neither_category_nor_id_matches() {
        let options: Vec<SessionConfigOption> =
            serde_json::from_value(json!([select_option(Some("mode"), "mode")])).unwrap();
        assert!(find_model_option(&options).is_none());
        assert!(current_model_from_config(&options).is_none());
    }

    // ── 分组选项 ─────────────────────────────────────────────────────────

    /// 分组形态必须展平，否则只拿到空列表（schema 允许两种形态）。
    #[test]
    fn flattens_grouped_options() {
        let response = json!({
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": "b",
                "options": [
                    { "group": "g1", "name": "Group 1", "options": [
                        { "value": "a", "name": "Model A" }
                    ]},
                    { "group": "g2", "name": "Group 2", "options": [
                        { "value": "b", "name": "Model B" }
                    ]}
                ]
            }]
        });

        let options = parse_config_options(&response);
        // 分组展平由 `select_options()` 负责；前端派生的模型列表依赖它。
        let flattened = find_model_option(&options)
            .expect("model option")
            .select_options();
        assert_eq!(flattened.len(), 2);
        assert_eq!(flattened[0].value, "a");
        assert_eq!(flattened[1].value, "b");
    }

    // ── 缺失与容错 ───────────────────────────────────────────────────────

    /// 老 agent 不发这个字段 —— 必须降级为空，不能 panic 或中断会话。
    #[test]
    fn missing_config_options_yields_empty_list() {
        assert!(parse_config_options(&json!({ "sessionId": "s1" })).is_empty());
        assert!(parse_config_options(&json!({})).is_empty());
        assert!(parse_config_options(&json!(null)).is_empty());
    }

    /// 结构不合法时同样降级为空，而不是让整个会话建立失败。
    #[test]
    fn malformed_config_options_yield_empty_list() {
        let response = json!({ "configOptions": "not-an-array" });
        assert!(parse_config_options(&response).is_empty());
    }

    /// select 形态的 `type` 可以缺省（协议规定缺省按 value_id 解析）。
    #[test]
    fn tolerates_missing_type_field() {
        let response = json!({
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "category": "model",
                "currentValue": "a",
                "options": [{ "value": "a", "name": "A" }]
            }]
        });
        let options = parse_config_options(&response);
        assert_eq!(
            find_model_option(&options)
                .expect("model option")
                .select_options()
                .len(),
            1
        );
    }

    // ── 会话状态（读写共享）───────────────────────────────────────────────

    /// 写请求的 `configId` 必须来自状态里的模型项，不能是字面量。
    #[test]
    fn state_reports_the_real_model_config_id() {
        let state = ConfigOptionsState::new(vec![SessionConfigOption {
            id: "primary-model-selector".into(),
            name: "Model".into(),
            description: None,
            category: Some(CATEGORY_MODEL.into()),
            kind: Some("select".into()),
            current_value: Some(SessionConfigValue::Text("gpt-5".into())),
            options: None,
            _meta: None,
        }]);

        // 通过**行为**验证，而不是内部查询方法 —— 测试要走生产路径。
        let frame = state
            .switch_model_frames(1, "s1", "claude-sonnet")
            .into_frame()
            .expect("should emit a frame");
        assert_eq!(frame["params"]["configId"], "primary-model-selector");
    }

    /// 没有模型项 → `Unsupported`，调用方据此静默降级。
    #[test]
    fn state_reports_unsupported_without_a_model_option() {
        let state = ConfigOptionsState::default();
        assert_eq!(
            state.switch_model_frames(1, "s1", "x"),
            ModelSwitch::Unsupported
        );
    }

    /// `replace` 是整体替换（协议语义），不是合并。
    #[test]
    fn state_replace_is_whole_value_not_a_merge() {
        let state = ConfigOptionsState::new(vec![SessionConfigOption {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: Some(CATEGORY_MODEL.into()),
            kind: Some("select".into()),
            current_value: Some(SessionConfigValue::Text("a".into())),
            options: None,
            _meta: None,
        }]);
        // 当前是 "a" → 切到 "a" 无需发帧
        assert_eq!(
            state.switch_model_frames(1, "s1", "a"),
            ModelSwitch::AlreadySet
        );

        // 新状态只含 thought_level，模型项消失 → 整体替换后为 Unsupported。
        // 局部合并会留下旧的模型项，"a" 仍是当前值，这里就会误判成 AlreadySet。
        state.replace(vec![SessionConfigOption {
            id: "effort".into(),
            name: "Effort".into(),
            description: None,
            category: Some(CATEGORY_THOUGHT_LEVEL.into()),
            kind: Some("select".into()),
            current_value: Some(SessionConfigValue::Text("high".into())),
            options: None,
            _meta: None,
        }]);
        assert_eq!(
            state.switch_model_frames(1, "s1", "a"),
            ModelSwitch::Unsupported
        );
        assert_eq!(state.snapshot().len(), 1);
    }

    // ── 线上字段名（camelCase）─────────────────────────────────────────────

    /// `currentValue` 是 camelCase —— 漏 `rename` 会静默丢掉当前值。
    ///
    /// 这条用**真实线上形状**（camelCase）构造，而不是用 Rust 字段名。之前所有测试
    /// 都用 `SessionConfigValue::Text(..)` 直接构造结构体，绕过了反序列化，所以这个
    /// 缺陷一直没被发现。
    #[test]
    fn parses_camel_case_wire_fields() {
        let response = json!({
            "configOptions": [{
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": "claude-sonnet",
                "options": [{ "value": "claude-sonnet", "name": "Claude Sonnet" }]
            }]
        });

        let options = parse_config_options(&response);
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].current(), Some("claude-sonnet"));
        assert_eq!(options[0].kind.as_deref(), Some("select"));
    }

    /// boolean 形态的 `currentValue` 同样是 camelCase。
    #[test]
    fn parses_camel_case_boolean_value() {
        let response = json!({
            "configOptions": [{
                "id": "fast_mode",
                "name": "Fast mode",
                "category": "model_config",
                "type": "boolean",
                "currentValue": true
            }]
        });

        let options = parse_config_options(&response);
        assert_eq!(
            options[0]
                .current_value
                .as_ref()
                .and_then(SessionConfigValue::as_flag),
            Some(true)
        );
    }

    // ── switch_model_frames：三处入口共用的判定 ────────────────────────────

    #[test]
    fn switch_model_emits_a_frame_when_the_value_differs() {
        let configs = ConfigOptionsState::new(vec![SessionConfigOption {
            id: "primary-model-selector".into(),
            name: "Model".into(),
            description: None,
            category: Some(CATEGORY_MODEL.into()),
            kind: Some("select".into()),
            current_value: Some(SessionConfigValue::Text("gpt-5".into())),
            options: None,
            _meta: None,
        }]);

        let switch = configs.switch_model_frames(1, "s1", "claude-sonnet");
        let frame = switch.into_frame().expect("should emit a frame");
        assert_eq!(frame["method"], "session/set_config_option");
        // 真实 configId，不是字面量 "model"
        assert_eq!(frame["params"]["configId"], "primary-model-selector");
        assert_eq!(frame["params"]["value"], "claude-sonnet");
    }

    /// 目标值已是当前值 → 不发帧（避免 agent 把冗余 set 当成真实变更）。
    #[test]
    fn switch_model_skips_when_already_set() {
        let configs = ConfigOptionsState::new(vec![SessionConfigOption {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: Some(CATEGORY_MODEL.into()),
            kind: Some("select".into()),
            current_value: Some(SessionConfigValue::Text("claude-sonnet".into())),
            options: None,
            _meta: None,
        }]);

        assert_eq!(
            configs.switch_model_frames(1, "s1", "claude-sonnet"),
            ModelSwitch::AlreadySet
        );
        assert!(configs
            .switch_model_frames(1, "s1", "claude-sonnet")
            .into_frame()
            .is_none());
    }

    /// 没有模型项 → Unsupported，与 AlreadySet 区分（日志语义不同）。
    #[test]
    fn switch_model_reports_unsupported_without_a_model_option() {
        let configs = ConfigOptionsState::default();
        assert_eq!(
            configs.switch_model_frames(1, "s1", "x"),
            ModelSwitch::Unsupported
        );
    }

    /// 模型项存在但 `currentValue` 缺失 → 仍应能切换。
    ///
    /// `current_model_from_config` 在没有模型项、以及有模型项但当前值缺失时都返回
    /// `None`。用它判定「不支持」会把后者误判 —— 表现为「有下拉、点了没反应」。
    #[test]
    fn switch_model_works_when_current_value_is_missing() {
        let configs = ConfigOptionsState::new(vec![SessionConfigOption {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: Some(CATEGORY_MODEL.into()),
            kind: Some("select".into()),
            // 老 agent / 初次握手时可能不返回当前值
            current_value: None,
            options: Some(SessionConfigSelectOptions::Ungrouped(vec![
                SessionConfigSelectOption {
                    value: "claude-sonnet".into(),
                    name: "Claude Sonnet".into(),
                    description: None,
                },
            ])),
            _meta: None,
        }]);

        let switch = configs.switch_model_frames(1, "s1", "claude-sonnet");
        assert!(
            switch.into_frame().is_some(),
            "模型项存在时即使当前值缺失，也必须能发出切换帧"
        );
    }

    /// 序列化输出的字段名必须与前端镜像一致。
    ///
    /// `#[serde(rename = "currentValue")]` 同时作用于**读和写** —— 所以后端发出的
    /// JSON 是 `currentValue`，前端接口也必须用 `currentValue`。两边不一致时
    /// TypeScript 不会报错（各自独立声明），运行时字段为 `undefined`。
    #[test]
    fn serializes_camel_case_wire_fields() {
        let option = SessionConfigOption {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: Some(CATEGORY_MODEL.into()),
            kind: Some("select".into()),
            current_value: Some(SessionConfigValue::Text("a".into())),
            options: None,
            _meta: None,
        };

        let json = serde_json::to_value(&option).expect("serialize");
        assert!(
            json.get("currentValue").is_some(),
            "wire name must be camelCase"
        );
        assert!(json.get("current_value").is_none());
        assert!(json.get("type").is_some());
    }

    // ── 请求体 ───────────────────────────────────────────────────────────

    #[test]
    fn builds_text_set_config_option_request() {
        let body = set_config_option_request(
            7,
            "sess_1",
            "model",
            &SessionConfigValue::Text("claude-sonnet".into()),
        );
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(body["id"], 7);
        assert_eq!(body["method"], "session/set_config_option");
        assert_eq!(body["params"]["sessionId"], "sess_1");
        assert_eq!(body["params"]["configId"], "model");
        assert_eq!(body["params"]["value"], "claude-sonnet");
        // select 形态不带 type 判别器
        assert!(body["params"].get("type").is_none());
    }

    /// boolean 必须显式带 `type`，否则 agent 会把布尔当字符串处理。
    #[test]
    fn builds_boolean_set_config_option_request_with_discriminator() {
        let body =
            set_config_option_request(8, "sess_1", "fast_mode", &SessionConfigValue::Flag(true));
        assert_eq!(body["params"]["type"], "boolean");
        assert_eq!(body["params"]["value"], true);
    }
}
