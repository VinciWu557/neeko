//! Agent registry and installation-check logic.

use crate::common::agent::types::AgentConfig;
use crate::common::executor::factory::ExecTarget;
use std::collections::HashMap;
use std::future::Future;

/// Registry of AI agent configurations.
///
/// 数据源为 [`crate::agent::builtin::default_configs`]（内置 11 个）+ 用户自定义。
/// 内置 agent 支持**覆盖**：`add_agent` 对内置 id 原位替换（不产生重复条目），
/// `remove_agent` 对内置 id 恢复出厂值（清除覆盖）；用户自定义走追加/去重。
pub struct AgentManager {
    agents: Vec<AgentConfig>,
    /// 被用户覆盖过的内置 agent id。
    ///
    /// 为什么是独立字段而不是「比较当前值 vs 出厂值」：出厂定义会随版本升级变化，
    /// 值相等与否不能回答「用户有没有动过它」—— 用户恰好改回原值也算动过，
    /// 而升级后默认值变了则会让一次真实覆盖静默消失。
    ///
    /// 这个信息**只存后端**：前端曾经为它保管 `AppConfig.agentOverrides` 键集合，
    /// 于是又多了一份需要同步的真相。
    overridden: std::collections::HashSet<String>,
}

impl Default for AgentManager {
    /// Create a default `AgentManager` with built-in agents.
    fn default() -> Self {
        Self::new()
    }
}

impl AgentManager {
    /// Create a new `AgentManager` with the default built-in agents.
    #[must_use]
    pub fn new() -> Self {
        Self {
            agents: crate::agent::builtin::default_configs(),
            overridden: std::collections::HashSet::new(),
        }
    }

    /// 启动时恢复内置 agent 的用户覆盖（config.json `agentOverrides`）。
    ///
    /// 覆盖值原位替换对应 builtin 元素；未知 id 忽略（防御）。覆盖不改变
    /// agent 的内置身份（`is_builtin` 恒保持 true，防止前端列表过滤丢失）。
    ///
    /// # `chat` 是出厂事实，不可被覆盖层改写
    ///
    /// 覆盖层是用户编辑时的**整份快照**（`AgentConfig` 多数字段非 `Option`，
    /// 序列化后丢失 presence）。所以旧快照里必然躺着当时那份 `chat` ——
    /// 如果让它生效，出厂定义的任何后续修正都会被永久挡回（spec §10.5d 事故：
    /// Pi 的 `--list-models` 就是这样被旧快照复活的）。
    ///
    /// 因此这里强制 `applied.chat = factory_chat`。用户的真实诉求「用不用它」
    /// 由 `chat_enabled`（纯偏好字段）承载，那个字段照旧取覆盖层的值。
    ///
    /// **幂等**：`factory_chat` 取自当前 `slot`，而 `slot.chat` 每次都被还原成
    /// 出厂值，所以连续调用两次结果相同。
    pub fn restore_overrides(&mut self, overrides: &HashMap<String, AgentConfig>) {
        for (id, cfg) in overrides {
            if let Some(slot) = self.agents.iter_mut().find(|a| a.id == *id && a.is_builtin) {
                let factory_chat = slot.chat.clone();
                let mut applied = cfg.clone();
                applied.is_builtin = true;
                applied.chat = factory_chat;
                *slot = applied;
                self.overridden.insert(id.clone());
            }
        }
    }

    /// 是否为内置 agent id。
    #[must_use]
    pub fn is_builtin_id(&self, agent_id: &str) -> bool {
        self.agents.iter().any(|a| a.id == agent_id && a.is_builtin)
    }

    /// Return all registered agents —— **带上覆盖标记的视图**。
    ///
    /// `is_overridden` 是派生值，只在这里填：它是「谁说真相」的一部分，不该由
    /// 前端保管键集合，也不该由调用方各自补。
    #[must_use]
    pub fn get_agents(&self) -> Vec<AgentConfig> {
        self.agents
            .iter()
            .map(|a| {
                let mut out = a.clone();
                out.is_overridden = self.overridden.contains(&a.id);
                out
            })
            .collect()
    }

    /// Get an agent by ID.
    #[must_use]
    pub fn get_agent(&self, agent_id: &str) -> Option<&AgentConfig> {
        self.agents.iter().find(|a| a.id == agent_id)
    }

