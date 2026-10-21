//! 把 Pi 的 `get_available_models` / `get_available_thinking_levels` 响应
//! **投影**成协议无关的 [`SessionConfigOption`]。
//!
//! # 为什么需要「投影」而不是「解析」
//!
//! ACP 直接把 agent 下发的 `configOptions` 数组反序列化 (`parse_config_options`)。
//! Pi 没有这个东西 —— 它给的是两份**独立查询**：
//!
//! ```text
//! get_available_models          → {"models":[{id,name,provider,…}]}
//! get_available_thinking_levels → {"levels":["low","high","max"]}
//! get_state                    → {model:{id,…}, thinkingLevel:"high", …}
//! ```
//!
//! 所以要由我们把三份数据拼成前端认识的配置项形状。**这是唯一需要凭空构造
//! `SessionConfigOption` 的传输**，因此投影逻辑集中在本文件，不散落到会话层。
//!
//! # 复用边界
//!
//! `SessionConfigOption` / `ConfigOptionsState` / `find_model_option` 全部来自
//! [`super::super::session_config`]（协议无关），本文件只做「Pi 数据 → 那个形状」。
//! 不重新定义结构、不复制定位逻辑。

use serde_json::Value;

use crate::agent::chat::adapter::acp_config::{
    SessionConfigOption, SessionConfigSelectOption, SessionConfigSelectOptions, SessionConfigValue,
    CATEGORY_MODEL, CATEGORY_THOUGHT_LEVEL,
};
use crate::common::agent::types::ModelInfo;

/// 模型配置项的 `id`（`SessionConfigOption.id`，也是 `set_model` 的分派键）。
pub const MODEL_CONFIG_ID: &str = "model";
/// 推理档位配置项的 `id`。
pub const THINKING_LEVEL_CONFIG_ID: &str = "thinking_level";

