//! 原型 —— 应用级通知核心域：类型 + 决策（实施落点：`src-tauri/src/notification/{types,policy}.rs`）。
//!
//! 设计依据：`.trellis/tasks/10-12-agent-notify/design.md` §1-§3。
//!
//! 核心不变量（可扩展性的根）：
//! 1. **语义类别是闭集** → `NotificationClass` enum（需要行动/完成/失败），编译期穷尽；
//! 2. **业务来源是开集** → `SourceRef`/`event_key` 全是数据，核心域禁止出现任何
//!    `domain == "agent"` 式的业务分支 —— 新业务接入零核心改动；
//! 3. **依赖方向倒置**：本域不 import 任何业务域；业务域（agent/git/terminal…）单向依赖本域门面；
//! 4. 纯决策：不 import tauri、不 async、不碰 IO，全部外部事实以 `DecisionEnv` 注入 → 100% 可单测。
//!
//! TDD：实施时先落 tests 模块（Red），再迁移实现（Green）。

use std::collections::HashMap;
use std::time::{Duration, Instant};

// ── 类型层（target: notification/types.rs）─────────────────────────────────────

/// 通知语义类别 —— 闭集。任何业务、任何平台的「需要注意」都落在这三类语义里；
/// 类别决定默认文案、节流策略与设置开关。新业务**不新增类别**（若真要新增，enum 强制全量 match 更新）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NotificationClass {
    /// 需要用户行动（审批、输入、确认）。
    ActionRequired,
    /// 任务完成。
    Completed,
    /// 任务失败 / 异常终止。
    Failed,
}

impl NotificationClass {
    /// 类别级用户开关（设置三层结构中的第二层，见 `NotificationSettings`）。
    fn enabled_in(self, settings: &NotificationSettings) -> bool {
        match self {
            Self::ActionRequired => settings.action_required,
            Self::Completed => settings.completed,
            Self::Failed => settings.failed,
        }
    }

    /// 类别级节流间隔：完成类用合并窗口（同一实例短时间多次「完成」只发一条），其余用通用节流。
    fn throttle(self, settings: &NotificationSettings) -> Duration {
        match self {
            Self::Completed => settings.merge_window(),
            _ => settings.throttle_interval(),
        }
    }

    /// detail 缺省时的兜底正文（业务方给了 detail 则优先用 detail）。
    fn default_body(self) -> &'static str {
        match self {
            Self::ActionRequired => "请回到 Neeko 处理",
            Self::Completed => "任务已完成",
            Self::Failed => "发生错误，请查看详情",
        }
    }
}

/// 通知来源定位 —— 开集，纯数据。业务身份（domain）、实例身份（instance_id）、
/// 文案素材（origin/group label）全部由业务方投影时填入。
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
    pub source: SourceRef,
    pub class: NotificationClass,
    /// 域内事件稳定标识（agent 域 = "approval_requested" 等），节流主键之一 + 精细设置键。
    pub event_key: String,
    /// 人类可读事件标签（进标题），由业务方提供 —— 核心域不维护各业务文案。
    pub event_label: String,
    /// 事件携带的细节（tool title / prompt / error message），可缺省，截断由核心负责。
    pub detail: Option<String>,
}

/// 决策环境：全部瞬时事实由外圈注入。
#[derive(Clone, Copy, Debug)]
pub struct DecisionEnv {
    pub app_focused: bool,
    /// 触发实例当前是否对用户可见（agent 域 = 该会话是否正被查看）。
    /// 抑制需要「聚焦 且 可见」同时成立 —— 用户正在看着它时系统通知是纯打扰。
    pub instance_visible: bool,
    /// 单调时钟当前值。注入而非内部取 now()，保证节流测试确定性。
    pub now: Instant,
}

