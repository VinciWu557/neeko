//! 会话配置项（session config options）—— **协议无关**的数据契约与状态机。
//!
//! # 为什么单独成文件
//!
//! 这套结构原本住在 `acp_config.rs`，但 ACP 只是**第一个**用到它的传输。
//! 「会话里有哪些配置项、当前选中哪个、怎么按语义定位」是**跨传输**的概念：
//!
//! | 传输 | 配置项来源 |
//! | --- | --- |
//! | ACP | `session/new` 响应的 `configOptions` 字段 |
//! | Pi rpc | 由 `get_available_models` / `get_available_thinking_levels` **投影**构造 |
//!
//! 把它留在 `acp_config.rs` 里，会让 Pi 适配器 `use acp_config::…` —— 读起来像
//! 「Pi 依赖 ACP」，实际依赖的却是协议无关的那部分。**位置即依赖声明**，
//! 放错位置会持续误导后来者（本仓已因此踩过一次：见 `agent-chat-transports.md`）。
//!
//! `acp_config.rs` 保留的是 ACP **传输语义**：`session/set_config_option` 请求体、
//! `sessionUpdate` 通知解析、`ModelSwitch` 的帧构造。
//!
//! # 三条硬约束（对任何传输都成立）
//!
//! 1. **定位靠 `category`，`id` 只作兜底** —— 规范明说 `category` 不用于正确性判定，
//!    各家 `id` 命名并不统一（`reasoning_effort` / `effort` / `model`）。
//! 2. **解析失败降级为空，不返回 `Result`** —— 老 agent 根本不发该字段，缺失是正常情况。
//!    返回 `Result` 会诱使调用方用 `?`，于是可选能力的缺失把整个会话建不起来。
//! 3. **全量替换，不做局部 merge** —— 换模型可能连带改变档位选项，merge 会留下陈旧项。
//!
//! # 本模块是纯数据 + 纯函数
//!
//! 不持有会话、不发 IO。解析与状态读写都可以脱离运行时直接断言。

use serde::{Deserialize, Serialize};

use crate::common::agent::types::ModelInfo;

/// `category` 取值：模型选择器。
pub const CATEGORY_MODEL: &str = "model";
/// `category` 取值：模型相关配置参数。
pub const CATEGORY_MODEL_CONFIG: &str = "model_config";
/// `category` 取值：推理档位（`model_config` 的历史特例，保留向后兼容）。
pub const CATEGORY_THOUGHT_LEVEL: &str = "thought_level";

/// 规范里的惯例 `id`，仅在 `category` 缺失时作为兜底判据；
/// 也是 `session/set_config_option` 的 `configId`（各家实测都用它）。
const LEGACY_MODEL_ID: &str = "model";

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

/// 模型条目列表（供 UI 下拉 / 端到端断言）。
///
/// 注意：**前端并不依赖它** —— 前端从同一份 `configOptions` 自行派生（见
/// `shared/types/agentChat.ts::modelsFromConfigOptions`）。这里保留是因为端到端测试
/// 需要在 Rust 侧断言「会话给出的模型列表是什么」。
#[must_use]
pub fn models_from_config(options: &[SessionConfigOption]) -> Vec<ModelInfo> {
    find_model_option(options)
        .map(|option| {
            option
                .select_options()
                .into_iter()
                .map(|item| ModelInfo {
                    id: item.value,
                    name: item.name,
                    description: item.description,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 当前模型 ID。
#[must_use]
pub fn current_model_from_config(options: &[SessionConfigOption]) -> Option<String> {
    find_model_option(options)
        .and_then(SessionConfigOption::current)
        .map(str::to_string)
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
}
