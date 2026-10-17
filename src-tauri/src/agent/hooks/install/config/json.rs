//! 用户配置的结构化合并器（父任务 design T7a 后半：客人义务升级）。
//!
//! **物理约束**：Claude / CodeBuddy / Qoder 的 hook 面在**用户的 `settings.json`** 里，
//! 是结构化合并而非独立文件。`10-12-agent-notify` 的 D7 曾明确「不取」此形态 ——
//! 本次接入必须**升级契约**，但不能降级架构：**独立 shim 文件仍是唯一写出的新文件**，
//! 本模块只负责在用户配置里增删**指向该 shim 的条目**，绝不触碰他人条目、
//! 绝不重写无法解析的文件。
//!
//! 分层：本文件是**纯 JSON 变换**（`Value` 进 → `Value` 出 + 回执），零 IO；
//! 读写、原子替换、权限继承在 `install::shim` 层。因此可 100% tempdir 直测（红线 13）。

use serde_json::{json, Value};

/// shim 的稳定路径片段 —— 识别「自家条目」的唯一判据。
///
/// 为什么按路径片段而非额外字段：hook 条目的 schema 由 CLI 拥有
/// （`matcher` / `hooks` / `timeout` / `async` / `if` …），我们**不能往里塞私有字段**
/// （会被 CLI 拒载或校验失败）。shim 文件名由 Neeko 固定生成（`neeko-status.mjs`，
/// 落在各 CLI 自己的配置目录），是天然稳定标记。
///
/// 为什么 shim 放 CLI 配置目录而非 `~/.neeko/`：① 每个 CLI 的安装面自包含，
/// 卸载只需动该目录；② 写入器无需穿透 `neeko_dir`（安装腿的动作函数只收
/// `(target, dir)` 两个事实）；③ 用户清空某个 CLI 的配置目录时连带清理，语义一致。
/// 模板本身仍是**同一份常量**（`templates::REPORT_SHIM`），磁盘上有几份不影响单一源。
pub const SHIM_MARKER: &str = "neeko-status.mjs";

/// 命令是否指向 Neeko 的 shim。
///
/// 判据是**路径段**而非裸子串：`neeko-status.mjs` 必须被路径分隔符或引号**前置**。
/// 只看子串会把 `node neeko-status.mjs`（相对路径、非 Neeko 生成）误判为自家条目 ——
/// 那会导致我们去删改别人的 hook。Windows 用 `\`，故两种分隔符都接受。
pub(crate) fn command_targets_shim(command: &str) -> bool {
    let mut rest = command;
    while let Some(idx) = rest.find(SHIM_MARKER) {
        let preceded_by_separator = matches!(
            rest[..idx].chars().next_back(),
            Some('/' | '\\' | '\'' | '"')
        );
        if preceded_by_separator {
            return true;
        }
        rest = &rest[idx + SHIM_MARKER.len()..];
    }
    false
}

/// 与 [`command_targets_shim`] 同一判据，但作用于**已拆分的 argv 元素**。
///
/// # 为什么要这一层
///
/// Codex 的 `notify` 是 argv 数组而非 shell 命令串，故 `config::toml` 只能逐元素判定。
/// 两个模块此前各写一份「是不是我们的 shim」的判据，且**标记清单已经漂移**：
/// 本模块只认 `SHIM_MARKER`（`neeko-status.mjs`，即真正落盘的文件名），`toml_merger`
/// 却多认一个模板文件名 `neeko-report.mjs` —— 后者从不作为任何 `file_name` 出现。
/// 同一契约两份实现且已不一致，正是「装了但探测说没有 / 反过来说别人的文件是我们的」
/// 这类缺陷的温床。故判据与标记常量**只在本模块定义一次**，`config::toml` 复用。
#[must_use]
pub fn entry_targets_shim(entry: &str) -> bool {
    command_targets_shim(entry)
}

/// 合并动作（策略集固定 → enum）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeAction {
    /// 插入/更新自家条目。
    Insert,
    /// 移除自家条目。
    Remove,
}

/// 一次合并的结果（机器可读，与既有 `HookApplyStatus` 同族，供前端分类）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    /// 新增/更新了条目。
    Changed,
    /// 条目已是最新（幂等命中）。
    Unchanged,
    /// 移除了条目。
    Removed,
    /// 无需处理 —— 含两种语义：移除时本就没有；或 **fail-safe 拒绝处理**（配置畸形）。
    Noop,
}