/// 用户设置（持久化于既有 config.json 域）。三层开关，全部数据驱动：
/// 全局 `enabled` → 类别 `action_required/completed/failed` → 事件覆盖 `event_overrides`。
/// 新业务/新事件接入设置 = 前端加一行配置数据，核心结构不变。
#[derive(Clone, Debug, PartialEq)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub action_required: bool,
    pub completed: bool,
    pub failed: bool,
    /// 事件级覆盖，键 = "{domain}.{event_key}"（如 "agent.turn_completed" → false）。
    /// 未列出的事件默认跟随类别开关（覆盖表只表达「显式关掉/打开」的差异项）。
    pub event_overrides: HashMap<String, bool>,
    /// 「仅在窗口失焦时通知」（默认开）。
    pub suppress_when_focused: bool,
    /// 同实例同事件最小间隔秒数（默认 2）。u64 而非 Duration：serde 进 config.json 友好。
    pub throttle_secs: u64,
    /// Completed 类合并窗口秒数（默认 3）。
    pub merge_window_secs: u64,
    /// 正文最大字符数（默认 200；不定长字段禁止整段进通知）。
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
            throttle_secs: 2,
            merge_window_secs: 3,
            body_max_chars: 200,
        }
    }
}

impl NotificationSettings {
    pub fn throttle_interval(&self) -> Duration {
        Duration::from_secs(self.throttle_secs)
    }
    pub fn merge_window(&self) -> Duration {
        Duration::from_secs(self.merge_window_secs)
    }
    /// 事件级开关：覆盖表优先，未覆盖则跟随类别开关。
    pub fn event_enabled(&self, domain: &str, event_key: &str, class: NotificationClass) -> bool {
        let key = format!("{domain}.{event_key}");
        self.event_overrides
            .get(&key)
            .copied()
            .unwrap_or_else(|| class.enabled_in(self))
    }
}

/// 裁决产物：投递层唯一消费的接口，值类型、零依赖。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotificationDraft {
    pub title: String,
    pub body: String,
    pub class: NotificationClass,
    /// 通用回流地址：`neeko://{domain}/{instance_id}`。前端按 domain 路由到各业务的聚焦动作，
    /// 新业务接入回流 = 前端路由表加一行。
    pub deep_link: String,
}

/// Unicode 安全截断：按 char 边界（不按字节，防 CJK/emoji 截半 panic），超长补省略号。
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let kept: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{kept}…")
}

// ── 决策层（target: notification/policy.rs）────────────────────────────────────

/// 节流主键：(业务域, 实例, 事件)。扁平有界 map，实例关闭时回收。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ThrottleKey {
    domain: &'static str,
    instance_id: String,
    event_key: String,
}

impl ThrottleKey {
    fn of(signal: &NotificationSignal) -> Self {
        Self {
            domain: signal.source.domain,
            instance_id: signal.source.instance_id.clone(),
            event_key: signal.event_key.clone(),
        }
    }
}

fn deep_link_for(source: &SourceRef) -> String {
    format!("neeko://{}/{}", source.domain, source.instance_id)
}

fn compose_draft(signal: &NotificationSignal, settings: &NotificationSettings) -> NotificationDraft {
    let title = truncate_chars(
        &format!("{} · {}", signal.source.group_label, signal.event_label),
        80,
    );
    let detail = signal
        .detail
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| signal.class.default_body());
    // origin_label 只做文案数据拼接；为空则不加前缀（健壮性：不产生 "[] xxx"）。
    let body_text = if signal.source.origin_label.trim().is_empty() {
        detail.to_string()
    } else {
        format!("[{}] {}", signal.source.origin_label, detail)
    };
    NotificationDraft {
        title,
        body: truncate_chars(&body_text, settings.body_max_chars),
        class: signal.class,
        deep_link: deep_link_for(&signal.source),
    }
}

