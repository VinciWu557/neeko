//! CLI 侧「hook 信任门」的只读探测（**CLI 无关**）。
//!
//! # 为什么单独一个模块
//!
//! 探测逻辑本身与任何 CLI 无关 —— 它只做两件事：
//!
//! 1. 在 hooks 文件里**定位我们自己的条目**（同一判据 [`crate::agent::hooks::install::config::json`] 已提供，
//!    复用而非重写）；
//! 2. 按 [`TrustSpec`] 渲染期望的信任键，在状态文件里逐个确认存在。
//!
//! 「信任记录落在哪个文件」「键长什么样」「记录在文件里的文本形态」都是**该 CLI 的私有契约**，
//! 故由数据表（[`crate::agent::hooks::targets::InstallShape::Structured::trust`]）以
//! [`TrustSpec`] 的 `state_file` / `key` / `record` 三个字段携带 ——
//! 本模块不知道任何 CLI 名，也不知道记录长什么样，加一个受信任 CLI 无需改这里。
//!
//! 这替代了此前写在原 `writers.rs` 里的形态：那版硬编码了 `"hooks.json"` / `"config.toml"`
//! 与 Codex 的键格式，使通用写入器携带了一个 CLI 的身份（开闭原则的反面）。
//!
//! # 只读
//!
//! **绝不代写信任记录** —— Codex 的 `trusted_hash` 输入是不可反推的内部序列化
//! （45 个候选全不匹配，`bypass_hook_trust` 三种注入亦无效 —— 实测表见
//! `.trellis/spec/backend/agent-hooks-domain.md`「为什么不能代写信任哈希」）。
//! 本模块只回答「用户是否已在 CLI 里确认过」。

use std::path::Path;

use serde_json::Value;

use crate::agent::hooks::install::config::json;
use crate::agent::hooks::install::json_file;
use crate::agent::hooks::targets::{HookEntry, TrustSpec};

/// 在 `hooks` 配置里定位一条自家 hook 的 `(group_idx, hook_idx)`。
///
/// 返回 `None` = 该条目**不在**配置里（未安装 → 谈不上信任）。
///
/// 判据统一走 [`config::json::command_targets_shim`]（路径段匹配），与安装/合并同源 ——
/// 三处若各写一份「这是不是我们的命令」的判定，就会漂移成「装进去了但探测说没有」。
fn locate_own_entry(config: &Value, root_key: &str, entry: &HookEntry) -> Option<(usize, usize)> {
    let groups = config
        .pointer(&format!("/{root_key}/{}", entry.native_event))?
        .as_array()?;
    for (group_idx, group) in groups.iter().enumerate() {
        let Some(hooks) = group.get("hooks").and_then(Value::as_array) else {
            continue;
        };
        if let Some(hook_idx) = hooks.iter().position(|h| {
            h.get("command")
                .and_then(Value::as_str)
                .is_some_and(json::command_targets_shim)
        }) {
            return Some((group_idx, hook_idx));
        }
    }
    None
}

