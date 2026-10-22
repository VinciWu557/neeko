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
        "必须经 supports_model_selection() 区分 SessionScoped / Unsupported\n\
         该判据已改为由 `chat_capabilities().config.shows_controls()` 派生 —— \
         不要再给 adapter 开单独的 override（那会造出可与能力快照矛盾的真相）"
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
/// 独立列模型命令（`model_list_args`）是纯 CLI 查询，在 `chat: None` 时照样能跑。
/// 而 `adapter_for` 对 `chat: None` 返回 `Err` —— 所以命令层**不能**先取 adapter
/// 再问模型列表，否则这类 agent 连问都问不到。
///
/// 变异实测：把顺序换回「先 adapter_for 再 list_models」，声明了该命令的 agent
/// 列表立刻消失。
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

    // 两步仍然独立：`adapter_for` 只用来**问能力位**，不决定能否列模型；
    // 命令是在 `!session_scoped` 里被尝试的（见
    // `session_model_capability_overrides_the_cli_bypass`）。
    //
    // 这条护栏锁的是「两者都出现」，而不是先后 —— 先后关系已由互斥裁决那条
    // 用例钉住（`scoped < guarded < cmd`）。
    assert!(
        body.contains("adapter_for") && body.contains("try_list_via_command"),
        "列模型必须同时保留两条途径：会话内能力位 + 独立的 CLI 命令"
    );
    assert!(
        body.contains("supports_model_selection"),
        "能力位必须取自适配器（`supports_model_selection`），不能按 agent id 分派"
    );
}

