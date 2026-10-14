//! 通知域值类型 —— 应用级、业务无关（design.md T4/D6）。
//!
//! 核心不变量：
//! 1. **语义类别是闭集** → [`NotificationClass`] enum（需要行动/完成/失败），编译期穷尽；
//! 2. **业务来源是开集** → [`SourceRef`] 的 `domain` / `event_key` 全是数据，本域禁止
//!    出现任何业务分支（如 `domain == "agent"`）—— 新业务接入零核心改动；
//! 3. 本文件不 import 任何业务域类型。

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// 通用深链协议前缀（完整形式：`neeko://{domain}/{instance_id}`）。
const DEEP_LINK_SCHEME: &str = "neeko://";

/// 通知语义类别 —— 闭集。任何业务、任何平台的「需要注意」都落在这三类语义里；
/// 类别决定默认文案、节流策略与设置开关。新业务**不新增类别**；
/// 若确需新增，enum 强制全量 match 更新（受控加法）。
/// 序列化 snake_case（`"action_required"` 等）—— 与 `StreamEvent` 的 IPC 口径一致。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationClass {
    /// 需要用户行动（审批、输入、确认）。
    ActionRequired,
    /// 任务完成。
    Completed,
    /// 任务失败 / 异常终止。
    Failed,
}

impl NotificationClass {
    /// detail 缺省时的兜底正文（业务方给了 detail 则优先用 detail）。
    #[must_use]
    pub const fn default_body(self) -> &'static str {
        match self {
            Self::ActionRequired => "请回到 Neeko 处理",
            Self::Completed => "任务已完成",
            Self::Failed => "发生错误，请查看详情",
        }
    }

    /// 类别级节流间隔：完成类用合并窗口（同一实例短时间多次「完成」只发一条），
    /// 其余用通用节流（三层开关的第二层按类别展开，见 `types::NotificationSettings`）。
    #[must_use]
    pub const fn throttle(self, settings: &NotificationSettings) -> Duration {
        match self {
            Self::Completed => settings.merge_window(),
            _ => settings.throttle_interval(),
        }
    }
}

/// 通知来源定位 —— 开集，纯数据。业务身份（domain）、实例身份（instance_id）、
/// 文案素材（origin/group label）全部由业务方投影时填入，核心域只透传与拼接。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceRef {
    /// 业务域稳定标识："agent" / 未来 "git"、"terminal"、"import"…（设置键与 deep link 路由用）。
    pub domain: &'static str,
    /// 域内实例标识（agent 域 = session_id）。节流主键之一 + 点击回流目标。
    pub instance_id: String,
    /// 产生通知的具体来源名（agent 域 = "pi"/"opencode"），仅进文案，核心不分支。
    pub origin_label: String,
    /// 分组展示名（agent 域 = 项目名），进标题。
    pub group_label: String,
}

/// 归一化通知信号：业务域投影产物，核心域唯一输入。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationSignal {
    /// 来源定位（业务身份是数据，见本文件头不变量 2）。
    pub source: SourceRef,
    /// 语义类别（闭集）。
    pub class: NotificationClass,
    /// 域内事件稳定标识（agent 域 = "approval_requested" 等），节流主键之一 + 精细设置键。
    pub event_key: String,
    /// 人类可读事件标签（进标题），由业务方提供 —— 核心域不维护各业务文案。
    pub event_label: String,
    /// 事件携带的细节（tool title / prompt / error message），可缺省，截断由核心负责。
    pub detail: Option<String>,
    /// 会话主题（R7）：业务域解析好的**原生标题或回退文本**，可缺省。
    ///
    /// 优先级判定（原生标题 vs 首条用户消息）由业务域负责，核心域只做非空校验与截断 ——
    /// 与 `detail` 同样属于「业务给料、核心拼装」，本域零分支（不变量 2）。
    pub topic: Option<String>,
}

