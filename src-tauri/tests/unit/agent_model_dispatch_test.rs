//! 静态护栏：`list_agent_models` 不得按 agent id 分派。
//!
//! # 为什么需要静态测试
//!
//! 旧实现是：
//!
//! ```ignore
//! if agent_id == "opencode" {
//!     return discover_opencode_models(None).await;
//! }
//! Ok(Vec::new())
//! ```
//!
//! 它的问题不是「只有 opencode 有实现」，而是**新增一个支持模型的 agent 必须回来
//! 改这个 if** —— 违背开闭原则。仓库里本来就有正确范式（`adapter_for` 按
//! `ChatStart` 类型分派 + `AgentAdapter` 默认方法 opt-in），只是没被用上。
//!
//! 行为测试抓不住这种回潮：只要 opencode 的用例还是绿的，把 if 加回去也没人发现
//! （除非恰好在测别的 agent）。所以判据只能是源码本身。

use std::fs;

/// 把注释剥掉 —— 文档里引用旧写法作为反例是合法的，不能算违规。
fn code_only(source: &str) -> String {
    source
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            !(trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn list_agent_models_does_not_dispatch_on_agent_id() {
    let source = fs::read_to_string("src/agent/commands.rs")
        .expect("read agent/commands.rs (run from src-tauri)");

    // 截取 `list_agent_models` 函数体：从签名到下一个 `#[tauri::command]`。
    let start = source
        .find("pub async fn list_agent_models(")
        .expect("list_agent_models must exist");
    let rest = &source[start..];
    let end = rest.find("#[tauri::command]").unwrap_or(rest.len());
    let body = code_only(&rest[..end]);

    assert!(
        !body.contains("agent_id =="),
        "list_agent_models 不得按 agent id 分派 —— 能力应挂在 ChatStart 上\n{body}"
    );
    assert!(
        !body.contains(r#""opencode""#),
        "list_agent_models 不得出现 opencode 字面量 —— 模型目录由适配器提供\n{body}"
    );
}

/// 能力必须来自适配器，而不是按 agent id 判断。
///
/// `list_models` 是 `AgentAdapter` 上的方法（早先是 `supports_model_selection` +
/// `model_catalog` + 独立的 `ModelCatalog` trait 三层，合并后只剩两个方法）。
#[test]
fn list_agent_models_asks_the_adapter_for_capability() {
    let source = fs::read_to_string("src/agent/commands.rs").expect("read agent/commands.rs");
    let start = source
        .find("pub async fn list_agent_models(")
        .expect("list_agent_models must exist");
    let rest = &source[start..];
    let end = rest.find("#[tauri::command]").unwrap_or(rest.len());
    let body = &rest[..end];

    assert!(
        body.contains("supports_model_selection()"),
        "必须经 supports_model_selection() 区分 SessionScoped / Unsupported"
    );
    assert!(
        body.contains("try_list_via_command"),
        "必须先尝试 agent 自己声明的列模型命令（与 chat 能力无关）"
    );
}

/// 换模型有**三处入口**，任何一处漏掉都会让「选了模型却不生效」。
///
/// 实测漏过两次：`Turn` 路径硬编码 `"model"`、`create` 路径直接不发。
/// 两处都没有行为测试能抓到（`create_with_io` 需要真实 IO），只能从源码结构判。
///
/// | 入口 | 漏掉的后果 |
/// | --- | --- |
/// | `create`（新会话首轮） | 打开 Chat 时选的模型不生效，要到第二轮才切 |
/// | `Turn`（后续轮次） | 换模型无效 |
/// | `SetConfigOption`（popover 控件） | 改推理档位无效 |
#[test]
fn every_model_switch_entry_point_uses_the_shared_judgement() {
    let source = fs::read_to_string("src/agent/chat/adapter/acp.rs")
        .expect("read adapter/acp.rs (run from src-tauri)");

    // create 路径：首轮 prompt 之前必须先切模型
    let create_body = source
        .split("// ── Send the initial prompt, then start the pump")
        .next()
        .expect("initial prompt marker must exist");
    assert!(
        create_body.contains("switch_model_frames"),
        "create 路径必须在首轮 prompt 前切模型 —— 否则打开 Chat 时选的模型不生效"
    );
    assert!(
        create_body.contains("ctx.model_id"),
        "create 路径必须读取 ctx.model_id"
    );

    // Turn 路径
    assert!(
        source.contains("SessionRequest::Turn { prompt, model_id }")
            && source.contains("switch_model_frames"),
        "Turn 路径必须走共享判定"
    );

    // 不允许任何入口硬编码 configId 字面量
    assert!(
        !source.contains(r#"&"model".to_string()"#) && !source.contains(r#""configId": "model""#),
        "不得硬编码 configId —— 必须取自会话状态（agent 的 id 不一定是 \"model\"）"
    );
}

/// 「列模型」与「能聊天」必须解耦。
///
/// `pi --list-models` 是纯 CLI 查询，在 `chat: None` 时照样能跑。而
/// `adapter_for` 对 `chat: None` 返回 `Err` —— 所以命令层**不能**先取 adapter
/// 再问模型列表，否则这类 agent 连问都问不到。
///
/// 变异实测：把顺序换回「先 adapter_for 再 list_models」，Pi 的列表立刻消失。
#[test]
fn model_list_does_not_require_chat_capability() {
    let source = fs::read_to_string("src/agent/commands.rs")
        .expect("read agent/commands.rs (run from src-tauri)");

    let start = source
        .find("pub async fn list_agent_models(")
        .expect("list_agent_models must exist");
    let rest = &source[start..];
    let end = rest.find("#[tauri::command]").unwrap_or(rest.len());
    let body = code_only(&rest[..end]);

    // 列模型命令必须**先于** adapter_for 被尝试
    let by_command = body
        .find("try_list_via_command")
        .expect("must try the declared model-list command");
    let adapter = body
        .find("adapter_for")
        .expect("must fall back to transport capability");
    assert!(
        by_command < adapter,
        "列模型命令必须在 adapter_for 之前尝试 —— 否则 chat: None 的 agent（如 Pi）\
         即使声明了 --list-models 也拿不到列表"
    );
}

/// `model_list_args` 是「独立列模型命令」的唯一声明点。
#[test]
fn pi_declares_its_model_list_command() {
    let source =
        fs::read_to_string("src/agent/builtin/providers.rs").expect("read builtin/providers.rs");
    assert!(
        source.contains(r#"&["--list-models"]"#),
        "Pi 必须声明 `--list-models` —— 它的 ACP 需要额外扩展，这条命令是当前\
         唯一能提前拿到模型列表的途径"
    );
}
