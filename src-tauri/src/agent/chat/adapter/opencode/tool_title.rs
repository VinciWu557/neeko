//! 工具标题渲染 —— **两个协议共用的唯一实现**。
//!
//! 1.x 与 2.x 的工具事件形状完全不同：
//!
//! | 协议 | 名字 | 输入 |
//! | --- | --- | --- |
//! | V1 `message.part.updated` | `part.tool` | `part.state.input` |
//! | V2 `session.tool.called` | 缓存自 `session.tool.input.started.name` | `data.input` |
//!
//! 但「bash 显示完整命令 / read 显示路径 / task 显示 `Type Task: desc`」这些
//! **呈现规则与协议无关**。放在这里而不是各写一份：两版的用户看到的是同一张卡片，
//! 行为分叉就是「换个 opencode 版本工具卡片长得不一样」这种说不清的差异。

/// Human-readable tool title derived from the tool name + its input.
///
/// 入参刻意拆成 `(tool, input)` 而不是整个 part：两个协议的 part 形状不同
/// （V1 是 `{tool, state:{input}}`，V2 是 `{name}` + `{input}` 分两个事件），
/// 但「怎么把 input 渲染成标题」这件事两版完全一致 —— 那部分才是本函数的职责。
pub(super) fn tool_title(tool: &str, input: Option<&serde_json::Value>) -> String {
    let tool = tool.to_string();
    // task (subagent spawn) → "Type Task" + description（对齐 opencode TUI 的 `{type} Task`）。
    if tool == "task" {
        let sub_type = input
            .and_then(|i| i.get("subagent_type"))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or("general");
        let desc = input
            .and_then(|i| i.get("description"))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty());
        return match desc {
            Some(d) => format!("{sub_type} Task: {d}"),
            None => format!("{sub_type} Task"),
        };
    }
    // todowrite → "N todos"（对齐 opencode 完成态 title）。
    if tool == "todowrite" {
        if let Some(count) = input
            .and_then(|i| i.get("todos"))
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
        {
            return format!("{count} todos");
        }
        return "todo".to_string();
    }
    // bash / run_command → 完整命令（`command` 支持 string 或数组；另兼容
    // `script` / `cmd` 字段），确保命令卡片能展示「执行了什么」而非工具名。
    if tool == "bash" || tool == "run_command" {
        if let Some(cmd) = command_from_input(input) {
            return cmd;
        }
    }
    // read_file / read → filePath / path / file（read 操作折叠标题 `read <路径>`）。
    for key in ["command", "filePath", "path", "file", "pattern"] {
        if let Some(v) = input
            .and_then(|i| i.get(key))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
        {
            return v.to_string();
        }
    }
    tool
}

/// 从 bash 工具的 input 提取命令字符串：`command`（string 或数组）、
/// `script`、`cmd`。均缺省时返回 `None`（调用方回退到工具名）。
pub(super) fn command_from_input(input: Option<&serde_json::Value>) -> Option<String> {
    let i = input?;
    if let Some(v) = i.get("command") {
        match v {
            serde_json::Value::String(s) if !s.is_empty() => return Some(s.clone()),
            serde_json::Value::Array(arr) => {
                let parts: Vec<&str> = arr.iter().filter_map(|x| x.as_str()).collect();
                if !parts.is_empty() {
                    return Some(parts.join(" "));
                }
            }
            _ => {}
        }
    }
    for key in ["script", "cmd"] {
        if let Some(s) = i
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            return Some(s.to_string());
        }
    }
    None
}