/// **模型列表的权威来源是 agent 协议本身，不是我们 spawn 的二进制。**
///
/// Pi 的 rpc 协议有 `get_available_models`，会话一建立就返回**裸名** id
///（`deepseek-flash`），与 `set_config_option` 要的 value 同形。
///
/// 而 `pi --list-models` 走的是我们自己的表格解析，给出的是 `provider/model`
/// 复合串（如 `cline/cohere/north-mini-code:free`）—— 形状不同，喂回
/// `set_model` 会被 agent 拒绝。两条来源并存必然漂移，所以对声明了会话内
/// 模型能力的 transport **不再**声明 CLI 旁路。
///
/// 变异实测：把 `with_model_list(..., &["--list-models"])` 加回 Pi
/// → 本用例变红。
#[test]
fn transports_with_session_models_do_not_declare_a_cli_bypass() {
    let source =
        fs::read_to_string("src/agent/builtin/providers.rs").expect("read builtin/providers.rs");
    assert!(
        !source.contains(r#"&["--list-models"]"#),
        "Pi 不得声明 `--list-models` —— 模型列表由 rpc 的 `get_available_models`\
         提供（裸名 id，与会话配置项同形）。CLI 旁路给的是 `provider/model` 复合串，\
         两者并存会让「显示的列表」与「能写回的 id」形状不一致"
    );
}

/// **会话内模型能力优先于 CLI 旁路**（消费点裁决）。
///
/// # 为什么必须在消费点裁决
///
/// `~/.neeko/config.json` 的 `agentOverrides` 是用户编辑时的**整份快照**。
/// 内置定义改过之后（Pi 删掉 `model_list_args`），旧快照仍会把 `--list-models`
/// 带回来 —— 实测用户机器上就是这样，于是模型列表又变回
/// `cline/cohere/north-mini-code:free` 这类 `provider/model` 复合串，与
/// `set_config_option` 要的裸名不匹配，点选写不进去。
///
/// # 判据是 `supports_session_config`，**不是** `supports_model_selection`
///
/// 后者是 `shows_controls()`，而 `PerTurn`（opencode serve）也为真。拿它做门控
/// 会把 serve 的 `models --verbose` 快速路径一并关掉 —— 而 `PerTurn` 又不是
/// `SessionConfig`，两条路径全被封，模型列表恒空。
///
/// 两个方向本来就不对称：
///
/// | 能力 | 目录 id 形状 | CLI 目录能否共存 |
/// | --- | --- | --- |
/// | `SessionConfig`（ACP / Pi） | 裸名 | 否 |
/// | `PerTurn`（serve） | `provider/model` | 是（`model_slug_split` 按此形状拆）|
///
/// 变异验证：把门控换回 `supports_model_selection()` → 本用例变红。
#[test]
fn session_model_capability_overrides_the_cli_bypass() {
    let source = fs::read_to_string("src/agent/commands.rs")
        .expect("read agent/commands.rs (run from src-tauri)");
    let start = source
        .find("pub async fn list_agent_models(")
        .expect("list_agent_models must exist");
    let rest = &source[start..];
    let end = rest.find("#[tauri::command]").unwrap_or(rest.len());
    let body = code_only(&rest[..end]);

    // 必须先算出 session_scoped，再以它门控 CLI 旁路
    let scoped = body
        .find("let session_scoped")
        .expect("must compute session_scoped first");
    let guarded = body
        .find("if !session_scoped")
        .expect("CLI bypass must be gated on !session_scoped");
    let cmd = body
        .find("list_models")
        .expect("must try the adapter catalog");
    assert!(
        scoped < guarded && guarded < cmd,
        "CLI 旁路必须在 `!session_scoped` 门控之内 —— 否则旧 agentOverrides 里的 \
         --list-models 会盖掉会话内的权威列表，给出 provider/model 复合串"
    );

    // 门控判据必须是 `SessionConfig`，不能是 `shows_controls()`（PerTurn 也为真）
    let scoped_stmt = &body[scoped..guarded];
    assert!(
        scoped_stmt.contains("supports_session_config()"),
        "互斥判据必须是 supports_session_config() —— 用 supports_model_selection() \
         会把 PerTurn（serve）的 models --verbose 快速路径也关掉，导致它的模型列表恒空\n{scoped_stmt}"
    );
    assert!(
        !scoped_stmt.contains("supports_model_selection()"),
        "互斥判据不得用 supports_model_selection()（shows_controls 对 PerTurn 也为真）\n{scoped_stmt}"
    );
}

/// **会话外模型目录的唯一入口是 `AgentAdapter::list_models`。**
///
/// 早先 `list_agent_models` 绕过 adapter 直接读 `config.model_list_args`，
/// 后果是双向的：
///
/// 1. `AgentAdapter::list_models` 与 `ServeAdapter` 的覆盖一起变成**死代码**；
/// 2. opencode 的 `models --verbose` 快速路径（它的 `model_list_args` 是 `None`）
///    永远走不到 —— `PerTurn` 传输的模型列表恒为空。
///
/// 变异验证：把 `a.list_models(&agent)` 换回 `try_list_via_command(&agent)`
/// 并且不区分有无 adapter → 本用例变红。
#[test]
fn out_of_session_catalog_goes_through_the_adapter() {
    let source = fs::read_to_string("src/agent/commands.rs")
        .expect("read agent/commands.rs (run from src-tauri)");
    let start = source
        .find("pub async fn list_agent_models(")
        .expect("list_agent_models must exist");
    let rest = &source[start..];
    let end = rest.find("#[tauri::command]").unwrap_or(rest.len());
    let body = code_only(&rest[..end]);

    assert!(
        body.contains("a.list_models(&agent)"),
        "会话外目录必须经 adapter 的 list_models —— 它是可覆盖的，\
         「这个 transport 有没有会话外目录」应该是一个局部决策\n{body}"
    );
    assert!(
        body.contains("try_list_via_command"),
        "`chat: None` 的纯 CLI agent 没有 adapter，必须退回它声明的 model_list_args\n{body}"
    );
    // Unsupported 是「没有会话外目录」这个合法答案，不是失败 —— 不得当成错误上抛
    assert!(
        body.contains("Err(AppError::Unsupported(_)) => None"),
        "Unsupported 必须降级为「继续走下一步」，否则 ACP / Pi 会被报成错误\n{body}"
    );
}