/// 从一个 hook 条目里取出它的**全部** `command` 值（分组形态 `{hooks:[…]}` 与裸 handler 都兼容）。
///
/// # 为什么是唯一的提取点
///
/// 条目有两种形态（Claude 规范的分组 `{matcher?, hooks:[{command,…}]}` 与防御性兼容的裸
/// handler `{command}`），而「从条目里找 command」有三个消费者：
/// - [`is_ours`]（判定归属，要**全部** command）；
/// - 状态腿的 `entry_command`（比对期望命令，取**第一条**）；
/// - 信任探针的条目定位。
///
/// 三处各写一份形态遍历 = 规范加一种形态时漏改一处，表现为「装进去了但探测说没有」。
/// 故形态知识**只在本模块定义一次**（与 [`command_targets_shim`] 同一理由）。
pub(crate) fn entry_commands(entry: &Value) -> Vec<&str> {
    match entry.get("hooks").and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .filter_map(|h| h.get("command"))
            .filter_map(Value::as_str)
            .collect(),
        None => entry
            .get("command")
            .and_then(Value::as_str)
            .into_iter()
            .collect(),
    }
}

/// 一个条目里**第一条** `command` 值（状态腿的比对基准）。
///
/// # 语义必须与 `entry_commands` 的"首个"不同（2026-10-16 复审修正）
///
/// 这里是「取**第一个 `command` 键**的值，它必须能解析为字符串」；而不是
/// 「取第一个**能解析为字符串**的 `command`」。二者在
/// `[{command: null}, {command: "x"}]` 上结论相反：前者 `None`，后者 `Some("x")`。
///
/// 差异会影响 `structured_status` 的 present 判定 —— 一个 `command: null` 的畸形条目
/// 若被"跳过"而认了后面的条目，就会把不生效的配置报成已安装。故保持原语义。
#[must_use]
pub fn entry_command(entry: &Value) -> Option<&str> {
    match entry.get("hooks").and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .find_map(|h| h.get("command"))
            .and_then(Value::as_str),
        None => entry.get("command").and_then(Value::as_str),
    }
}

/// 判断一个 hook 条目是否属于 Neeko（其任一 command 含 shim 标记）。
///
/// 判据只看 `command` 字符串 —— 形态遍历复用 [`entry_commands`]（不重复实现）。
fn is_ours(entry: &Value) -> bool {
    entry_commands(entry)
        .iter()
        .any(|c| command_targets_shim(c))
}

/// 构造一条指向 shim 的 hook 条目（schema 对齐 Claude Code 规范；CodeBuddy/Qoder 同形）。
///
/// `matcher: None` 时**不写该字段** —— 不是写空串：Claude 规范里「不使用 matcher 的事件」
/// 与「matcher 为空串」语义不同（前者由 CLI 按事件类型自行判定，后者可能被当作字面匹配）。
#[must_use]
pub(crate) fn build_entry(matcher: Option<&str>, command: &str) -> Value {
    let inner = json!({
        "type": "command",
        "command": command,
        "timeout": 10,
        // 显式 async：shim 本身 800ms 超时且全吞异常，但 async 让 CLI 不等待子进程，
        // 双重保证「绝不阻塞用户终端里的 agent」（design T5 / R6.2）。
        "async": true,
    });
    let mut group = json!({ "hooks": [inner] });
    if let Some(m) = matcher {
        group["matcher"] = json!(m);
    }
    group
}