/// `PermissionRequest` → `permission_request`（信任键用的是 snake_case 事件名）。
///
/// 与实测键形态一致：`[hooks.state."<path>:session_start:0:0"]` /
/// `...:user_prompt_submit:0:0`。
#[must_use]
pub fn camel_to_snake(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// 探测某条待信任的 hook 是否已被用户确认。
///
/// # 返回值的三态语义（调用方据此决定 UI 措辞）
///
/// - `false` = **需要信任且尚未确认**（含：hooks 文件不可读 / 状态文件缺失 —— 两者都
///   表示「谈不上已确认」）；
/// - `true` = 该面每条条目都有对应的信任键；
/// - 不适用（无信任门）由调用方按 `trust.is_none()` 判为 `None`，本函数不返回它。
///
/// `shim_path` = hooks 文件绝对路径（信任键以它为前缀）；`dir` = 该 CLI 配置根。
#[must_use]
pub fn probe(
    spec: &TrustSpec,
    dir: &Path,
    shim_file: &str,
    root_key: &str,
    entries: &[HookEntry],
) -> bool {
    let Some(config) = json_file::read_json(&dir.join(shim_file)) else {
        return false; // hooks 配置不在/不可读 = 谈不上已确认
    };
    let Ok(state) = std::fs::read_to_string(dir.join(spec.state_file)) else {
        return false; // 状态文件缺失 = 用户从未确认过
    };
    let shim = dir.join(shim_file).display().to_string();
    // **每条**条目都必须有对应的信任键（CLI 在用户逐条/n 键确认后写入）。
    entries.iter().all(|entry| {
        let Some((group_idx, hook_idx)) = locate_own_entry(&config, root_key, entry) else {
            return false; // 条目不在配置里
        };
        let key = (spec.key)(
            &shim,
            &camel_to_snake(entry.native_event),
            group_idx,
            hook_idx,
        );
        state.contains(&(spec.record)(&key))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::hooks::install::dispatch::install_at;
    use crate::agent::hooks::install::json_file::read_json;
    use crate::agent::hooks::install::status::trust_status;
    use crate::agent::hooks::install::test_support::*;
    use crate::agent::hooks::targets::InstallShape;

    /// 测试用信任规格：状态文件 `state.toml`，键 `k:<event>:<gi>:<hi>`。
    fn spec() -> TrustSpec {
        TrustSpec {
            state_file: "state.toml",
            key: |_shim, event, gi, hi| format!("k:{event}:{gi}:{hi}"),
            // 测试用记录形态刻意与 Codex 的 `[hooks.state."…"]` **不同** ——
            // 若通用探针里还残留那条硬编码，本文件的用例会立刻变红（反证）。
            record: |key| format!("record({key})"),
        }
    }

    fn entries() -> &'static [HookEntry] {
        &crate::agent::hooks::targets::CLAUDE_COMPAT_ENTRIES
    }

    /// 写一份 hooks 配置（`PermissionRequest` 下一条自家命令）。
    fn hooks_with_own() -> Value {
        serde_json::json!({
            "hooks": {
                "PermissionRequest": [{
                    "matcher": "*",
                    "hooks": [{ "type": "command", "command": "node /x/neeko-status.mjs claude" }]
                }]
            }
        })
    }

    /// camel_to_snake 覆盖单段、多段、首字母大写与无大写四种输入。
    #[test]
    fn camel_to_snake_covers_shapes() {
        assert_eq!(camel_to_snake("PermissionRequest"), "permission_request");
        assert_eq!(camel_to_snake("Stop"), "stop");
        assert_eq!(camel_to_snake("StopFailure"), "stop_failure");
        assert_eq!(camel_to_snake("already_snake"), "already_snake");
        assert_eq!(camel_to_snake(""), "");
    }

    /// 自家条目定位必须走与安装同源的判据（否则「装进去但探测说没有」）。
    #[test]
    fn locates_own_entry_by_merger_predicate() {
        let config = hooks_with_own();
        let perm = entries()
            .iter()
            .find(|e| e.native_event == "PermissionRequest")
            .expect("perm entry");
        assert_eq!(locate_own_entry(&config, "hooks", perm), Some((0, 0)));
    }

    /// 裸文件名（无路径分隔符）**不**算自家条目 —— 与 merger 同判据。
    #[test]
    fn bare_filename_is_not_own_entry() {
        let config = serde_json::json!({
            "hooks": { "PermissionRequest": [{ "hooks": [{ "command": "neeko-status.mjs" }] }] }
        });
        let perm = entries()
            .iter()
            .find(|e| e.native_event == "PermissionRequest")
            .expect("perm entry");
        assert_eq!(locate_own_entry(&config, "hooks", perm), None);
    }

    /// 端到端：hooks 在 + 状态键齐 → `true`。
    #[test]
    fn probe_true_when_all_keys_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        std::fs::write(
            dir.join("h.json"),
            serde_json::to_string(&hooks_with_own()).expect("ser"),
        )
        .expect("write");
        // 三条 entries 的键全部写出（PermissionRequest 只在配置里，其余两条也需键）。
        let shim = dir.join("h.json").display().to_string();
        let state = entries()
            .iter()
            .map(|e| format!("record(k:{}:0:0)", camel_to_snake(e.native_event)))
            .collect::<Vec<_>>()
            .join("\n");
        // 其余两条也必须出现在配置里，否则 locate 失败。
        let mut config = hooks_with_own();
        for e in entries()
            .iter()
            .filter(|e| e.native_event != "PermissionRequest")
        {
            config["hooks"][e.native_event] = serde_json::json!([{
                "hooks": [{ "command": "node /x/neeko-status.mjs claude" }]
            }]);
        }
        std::fs::write(
            dir.join("h.json"),
            serde_json::to_string(&config).expect("ser"),
        )
        .expect("write");
        std::fs::write(dir.join("state.toml"), format!("{state}\n")).expect("write");
        assert!(
            probe(&spec(), dir, "h.json", "hooks", entries()),
            "shim={shim}"
        );
    }

    /// 缺任一键 → `false`（不能因「大部分已确认」就报已确认）。
    #[test]
    fn probe_false_when_one_key_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        let mut config = hooks_with_own();
        for e in entries()
            .iter()
            .filter(|e| e.native_event != "PermissionRequest")
        {
            config["hooks"][e.native_event] = serde_json::json!([{
                "hooks": [{ "command": "node /x/neeko-status.mjs claude" }]
            }]);
        }
        std::fs::write(
            dir.join("h.json"),
            serde_json::to_string(&config).expect("ser"),
        )
        .expect("write");
        // 只写 PermissionRequest 的键，缺另外两条。
        std::fs::write(dir.join("state.toml"), "record(k:permission_request:0:0)\n")
            .expect("write");
        assert!(!probe(&spec(), dir, "h.json", "hooks", entries()));
    }

    /// 状态文件缺失 → `false`（从未确认过），不是 panic 也不是「不适用」。
    #[test]
    fn probe_false_when_state_file_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        std::fs::write(
            dir.join("h.json"),
            serde_json::to_string(&hooks_with_own()).expect("ser"),
        )
        .expect("write");
        assert!(!probe(&spec(), dir, "h.json", "hooks", entries()));
    }

    /// hooks 文件缺失/畸形 → `false`（fail-safe，不 panic）。
    #[test]
    fn probe_false_when_hooks_missing_or_malformed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        assert!(!probe(&spec(), dir, "h.json", "hooks", entries()), "缺失");
        std::fs::write(dir.join("h.json"), "{not json").expect("write");
        std::fs::write(dir.join("state.toml"), "").expect("write");
        assert!(!probe(&spec(), dir, "h.json", "hooks", entries()), "畸形");
    }

    /// `trust_status`（数据分发）：Codex 的 `hooks.json` 面需要信任，判据是**我们每条条目**的
    /// `[hooks.state."<abs hooks.json>:<event_snake>:<gi>:<hi>"]` 键都存在。
    ///
    /// **反证钉子（2026-10-16 实测定稿）**：`hooks.json` 是共享文件，用户机同时有 superset
    /// 的 hook **且已被信任**（`...:stop:0:0` 等键）。早期实现只判「有没有以我们路径开头的键」
    /// → 命中**他人的**键 → 谎报「已确认」。第三个断言（只装他人的信任键）就是反证它。
    #[test]
    fn trust_status_requires_our_own_entry_keys() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let t = dual_face_target();

        // 无 config.toml → 未确认。
        assert_eq!(trust_status(&t, tmp.path()), Some(false));

        // hooks.json 不存在 → 未确认（谈不上已确认）。
        write_at(&tmp.path().join("config.toml"), "model = \"x\"\n");
        assert_eq!(trust_status(&t, tmp.path()), Some(false));

        // 装上我们的条目（hooks.json 就位）但**无**信任键 → 仍未确认。
        write_at(&tmp.path().join("hooks.json"), "{}");
        let _node = with_node();
        let _ = install_at(&t, tmp.path());
        assert_eq!(
            trust_status(&t, tmp.path()),
            Some(false),
            "只有条目、无信任键 → 未确认"
        );

        // **只装他人的信任键**（superset 的 `stop:0:0`）→ 仍必须报未确认（反证钉子）。
        let path = tmp.path().join("hooks.json").display().to_string();
        let foreign = format!(
            "[hooks.state.\"{path}:stop:0:0\"]\ntrusted_hash = \"sha256:x\"\n\
         [hooks.state.\"{path}:session_start:0:0\"]\ntrusted_hash = \"sha256:y\"\n"
        );
        write_at(&tmp.path().join("config.toml"), &foreign);
        assert_eq!(
            trust_status(&t, tmp.path()),
            Some(false),
            "他人的信任键不得被当作我们的（否则谎报已确认）"
        );

        // 装上**我们每条条目**的信任键 → 已确认。
        let config = read_json(&tmp.path().join("hooks.json")).expect("hooks.json");
        let mut trusted = String::new();
        for entry in &crate::agent::hooks::targets::CLAUDE_COMPAT_ENTRIES {
            let groups = config
                .pointer(&format!("/hooks/{}", entry.native_event))
                .and_then(Value::as_array)
                .expect("event groups");
            let snake = crate::agent::hooks::install::trust::camel_to_snake(entry.native_event);
            for (gi, group) in groups.iter().enumerate() {
                let is_ours = group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|hs| {
                        hs.iter().any(|h| {
                            h.get("command").and_then(Value::as_str).is_some_and(
                                crate::agent::hooks::install::config::json::command_targets_shim,
                            )
                        })
                    });
                if !is_ours {
                    continue;
                }
                let hi = group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .and_then(|hs| {
                        hs.iter().position(|h| {
                            h.get("command").and_then(Value::as_str).is_some_and(
                                crate::agent::hooks::install::config::json::command_targets_shim,
                            )
                        })
                    })
                    .unwrap_or(0);
                trusted.push_str(&format!(
                    "[hooks.state.\"{path}:{snake}:{gi}:{hi}\"]\ntrusted_hash = \"sha256:z\"\n"
                ));
            }
        }
        write_at(&tmp.path().join("config.toml"), &trusted);
        assert_eq!(
            trust_status(&t, tmp.path()),
            Some(true),
            "全部条目确认后应为已确认：\n{trusted}"
        );
    }
    /// **无信任门的面 → `None`**（不展示信任态，避免误导）。
    ///
    /// 这是「信任门是数据而非代码」的直接判据：`Standalone`（pi / omp）与 `NotifyArgv`
    /// （Codex `notify`）都**不该**被探测 —— 它们绕过信任门。
    /// 反证：若把 `trust_status` 改回按文件名 `"hooks.json"` 判断，
    /// `Structured{settings_file: "settings.json", trust: None}`（claude 系）会被误判为需要信任。
    #[test]
    fn trust_status_is_none_without_trust_spec() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(trust_status(&target("neeko-status.js"), tmp.path()), None);
        assert_eq!(trust_status(&notify_target(), tmp.path()), None);
        assert_eq!(
            trust_status(&structured_target(), tmp.path()),
            None,
            "Structured 但 trust=None 必须报不适用（不得按文件名猜）"
        );
    }
    /// **数据驱动的注册判据**：真实 `HOOK_TARGETS` 里只有 Codex 的 `hooks.json` 面声明信任门。
    ///
    /// 反证：给 claude 行的 `trust` 补上 `Some(...)`，本用例必红。
    #[test]
    fn only_codex_declares_a_trust_spec() {
        let with_trust: Vec<&str> = crate::agent::hooks::targets::HOOK_TARGETS
            .iter()
            .filter(|t| {
                t.shapes
                    .iter()
                    .any(|s| matches!(s, InstallShape::Structured { trust: Some(_), .. }))
            })
            .map(|t| t.source)
            .collect();
        assert_eq!(with_trust, vec!["codex"], "信任门目前只属于 Codex");
    }
}