    /// Register an agent.
    ///
    /// 内置 id → 原位替换（覆盖，不产生重复条目，`is_builtin` 身份保留）；
    /// 自定义 id → 去重后追加，且**强制清零** `is_builtin`。
    ///
    /// 清零在**唯一入口**做，而不是每个调用方各做一遍：`is_builtin` 是「仅由后端
    /// 填写、前端绝不可写」的信任标识（`.trellis/spec/backend/type-safety.md`
    /// 「防御契约」）。所有进入 `AgentManager` 的路径（Tauri 命令 / 启动反序列化
    /// 持久化文件 / 未来的新入口）都经本函数，伪造值在此被统一消解。
    pub fn add_agent(&mut self, mut agent: AgentConfig) {
        let slot_id = agent.id.clone();
        if let Some(slot) = self
            .agents
            .iter_mut()
            .find(|a| a.id == agent.id && a.is_builtin)
        {
            agent.is_builtin = true;
            *slot = agent;
            self.overridden.insert(slot_id);
            return;
        }
        agent.is_builtin = false;
        self.agents.retain(|a| a.id != agent.id);
        self.agents.push(agent);
    }

    /// Unregister an agent by ID.
    ///
    /// 内置 id → 恢复出厂值（清除覆盖）；自定义 id → 移除。
    pub fn remove_agent(&mut self, agent_id: &str) {
        if self.is_builtin_id(agent_id) {
            let default = crate::agent::builtin::default_configs()
                .into_iter()
                .find(|a| a.id == agent_id);
            if let Some(d) = default {
                if let Some(slot) = self
                    .agents
                    .iter_mut()
                    .find(|a| a.id == agent_id && a.is_builtin)
                {
                    *slot = d;
                }
                self.overridden.remove(agent_id);
                return;
            }
        }
        self.agents.retain(|a| a.id != agent_id);
    }

    /// Resolve agent IDs to their CLI command names.
    #[must_use]
    pub fn resolve_commands(&self, agent_ids: &[String]) -> Vec<(String, Option<String>)> {
        agent_ids
            .iter()
            .map(|id| {
                let cmd = self.get_agent(id).map(|a| a.command.clone());
                (id.clone(), cmd)
            })
            .collect()
    }

    /// Check whether each agent CLI exists in the given execution target.
    pub async fn check_installed(
        commands: &[(String, Option<String>)],
        target: &ExecTarget,
    ) -> HashMap<String, bool> {
        let target = target.clone();
        Self::check_installed_with(commands, move |cmd: String| {
            let target = target.clone();
            async move { crate::core::exec::command_exists(&target, &cmd).await }
        })
        .await
    }