/// 在 `hooks.<native_event>` 数组里插入/更新（或移除）一条指向 shim 的条目。
///
/// `root_key` = 事件挂在配置的哪个根键下（由 `InstallShape::Structured` 携带，
/// 见 `targets::InstallShape` 的字段说明）。通用模块**不猜**这个键名。
///
/// 不变量（全部有单测钉死，对应父任务 AC3）：
/// 1. **他人条目逐字保留**（同事件下 orca / clawd / superset 的条目不受影响，含 `http` 型）；
/// 2. **fail-safe**：`hooks` 不是对象、或某事件不是数组 → 返回 `Noop` 且**原样保留**
///    （调用方据此跳过写盘）；
/// 3. **幂等 + 收敛**：已存在且 command 一致 → `Unchanged`（不产生写盘）；
///    多条自家条目 → 收敛到恰好一条（防历史版本累积）；
/// 4. **空数组清理**：移除后 `hooks.<event>` 为空则删该键，不留空壳。
pub fn apply(
    config: &mut Value,
    root_key: &str,
    native_event: &str,
    matcher: Option<&str>,
    command: &str,
    action: MergeAction,
) -> MergeOutcome {
    let Some(root) = config.as_object_mut() else {
        return MergeOutcome::Noop; // 非对象配置：拒绝处理
    };
    let hooks = root.entry(root_key).or_insert_with(|| json!({}));
    let Some(hooks) = hooks.as_object_mut() else {
        return MergeOutcome::Noop; // hooks 非对象：拒绝（不破坏用户结构）
    };

    // 事件值非数组（如对象/标量）同样拒绝 —— 只接受数组形态，避免把对象当数组改。
    let existing = match hooks.get(native_event) {
        None => None,
        Some(Value::Array(list)) => Some(list.clone()),
        Some(_) => return MergeOutcome::Noop,
    };
    let mut list = existing.clone().unwrap_or_default();

    match action {
        MergeAction::Insert => {
            let desired = build_entry(matcher, command);
            let ours: Vec<usize> = list
                .iter()
                .enumerate()
                .filter(|(_, e)| is_ours(e))
                .map(|(i, _)| i)
                .collect();
            if ours.len() == 1 && list[ours[0]] == desired {
                return MergeOutcome::Unchanged; // 幂等命中
            }
            // 收敛到恰好一条：逆序删除，索引不漂移。
            for idx in ours.into_iter().rev() {
                list.remove(idx);
            }
            list.push(desired);
        }
        MergeAction::Remove => {
            let before = list.len();
            list.retain(|e| !is_ours(e));
            if list.len() == before {
                return MergeOutcome::Noop; // 本就没有
            }
        }
    }

    if list.is_empty() {
        hooks.remove(native_event); // 不留空数组
    } else {
        hooks.insert(native_event.to_string(), Value::Array(list));
    }
    match action {
        MergeAction::Insert => MergeOutcome::Changed,
        MergeAction::Remove => MergeOutcome::Removed,
    }
}

