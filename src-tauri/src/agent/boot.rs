//! 启动期自定义 agent 装载 + 历史配置迁移（`agentSkillPathOverrides` → `agent.skill_path`）。
//!
//! 边界：本模块拥有「配置里 agent 相关字段的形状与迁移规则」，**读盘 / 写盘由调用方
//! （组合根）承担** —— 因此本模块不依赖 `StorageManager`，域间零耦合且可直测。
//!
//! 迁移规则（历史包袱的唯一出口，勿回退）：
//! 1. `customAgents[i].skill_path` 缺失（或空白）时，从 `agentSkillPathOverrides[id]`
//!    注入；
//! 2. 任何来源的 `skill_path` 都按 [`normalize_skill_path_str`] 归一（ASCII `~` vs
//!    全角 `～` / `〜` 的 IME 误输）；
//! 3. 未被 `customAgents` 覆盖的覆盖项（例如内置 agent 的 skill 路径）就地补进已注册
//!    agent 的空 `skill_path`；
//! 4. 只要发生过任一迁移，**移除** `agentSkillPathOverrides` 键 —— 由调用方持久化，
//!    下次启动即不再进入迁移路径。

use std::collections::HashMap;
use std::sync::Mutex;

use crate::agent::AgentManager;
use crate::common::agent::types::AgentConfig;

/// 配置键：集中式 skill 路径覆盖（历史形态，迁移后移除）。
const LEGACY_SKILL_PATH_KEY: &str = "agentSkillPathOverrides";
/// 配置键：自定义 agent 列表。
const CUSTOM_AGENTS_KEY: &str = "customAgents";
/// agent 的 skill 路径字段名。
const SKILL_PATH_FIELD: &str = "skill_path";

/// 装载结果（供调用方记日志 / 决定是否落盘，供测试断言）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AgentBootOutcome {
    /// 本次成功解析并注册进 `AgentManager` 的自定义 agent 数。
    pub registered_agents: usize,
    /// 是否发生过迁移（`skill_path` 注入 / 归一 / 补齐）—— `true` 时调用方需落盘。
    pub migrated: bool,
}

/// 把配置里的自定义 agent 装载进 `AgentManager`，并迁移历史 skill 路径覆盖。
///
/// 返回是否发生迁移：调用方据此持久化被就地修改的 `config`（本函数不碰磁盘）。
#[must_use]
pub fn load_custom_agents(
    config: &mut serde_json::Value,
    agents: &Mutex<AgentManager>,
) -> AgentBootOutcome {
    let legacy_overrides = legacy_skill_path_overrides(config);
    let mut outcome = AgentBootOutcome::default();

    let Ok(mut manager) = agents.lock() else {
        log::error!("[boot] agent manager lock poisoned; custom agents not registered");
        return outcome;
    };

    if let Some(custom_agents) = config
        .get_mut(CUSTOM_AGENTS_KEY)
        .and_then(|v| v.as_array_mut())
    {
        for agent_json in custom_agents.iter_mut() {
            inject_legacy_skill_path(agent_json, &legacy_overrides, &mut outcome);

            let Ok(mut agent) = serde_json::from_value::<AgentConfig>(agent_json.clone()) else {
                log::warn!("[boot] skipped malformed custom agent entry: {agent_json}");
                continue;
            };
            normalize_agent_skill_path(&mut agent, agent_json, &mut outcome);

            // `AgentManager::add_agent` 是唯一入口：内置 id 原位替换（身份保留）、
            // 自定义 id 去重追加 —— 无需先 remove。
            manager.add_agent(agent);
            outcome.registered_agents += 1;
        }
    }

    // 覆盖项里未被 customAgents 覆盖的部分（如内置 agent 的 skill 路径）：就地补空。
    for (id, path) in &legacy_overrides {
        let Some(existing) = manager.get_agent(id).cloned() else {
            continue;
        };
        let needs_path = existing
            .skill_path
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if !needs_path {
            continue;
        }
        let mut updated = existing;
        updated.skill_path = Some(path.clone());
        manager.remove_agent(id);
        manager.add_agent(updated);
        outcome.migrated = true;
    }
    drop(manager);

    if outcome.migrated {
        if let Some(obj) = config.as_object_mut() {
            obj.remove(LEGACY_SKILL_PATH_KEY);
        }
        log::info!("[boot] migrated legacy {LEGACY_SKILL_PATH_KEY} into agent skill_path fields");
    }
    outcome
}

