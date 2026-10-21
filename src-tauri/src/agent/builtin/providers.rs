//! 内置 Agent 单一事实源 —— 11 个 `AgentConfig`（纯数据）。
//!
//! 数据只有一份（AgentConfig），不再有独立的 provider 数据层；运行时行为
//! 经 `AgentProvider::from(&config)` 获得。id 字面量直接在此定义（无 ids.rs）。

use std::collections::HashMap;

use crate::common::agent::types::{AgentConfig, ChatStart, DeploySpec, Detection};

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
            is_builtin: true,
            command: "claude".into(),
            args: vec![],
            env: HashMap::new(),
            chat: None,
            chat_command: None,
            chat_args: None,
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
            Some(ChatStart::Serve),
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
        with_model_list(
            shell_agent(
                "pi",
                "Pi",
                "pi.svg",
                "pi",
                Some(&["-p"]),
                None,
                None,
                // 私有 rpc 协议（单进程，不依赖 pi-acp 中间层）。
                Some(ChatStart::PiRpc),
                "~/.pi/skills",
            ),
            // 表格输出：provider / model / context / max-out / thinking / images
            &["--list-models"],
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
            enabled: true,
            is_builtin: true,
            command: String::new(),
            args: vec![],
            env: HashMap::new(),
            chat: Some(ChatStart::Mock),
            chat_command: None,
            chat_args: None,
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

/// 给 agent 声明「列出可用模型」的命令参数。
///
/// 与 CHAT 能力正交：`pi --list-models` 是纯 CLI 查询，不需要 ACP / serve 就能跑。
/// 存在它，用户在**发第一条消息之前**就能看到模型列表。
fn with_model_list(mut agent: AgentConfig, args: &[&str]) -> AgentConfig {
    agent.model_list_args = Some(args.iter().map(|s| (*s).into()).collect());
    agent
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
    chat: Option<ChatStart>,
    skill_path: &'static str,
) -> AgentConfig {
    AgentConfig {
        id: id.into(),
        name: name.into(),
        icon: Some(icon.into()),
        enabled: true,
        is_builtin: true,
        command: command.into(),
        args: vec![],
        env: HashMap::new(),
        chat,
        // 内置定义不拆分 chat 可执行文件/参数（需要时由调用方后置覆盖）。
        chat_command: None,
        chat_args: None,
        prompt_args: prompt_args.map(|a| a.iter().map(|s| (*s).into()).collect()),
        interactive_prompt_args: interactive_prompt_args
            .map(|a| a.iter().map(|s| (*s).into()).collect()),
        post_prompt_args: post_prompt_args.map(|a| a.iter().map(|s| (*s).into()).collect()),
        // 大多数 agent 没有独立的列模型命令；有的话由调用方后置设置
        // （`with_model_list`），避免给这个已有 9 个参数的构造函数再加一个。
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
