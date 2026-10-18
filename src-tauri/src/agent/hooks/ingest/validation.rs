//! **上报校验**：把 raw body 验证并解码成一条 [`HookEvent`]（源 B 的准入边界）。
//!
//! # 边界由类型签名强制
//!
//! 入参是 `(&str source, &[u8] body)` —— 它**无法**表达「HTTP」。因此不论传输换几次，
//! 这里都不可能长出传输职责。反过来传输侧（body 上限 / 超时 / panic / 并发 / 鉴权）
//! 全在 [`crate::server`] 引擎里，也不会长出业务分支。
//!
//! 纯函数、无 IO、无 tokio：所有分支都能用 `#[test]` 直测。
//!
//! # 三条判据，一个出口
//!
//! `source` 白名单 → JSON 解析 → 会话身份非空。任一不过即静默返回（fail-open）——
//! **没有第二个出站状态**，这正是删掉旧 `IngestOutcome` 枚举的原因。
//!
//! 注意本模块只回答「这条上报是否合法」，**不回答「收来干什么」**：事件的语义由各消费者解释
//! （通知见 [`super::notify`]；未来状态面板见各自的投影文件）。

use crate::agent::hooks::targets::HOOK_TARGETS;

use super::event::HookEvent;

/// token 校验请求头（上报模板与本域是同一 wire 契约的两端）。
///
/// 常量留在协议侧（`templates/tests.rs` / `targets/tests.rs` 锚点测试消费）；
/// **校验逻辑**本身在 [`crate::server::AuthGate`]（全仓唯一一处恒定时间比较）。
pub const TOKEN_HEADER: &str = "x-neeko-agent-hook-token";

/// 已路由、已鉴权的上报 → 校验并解码。`sink` 收到通过全部判据的事件。
///
/// `sink` 的第一个参数是**白名单归一后**的 source（`&'static str`，可直接进日志/通知），
/// 与入参的原始路径段是两个东西 —— 故实现与调用方都用不同名字区分（不遮蔽）。
///
/// 返回 unit：所有不合法路径都是 fail-open（静默 204）。
pub fn validate(source: &str, body: &[u8], mut sink: impl FnMut(&str, HookEvent)) {
    let Some(source) = hook_source(source) else {
        return; // 白名单外：静默（`hook_source` 内已记 warn）
    };
    let Ok(event) = serde_json::from_slice::<HookEvent>(body) else {
        return; // 非法 JSON：静默
    };
    if event.is_usable() {
        sink(source, event);
    }
}

/// `/hook/{source}` → 白名单内的 `&'static str`。
///
/// 白名单直接来自 [`HOOK_TARGETS`] —— 路由与文件面共用同一张表，接新 CLI 只加一行数据。
fn hook_source(source: &str) -> Option<&'static str> {
    match HOOK_TARGETS.iter().find(|target| target.source == source) {
        Some(target) => Some(target.source),
        None => {
            // **可观测性缺口修补（2026-10-16 实测事故）**：未知 source 静默返回 204，
            // 与「载荷畸形」共用同一个 fail-open 出口 → 用户看到的 HTTP 状态无法区分两者。
            // 实测形态：运行中的进程是加新 CLI 之前编译的（HOOK_TARGETS 是编译期常量），
            // 于是新 CLI 的上报全被静默丢弃、无任何日志，表现为「刚装上有通知、之后一直没通知」。
            //
            // 记 warn 让「路由未注册」可自证；仍返回 204（fail-open 契约不变）。
            log::warn!(
                "[agent-hooks] unknown source {source:?} (not in HOOK_TARGETS); \
                 the running binary may predate that CLI line — rebuild/restart Neeko"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_body() -> &'static [u8] {
        br#"{"agent_session_id":"a1","event":"turn_completed","cwd":"/x/proj"}"#
    }

    /// happy path：合法 source + 合法 event → sink 收到恰好一次。
    #[test]
    fn accepted_delivers_event_to_sink() {
        let mut got = None;
        validate("opencode", valid_body(), |source, event| {
            got = Some((source.to_string(), event));
        });
        let (source, event) = got.expect("sink called");
        assert_eq!(source, "opencode");
        assert_eq!(event.agent_session_id, "a1");
        assert_eq!(event.event, "turn_completed");
    }

    /// 语义不合法一律静默：白名单外 / 非法 JSON / 空 session_id / 缺必填字段。
    #[test]
    fn malformed_semantics_fail_open() {
        let cases: [(&str, &[u8]); 4] = [
            ("cursor", valid_body()), // 未接入的 CLI
            ("pi", b"not json"),
            ("pi", br#"{"agent_session_id":"","event":"turn_completed"}"#),
            ("pi", br#"{"event":"turn_completed"}"#),
        ];
        for (source, body) in cases {
            let mut called = false;
            validate(source, body, |_, _| called = true);
            assert!(!called, "sink must stay silent for {source} / {body:?}");
        }
    }

    /// 路由白名单来自事实表：表里的 source 全通，表外的一律静默。
    #[test]
    fn route_whitelist_derives_from_hook_targets() {
        for target in HOOK_TARGETS {
            let mut got = None;
            validate(target.source, valid_body(), |source, _| {
                got = Some(source.to_string());
            });
            assert_eq!(got.as_deref(), Some(target.source));
        }

        let mut delivered = false;
        validate("cursor", valid_body(), |_, _| delivered = true);
        assert!(!delivered, "unknown source must not deliver");
    }

    /// 未知 source 与已注册 source 的唯一可辨差异是「是否投递」（HTTP 都是 204）。
    ///
    /// 实测事故（2026-10-16）的产物：运行中的二进制早于某个 CLI 被加入 `HOOK_TARGETS`，
    /// 该 CLI 的上报被静默丢弃且无任何日志，表现为「刚装上有通知、之后一直没通知」。
    /// 修补是加 warn；本用例钉住「两者都 fail-open 204」这半（行为契约不变）。
    #[test]
    fn unknown_source_is_silent_but_known_source_delivers() {
        assert!(hook_source("pi").is_some());
        assert!(hook_source("not-a-registered-cli").is_none());

        let mut delivered = false;
        validate("pi", valid_body(), |_, _| delivered = true);
        assert!(delivered, "已注册 source 必须投递");

        let mut delivered_unknown = false;
        validate("not-a-registered-cli", valid_body(), |_, _| {
            delivered_unknown = true;
        });
        assert!(!delivered_unknown, "未知 source 不得投递");
    }
}
