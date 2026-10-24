//! 内置 Agent 单一事实源 —— 11 个 `AgentConfig`（纯数据）。
//!
//! 数据只有一份（AgentConfig），不再有独立的 provider 数据层；运行时行为
//! 经 `AgentProvider::from(&config)` 获得。id 字面量直接在此定义（无 ids.rs）。

use std::collections::HashMap;

use crate::common::agent::chat_launch::ChatLaunch;
use crate::common::agent::types::{AgentConfig, DeploySpec, Detection};

/// 返回全部内置 AgentConfig（11 个）。
#[must_use]
pub fn builtin_configs() -> Vec<AgentConfig> {
    vec![
        // ── Claude Code ───────────────────────────────────────────────────────
        AgentConfig {
            id: "claude-code".into(),
            name: "Claude Code".into(),
            icon: Some("claude-code.png".into()),
            enabled: true,
            chat_enabled: None,
            is_builtin: true,
            is_overridden: false,
            command: "claude".into(),
            args: vec![],
            env: HashMap::new(),
            chat: None,
            prompt_args: Some(vec!["--bare".into(), "-p".into()]),
            interactive_prompt_args: None,
            post_prompt_args: Some(vec!["--dangerously-skip-permissions".into()]),
            model_list_args: None,
            skill_path: Some("~/.claude/skills".into()),
            detection: Some(Detection::Command {
                target: "claude".into(),
            }),
            deploy: DeploySpec {
                // claude-code 目录是 .claude（id 是 claude-code）
                skills: "{{projectPath}}/.claude/skills".into(),
                commands: Some("{{projectPath}}/.claude/commands".into()),
                mcp_config: Some("{{home}}/.claude/settings.json".into()),
            },
        },
        // ── Shell CLI agents（9 个；opencode 带 serve CHAT 能力）─────────────
        shell_agent(
            "opencode",
            "OpenCode",
            "opencode.png",
            "opencode",
            Some(&["run", "--pure", "--dangerously-skip-permissions=true", "-f"]),
            // 交互式（TUI）形态：opencode --prompt "<prompt>"（打开 CLI 并预填 prompt）
            Some(&["--prompt"]),
            None,
            Some(ChatLaunch {
                program: Some("opencode".into()),
                args: vec!["serve".into()],
                ..Default::default()
            }),
            "~/.config/opencode/skills",
        ),
        shell_agent(
            "gemini",
            "Gemini",
            "gemini.png",
            "gemini",
            Some(&["--prompt"]),
            None,
            None,
            None,
            "~/.gemini/skills",
        ),
        shell_agent(
            "codex",
            "Codex",
            "codex.png",
            "codex",
            Some(&[]),
            None,
            None,
            None,
            "~/.codex/skills",
        ),
        shell_agent(
            "qoder",
            "Qoder",
            "qoder.svg",
            "qodercli",
            Some(&["--prompt"]),
            None,
            None,
            None,
            "~/.qoder/skills",
        ),
        shell_agent(
            "codebuddy",
            "CodeBuddy",
            "codebuddy.svg",
            "codebuddy",
            Some(&["--prompt"]),
            None,
            None,
            None,
            "~/.codebuddy/skills",
        ),
        shell_agent(
            "omp",
            "OMP",
            "omp.svg",
            "omp",
            Some(&["-p"]),
            None,
            None,
            None,
            "~/.omp/skills",
        ),
        shell_agent(
            "pi",
            "Pi",
            "pi.svg",
            "pi",
            Some(&["-p"]),
            None,
            None,
            // 私有 rpc 协议（单进程，不依赖 pi-acp 中间层）。
            Some(ChatLaunch {
                args: vec!["--mode".into(), "rpc".into()],
                ..Default::default()
            }),
            "~/.pi/skills",
        ),
        shell_agent(
            "reasonix",
            "Reasonix",
            "reasonix.svg",
            "reasonix",
            Some(&["run", "--yolo"]),
            None,
            None,
            None,
            "~/.reasonix/skills",
        ),
        shell_agent(
            "grok",
            "Grok",
            "grok.ico",
            "grok",
            Some(&["-p"]),
            None,
            None,
            None,
            "~/.grok/skills",
        ),
        // ── MockAgent（进程内 CHAT mock，无 CLI 能力）────────────────────────
        // 名字用「MockAgent」而 id 保持 `mockAgent`：id 被前端 `AGENT_IDS` 与持久化
        // 配置引用，改名是破坏性变更；展示名只影响 UI。
        AgentConfig {
            id: "mockAgent".into(),
            name: "MockAgent".into(),
            // 复用应用自身图标 —— 之前指向不存在的 `mock.png`，界面上是空白。
            icon: Some("mock-agent.png".into()),
            chat_enabled: None,
            enabled: true,
            is_builtin: true,
            is_overridden: false,
            command: String::new(),
            args: vec![],
            env: HashMap::new(),
            // 进程内实现（无 argv，不 spawn 子进程）—— 显式声明，不从空 command 推断。
            chat: Some(ChatLaunch {
                inprocess: true,
                ..Default::default()
            }),
            prompt_args: None,
            interactive_prompt_args: None,
            post_prompt_args: None,
            model_list_args: None,
            skill_path: Some("~/.mock-agent/skills".into()),
            detection: None,
            deploy: DeploySpec {
                skills: "{{projectPath}}/.mock-agent/skills".into(),
                commands: None,
                mcp_config: None,
            },
        },
    ]
}

