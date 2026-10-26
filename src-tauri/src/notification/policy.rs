//! 通知决策核心 —— 纯函数（design.md T3）。
//!
//! 铁律：本文件**不 import tauri、不 async、不碰 IO、不认识任何业务域** ——
//! 全部外部事实以 [`DecisionEnv`] 注入，因此可 100% 单测（AC9）。

use std::collections::HashMap;
use std::time::Instant;

use super::types::{
    deep_link_for, DecisionEnv, NotificationDraft, NotificationSettings, NotificationSignal,
};

/// 节流主键：`(业务域, 实例, 事件)`。扁平有界 map，实例关闭时回收。
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

/// 组装投递草稿：标题/正文由**业务投影携带的数据字段**拼接（核心零业务文案，T4/D6），
/// 正文截断至 settings.body_max_chars（R2.4）。
fn compose_draft(
    signal: &NotificationSignal,
    settings: &NotificationSettings,
) -> NotificationDraft {
    let title = truncate_chars(
        &format!("{} · {}", signal.source.group_label, signal.event_label),
        super::types::MAX_TITLE_CHARS,
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
        subtitle: subtitle_of(signal),
        body: truncate_chars(&body_text, settings.body_max_chars),
        class: signal.class,
        deep_link: deep_link_for(&signal.source),
    }
}

/// 会话主题 → 副标题（R7.1 第 3 档：缺失/全空白 → 空串，不回退成占位符）。
///
/// 只做「trim + 非空判定 + 截断」，不判定来源优先级（原生标题 vs 首条用户消息）——
/// 那是业务域的知识，核心域零分支（不变量 2）。
fn subtitle_of(signal: &NotificationSignal) -> String {
    signal
        .topic
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| truncate_chars(t, super::types::MAX_SUBTITLE_CHARS))
        .unwrap_or_default()
}

/// 纯函数裁决。规则顺序（对应 prd R2/R4）：全局开关（R4.1）→ 三层开关（R4.2，数据驱动）
/// → 焦点抑制（R2.1）→ 节流与完成合并（R2.2/R2.3）。
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
        return None; // 用户正在看着这个实例，系统通知是纯打扰（in-app toast 走前端既有链路）
    }
    if let Some(last) = last_fired {
        if env.now.duration_since(last) < signal.class.throttle(settings) {
            return None; // 事件风暴 / 完成合并（AC2、AC4）
        }
    }
    Some(compose_draft(signal, settings))
}

/// 决策门面：持有节流记忆（每 `(domain, instance, event)` 一个时间戳，有界、随实例关闭回收，
/// 不持久化 —— design D2：重启丢节流窗口无害，换来零 IO）。
#[derive(Debug, Default)]
pub struct NotificationPolicy {
    fired: HashMap<ThrottleKey, Instant>,
}

impl NotificationPolicy {
    /// 新建空决策器。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 同步纯裁决；返回 Some 时由门面（center.rs）交投递层异步派发，不反压业务主链路（T2）。
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

// ── TDD：决策核心单测（AC9：本文件 100% 覆盖）─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notification::types::{NotificationClass, SourceRef};
    use std::time::Duration;

    /// agent 域信号工厂（测试里模拟第一个接入方；核心不知道 agent 存在）。
    fn signal(
        class: NotificationClass,
        event_key: &str,
        detail: Option<&str>,
    ) -> NotificationSignal {
        signal_with_topic(class, event_key, detail, None)
    }