    /// Injectable core of [`check_installed`]: caller supplies existence check.
    ///
    /// 生产代码传入 `|cmd| command_exists(target, cmd)`，单测传入闭包返回固定值，
    pub async fn check_installed_with<F, Fut>(
        commands: &[(String, Option<String>)],
        checker: F,
    ) -> HashMap<String, bool>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = bool>,
    {
        let mut result = HashMap::new();
        for (id, cmd) in commands {
            let installed = match cmd.as_deref() {
                Some(c) => checker(c.to_string()).await,
                None => false,
            };
            result.insert(id.clone(), installed);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::agent::chat_launch::ChatLaunch;

    #[test]
    fn should_initialize_with_eleven_presets() {
        let manager = AgentManager::new();
        assert_eq!(manager.get_agents().len(), 11);
    }

    #[test]
    fn should_include_grok_default_agent() {
        let manager = AgentManager::new();
        let agent = manager
            .get_agent("grok")
            .expect("grok should be a default agent");
        assert_eq!(agent.command, "grok");
        assert_eq!(agent.icon.as_deref(), Some("grok.ico"));
        assert!(agent.is_builtin);
    }

    #[test]
    fn should_mark_all_default_agents_as_builtin_with_skill_path() {
        let manager = AgentManager::new();
        for agent in manager.get_agents() {
            assert!(
                agent.is_builtin,
                "default agent {} should be marked is_builtin",
                agent.id
            );
            assert!(
                agent.skill_path.is_some(),
                "default agent {} should have skill_path",
                agent.id
            );
        }
    }

    #[test]
    fn should_find_agent_by_id() {
        let manager = AgentManager::new();
        let agent = manager.get_agent("opencode");
        assert!(agent.is_some());
        // name 为 display name（provider 提供），非 id。
        assert_eq!(agent.unwrap().name, "OpenCode");
    }

    #[test]
    fn should_return_none_for_unknown_id() {
        let manager = AgentManager::new();
        assert!(manager.get_agent("nonexistent").is_none());
    }

    #[test]
    fn should_add_custom_agent() {
        let mut manager = AgentManager::new();
        let before = manager.get_agents().len();
        let custom = AgentConfig {
            id: "custom".into(),
            name: "Custom Agent".into(),
            command: "custom".into(),
            ..Default::default()
        };
        manager.add_agent(custom);
        assert_eq!(manager.get_agents().len(), before + 1);
        assert!(manager.get_agent("custom").is_some());
    }

    /// 信任标识入口归一：自定义 id 携带伪造的 `is_builtin: true` 一律被清零
    /// （契约见 `.trellis/spec/backend/type-safety.md`「防御契约」）。
    #[test]
    fn should_strip_forged_builtin_flag_on_custom_id() {
        let mut manager = AgentManager::new();
        manager.add_agent(AgentConfig {
            id: "custom:forged".into(),
            name: "Forged".into(),
            command: "forged".into(),
            is_builtin: true, // 伪造：前端可构造 / 持久化文件可手改
            ..Default::default()
        });

        let stored = manager.get_agent("custom:forged").expect("registered");
        assert!(!stored.is_builtin, "自定义 id 的信任标识必须清零");
        assert!(!manager.is_builtin_id("custom:forged"));
    }

    /// 内置 id 的覆盖仍保留内置身份（清零只作用于非内置分支）。
    #[test]
    fn should_keep_builtin_identity_on_builtin_id_override() {
        let mut manager = AgentManager::new();
        let builtin_id = manager
            .get_agents()
            .iter()
            .find(|a| a.is_builtin)
            .expect("a builtin agent")
            .id
            .clone();

        manager.add_agent(AgentConfig {
            id: builtin_id.clone(),
            name: "Overridden".into(),
            command: "overridden".into(),
            is_builtin: false, // 覆盖层不带身份，身份由 Manager 决定
            ..Default::default()
        });

        let stored = manager.get_agent(&builtin_id).expect("present");
        assert!(stored.is_builtin, "内置 id 的身份不得被覆盖层清零");
        assert_eq!(stored.name, "Overridden");
    }

    #[test]
    fn should_remove_custom_agent() {
        let mut manager = AgentManager::new();
        let before = manager.get_agents().len();
        manager.add_agent(AgentConfig {
            id: "temp".into(),
            name: "Temp".into(),
            command: "temp".into(),
            ..Default::default()
        });
        assert!(manager.get_agent("temp").is_some());
        manager.remove_agent("temp");
        assert_eq!(manager.get_agents().len(), before);
        assert!(manager.get_agent("temp").is_none());
    }

    #[test]
    fn should_not_panic_when_removing_nonexistent() {
        let mut manager = AgentManager::new();
        let before = manager.get_agents().len();
        manager.remove_agent("nonexistent");
        assert_eq!(manager.get_agents().len(), before);
    }

    #[test]
    fn should_contain_all_expected_presets() {
        let manager = AgentManager::new();
        let agents = manager.get_agents();
        let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
        for expected in [
            "opencode",
            "claude-code",
            "gemini",
            "codex",
            "qoder",
            "codebuddy",
            "pi",
            "omp",
            "reasonix",
            "grok",
        ] {
            assert!(
                ids.contains(&expected),
                "missing default agent {expected}: {ids:?}"
            );
        }
    }

    #[test]
    fn should_have_all_agents_enabled_by_default() {
        let manager = AgentManager::new();
        assert!(manager.get_agents().iter().all(|a| a.enabled));
    }

    #[tokio::test]
    async fn should_check_installed_returns_map_on_local_target() {
        let manager = AgentManager::new();
        let ids = vec!["opencode".to_string()];
        let commands = manager.resolve_commands(&ids);
        // hermetic：注入假 checker，不触文件系统
        let result =
            AgentManager::check_installed_with(&commands, |cmd| async move { cmd == "opencode" })
                .await;
        assert_eq!(result.get("opencode"), Some(&true));
    }

    #[tokio::test]
    async fn should_check_installed_returns_false_for_unknown() {
        let manager = AgentManager::new();
        let ids = vec!["nonexistent".to_string()];
        let commands = manager.resolve_commands(&ids);
        assert_eq!(commands[0].1, None);
        let result = AgentManager::check_installed_with(&commands, |_| async { true }).await;
        // None command → false，不调用 checker
        assert_eq!(result.get("nonexistent"), Some(&false));
    }

    #[tokio::test]
    async fn should_check_installed_empty_input() {
        let result = AgentManager::check_installed_with(&[], |_| async { true }).await;
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn should_check_installed_with_injected_checker() {
        let commands = vec![
            ("a".to_string(), Some("exists".to_string())),
            ("b".to_string(), Some("missing".to_string())),
            ("c".to_string(), None),
        ];
        let result =
            AgentManager::check_installed_with(&commands, |cmd| async move { cmd == "exists" })
                .await;
        assert_eq!(result.get("a"), Some(&true));
        assert_eq!(result.get("b"), Some(&false));
        assert_eq!(result.get("c"), Some(&false));
    }

    #[test]
    fn should_resolve_commands_for_known_and_unknown() {
        let manager = AgentManager::new();
        let ids = vec!["opencode".into(), "nope".into()];
        let commands = manager.resolve_commands(&ids);
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].1.as_deref(), Some("opencode"));
        assert_eq!(commands[1].1, None);
    }

    #[test]
    fn should_override_builtin_agent_in_place() {
        let mut manager = AgentManager::new();
        let before = manager.get_agents().len();
        let overridden = AgentConfig {
            id: "opencode".into(),
            name: "OpenCode (custom)".into(),
            command: "my-opencode".into(),
            ..Default::default()
        };
        manager.add_agent(overridden);
        // 原位替换：长度不变、取回的是覆盖值、内置身份保留
        assert_eq!(manager.get_agents().len(), before);
        let agent = manager.get_agent("opencode").unwrap();
        assert_eq!(agent.command, "my-opencode");
        assert_eq!(agent.name, "OpenCode (custom)");
        assert!(agent.is_builtin, "override must keep is_builtin identity");
    }

    #[test]
    fn should_reset_builtin_agent_to_factory_default() {
        let mut manager = AgentManager::new();
        let overridden = AgentConfig {
            id: "opencode".into(),
            name: "OpenCode (custom)".into(),
            command: "my-opencode".into(),
            ..Default::default()
        };
        manager.add_agent(overridden);
        assert_eq!(
            manager.get_agent("opencode").unwrap().command,
            "my-opencode"
        );

        manager.remove_agent("opencode");
        // 恢复出厂：仍在列表（未删除），值为内置原值
        assert!(manager.get_agent("opencode").is_some());
        let agent = manager.get_agent("opencode").unwrap();
        assert_eq!(agent.command, "opencode");
        assert_eq!(agent.name, "OpenCode");
    }

    /// `is_overridden` 必须由 `AgentManager` 自己回答 —— 前端不再保管键集合。
    ///
    /// 判据是「谁拥有这个知识」：后端知道 `add_agent`/`remove_agent`/启动恢复
    /// 都做了什么，前端只能靠旁路记录去猜。
    #[test]
    fn get_agents_reports_override_state() {
        let mut manager = AgentManager::new();

        // 出厂状态：全部非覆盖。
        let before = manager.get_agents();
        assert!(before.iter().all(|a| !a.is_overridden));

        // 覆盖一个内置 agent。
        manager.add_agent(AgentConfig {
            id: "gemini".into(),
            name: "Gemini Custom".into(),
            command: "gemini-custom".into(),
            ..Default::default()
        });
        let after = manager.get_agents();
        let gemini = after.iter().find(|a| a.id == "gemini").unwrap();
        assert!(gemini.is_overridden, "覆盖后必须标记");
        assert!(gemini.is_builtin, "覆盖不改变内置身份");
        assert!(
            after
                .iter()
                .filter(|a| a.id != "gemini")
                .all(|a| !a.is_overridden),
            "其它 agent 不受影响"
        );

        // 恢复出厂 → 标记清除。
        manager.remove_agent("gemini");
        let restored = manager.get_agents();
        let gemini = restored.iter().find(|a| a.id == "gemini").unwrap();
        assert!(!gemini.is_overridden, "Reset 后标记必须清除");
        assert_eq!(gemini.command, "gemini", "回到出厂命令");
    }

    /// 自定义 agent 恒不标记为「覆盖」—— 删掉它就是删掉，谈不上覆盖。
    #[test]
    fn custom_agents_are_never_marked_overridden() {
        let mut manager = AgentManager::new();
        manager.add_agent(AgentConfig {
            id: "mine".into(),
            name: "Mine".into(),
            command: "mine".into(),
            ..Default::default()
        });

        let mine = manager
            .get_agents()
            .into_iter()
            .find(|a| a.id == "mine")
            .unwrap();
        assert!(!mine.is_builtin);
        assert!(!mine.is_overridden);
    }

    #[test]
    fn should_restore_overrides_from_config() {
        let mut manager = AgentManager::new();
        let overrides = HashMap::from([(
            "gemini".to_string(),
            AgentConfig {
                id: "gemini".into(),
                name: "Gemini Custom".into(),
                command: "gemini-custom".into(),
                ..Default::default()
            },
        )]);
        manager.restore_overrides(&overrides);
        let agent = manager.get_agent("gemini").unwrap();
        assert_eq!(agent.command, "gemini-custom");
        assert!(agent.is_builtin);
        // 未知 id 忽略
        let bad = HashMap::from([(
            "nonexistent".to_string(),
            AgentConfig {
                id: "nonexistent".into(),
                ..Default::default()
            },
        )]);
        manager.restore_overrides(&bad);
        assert!(manager.get_agent("nonexistent").is_none());
    }

    /// **`chat` 是出厂事实，覆盖层改不动它。**
    ///
    /// 覆盖层是整份快照，旧文件里必然躺着当时那份 `chat`。让它生效 = 出厂
    /// 协议的后续修正被永久挡回（spec §10.5d 事故形态）。
    ///
    /// 变异验证：删掉 `applied.chat = factory_chat` → 本用例红。
    #[test]
    fn override_cannot_rewrite_the_builtin_chat_protocol() {
        let mut manager = AgentManager::new();
        let factory = manager.get_agent("pi").expect("builtin pi").chat.clone();
        assert!(factory.is_some(), "pi 出厂就有 chat");

        // 旧快照里塞一个**完全不同**的协议，并关掉 chat。
        let overrides = HashMap::from([(
            "pi".to_string(),
            AgentConfig {
                id: "pi".into(),
                name: "Pi".into(),
                chat: Some(ChatLaunch {
                    program: Some("someone-elses-acp".into()),
                    args: vec!["acp".into()],
                    ..Default::default()
                }),
                chat_enabled: Some(false),
                ..Default::default()
            },
        )]);
        manager.restore_overrides(&overrides);

        let agent = manager.get_agent("pi").unwrap();
        assert_eq!(agent.chat, factory, "出厂协议不得被覆盖层改写");
        assert_eq!(agent.chat_enabled, Some(false), "用户偏好照旧生效");
        assert!(!agent.is_chat_agent(), "关掉后不再算 chat agent");
    }

    /// 覆盖层的其余字段（`command` / `args` / `deploy` / `detection`）**仍然生效**。
    ///
    /// 这条是「只有 `chat` 被锁」的反向保证 —— 别为了锁 `chat` 把整份覆盖废掉。
    #[test]
    fn override_still_applies_everything_but_chat() {
        let mut manager = AgentManager::new();
        let overrides = HashMap::from([(
            "pi".to_string(),
            AgentConfig {
                id: "pi".into(),
                name: "Pi Renamed".into(),
                command: "pi-custom".into(),
                args: vec!["--mine".into()],
                prompt_args: Some(vec!["-p".into()]),
                ..Default::default()
            },
        )]);
        manager.restore_overrides(&overrides);

        let agent = manager.get_agent("pi").unwrap();
        assert_eq!(agent.name, "Pi Renamed");
        assert_eq!(agent.command, "pi-custom");
        assert_eq!(agent.args, vec!["--mine"]);
        assert_eq!(agent.prompt_args, Some(vec!["-p".into()]));
        assert!(agent.chat.is_some(), "chat 仍是出厂值");
    }

    /// **幂等**：连续恢复两次结果相同（启动期只调一次，但语义必须成立）。
    #[test]
    fn restore_overrides_is_idempotent() {
        let mut manager = AgentManager::new();
        let overrides = HashMap::from([(
            "opencode".to_string(),
            AgentConfig {
                id: "opencode".into(),
                name: "OC".into(),
                command: "oc".into(),
                chat: Some(ChatLaunch::default()),
                ..Default::default()
            },
        )]);
        manager.restore_overrides(&overrides.clone().into_iter().collect());
        let once = manager.get_agent("opencode").unwrap().clone();
        manager.restore_overrides(&overrides);
        let twice = manager.get_agent("opencode").unwrap().clone();
        assert_eq!(once.chat, twice.chat);
        assert_eq!(once.command, twice.command);
    }

    #[test]
    fn should_resolve_prompt_args_for_opencode() {
        let manager = AgentManager::new();
        let agent = manager.get_agent("opencode").unwrap();
        let args = agent.resolve_prompt_args();
        assert!(args.is_some());
        assert!(args.unwrap().contains(&"run".to_string()));
    }

    #[test]
    fn should_resolve_post_prompt_args_for_claude() {
        let manager = AgentManager::new();
        let agent = manager.get_agent("claude-code").unwrap();
        let args = agent.resolve_post_prompt_args();
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn should_return_empty_vec_for_agent_without_post_prompt_args() {
        let manager = AgentManager::new();
        let agent = manager.get_agent("opencode").unwrap();
        let args = agent.resolve_post_prompt_args();
        assert!(args.is_empty());
    }
}
