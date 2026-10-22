//! 内置 Agent 契约测试：数量、完整性、能力矩阵与特例。

use crate::common::agent::types::ChatStart;

use super::{builtin_configs, config_map, default_configs};

#[test]
fn provides_eleven_builtin_configs() {
    assert_eq!(builtin_configs().len(), 11);
}

#[test]
fn serialized_configs_keep_is_builtin_and_chat() {
    // IPC 载荷契约：is_builtin 必须为 true（前端 filter 依据）；chat 序列化为
    // 小写字符串或省略（null 被 skip）。防止将来 serde 属性改动悄悄破坏前端。
    for c in builtin_configs() {
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(
            json["is_builtin"].as_bool(),
            Some(true),
            "{} is_builtin lost in serialization",
            c.id
        );
        if c.chat.is_some() {
            assert!(
                json["chat"].as_str().is_some(),
                "{} chat should serialize as string",
                c.id
            );
        }
    }
}

#[test]
fn default_configs_aliases_builtin() {
    assert_eq!(default_configs().len(), 11);
}

#[test]
fn all_configs_have_complete_contract() {
    for c in builtin_configs() {
        assert!(!c.id.is_empty(), "id empty");
        assert!(!c.name.is_empty(), "{} name empty", c.id);
        // mockAgent 为进程内 agent，允许空 command（无 CLI 能力）。
        if c.id != "mockAgent" {
            assert!(!c.command.is_empty(), "{} command empty", c.id);
        }
        assert!(!c.deploy.skills.is_empty(), "{} deploy.skills empty", c.id);
        assert!(c.is_builtin, "{} should be builtin", c.id);
    }
}

#[test]
fn config_map_links_ids() {
    let map = config_map();
    assert_eq!(map.len(), 11);
    assert!(map.contains_key("opencode"));
    assert!(map.contains_key("claude-code"));
    assert!(!map.contains_key("deepseek-harness"));
}

#[test]
fn opencode_interactive_prompt_form_is_tui() {
    let c = config_map();
    let opencode = c.get("opencode").expect("opencode config");
    // 交互式（TUI）形态：`opencode --prompt "<prompt>"`（打开 CLI 并预填 prompt）——
    // 由数据（interactive_prompt_args）承载，前端不做 agent 特判。
    assert_eq!(
        opencode.interactive_prompt_args,
        Some(vec!["--prompt".to_string()])
    );
    // headless 形态保持不动（AI commit 等后台一次性执行用）。
    assert_eq!(
        opencode.prompt_args,
        Some(vec![
            "run".to_string(),
            "--pure".to_string(),
            "--dangerously-skip-permissions=true".to_string(),
            "-f".to_string(),
        ])
    );
}

#[test]
fn cli_agents_default_to_no_interactive_form() {
    for c in builtin_configs() {
        if c.id == "opencode" {
            continue;
        }
        assert_eq!(c.interactive_prompt_args, None, "{} 未声明交互式形态", c.id);
    }
}

#[test]
fn chat_agents_are_exactly_these() {
    // 这个清单是刻意的：每加一个 chat agent 都要在这里显式登记。
    // 它防止「某个 agent 意外获得了 chat 能力」——那种变化会悄悄改变
    // Chat 页面的 agent 选择器内容，而没有任何测试会察觉。
    let chat: Vec<String> = builtin_configs()
        .into_iter()
        .filter(|c| c.is_chat_agent())
        .map(|c| c.id)
        .collect();
    assert_eq!(
        chat,
        vec![
            "opencode".to_string(),
            "pi".to_string(),
            "mockAgent".to_string()
        ]
    );
}

/// Pi 走**私有 rpc 协议**，不是 ACP —— 它是单进程直连，不依赖 `pi-acp` 中间层。
#[test]
fn pi_uses_the_private_rpc_transport() {
    let c = config_map();
    let pi = c.get("pi").expect("pi config");
    assert_eq!(pi.chat, Some(crate::common::agent::types::ChatStart::PiRpc));
    // **不声明 CLI 列模型命令**：模型列表由 rpc 的 `get_available_models` 提供，
    // 它给的是裸名 id（与会话配置项同形）。CLI 表格那条路径给的是
    // `provider/model` 复合串，两条来源并存会让「显示的列表」与「能写回的 id」
    // 形状不一致（实测会得到 `Model not found: provider/provider/model`）。
    // 表格解析器已删（见 `model_discovery::pi_table_output_is_not_parsed_any_more`）。
    assert_eq!(pi.model_list_args, None);
}

#[test]
fn opencode_defaults_to_serve_chat() {
    let c = config_map();
    let opencode = c.get("opencode").expect("opencode config");
    assert_eq!(opencode.chat, Some(ChatStart::Serve));
    assert!(opencode.is_cli_agent());
    assert!(opencode.is_headless_agent());
    assert_eq!(
        opencode.skill_path.as_deref(),
        Some("~/.config/opencode/skills")
    );
}

#[test]
fn mock_agent_is_chat_only() {
    let c = config_map();
    let mock = c.get("mockAgent").expect("mockAgent config");
    assert_eq!(mock.chat, Some(ChatStart::Mock));
    assert!(!mock.is_cli_agent(), "mockAgent 无 CLI 能力");
    assert!(!mock.is_headless_agent(), "mockAgent 无 Headless 能力");
    assert!(mock.detection.is_none(), "mockAgent 不可检测（恒已安装）");
}

#[test]
fn all_cli_agents_support_headless() {
    for c in builtin_configs() {
        if c.is_cli_agent() {
            assert!(c.is_headless_agent(), "{} 缺 prompt_args", c.id);
        }
    }
}

#[test]
fn special_skill_paths_preserved() {
    let map = config_map();
    assert_eq!(
        map.get("opencode").unwrap().skill_path.as_deref(),
        Some("~/.config/opencode/skills")
    );
    assert_eq!(
        map.get("claude-code").unwrap().skill_path.as_deref(),
        Some("~/.claude/skills")
    );
    assert_eq!(
        map.get("gemini").unwrap().skill_path.as_deref(),
        Some("~/.gemini/skills")
    );
}

#[test]
fn mcp_and_commands_deploy_capabilities() {
    let map = config_map();
    // claude-code 支持三类部署。
    let cc = map.get("claude-code").unwrap();
    assert!(cc.deploy.supports_mcp());
    assert!(cc.deploy.supports_commands());
    // mockAgent 仅 skill 部署。
    let mock = map.get("mockAgent").unwrap();
    assert!(!mock.deploy.supports_mcp());
    assert!(!mock.deploy.supports_commands());
}