    /// 带主题的信号工厂（R7 副标题用例）。
    fn signal_with_topic(
        class: NotificationClass,
        event_key: &str,
        detail: Option<&str>,
        topic: Option<&str>,
    ) -> NotificationSignal {
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
                NotificationClass::ActionRequired => "Agent needs approval".into(),
                NotificationClass::Completed => "Agent turn completed".into(),
                NotificationClass::Failed => "Agent session failed".into(),
            },
            detail: detail.map(str::to_string),
            topic: topic.map(str::to_string),
        }
    }

    fn env(now: Instant, app_focused: bool, instance_visible: bool) -> DecisionEnv {
        DecisionEnv {
            app_focused,
            instance_visible,
            now,
        }
    }

    fn unfocused(now: Instant) -> DecisionEnv {
        env(now, false, false)
    }

    /// 基线路径：失焦 + 开关全开 → 发出草稿，字段组装与通用 deep link 正确。
    #[test]
    fn fires_when_unfocused() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let d = p
            .observe(
                &signal(
                    NotificationClass::ActionRequired,
                    "approval_requested",
                    Some("edit_file: main.rs"),
                ),
                &unfocused(Instant::now()),
                &s,
            )
            .expect("should fire");
        assert_eq!(d.title, "neeko · Agent needs approval");
        assert_eq!(d.body, "[opencode] edit_file: main.rs");
        assert_eq!(d.deep_link, "neeko://agent/s1");
    }

    /// R4.1：全局开关关闭 → 一切静默。
    #[test]
    fn global_switch_off_suppresses_all() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings {
            enabled: false,
            ..Default::default()
        };
        assert!(p
            .observe(
                &signal(NotificationClass::Failed, "session_failed", None),
                &unfocused(Instant::now()),
                &s
            )
            .is_none());
    }

    /// R4.2：类别开关独立生效，不影响其他类别。
    #[test]
    fn class_toggle() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings {
            completed: false,
            ..Default::default()
        };
        let now = Instant::now();
        assert!(p
            .observe(
                &signal(NotificationClass::Completed, "turn_completed", None),
                &unfocused(now),
                &s
            )
            .is_none());
        assert!(p
            .observe(
                &signal(
                    NotificationClass::ActionRequired,
                    "input_requested",
                    Some("which env?")
                ),
                &unfocused(now),
                &s
            )
            .is_some());
    }

    /// R4.2：事件级覆盖（数据驱动精细开关）显式关闭/打开优先于类别开关。
    #[test]
    fn event_override_is_data_driven() {
        let mut p = NotificationPolicy::new();
        let mut overrides = HashMap::new();
        overrides.insert("agent.turn_completed".to_string(), false);
        let s = NotificationSettings {
            event_overrides: overrides,
            ..Default::default()
        };
        let now = Instant::now();
        assert!(p
            .observe(
                &signal(NotificationClass::Completed, "turn_completed", None),
                &unfocused(now),
                &s
            )
            .is_none());
        // 显式打开一个被类别关掉的事件
        let mut o2 = HashMap::new();
        o2.insert("agent.session_failed".to_string(), true);
        let s2 = NotificationSettings {
            failed: false,
            event_overrides: o2,
            ..Default::default()
        };
        assert!(p
            .observe(
                &signal(NotificationClass::Failed, "session_failed", None),
                &unfocused(now),
                &s2
            )
            .is_some());
    }

    /// 可扩展性钉子（AC10）：假想的 "git" 业务域信号走完全相同的裁决管线，核心零改动。
    #[test]
    fn unknown_future_domain_flows_through_core() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let git_signal = NotificationSignal {
            source: SourceRef {
                domain: "git",
                instance_id: "rebase-1".into(),
                origin_label: String::new(),
                group_label: "neeko".into(),
            },
            class: NotificationClass::Failed,
            event_key: "rebase_conflict".into(),
            event_label: "Rebase 冲突待解决".into(),
            detail: Some("CONFLICT src/app.rs".into()),
            topic: None,
        };
        let d = p
            .observe(&git_signal, &unfocused(Instant::now()), &s)
            .unwrap();
        assert_eq!(d.title, "neeko · Rebase 冲突待解决");
        assert_eq!(d.body, "CONFLICT src/app.rs"); // origin_label 为空 → 不加 "[]" 前缀
        assert_eq!(d.deep_link, "neeko://git/rebase-1");
    }

    /// R2.1：抑制需要「聚焦 且 可见」同时成立；聚焦但看的是别的实例 → 仍然通知。
    #[test]
    fn suppression_requires_focused_and_visible() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        let sig = signal(
            NotificationClass::ActionRequired,
            "approval_requested",
            None,
        );
        assert!(p.observe(&sig, &env(now, true, true), &s).is_none());
        assert!(p.observe(&sig, &env(now, true, false), &s).is_some());
        // R4.3 关闭抑制开关后，聚焦+可见也通知
        let s2 = NotificationSettings {
            suppress_when_focused: false,
            ..Default::default()
        };
        assert!(p
            .observe(&sig, &env(now + Duration::from_secs(5), true, true), &s2)
            .is_some());
    }

    /// R2.2 / AC4：节流窗口内同实例同事件只发一条；窗口过后恢复。
    #[test]
    fn throttle_storm_within_interval() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default(); // 2s
        let t0 = Instant::now();
        let sig = signal(
            NotificationClass::ActionRequired,
            "approval_requested",
            Some("rm -rf build"),
        );
        assert!(p.observe(&sig, &unfocused(t0), &s).is_some());
        for i in 1..10 {
            let t = t0 + Duration::from_millis(i * 100); // 0.1s ~ 0.9s，均在窗口内
            assert!(
                p.observe(&sig, &unfocused(t), &s).is_none(),
                "burst {i} must be throttled"
            );
        }
        assert!(p
            .observe(&sig, &unfocused(t0 + Duration::from_secs(3)), &s)
            .is_some());
    }

    /// R2.3 / AC2 / D3：Completed 类走合并窗口 —— 短时间内两条「完成」只发一条；
    /// 多轮会话的下一轮（窗口外）恢复。
    #[test]
    fn completion_merge_window() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default(); // merge 3s
        let t0 = Instant::now();
        let done = signal(NotificationClass::Completed, "turn_completed", None);
        assert!(p.observe(&done, &unfocused(t0), &s).is_some());
        assert!(p
            .observe(&done, &unfocused(t0 + Duration::from_millis(500)), &s)
            .is_none());
        assert!(p
            .observe(&done, &unfocused(t0 + Duration::from_secs(4)), &s)
            .is_some());
    }

    /// 节流按 (domain, instance, event) 分槽：跨实例、跨事件互不影响。
    #[test]
    fn throttle_is_per_instance_and_event() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        assert!(p
            .observe(
                &signal(
                    NotificationClass::ActionRequired,
                    "approval_requested",
                    None
                ),
                &unfocused(now),
                &s
            )
            .is_some());
        let mut other_instance = signal(
            NotificationClass::ActionRequired,
            "approval_requested",
            None,
        );
        other_instance.source.instance_id = "s2".into();
        assert!(p.observe(&other_instance, &unfocused(now), &s).is_some());
        assert!(p
            .observe(
                &signal(NotificationClass::Failed, "session_failed", None),
                &unfocused(now),
                &s
            )
            .is_some());
    }

    /// R2.4 / AC5：10KB detail → 正文按字符截断并带省略号，绝不整段进通知。
    #[test]
    fn body_truncated_to_max_chars() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default(); // 200
        let huge = "x".repeat(10 * 1024);
        let d = p
            .observe(
                &signal(
                    NotificationClass::ActionRequired,
                    "input_requested",
                    Some(&huge),
                ),
                &unfocused(Instant::now()),
                &s,
            )
            .unwrap();
        assert_eq!(d.body.chars().count(), 200);
        assert!(d.body.ends_with('…'));
    }

    /// 截断 Unicode 安全（char 边界，不按字节）：CJK 与 emoji 不 panic、不截半。
    #[test]
    fn truncation_is_unicode_safe() {
        assert_eq!(truncate_chars("你好世界", 3), "你好…");
        assert_eq!(truncate_chars("abc", 0), "");
        let emoji = "🦀".repeat(50);
        let t = truncate_chars(&emoji, 10);
        assert_eq!(t.chars().count(), 10);
        assert!(t.ends_with('…'));
    }

    /// detail 为 None / 空串 / 纯空白 → 落类别兜底文案。
    ///
    /// 期望值由 `NotificationClass::default_body()` **推导**而非复述字面量：
    /// 兜底文案是产品文案，会随需求调整；钉死副本会让改文案时测试假红（同一事实两个定义点）。
    #[test]
    fn blank_detail_falls_back_to_class_default() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        let d = p
            .observe(
                &signal(NotificationClass::Failed, "session_failed", None),
                &unfocused(now),
                &s,
            )
            .unwrap();
        assert_eq!(
            d.body,
            format!("[opencode] {}", NotificationClass::Failed.default_body())
        );
        let d2 = p
            .observe(
                &signal(
                    NotificationClass::ActionRequired,
                    "input_requested",
                    Some("   "),
                ),
                &unfocused(now + Duration::from_secs(5)),
                &s,
            )
            .unwrap();
        assert_eq!(
            d2.body,
            format!(
                "[opencode] {}",
                NotificationClass::ActionRequired.default_body()
            )
        );
    }

    /// R2.5：来源名（pi/opencode）是数据不是分支 —— 裁决结果同构，名字只进文案。
    #[test]
    fn origin_label_is_data_not_branch() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        let mut pi = signal(NotificationClass::Completed, "turn_completed", Some("done"));
        pi.source.origin_label = "pi".into();
        let d_pi = p.observe(&pi, &unfocused(now), &s).unwrap();
        let d_oc = p
            .observe(
                &signal(NotificationClass::Completed, "turn_completed", Some("done")),
                &unfocused(now + Duration::from_secs(10)),
                &s,
            )
            .unwrap();
        assert_eq!(d_pi.title, d_oc.title);
        assert!(d_pi.body.starts_with("[pi] "));
        assert!(d_oc.body.starts_with("[opencode] "));
    }

    /// D2：实例关闭回收记忆；回收后同实例可立即再发，且不误伤其他实例。
    #[test]
    fn release_instance_frees_only_that_instance() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let now = Instant::now();
        let sig = signal(
            NotificationClass::ActionRequired,
            "approval_requested",
            None,
        );
        let mut other = sig.clone();
        other.source.instance_id = "s2".into();
        assert!(p.observe(&sig, &unfocused(now), &s).is_some());
        assert!(p.observe(&other, &unfocused(now), &s).is_some());
        p.release_instance("agent", "s1");
        assert_eq!(p.fired.len(), 1); // s2 的记忆保留
        assert!(p.observe(&sig, &unfocused(now), &s).is_some()); // s1 立即可再发
    }

    /// 超长 group_label 不撑爆标题（标题有上限）。
    #[test]
    fn title_is_bounded() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let mut sig = signal(NotificationClass::Completed, "turn_completed", None);
        sig.source.group_label = "p".repeat(500);
        let d = p.observe(&sig, &unfocused(Instant::now()), &s).unwrap();
        assert!(d.title.chars().count() <= super::super::types::MAX_TITLE_CHARS);
    }

    /// R7.1/R7.3：主题进副标题（trim 后原样），空/缺省/全空白 → 空串（不回退成占位符）。
    #[test]
    fn topic_becomes_subtitle_only_when_present() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();

        // 三次 observe 用不同 event_key：同会话同事件受 2s 节流（R2.2），本用例只测组装。
        let d = p
            .observe(
                &signal_with_topic(
                    NotificationClass::Completed,
                    "turn_completed",
                    None,
                    Some("  修复登录竞态  "),
                ),
                &unfocused(Instant::now()),
                &s,
            )
            .unwrap();
        assert_eq!(d.subtitle, "修复登录竞态");

        // 无主题（源 B 拿不到 title 的常态）→ 空副标题，不是 "[]" 也不是空格。
        let d = p
            .observe(
                &signal(NotificationClass::Failed, "session_failed", None),
                &unfocused(Instant::now()),
                &s,
            )
            .unwrap();
        assert_eq!(d.subtitle, "");

        let d = p
            .observe(
                &signal_with_topic(
                    NotificationClass::ActionRequired,
                    "approval_requested",
                    None,
                    Some("   "),
                ),
                &unfocused(Instant::now()),
                &s,
            )
            .unwrap();
        assert_eq!(d.subtitle, "");
    }

    /// R7.3：副标题有独立上限（60，比标题 80 短 —— macOS 单行展示位），
    /// 截断按 char 边界（CJK 不得截半 panic）。
    #[test]
    fn subtitle_is_bounded_and_unicode_safe() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let d = p
            .observe(
                &signal_with_topic(
                    NotificationClass::Completed,
                    "turn_completed",
                    None,
                    Some(&"会话主题很长的中文内容".repeat(20)),
                ),
                &unfocused(Instant::now()),
                &s,
            )
            .unwrap();
        assert!(
            d.subtitle.chars().count() <= super::super::types::MAX_SUBTITLE_CHARS,
            "副标题应截断至 {MAX} 字符，实际 {}",
            d.subtitle.chars().count(),
            MAX = super::super::types::MAX_SUBTITLE_CHARS
        );
        assert!(d.subtitle.ends_with('…'), "截断应带省略号");
    }

    /// 副标题不得挤占正文：主题存在时正文仍是 detail（拼装互不干扰）。
    #[test]
    fn subtitle_does_not_consume_body() {
        let mut p = NotificationPolicy::new();
        let s = NotificationSettings::default();
        let d = p
            .observe(
                &signal_with_topic(
                    NotificationClass::ActionRequired,
                    "approval_requested",
                    Some("edit_file: main.rs"),
                    Some("修复登录"),
                ),
                &unfocused(Instant::now()),
                &s,
            )
            .unwrap();
        assert_eq!(d.subtitle, "修复登录");
        assert_eq!(d.body, "[opencode] edit_file: main.rs");
    }
}
