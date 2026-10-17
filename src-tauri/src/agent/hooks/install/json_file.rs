//! 用户配置 JSON 的**只读**入口（fail-safe）。
//!
//! # 为什么单独一个模块（而不是留在安装腿里）
//!
//! 「读一个可能被用户手改过的 JSON 配置」是**两个互不相识的消费者**的共同需求：
//! 安装腿（判断条目是否在位）与信任探针（`trust` 判断条目是否被确认）。
//! 此前它住在安装腿的实现里，于是被声明为「CLI 无关、只读」的 `trust` 只能
//! `crate::agent::hooks::install::read_json` —— **低层探测回指高层写入器**，`trust` 无法脱离
//! 安装腿单独编译/测试（依赖倒置的反面）。
//!
//! 抽到此处后依赖方向变成单向：`install::shape::*` 与 `install::trust` 都依赖它，
//! `json_file` 不依赖 hooks 域内任何模块。断言漂移也从「两处各写一份容错」收敛为一条。

use std::path::Path;

use serde_json::Value;

/// 读用户配置 JSON（不存在 / 不可读 / 非法 JSON 一律 `None`）。
///
/// 返回 `None` = **不存在 / 不可读 / 非法 JSON**。调用方需自行区分后两者的语义：
/// 「不存在」可以安全创建（见 `install::shape::structured` 的安装腿），
/// 「存在但不可解析」必须 fail-safe 跳过（绝不覆盖用户内容）。
///
/// 三态区分靠调用方另查 `path.exists()` —— 本函数只回答「能拿到可用的 `Value` 吗」，
/// 不把「文件系统状态」与「内容是否可用」两个事实混进一个返回值。
#[must_use]
pub(crate) fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_valid_json() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("settings.json");
        std::fs::write(&path, r#"{"hooks":{}}"#).expect("write");
        assert_eq!(read_json(&path), Some(serde_json::json!({ "hooks": {} })));
    }

    #[test]
    fn absent_and_malformed_are_none() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(read_json(&tmp.path().join("nope.json")), None, "不存在");
        let bad = tmp.path().join("bad.json");
        std::fs::write(&bad, "{not json").expect("write");
        assert_eq!(read_json(&bad), None, "非法 JSON 必须 fail-safe");
    }
}
