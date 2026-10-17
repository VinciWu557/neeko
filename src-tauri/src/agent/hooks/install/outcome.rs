//! hook 应用的**结果类型**：机器可读状态 + 回执 + 安装状态。
//!
//! # 为什么单独一个模块
//!
//! 这三个类型是**跨栈契约**（`serde` 序列化后与前端联合类型一一对应），
//! 由安装腿、卸载腿、状态腿、聚合器共同产出或消费。它们此前与行为代码混在一个文件里，
//! 使得「契约有几个生产者」不可读 —— 而契约漂移（前端按 status 文案分类）正是要防的。
//!
//! 跨语言镜像测试在前端侧钉住 `snake_case` / `camelCase` 的字段名与取值。

use crate::agent::hooks::targets::HookTarget;

/// 单个 CLI 的一次 hook 应用结果状态（机器可读，序列化后与前端联合类型一一对应）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookApplyStatus {
    /// 已写入新内容（首次安装或版本更新）。
    Applied,
    /// 内容已是最新（幂等命中，未写入）。
    Unchanged,
    /// 已删除自家受管文件（卸载）。
    Removed,
    /// 按客人义务跳过（同名他人文件 / 用户配置畸形 / 无 node 等），非故障。
    Skipped,
    /// 真实故障（IO / 目录不可定位），`detail` 含原因。
    Failed,
}

/// 单个 CLI 的 hook 应用回执。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookApplyOutcome {
    /// CLI 标识（= [`HookTarget::source`]）。
    pub source: String,
    /// 机器可读状态。
    pub status: HookApplyStatus,
    /// 人类可读补充（失败/跳过缘由；正常时为空串）。
    pub detail: String,
}

/// 一个 CLI 的 hook 安装状态。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInstallStatus {
    /// CLI 标识（= [`HookTarget::source`]）。
    pub source: String,
    /// hook 文件绝对路径（展示/诊断用；无法定位目录时为空串）。
    pub path: String,
    /// 已存在且是我们的受管文件。
    pub installed: bool,
    /// 受管文件版本与当前应用一致（false 且 installed 时提示需更新）。
    pub version_current: bool,
    /// CLI 侧信任态：`None` = 该 CLI 无信任概念（无需展示）；
    /// `Some(true)` = 需要且用户已确认（或无需确认）；`Some(false)` = **已安装但用户还没确认**
    /// —— 此时功能不生效（需要信任门的 CLI 的 `hooks.json` 面），UI 必须如实提示，
    /// 否则又是「装了但没通知」的形态。
    pub trusted: Option<bool>,
}

/// 构造一条回执（三条腿与聚合器共用的唯一书写点）。
#[must_use]
pub(crate) fn outcome(
    target: &HookTarget,
    status: HookApplyStatus,
    detail: String,
) -> HookApplyOutcome {
    HookApplyOutcome {
        source: target.source.to_string(),
        status,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回执/状态序列化形状与前端 TS 镜像同源（跨语言契约不许各自漂移）。
    #[test]
    fn outcomes_match_frontend_type_mirror() {
        const FRONTEND: &str = include_str!("../../../../../src/shared/types/notification.ts");
        let json = serde_json::to_value(HookApplyStatus::Unchanged).expect("ser");
        assert_eq!(json, serde_json::json!("unchanged"));
        for variant in ["applied", "unchanged", "removed", "skipped", "failed"] {
            assert!(
                FRONTEND.contains(&format!("'{variant}'")),
                "前端 HookApplyStatus 镜像缺少 {variant}（改枚举必须双端同步）"
            );
        }
        for field in ["source", "status", "detail", "versionCurrent", "trusted"] {
            assert!(
                FRONTEND.contains(&format!("{field}:")),
                "前端 notification.ts 镜像缺少字段 {field}"
            );
        }
    }
}