/// `get_available_models` 的响应 → `Vec<ModelInfo>`。
///
/// 同时服务两个出口：会话外层（`adapter.list_models` 的 command 路径不需要它）
/// 与下面 [`project_config_options`] 的模型项构造。
#[must_use]
pub fn models_from_response(data: &Value) -> Vec<ModelInfo> {
    data.get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    Some(ModelInfo {
                        id: m.get("id")?.as_str()?.to_string(),
                        name: m
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        // provider 是 Pi 的必要信息：切模型要分开传，且同一个
                        // `id` 会出现在多个 provider 下（实测 224 条 / 194 唯一）。
                        // 放 `group` 而不是 `description` —— 后者是「可选说明」，
                        // 拿它充当主键的一部分是滥用。
                        description: None,
                        group: m
                            .get("provider")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 三份 Pi 响应 → 前端渲染用的配置项列表。
///
/// 缺失的任一输入都只是让对应项缺席，**不报错** —— 与 ACP 的降级语义一致：
/// 可选能力缺失不该阻断会话（`session_config.rs` 硬约束 2）。
#[must_use]
pub fn project_config_options(
    models: &[ModelInfo],
    levels: &[String],
    current: Option<&CurrentSelection>,
) -> Vec<SessionConfigOption> {
    let mut options = Vec::with_capacity(2);

    if !models.is_empty() {
        options.push(SessionConfigOption {
            id: MODEL_CONFIG_ID.into(),
            name: "Model".into(),
            description: None,
            category: Some(CATEGORY_MODEL.into()),
            kind: Some("select".into()),
            current_value: current
                .and_then(|c| c.model_id.as_deref())
                .map(|id| SessionConfigValue::Text(id.to_string())),
            options: Some(SessionConfigSelectOptions::Ungrouped(
                models
                    .iter()
                    .map(|m| SessionConfigSelectOption {
                        value: m.id.clone(),
                        name: m.name.clone(),
                        description: m.description.clone(),
                        // provider 必须原样带下去：会话内列表是前端真正渲染的
                        // 那一份，丢掉它 → React key 重复 + 搜不到 provider。
                        group: m.group.clone(),
                    })
                    .collect(),
            )),
            _meta: None,
        });
    }

    if !levels.is_empty() {
        options.push(SessionConfigOption {
            id: THINKING_LEVEL_CONFIG_ID.into(),
            name: "Thinking level".into(),
            description: None,
            category: Some(CATEGORY_THOUGHT_LEVEL.into()),
            kind: Some("select".into()),
            current_value: current
                .and_then(|c| c.thinking_level.as_deref())
                .map(|l| SessionConfigValue::Text(l.to_string())),
            options: Some(SessionConfigSelectOptions::Ungrouped(
                levels
                    .iter()
                    .map(|l| SessionConfigSelectOption {
                        value: l.clone(),
                        name: l.clone(),
                        description: None,
                        // 档位在列表内唯一，没有分组维度。
                        group: None,
                    })
                    .collect(),
            )),
            _meta: None,
        });
    }

    options
}

/// `get_state` 里的当前选择。
///
/// 单独成型而不是从 `Value` 里现场取三处：`get_state` 的载荷同时用于
/// 投影配置项与判断「是否需要真的发 `set_model`」，两处必须读**同一份**快照。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CurrentSelection {
    /// 当前模型 `id`。
    pub model_id: Option<String>,
    /// 当前推理档位。
    pub thinking_level: Option<String>,
}

impl CurrentSelection {
    /// 从 `get_state` 的 `data` 解析。
    #[must_use]
    pub fn from_state(data: &Value) -> Self {
        Self {
            model_id: data
                .get("model")
                .and_then(|m| m.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string),
            thinking_level: data
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }
}

/// `get_available_thinking_levels` 的响应 → 档位列表。
#[must_use]
pub fn levels_from_response(data: &Value) -> Vec<String> {
    data.get("levels")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|l| l.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_models_without_parsing_slug() {
        let data = json!({"models": [
            {"id": "deepseek-flash", "name": "DeepSeek Flash", "provider": "deepseek"},
            {"id": "auto/x", "name": "X", "provider": "magpie"}
        ]});
        let models = models_from_response(&data);
        assert_eq!(models.len(), 2);
        // provider 是独立字段，id 里带 `/` 也不拆
        assert_eq!(models[1].id, "auto/x");
        // provider 落 `group`（它是区分同名模型的主键分量），不是 `description`
        assert_eq!(models[1].group.as_deref(), Some("magpie"));
        assert_eq!(models[1].description, None);
    }

    /// **`id` 不唯一是常态**：同名模型会出现在多个 provider 下（实测 224 条
    /// 只有 194 个唯一 id）。`(id, group)` 才是标识 —— 前端拿 `id` 当 React key
    /// 会重复、当选中判定会让多行同时高亮。
    #[test]
    fn duplicate_ids_are_disambiguated_by_group() {
        let data = json!({"models": [
            {"id": "deepseek-v4-pro", "name": "V4 Pro", "provider": "deepseek"},
            {"id": "deepseek-v4-pro", "name": "V4 Pro", "provider": "opencode"},
            {"id": "deepseek-v4-pro", "name": "V4 Pro", "provider": "ark-coding-plan"}
        ]});
        let models = models_from_response(&data);
        assert_eq!(models.len(), 3);

        // 裸 id 全部相同
        assert!(models.iter().all(|m| m.id == "deepseek-v4-pro"));
        // group 把它们区分开
        let groups: Vec<&str> = models.iter().filter_map(|m| m.group.as_deref()).collect();
        assert_eq!(groups, ["deepseek", "opencode", "ark-coding-plan"]);
        // 组合键唯一
        let keys: std::collections::HashSet<String> = models
            .iter()
            .map(|m| format!("{}|{}", m.id, m.group.as_deref().unwrap_or("")))
            .collect();
        assert_eq!(keys.len(), 3);
    }

    /// **provider 必须穿过 `project_config_options`**。
    ///
    /// 会话内的模型列表才是前端真正渲染的那一份（`useModelsForPicker` 会话内优先）。
    /// 投影时丢掉 `group` 会让：
    /// - React key 退化回裸 id → 重复（实测 224 条 / 194 唯一）
    /// - 搜索 provider 名全部落空 → 「列表里明明显示着却搜不到」
    #[test]
    fn projection_preserves_the_group_through_config_options() {
        let models = models_from_response(&json!({"models": [
            {"id": "deepseek-v4-pro", "name": "V4 Pro", "provider": "deepseek"},
            {"id": "deepseek-v4-pro", "name": "V4 Pro", "provider": "opencode"}
        ]}));
        let options = project_config_options(&models, &[], None);
        let model = crate::agent::chat::adapter::session_config::find_model_option(&options)
            .expect("model option");
        let items = model.select_options();

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].group.as_deref(), Some("deepseek"));
        assert_eq!(items[1].group.as_deref(), Some("opencode"));
        // 组合键唯一（前端 key / 选中判定都靠它）
        let keys: std::collections::HashSet<String> = items
            .iter()
            .map(|o| format!("{}|{}", o.value, o.group.as_deref().unwrap_or("")))
            .collect();
        assert_eq!(keys.len(), 2);
    }

    /// 档位项没有分组维度（值在列表内唯一）。
    #[test]
    fn thinking_level_options_have_no_group() {
        let levels = levels_from_response(&json!({"levels": ["low", "high"]}));
        let options = project_config_options(&[], &levels, None);
        let level = crate::agent::chat::adapter::session_config::find_by_category(
            &options,
            CATEGORY_THOUGHT_LEVEL,
        )
        .expect("thought_level");
        assert!(level.select_options().iter().all(|o| o.group.is_none()));
    }

    #[test]
    fn handles_missing_or_malformed_models() {
        assert!(models_from_response(&json!({})).is_empty());
        assert!(models_from_response(&json!({"models": "nope"})).is_empty());
        let partial = json!({"models": [{"name": "x"}, {"id": "ok", "name": "ok"}]});
        assert_eq!(models_from_response(&partial).len(), 1);
    }

    #[test]
    fn projects_both_options_with_current_values() {
        let models = models_from_response(&json!({"models": [
            {"id": "m1", "name": "M1", "provider": "p"}
        ]}));
        let levels = levels_from_response(&json!({"levels": ["low", "high"]}));
        let current = CurrentSelection {
            model_id: Some("m1".into()),
            thinking_level: Some("high".into()),
        };

        let options = project_config_options(&models, &levels, Some(&current));
        assert_eq!(options.len(), 2);

        let model = crate::agent::chat::adapter::session_config::find_model_option(&options)
            .expect("model option must be findable by category");
        assert_eq!(model.id, MODEL_CONFIG_ID);
        assert_eq!(model.current(), Some("m1"));

        let level = crate::agent::chat::adapter::session_config::find_by_category(
            &options,
            CATEGORY_THOUGHT_LEVEL,
        )
        .expect("thought_level option");
        assert_eq!(level.current(), Some("high"));
    }

    /// 档位列表为空时**不产出**该项 —— 否则前端会渲染一个没有选项的空下拉。
    #[test]
    fn omits_options_that_have_no_values() {
        let models = models_from_response(&json!({"models": [{"id":"m","name":"M"}]}));
        let options = project_config_options(&models, &[], None);
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].id, MODEL_CONFIG_ID);

        let none = project_config_options(&[], &[], None);
        assert!(none.is_empty());
    }

    #[test]
    fn reads_current_selection_from_state() {
        let state = json!({"model": {"id": "auto/dv4"}, "thinkingLevel": "max"});
        let cur = CurrentSelection::from_state(&state);
        assert_eq!(cur.model_id.as_deref(), Some("auto/dv4"));
        assert_eq!(cur.thinking_level.as_deref(), Some("max"));
    }

    #[test]
    fn missing_state_fields_degrade_to_none() {
        assert_eq!(
            CurrentSelection::from_state(&json!({})),
            CurrentSelection::default()
        );
    }
}
