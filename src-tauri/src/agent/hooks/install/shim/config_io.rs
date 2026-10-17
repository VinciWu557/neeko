//! 用户配置文件的落盘 —— 三条腿写用户文件（`settings.json` / `config.toml` / `hooks.json`）
//! 的**唯一实现点**。
//!
//! # 为什么单独一个模块
//!
//! 「原子替换 + 保留原权限 + 失败文案带文件名」这段序列此前在
//! `install_structured` / `uninstall_structured` / `install_notify_argv` /
//! `uninstall_notify_argv` 里各写了一遍，失败样板 `format!("write {文件}: {err}")` 出现 4 次。
//! 更关键的是**权限语义**只有一处需要正确：用户文件可能是 0600，无条件写 0644 = 静默降权
//! （反向则泄漏）。把它和 [`.trellis/spec`] 里那条「文件权限是威胁模型的一半」的判据
//! 绑在同一个函数上，改动不可能绕过。

use std::path::Path;

use serde_json::Value;

/// 原子改写用户既有文件（保留原权限位）。
///
/// `label` = 写进失败文案的文件名（调用方知道是 `settings.json` 还是 `config.toml` ——
/// 本模块不猜，正是为了通用模块不携带单个 CLI 的私有文件名）。
///
/// 失败文案的**唯一书写点**：`write {label}: {err}`。四条写入腿口径一致。
pub(crate) fn write_user_file(path: &Path, label: &str, content: &str) -> Result<(), String> {
    crate::platform::private_file::write_atomic_preserving_mode(path, content)
        .map_err(|err| format!("write {label}: {err}"))
}

/// 把 JSON 值以「两空格缩进 + 尾换行」写回用户配置（用户文件的既有风格）。
///
/// 序列化失败**如实回传**（而不是 `.ok()?` 静默当作「无痕迹」）：`Value` 由
/// `read_json` 解析而来，理论上总能序列化回去；真失败说明我们的假设破了 —— 静默吞掉
/// 会让用户看到「已卸载」而文件其实没动。
pub(crate) fn write_user_json(path: &Path, label: &str, value: &Value) -> Result<(), String> {
    let Ok(serialized) = serde_json::to_string_pretty(value) else {
        return Err(format!("serialize {label} failed"));
    };
    write_user_file(path, label, &format!("{serialized}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JSON 写回：内容是两空格缩进 + 尾换行，且**键序保留**（用户文件的一部分）。
    #[test]
    fn writes_json_with_pretty_indent_and_trailing_newline() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("settings.json");
        let value: Value = serde_json::from_str(r#"{"zzz":1,"aaa":2}"#).expect("parse");
        write_user_json(&path, "settings.json", &value).expect("write");

        let out = std::fs::read_to_string(&path).expect("read");
        assert!(out.ends_with("}\n"), "必须尾换行: {out:?}");
        assert!(
            out.find("\"zzz\"").expect("zzz") < out.find("\"aaa\"").expect("aaa"),
            "用户键序必须保留: {out}"
        );
    }

    /// 失败文案带调用方给的文件名（通用模块不猜 CLI 私有名）。
    #[test]
    fn write_failure_reports_the_label_not_a_hardcoded_name() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // 父目录不存在 → 原子写必定失败。
        let path = tmp.path().join("missing").join("config.toml");
        let err = write_user_file(&path, "config.toml", "notify = []\n").expect_err("must fail");
        assert!(err.starts_with("write config.toml: "), "{err}");
    }
}