/// 决策环境：全部瞬时事实由外圈注入，保证 [`crate::notification::policy`] 纯函数可 100% 单测。
#[derive(Clone, Copy, Debug)]
pub struct DecisionEnv {
    /// 应用窗口是否聚焦（app 域 `WindowEvent::Focused` 维护的 AtomicBool，design D1）。
    pub app_focused: bool,
    /// 触发实例当前是否对用户可见（agent 域 = 该会话是否正被查看）。
    /// 抑制需要「聚焦 且 可见」同时成立 —— 用户正在看着它时系统通知是纯打扰。
    pub instance_visible: bool,
    /// 单调时钟当前值。注入而非内部取 now()，保证节流测试确定性。
    pub now: Instant,
}

/// 裁决产物：投递层唯一消费的接口，值类型、零依赖。序列化为前端回流载荷（snake_case，
/// 与 `StreamEvent` 等 IPC 类型口径一致）。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NotificationDraft {
    /// 通知标题（`"{group_label} · {event_label}"`，截断至 [`MAX_TITLE_CHARS`]）。
    pub title: String,
    /// 会话主题副标题（R7.3）：macOS 走原生第二行；空串 = 无主题（不回退成占位符），
    /// Win/Linux 由投递层降级拼进 body 前缀。截断至 [`MAX_SUBTITLE_CHARS`]。
    pub subtitle: String,
    /// 通知正文（`"[{origin_label}] {detail|类别兜底}"`，截断至 settings.body_max_chars）。
    pub body: String,
    /// 语义类别（前端按类别选 toast 样式）。
    pub class: NotificationClass,
    /// 通用回流地址 `neeko://{domain}/{instance_id}`：前端按 domain 路由到各业务的聚焦动作，
    /// 新业务接入回流 = 前端路由表加一行。
    pub deep_link: String,
}

/// 标题最大字符数（超出截断带省略号；与正文共用 Unicode 安全截断）。
pub const MAX_TITLE_CHARS: usize = 80;

/// 副标题最大字符数（R7.3）。
///
/// 比标题（80）更短：副标题是 macOS 上的**单行第二行**展示位，超长会被系统按可视宽度裁掉
/// 且不显示省略号 —— 由我们主动截断才能保证尾部有省略号、语义完整。正文仍走用户配置的
/// `body_max_chars`（200），两者是不同用途的独立上限。
pub const MAX_SUBTITLE_CHARS: usize = 60;

/// 用户设置（持久化于既有 config.json 域的 `notification` 键）。三层开关，全部数据驱动：
/// 全局 `enabled` → 类别 `action_required/completed/failed` → 事件覆盖 `event_overrides`。
/// 新业务/新事件接入设置 = 前端加一行配置数据，本结构不变。
///
/// serde 命名 camelCase —— 与 config.json 既有键（`watcherExclude`/`customAgents`/
/// `agentOverrides`）口径一致；`#[serde(default)]` 保证旧配置文件缺字段时整体回落默认值。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    /// 全局开关（R4.1）。
    pub enabled: bool,
    /// 「需要行动」类通知开关。
    pub action_required: bool,
    /// 「完成」类通知开关。
    pub completed: bool,
    /// 「失败」类通知开关。
    pub failed: bool,
    /// 事件级覆盖，键 = `"{domain}.{event_key}"`（如 `"agent.turn_completed": false`）。
    /// 未列出的事件默认跟随类别开关（覆盖表只表达「显式关掉/打开」的差异项）。
    pub event_overrides: HashMap<String, bool>,
    /// 「仅在窗口失焦时通知」（R4.3，默认开）。
    pub suppress_when_focused: bool,
    /// 外部 Agent CLI hook 安装开关（R6.5，默认关 —— 用户全局配置是客人的家，须显式同意）。
    ///
    /// 本域只持有该**意图**：文件的安装/卸载由 agent 域承担（`agent_hooks_apply` 命令 →
    /// `agent/hooks/writers.rs`），前端在保存设置后串行触发。核心域不 import 业务域，
    /// 故此处刻意不写具体落点函数名 —— 联动契约见 `.trellis/tasks/10-12-agent-notify/`。
    pub cli_hooks: bool,
    /// 同实例同事件最小间隔秒数（默认 2）。u64 而非 Duration：serde 进 config.json 友好。
    pub throttle_secs: u64,
    /// Completed 类合并窗口秒数（默认 3）。
    pub merge_window_secs: u64,
    /// 正文最大字符数（默认 200；不定长字段禁止整段进通知，红线 4 精神）。
    pub body_max_chars: usize,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            action_required: true,
            completed: true,
            failed: true,
            event_overrides: HashMap::new(),
            suppress_when_focused: true,
            cli_hooks: false,
            throttle_secs: 2,
            merge_window_secs: 3,
            body_max_chars: 200,
        }
    }
}