/// `customAgents[i]` 的 `skill_path` 缺失 / 空白时，从历史覆盖表注入。
fn inject_legacy_skill_path(
    agent_json: &mut serde_json::Value,
    legacy_overrides: &HashMap<String, String>,
    outcome: &mut AgentBootOutcome,
) {
    let has_path = agent_json
        .get(SKILL_PATH_FIELD)
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if has_path {
        return;
    }
    let Some(path) = agent_json
        .get("id")
        .and_then(|v| v.as_str())
        .and_then(|id| legacy_overrides.get(id))
    else {
        return;
    };
    if let Some(obj) = agent_json.as_object_mut() {
        obj.insert(
            SKILL_PATH_FIELD.into(),
            serde_json::Value::String(path.clone()),
        );
        outcome.migrated = true;
    }
}

/// 归一化 agent 的 `skill_path`，并把结果写回配置 JSON（两处同源）。
fn normalize_agent_skill_path(
    agent: &mut AgentConfig,
    agent_json: &mut serde_json::Value,
    outcome: &mut AgentBootOutcome,
) {
    let Some(current) = agent.skill_path.as_ref() else {
        return;
    };
    let normalized = normalize_skill_path_str(current);
    if normalized == *current {
        return;
    }
    agent.skill_path = Some(normalized.clone());
    if let Some(obj) = agent_json.as_object_mut() {
        obj.insert(
            SKILL_PATH_FIELD.into(),
            serde_json::Value::String(normalized),
        );
        outcome.migrated = true;
    }
}