/// 纯函数裁决。规则顺序：
/// 1. 全局开关 → 2. 事件/类别开关（数据驱动） → 3. 焦点抑制 → 4. 节流/合并。
/// 输入不含任何业务类型 —— 这就是「核心域业务无关」的编译期体现。
fn evaluate(
    signal: &NotificationSignal,
    env: &DecisionEnv,
    settings: &NotificationSettings,
    last_fired: Option<Instant>,
) -> Option<NotificationDraft> {
    if !settings.enabled {
        return None;
    }
    if !settings.event_enabled(signal.source.domain, &signal.event_key, signal.class) {
        return None;
    }
    if settings.suppress_when_focused && env.app_focused && env.instance_visible {
        return None;
    }
    if let Some(last) = last_fired {
        if env.now.duration_since(last) < signal.class.throttle(settings) {
            return None; // 事件风暴 / 完成合并
        }
    }
    Some(compose_draft(signal, settings))
}

/// 决策门面：持有节流记忆（每 (domain, instance, event) 一个时间戳，有界、随实例关闭回收，不持久化）。
#[derive(Debug, Default)]
pub struct NotificationPolicy {
    fired: HashMap<ThrottleKey, Instant>,
}

impl NotificationPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// 同步纯裁决；返回 Some 时由外圈门面（NotificationCenter）交投递层异步派发，不反压业务主链路。
    pub fn observe(
        &mut self,
        signal: &NotificationSignal,
        env: &DecisionEnv,
        settings: &NotificationSettings,
    ) -> Option<NotificationDraft> {
        let key = ThrottleKey::of(signal);
        let draft = evaluate(signal, env, settings, self.fired.get(&key).copied());
        if draft.is_some() {
            self.fired.insert(key, env.now);
        }
        draft
    }

    /// 实例关闭时回收记忆（agent 域 = SessionDone；未来业务同理），防长跑进程缓慢增长。
    pub fn release_instance(&mut self, domain: &str, instance_id: &str) {
        self.fired
            .retain(|k, _| k.domain != domain || k.instance_id != instance_id);
    }
}