/// 事件覆盖表的条目上限：覆盖项是稀疏例外（正常远小于此数），超限只可能是手改/异常写入，
/// 整体回空 = 全部「跟随类别」，确定性降级优于不定序的部分保留。
pub const MAX_EVENT_OVERRIDES: usize = 64;

impl NotificationSettings {
    /// 归一化边界值（唯一实现点，两个入口共用：命令 set + config 读盘）。
    ///
    /// 设置是用户/磁盘可触达的边界输入：手改 config.json 或前端异常值不得把通知行为
    /// 推到退化区（正文 0 字符 = 静默失效、节流 0 秒 = 事件风暴、覆盖表无界 = 存储膨胀）。
    /// 数值越界回各自默认；`event_overrides` 超限整体回空（跟随类别，确定性降级）。
    #[must_use]
    pub fn normalized(self) -> Self {
        let defaults = Self::default();
        // 逐字段解构：全部字段显式重建，布尔/字符串等直通字段也在列（模式不支持
        // 「绑定其余字段」的写法，FRU `..self` 又会在部分移动后重复移动）。
        let Self {
            enabled,
            action_required,
            completed,
            failed,
            event_overrides,
            suppress_when_focused,
            cli_hooks,
            throttle_secs,
            merge_window_secs,
            body_max_chars,
        } = self;
        Self {
            enabled,
            action_required,
            completed,
            failed,
            suppress_when_focused,
            cli_hooks,
            throttle_secs: if (1..=3600).contains(&throttle_secs) {
                throttle_secs
            } else {
                log::warn!("[notify] throttle_secs {throttle_secs} 越界，回默认");
                defaults.throttle_secs
            },
            merge_window_secs: if (1..=3600).contains(&merge_window_secs) {
                merge_window_secs
            } else {
                log::warn!("[notify] merge_window_secs {merge_window_secs} 越界，回默认");
                defaults.merge_window_secs
            },
            body_max_chars: if (20..=2000).contains(&body_max_chars) {
                body_max_chars
            } else {
                log::warn!("[notify] body_max_chars {body_max_chars} 越界，回默认");
                defaults.body_max_chars
            },
            event_overrides: if event_overrides.len() > MAX_EVENT_OVERRIDES {
                log::warn!(
                    "[notify] event_overrides 共 {} 项，超过上限 {MAX_EVENT_OVERRIDES}，整体回空（跟随类别）",
                    event_overrides.len()
                );
                HashMap::new()
            } else {
                event_overrides
            },
        }
    }

    /// 通用节流间隔（R2.2）。
    #[must_use]
    pub const fn throttle_interval(&self) -> Duration {
        Duration::from_secs(self.throttle_secs)
    }

    /// Completed 类合并窗口（R2.3 / design D3）。
    #[must_use]
    pub const fn merge_window(&self) -> Duration {
        Duration::from_secs(self.merge_window_secs)
    }