// ── TDD：四条不变量 + 幂等收敛 + schema 形状（夹具为内联 JSON，无路径依赖）────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试薄包装：根键固定为 `"hooks"`（Claude 兼容面的真实值）。
    ///
    /// 让用例只表达**合并语义**，不必每次重复根键 —— 也顺带证明根键只影响
    /// 「事件挂在哪个键下」，不影响任何合并规则。
    fn apply(
        config: &mut Value,
        native_event: &str,
        matcher: Option<&str>,
        command: &str,
        action: MergeAction,
    ) -> MergeOutcome {
        super::apply(config, "hooks", native_event, matcher, command, action)
    }

    const CMD: &str = "node \"/home/u/.claude/neeko-status.mjs\" claude approval_requested";

    /// 用户既有配置：含他人条目（orca 的 command + superset 的 http），必须逐字保留。
    fn cfg() -> Value {
        json!({
            "env": { "ANTHROPIC_BASE_URL": "https://example.invalid" },
            "hooks": {
                "PermissionRequest": [
                    { "matcher": "*", "hooks": [
                        { "type": "command", "command": "/Users/x/.orca/agent-hooks/claude-hook.sh" }]},
                    { "matcher": "", "hooks": [
                        { "type": "http", "url": "http://127.0.0.1:23333/permission" }]}
                ],
                "Stop": [ { "hooks": [ { "type": "command", "command": "echo hi" } ] } ]
            }
        })
    }

    /// AC3① 插入后他人条目逐字保留（含 `http` 型）—— 客人义务的核心不变量。
    #[test]
    fn insert_preserves_foreign_entries_verbatim() {
        let mut c = cfg();

        let foreign_orca = c["hooks"]["PermissionRequest"][0].clone();
        let foreign_http = c["hooks"]["PermissionRequest"][1].clone();

        assert_eq!(
            apply(
                &mut c,
                "PermissionRequest",
                Some("*"),
                CMD,
                MergeAction::Insert
            ),
            MergeOutcome::Changed
        );

        let list = c["hooks"]["PermissionRequest"].as_array().expect("array");
        assert_eq!(list.len(), 3, "两条他人 + 一条自家");
        assert_eq!(list[0], foreign_orca, "他人 command 条目必须逐字不变");
        assert_eq!(list[1], foreign_http, "他人 http 条目必须逐字不变");
        assert!(is_ours(&list[2]));
        // 无关键同样不受影响。
        assert_eq!(
            c["env"]["ANTHROPIC_BASE_URL"],
            json!("https://example.invalid")
        );
    }

    /// **键序保留**（2026-10-16 审查发现）：`settings.json` 是**用户的文件**，
    /// 重排它的键序虽然语义等价，但对用户是可见的噪音（diff 里满屏假变更）。
    ///
    /// 判据落在**序列化往返**上，而非内部 `Value` 结构：真正影响用户的是
    /// `to_string_pretty` 的输出。故这里显式走一次往返。
    ///
    /// 反证：去掉 `serde_json` 的 `preserve_order` feature（`Cargo.toml`），
    /// 键会被排成字典序（`aaa` 跑最前），本用例必红。
    #[test]
    fn serialization_preserves_user_key_order() {
        let raw = r#"{"zzz":1,"hooks":{"Stop":[{"command":"foreign"}]},"aaa":2}"#;
        let mut c: Value = serde_json::from_str(raw).expect("parse");
        assert_eq!(
            apply(&mut c, "Stop", None, CMD, MergeAction::Insert),
            MergeOutcome::Changed
        );
        let out = serde_json::to_string_pretty(&c).expect("ser");
        let first_key = out
            .lines()
            .nth(1)
            .and_then(|l| l.trim().split('"').nth(1))
            .expect("first key");
        assert_eq!(
            first_key, "zzz",
            "用户原本的首个键必须仍在最前（顺序是用户文件的一部分）:\n{out}"
        );
    }

    /// AC3③ 幂等：同 command 再插一次 → `Unchanged`（调用方据此不写盘，避免 mtime 抖动）。
    #[test]
    fn insert_is_idempotent() {
        let mut c = cfg();
        assert_eq!(
            apply(&mut c, "Stop", None, CMD, MergeAction::Insert),
            MergeOutcome::Changed
        );
        assert_eq!(
            apply(&mut c, "Stop", None, CMD, MergeAction::Insert),
            MergeOutcome::Unchanged
        );
        assert_eq!(
            c["hooks"]["Stop"].as_array().expect("a").len(),
            2,
            "不得累积"
        );
    }

    /// AC3③ 收敛：历史版本残留多条自家条目 → 收敛到恰好一条。
    ///
    /// 反证：把收敛逻辑删掉（只 push），本用例会得到 3 条自家条目。
    #[test]
    fn insert_converges_duplicate_own_entries() {
        let mut c = json!({ "hooks": { "Stop": [
            { "hooks": [ { "command": "node /x/.claude/neeko-status.mjs claude turn_completed" } ]},
            { "hooks": [ { "command": "node /x/.claude/neeko-status.mjs claude turn_completed" } ]},
            { "hooks": [ { "command": "echo foreign" } ]}
        ]}});
        assert_eq!(
            apply(&mut c, "Stop", None, CMD, MergeAction::Insert),
            MergeOutcome::Changed
        );
        let list = c["hooks"]["Stop"].as_array().expect("a");
        let ours = list.iter().filter(|e| is_ours(e)).count();
        assert_eq!(ours, 1, "必须收敛到一条，否则每次升级累积一条");
        assert_eq!(list.len(), 2, "他人的 `echo foreign` 保留");
    }

    /// AC3④ 移除：只删自家；空数组删键（不留空壳）；他人保留。
    #[test]
    fn remove_only_ours_and_prunes_empty_event() {
        let mut c = cfg();
        apply(
            &mut c,
            "PermissionRequest",
            Some("*"),
            CMD,
            MergeAction::Insert,
        );
        apply(&mut c, "Stop", None, CMD, MergeAction::Insert);

        // Stop 原本有他人 `echo hi`：移除自家后该键仍在，且只剩他人一条。
        assert_eq!(
            apply(&mut c, "Stop", None, CMD, MergeAction::Remove),
            MergeOutcome::Removed
        );
        let stop = c["hooks"]["Stop"].as_array().expect("a");
        assert_eq!(stop.len(), 1, "他人条目保留");
        assert!(!is_ours(&stop[0]));

        assert_eq!(
            apply(
                &mut c,
                "PermissionRequest",
                Some("*"),
                CMD,
                MergeAction::Remove
            ),
            MergeOutcome::Removed
        );
        assert_eq!(
            c["hooks"]["PermissionRequest"].as_array().expect("a").len(),
            2,
            "他人两条保留"
        );

        // 再移除一次：本就没有 → Noop（不产生噪音回执）。
        assert_eq!(
            apply(&mut c, "Stop", None, CMD, MergeAction::Remove),
            MergeOutcome::Noop
        );
    }

    /// AC3④ 空数组删键：某事件下**只有**自家条目时，移除后整键消失（不留空壳）。
    #[test]
    fn remove_prunes_event_key_when_only_ours() {
        let mut c = json!({ "hooks": { "Stop": [] } });
        apply(&mut c, "Stop", None, CMD, MergeAction::Insert);
        assert_eq!(c["hooks"]["Stop"].as_array().expect("a").len(), 1);

        assert_eq!(
            apply(&mut c, "Stop", None, CMD, MergeAction::Remove),
            MergeOutcome::Removed
        );
        assert!(
            c["hooks"].get("Stop").is_none(),
            "空数组必须删键（不留空壳）: {c}"
        );
    }

    /// AC3② fail-safe：畸形配置一律 `Noop` 且**原样保留**，绝不破坏用户结构。
    #[test]
    fn malformed_config_is_never_destroyed() {
        // hooks 非对象。
        let mut broken = json!({ "hooks": "not-an-object" });
        let snapshot = broken.clone();
        assert_eq!(
            apply(&mut broken, "Stop", None, CMD, MergeAction::Insert),
            MergeOutcome::Noop
        );
        assert_eq!(broken, snapshot, "无法解析的结构必须原样保留");

        // 顶层非对象。
        let mut scalar = json!(42);
        assert_eq!(
            apply(&mut scalar, "Stop", None, CMD, MergeAction::Insert),
            MergeOutcome::Noop
        );
        assert_eq!(scalar, json!(42));

        // 事件值非数组（对象形态）→ 同样拒绝，不把对象当数组改。
        let mut weird = json!({ "hooks": { "Stop": { "oops": true } } });
        let snap = weird.clone();
        assert_eq!(
            apply(&mut weird, "Stop", None, CMD, MergeAction::Insert),
            MergeOutcome::Noop
        );
        assert_eq!(weird, snap);

        // 移除路径同样 fail-safe（不得把畸形配置当空配置处理）。
        let mut broken2 = json!({ "hooks": [1, 2, 3] });
        let snap2 = broken2.clone();
        assert_eq!(
            apply(&mut broken2, "Stop", None, CMD, MergeAction::Remove),
            MergeOutcome::Noop
        );
        assert_eq!(broken2, snap2);
    }

    /// 条目 schema 形状：`{matcher?, hooks:[{type:command, command, timeout, async}]}`。
    /// `matcher: None` 时**不写该字段**（不是写空串 —— 语义不同）。
    #[test]
    fn entry_shape_matches_cli_schema() {
        let with = build_entry(Some("*"), CMD);
        assert_eq!(with["matcher"], json!("*"));
        assert_eq!(with["hooks"][0]["type"], json!("command"));
        assert_eq!(with["hooks"][0]["command"], json!(CMD));
        assert_eq!(with["hooks"][0]["async"], json!(true));
        assert_eq!(with["hooks"][0]["timeout"], json!(10));

        let without = build_entry(None, CMD);
        assert!(
            without.get("matcher").is_none(),
            "无 matcher 的事件不得写该字段"
        );
        assert_eq!(without["hooks"][0]["command"], json!(CMD));
    }

    /// 自家识别：只看 command 里的 **shim 路径段**，且兼容「分组形态」与「裸 handler」。
    #[test]
    fn ownership_detection_covers_both_shapes() {
        let grouped = json!({ "matcher": "*", "hooks": [
            { "type": "command", "command": format!("node '/x/.claude/{SHIM_MARKER}' claude approval_requested") }]});
        assert!(is_ours(&grouped));

        let bare = json!({ "type": "command", "command": format!("node /x/.claude/{SHIM_MARKER} claude Stop") });
        assert!(is_ours(&bare));

        // Windows 路径分隔符同样识别。
        let windows = json!({ "hooks": [
            { "type": "command", "command": format!("node \"C:\\Users\\x\\.claude\\{SHIM_MARKER}\" claude Stop") }]});
        assert!(is_ours(&windows));

        // 他人条目（路径不含 shim 标记）不得被误判。
        let foreign = json!({ "hooks": [
            { "type": "command", "command": "/Users/x/.orca/agent-hooks/claude-hook.sh" }]});
        assert!(!is_ours(&foreign));

        // **关键**：裸文件名（相对路径、非 Neeko 生成）不得被误判 —— 否则我们会去删改
        // 别人的 hook。判据是路径段，不是裸子串。
        let other = json!({ "hooks": [{ "type": "command", "command": "node neeko-status.mjs" }]});
        assert!(!is_ours(&other), "裸文件名不得被当作自家条目");

        // 名字里带该子串但不是该文件（如 `xneeko-status.mjs`）也不得误判。
        let prefix = json!({ "hooks": [
            { "type": "command", "command": "/x/.claude/xneeko-status.mjs claude Stop" }]});
        assert!(!is_ours(&prefix), "子串前缀不得被当作自家条目");
    }

    /// `entry_command` 的语义边界：**首个 `command` 键**的值必须可解析，否则 `None`。
    ///
    /// 反证：若实现成「取第一个能解析为字符串的 command」（`filter_map(as_str).next()`），
    /// 本用例会得到 `Some("x")` —— 一个 `command: null` 的畸形条目被跳过，
    /// 让 `structured_status` 把不生效的配置报成已安装。
    #[test]
    fn entry_command_does_not_skip_a_null_command() {
        let with_null_first = json!({ "hooks": [
            { "command": null },
            { "command": "x" }
        ]});
        assert_eq!(
            entry_command(&with_null_first),
            None,
            "首个 command 键存在但为 null → 必须 None（不得跳到后面那条）"
        );

        // 首个键**不存在**时才看下一个（find_map 语义：找第一个有 command 键的条目）。
        let missing_first = json!({ "hooks": [
            { "type": "command" },
            { "command": "x" }
        ]});
        assert_eq!(entry_command(&missing_first), Some("x"));

        // 裸 handler 形态。
        assert_eq!(entry_command(&json!({ "command": "y" })), Some("y"));
        assert_eq!(entry_command(&json!({ "command": 42 })), None);
    }

    /// **根键是数据**（红线 15 精神）：换一个根键名，合并规则完全不变。
    ///
    /// 反证：把 `root_key` 重新写死成 `"hooks"`，本用例会读不到 `custom` 下的条目。
    #[test]
    fn root_key_is_data_not_hardcoded() {
        let mut c = json!({ "model": "x" });
        assert_eq!(
            super::apply(&mut c, "custom", "Stop", None, CMD, MergeAction::Insert),
            MergeOutcome::Changed
        );
        assert_eq!(
            c["custom"]["Stop"].as_array().expect("array").len(),
            1,
            "事件必须挂在声明的根键下: {c}"
        );
        assert!(c.get("hooks").is_none(), "不得凭空写出非声明的根键: {c}");

        // 移除同样按声明的根键工作，且空数组删键。
        assert_eq!(
            super::apply(&mut c, "custom", "Stop", None, CMD, MergeAction::Remove),
            MergeOutcome::Removed
        );
        assert!(c["custom"].get("Stop").is_none(), "空数组必须删键: {c}");
    }

    /// 空配置从零构建：`hooks` 键缺失时自动创建（首次安装路径）。
    #[test]
    fn insert_creates_hooks_key_when_absent() {
        let mut c = json!({ "model": "x" });
        assert_eq!(
            apply(&mut c, "Stop", None, CMD, MergeAction::Insert),
            MergeOutcome::Changed
        );
        assert_eq!(c["hooks"]["Stop"].as_array().expect("a").len(), 1);
        assert_eq!(c["model"], json!("x"), "无关键保留");
    }
}