/// 读取历史 `agentSkillPathOverrides` 表（已归一化、已剔除空白项）。
fn legacy_skill_path_overrides(config: &serde_json::Value) -> HashMap<String, String> {
    config
        .get(LEGACY_SKILL_PATH_KEY)
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| {
                    v.as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| (k.clone(), normalize_skill_path_str(s)))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 归一 home 相对 skill 路径（ASCII `~` vs 全角 `～`/`〜` —— 常见 IME 误输）。
fn normalize_skill_path_str(path: &str) -> String {
    let trimmed = path.trim();
    // U+FF5E FULLWIDTH TILDE, U+301C WAVE DASH
    if let Some(rest) = trimmed.strip_prefix('\u{FF5E}') {
        return format!("~{rest}");
    }
    if let Some(rest) = trimmed.strip_prefix('\u{301C}') {
        return format!("~{rest}");
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom_agent_json(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "name": id,
            "enabled": true,
            "command": "mock",
            "args": [],
            "env": {},
        })
    }

    #[test]
    fn should_normalize_fullwidth_tilde_skill_path() {
        assert_eq!(
            normalize_skill_path_str("～/.gork/skills"),
            "~/.gork/skills"
        );
        assert_eq!(
            normalize_skill_path_str("〜/.grok/skills"),
            "~/.grok/skills"
        );
        assert_eq!(normalize_skill_path_str("~/ok"), "~/ok");
    }

    #[test]
    fn should_read_legacy_skill_path_overrides() {
        let config = serde_json::json!({
            "agentSkillPathOverrides": {
                "custom:grok": "～/.gork/skills",
                "custom:mimo": "~/.mimo/skills",
                "empty": "  "
            }
        });
        let map = legacy_skill_path_overrides(&config);
        assert_eq!(
            map.get("custom:grok").map(String::as_str),
            Some("~/.gork/skills")
        );
        assert_eq!(
            map.get("custom:mimo").map(String::as_str),
            Some("~/.mimo/skills")
        );
        assert!(!map.contains_key("empty"));
    }

    /// 端到端迁移：历史覆盖注入 → 归一化 → 注册进 manager → 移除历史键。
    #[test]
    fn migrates_legacy_override_into_registered_agent() {
        let agents = Mutex::new(AgentManager::new());
        let mut config = serde_json::json!({
            "agentSkillPathOverrides": { "custom:grok": "～/.gork/skills" },
            "customAgents": [custom_agent_json("custom:grok")],
        });

        let outcome = load_custom_agents(&mut config, &agents);

        assert_eq!(outcome.registered_agents, 1);
        assert!(outcome.migrated, "注入 + 归一都必须记账");
        assert!(
            config.get(LEGACY_SKILL_PATH_KEY).is_none(),
            "迁移后必须移除历史键（调用方据此落盘）"
        );
        let registered = agents
            .lock()
            .expect("lock")
            .get_agent("custom:grok")
            .cloned()
            .expect("agent registered");
        assert_eq!(registered.skill_path.as_deref(), Some("~/.gork/skills"));
    }

    /// 覆盖项未被 `customAgents` 覆盖（如内置 agent）→ 就地补齐已注册 agent 的空
    /// `skill_path`，并把归一化后的值写回配置。
    #[test]
    fn fills_empty_skill_path_on_resident_agent() {
        let agents = Mutex::new(AgentManager::new());
        agents.lock().expect("lock").add_agent(AgentConfig {
            id: "custom:resident".to_string(),
            name: "Resident".to_string(),
            command: "mock".to_string(),
            ..Default::default()
        });
        let mut config = serde_json::json!({
            "agentSkillPathOverrides": { "custom:resident": "〜/.resident/skills" },
        });

        let outcome = load_custom_agents(&mut config, &agents);

        assert!(outcome.migrated);
        assert_eq!(outcome.registered_agents, 0, "没有 customAgents 条目");
        let agent = agents
            .lock()
            .expect("lock")
            .get_agent("custom:resident")
            .cloned()
            .expect("agent present");
        assert_eq!(agent.skill_path.as_deref(), Some("~/.resident/skills"));
    }

    /// 无迁移面时零副作用：不注册、不记账、不动配置。
    #[test]
    fn no_legacy_config_is_a_noop() {
        let agents = Mutex::new(AgentManager::new());
        let mut config = serde_json::json!({ "customAgents": [custom_agent_json("custom:a")] });

        let outcome = load_custom_agents(&mut config, &agents);

        assert_eq!(
            outcome,
            AgentBootOutcome {
                registered_agents: 1,
                migrated: false
            }
        );
        assert!(config.get("customAgents").is_some());
    }

    /// 启动反序列化路径同样受「信任标识入口归一」保护
    /// （`.trellis/spec/backend/type-safety.md`「防御契约」的测试要求）：持久化文件里
    /// 手工编辑出来的 `is_builtin: true` 不得进入 `AgentManager`。
    #[test]
    fn strips_forged_builtin_flag_from_persisted_custom_agents() {
        let agents = Mutex::new(AgentManager::new());
        let mut config = serde_json::json!({
            "customAgents": [{
                "id": "custom:forged",
                "name": "Forged",
                "enabled": true,
                "command": "forged",
                "args": [],
                "env": {},
                "is_builtin": true,
            }],
        });

        let outcome = load_custom_agents(&mut config, &agents);
        assert_eq!(outcome.registered_agents, 1);

        let stored = agents
            .lock()
            .expect("lock")
            .get_agent("custom:forged")
            .cloned()
            .expect("registered");
        assert!(!stored.is_builtin, "持久化文件里的伪造身份必须被消解");
    }

    /// 覆盖层的身份由 Manager 决定：`customAgents` 里出现**内置 id** 时不得把它降级为
    /// 自定义（`add_agent` 的原位替换分支负责保留身份 —— 这是它取代「先 remove 再 add」
    /// 后仍必须成立的行为）。
    #[test]
    fn builtin_id_entry_keeps_builtin_identity() {
        let agents = Mutex::new(AgentManager::new());
        let builtin_id = agents
            .lock()
            .expect("lock")
            .get_agents()
            .iter()
            .find(|a| a.is_builtin)
            .expect("a builtin agent")
            .id
            .clone();
        let mut config = serde_json::json!({
            "customAgents": [{
                "id": builtin_id,
                "name": "Overridden",
                "enabled": true,
                "command": "overridden",
                "args": [],
                "env": {},
            }],
        });

        let outcome = load_custom_agents(&mut config, &agents);

        assert_eq!(outcome.registered_agents, 1);
        let manager = agents.lock().expect("lock");
        assert!(
            manager.is_builtin_id(&builtin_id),
            "内置身份不得被覆盖层改写"
        );
        assert_eq!(
            manager.get_agent(&builtin_id).expect("present").name,
            "Overridden",
            "覆盖值必须生效"
        );
    }

    /// 畸形条目跳过而不中断整批装载（防御 frontend 手改配置）。
    #[test]
    fn malformed_entry_is_skipped_without_aborting_batch() {
        let agents = Mutex::new(AgentManager::new());
        let mut config = serde_json::json!({
            "customAgents": [serde_json::json!({ "name": "no id" }), custom_agent_json("custom:ok")],
        });

        let outcome = load_custom_agents(&mut config, &agents);

        assert_eq!(outcome.registered_agents, 1, "合法条目仍须装载");
        assert!(agents
            .lock()
            .expect("lock")
            .get_agent("custom:ok")
            .is_some());
    }
}