    /// 三层开关合成：事件覆盖表优先，未覆盖则跟随类别开关。
    #[must_use]
    pub fn event_enabled(&self, domain: &str, event_key: &str, class: NotificationClass) -> bool {
        let key = format!("{domain}.{event_key}");
        let class_default = match class {
            NotificationClass::ActionRequired => self.action_required,
            NotificationClass::Completed => self.completed,
            NotificationClass::Failed => self.failed,
        };
        self.event_overrides
            .get(&key)
            .copied()
            .unwrap_or(class_default)
    }
}

/// 通用深链：`neeko://{domain}/{instance_id}`（前端按 domain 路由，D9）。
#[must_use]
pub fn deep_link_for(source: &SourceRef) -> String {
    format!("{DEEP_LINK_SCHEME}{}/{}", source.domain, source.instance_id)
}

// ── TDD：边界值归一与序列化兼容 ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 越界数值（0 / 超限）一律回各自默认 —— 退化配置不得让通知静默失效或刷屏。
    #[test]
    fn out_of_range_values_fall_back_to_defaults() {
        let s = NotificationSettings {
            throttle_secs: 0,
            merge_window_secs: 100_000,
            body_max_chars: 5,
            ..Default::default()
        }
        .normalized();
        let d = NotificationSettings::default();
        assert_eq!(s.throttle_secs, d.throttle_secs);
        assert_eq!(s.merge_window_secs, d.merge_window_secs);
        assert_eq!(s.body_max_chars, d.body_max_chars);
    }

    /// 区间内数值原样保留，其余字段不受影响。
    #[test]
    fn in_range_values_pass_through() {
        let s = NotificationSettings {
            throttle_secs: 5,
            merge_window_secs: 10,
            body_max_chars: 500,
            ..Default::default()
        }
        .normalized();
        assert_eq!(
            (s.throttle_secs, s.merge_window_secs, s.body_max_chars),
            (5, 10, 500)
        );
        assert!(s.enabled);
    }

    /// 覆盖表有界：超限（只可能是手改/异常写入）整体回空 = 全部跟随类别。
    #[test]
    fn oversized_event_overrides_are_dropped_wholesale() {
        let mut overrides = HashMap::new();
        for i in 0..=MAX_EVENT_OVERRIDES {
            overrides.insert(format!("agent.key_{i}"), false);
        }
        let s = NotificationSettings {
            event_overrides: overrides,
            ..Default::default()
        }
        .normalized();
        assert!(s.event_overrides.is_empty());
    }

    /// 上限内的覆盖表原样保留（正常用户数据不被归一化误伤）。
    #[test]
    fn in_bounds_overrides_pass_through() {
        let mut overrides = HashMap::new();
        overrides.insert("agent.turn_completed".to_string(), false);
        let s = NotificationSettings {
            event_overrides: overrides,
            ..Default::default()
        }
        .normalized();
        assert_eq!(s.event_overrides.get("agent.turn_completed"), Some(&false));
    }

    /// 旧 config.json 无 `notification` 字段/子字段缺失 → serde 容器默认整体回落。
    #[test]
    fn empty_json_object_deserializes_to_defaults() {
        let s: NotificationSettings = serde_json::from_str::<NotificationSettings>("{}")
            .expect("deserialize")
            .normalized();
        assert_eq!(s, NotificationSettings::default());
    }

    /// camelCase 契约钉死（与 config.json 既有键风格一致；改名即破坏兼容）。
    #[test]
    fn settings_serializes_with_camel_case_keys() {
        let json = serde_json::to_value(NotificationSettings::default()).expect("serialize");
        let keys: Vec<&String> = json.as_object().expect("object").keys().collect();
        for expected in [
            "actionRequired",
            "suppressWhenFocused",
            "throttleSecs",
            "mergeWindowSecs",
            "bodyMaxChars",
            "eventOverrides",
        ] {
            assert!(
                keys.iter().any(|k| *k == expected),
                "missing camel key {expected}"
            );
        }
    }
}