/// 返回内置 AgentConfig（`builtin_configs` 的兼容别名）。
#[must_use]
pub fn default_configs() -> Vec<AgentConfig> {
    builtin_configs()
}

/// Build a lookup map: agent_id → AgentConfig.
#[must_use]
pub fn config_map() -> HashMap<String, AgentConfig> {
    builtin_configs()
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect()
}

/// 构造一个标准 CLI agent：skills/commands 位于 `{{projectPath}}/.{id}/` 下、
/// MCP 配置位于 `{{home}}/.{id}/config.json`，detection = command。
#[allow(clippy::too_many_arguments)]
fn shell_agent(
    id: &'static str,
    name: &'static str,
    icon: &'static str,
    command: &'static str,
    prompt_args: Option<&[&'static str]>,
    interactive_prompt_args: Option<&[&'static str]>,
    post_prompt_args: Option<&[&'static str]>,
    chat: Option<ChatLaunch>,
    skill_path: &'static str,
) -> AgentConfig {
    AgentConfig {
        id: id.into(),
        name: name.into(),
        icon: Some(icon.into()),
        enabled: true,
        chat_enabled: None,
        is_builtin: true,
        is_overridden: false,
        command: command.into(),
        args: vec![],
        env: HashMap::new(),
        chat,
        // 内置定义不拆分 chat 可执行文件/参数（需要时由调用方后置覆盖）。
        prompt_args: prompt_args.map(|a| a.iter().map(|s| (*s).into()).collect()),
        interactive_prompt_args: interactive_prompt_args
            .map(|a| a.iter().map(|s| (*s).into()).collect()),
        post_prompt_args: post_prompt_args.map(|a| a.iter().map(|s| (*s).into()).collect()),
        // 大多数 agent 没有独立的列模型命令；有的话由调用方后置设置
        // 模型列表一律走 agent 自己的协议（见下方说明），内置定义不填。
        model_list_args: None,
        skill_path: Some(skill_path.into()),
        detection: Some(Detection::Command {
            target: command.into(),
        }),
        deploy: DeploySpec {
            skills: format!("{{{{projectPath}}}}/.{id}/skills"),
            commands: Some(format!("{{{{projectPath}}}}/.{id}/commands")),
            mcp_config: Some(format!("{{{{home}}}}/.{id}/config.json")),
        },
    }
}