// ── TDD：决策核心单测（100% 覆盖目标）──────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// agent 域信号工厂（测试里模拟第一个接入方；核心不知道 agent 存在）。
    fn agent_signal(class: NotificationClass, event_key: &str, detail: Option<&str>) -> NotificationSignal {
        NotificationSignal {
            source: SourceRef {
                domain: "agent",
                instance_id: "s1".into(),
                origin_label: "opencode".into(),
                group_label: "neeko".into(),
            },
            class,
            event_key: event_key.into(),
            event_label: match class {
                NotificationClass::ActionRequired => "Agent 等待审批".into(),
                NotificationClass::Completed => "任务完成".into(),
                NotificationClass::Failed => "会话异常终止".into(),
            },
            detail: detail.map(str::to_string),
        }
    }

    fn env(now: Instant, app_focused: bool, instance_visible: bool) -> DecisionEnv {
        DecisionEnv { app_focused, instance_visible, now }
    }

    fn unfocused(now: Instant) -> DecisionEnv {
        env(now, false, false)
    }

    /// 基线路径：失焦 + 开关全开 → 发出草稿，deep link 按 (domain, instance) 通用生成。
    #[test]
    fn fires_when_unfocused() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let d = p
            .observe(&agent_signal(NotificationClass::ActionRequired, "approval_requested", Some("edit_file: main.rs")), &unfocused(Instant::now()), &s)
            .expect("should fire");
        assert_eq!(d.title, "neeko · Agent 等待审批");
        assert_eq!(d.body, "[opencode] edit_file: main.rs");
        assert_eq!(d.deep_link, "neeko://agent/s1");
    }

    /// 全局开关关闭 → 一切静默。
    #[test]
    fn global_switch_off_suppresses_all() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings { enabled: false, ..Default::default() };
        assert!(p.observe(&agent_signal(NotificationClass::Failed, "session_failed", None), &unfocused(Instant::now()), &s).is_none());
    }

    /// 类别开关独立生效，不影响其他类别。
    #[test]
    fn class_toggle() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings { completed: false, ..Default::default() };
        let now = Instant::now();
        assert!(p.observe(&agent_signal(NotificationClass::Completed, "turn_completed", None), &unfocused(now), &s).is_none());
        assert!(p.observe(&agent_signal(NotificationClass::ActionRequired, "input_requested", Some("which env?")), &unfocused(now), &s).is_some());
    }

    /// 事件级覆盖（数据驱动精细开关）：关掉一个事件不影响同类别其他事件。
    #[test]
    fn event_override_is_data_driven() {
        let mut p = NotificationPolicy::new();
        let mut overrides = HashMap::new();
        overrides.insert("agent.turn_completed".to_string(), false);
        let s = NotificationSettings { event_overrides: overrides, ..Default::default() };
        let now = Instant::now();
        assert!(p.observe(&agent_signal(NotificationClass::Completed, "turn_completed", None), &unfocused(now), &s).is_none());
        // 同为数据：显式打开一个被类别关掉的事件
        let mut o2 = HashMap::new();
        o2.insert("agent.session_failed".to_string(), true);
        let s2 = NotificationSettings { failed: false, event_overrides: o2, ..Default::default() };
        assert!(p.observe(&agent_signal(NotificationClass::Failed, "session_failed", None), &unfocused(now), &s2).is_some());
    }

    /// 可扩展性钉子（AC6 泛化）：一个假想的 "git" 业务域信号走完全相同的裁决管线，核心零改动。
    #[test]
    fn unknown_future_domain_flows_through_core() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let git_signal = NotificationSignal {
            source: SourceRef { domain: "git", instance_id: "rebase-1".into(), origin_label: String::new(), group_label: "neeko".into() },
            class: NotificationClass::Failed,
            event_key: "rebase_conflict".into(),
            event_label: "Rebase 冲突待解决".into(),
            detail: Some("CONFLICT src/app.rs".into()),
        };
        let d = p.observe(&git_signal, &unfocused(Instant::now()), &s).unwrap();
        assert_eq!(d.title, "neeko · Rebase 冲突待解决");
        assert_eq!(d.body, "CONFLICT src/app.rs"); // origin_label 为空 → 不加 "[]" 前缀
        assert_eq!(d.deep_link, "neeko://git/rebase-1");
    }

    /// 抑制需要「聚焦 且 可见」同时成立；聚焦但看的是别的实例 → 仍然通知。
    #[test]
    fn suppression_requires_focused_and_visible() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        let sig = agent_signal(NotificationClass::ActionRequired, "approval_requested", None);
        assert!(p.observe(&sig, &env(now, true, true), &s).is_none());
        assert!(p.observe(&sig, &env(now, true, false), &s).is_some());
        let s2 = NotificationSettings { suppress_when_focused: false, ..Default::default() };
        assert!(p.observe(&sig, &env(now + Duration::from_secs(5), true, true), &s2).is_some());
    }

    /// 节流：窗口内同 (domain, instance, event) 只发一条；窗口过后恢复。
    #[test]
    fn throttle_storm_within_interval() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default(); // 2s
        let t0 = Instant::now();
        let sig = agent_signal(NotificationClass::ActionRequired, "approval_requested", Some("rm -rf build"));
        assert!(p.observe(&sig, &unfocused(t0), &s).is_some());
        for i in 1..10 {
            assert!(p.observe(&sig, &unfocused(t0 + Duration::from_millis(i * 100)), &s).is_none(), "burst {i} must be throttled");
        }
        assert!(p.observe(&sig, &unfocused(t0 + Duration::from_secs(3)), &s).is_some());
    }

    /// 完成合并：Completed 类走合并窗口 —— 短时间内 TurnEnd{completed} + SessionDone{completed}
    /// （同 event_key）只发一条；多轮会话的下一轮（窗口外）恢复。
    #[test]
    fn completion_merge_window() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default(); // merge 3s
        let t0 = Instant::now();
        let done = agent_signal(NotificationClass::Completed, "turn_completed", None);
        assert!(p.observe(&done, &unfocused(t0), &s).is_some());
        assert!(p.observe(&done, &unfocused(t0 + Duration::from_millis(500)), &s).is_none());
        assert!(p.observe(&done, &unfocused(t0 + Duration::from_secs(4)), &s).is_some());
    }

    /// 节流按 (domain, instance, event) 分槽：跨实例、跨事件互不影响。
    #[test]
    fn throttle_is_per_instance_and_event() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        assert!(p.observe(&agent_signal(NotificationClass::ActionRequired, "approval_requested", None), &unfocused(now), &s).is_some());
        let mut other_instance = agent_signal(NotificationClass::ActionRequired, "approval_requested", None);
        other_instance.source.instance_id = "s2".into();
        assert!(p.observe(&other_instance, &unfocused(now), &s).is_some());
        assert!(p.observe(&agent_signal(NotificationClass::Failed, "session_failed", None), &unfocused(now), &s).is_some());
    }

    /// 10KB detail → 正文按字符截断并带省略号，绝不整段进通知（IPC 载荷红线精神）。
    #[test]
    fn body_truncated_to_max_chars() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default(); // 200
        let huge = "x".repeat(10 * 1024);
        let d = p.observe(&agent_signal(NotificationClass::ActionRequired, "input_requested", Some(&huge)), &unfocused(Instant::now()), &s).unwrap();
        assert_eq!(d.body.chars().count(), 200);
        assert!(d.body.ends_with('…'));
    }

    /// 截断 Unicode 安全（char 边界，不按字节）。
    #[test]
    fn truncation_is_unicode_safe() {
        assert_eq!(truncate_chars("你好世界", 3), "你好…");
        assert_eq!(truncate_chars("abc", 0), "");
        let emoji = "🦀".repeat(50);
        let t = truncate_chars(&emoji, 10);
        assert_eq!(t.chars().count(), 10);
        assert!(t.ends_with('…'));
    }

    /// detail 为 None / 空串 / 纯空白 → 类别兜底文案。
    #[test]
    fn blank_detail_falls_back_to_class_default() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        let d = p.observe(&agent_signal(NotificationClass::Failed, "session_failed", None), &unfocused(now), &s).unwrap();
        assert_eq!(d.body, "[opencode] 发生错误，请查看详情");
        let d2 = p.observe(&agent_signal(NotificationClass::ActionRequired, "input_requested", Some("   ")), &unfocused(now + Duration::from_secs(5)), &s).unwrap();
        assert_eq!(d2.body, "[opencode] 请回到 Neeko 处理");
    }

    /// 来源名（pi/opencode）是数据不是分支：裁决结果同构，名字只进文案。
    #[test]
    fn origin_label_is_data_not_branch() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        let mut pi = agent_signal(NotificationClass::Completed, "turn_completed", Some("done"));
        pi.source.origin_label = "pi".into();
        let d_pi = p.observe(&pi, &unfocused(now), &s).unwrap();
        let d_oc = p.observe(&agent_signal(NotificationClass::Completed, "turn_completed", Some("done")), &unfocused(now + Duration::from_secs(10)), &s).unwrap();
        assert_eq!(d_pi.title, d_oc.title);
        assert!(d_pi.body.starts_with("[pi] "));
        assert!(d_oc.body.starts_with("[opencode] "));
    }

    /// 实例关闭回收记忆：回收后同实例可立即再发（无残留节流），且不误伤其他实例。
    #[test]
    fn release_instance_frees_only_that_instance() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        let sig = agent_signal(NotificationClass::ActionRequired, "approval_requested", None);
        let mut other = sig.clone();
        other.source.instance_id = "s2".into();
        assert!(p.observe(&sig, &unfocused(now), &s).is_some());
        assert!(p.observe(&other, &unfocused(now), &s).is_some());
        p.release_instance("agent", "s1");
        assert_eq!(p.fired.len(), 1); // s2 的记忆保留
        assert!(p.observe(&sig, &unfocused(now), &s).is_some()); // s1 立即可再发
    }

    /// 超长 group_label 不撑爆标题。
    #[test]
    fn title_is_bounded() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let mut sig = agent_signal(NotificationClass::Completed, "turn_completed", None);
        sig.source.group_label = "p".repeat(500);
        let d = p.observe(&sig, &unfocused(Instant::now()), &s).unwrap();
        assert!(d.title.chars().count() <= 80);
    }
}
