//! 通知域启动接线（与 `session` / `agent` / `library` / `lsp` 四域对称，由组合根调用一次）。
//!
//! 只做一件事：把「用户点了系统通知」这条**入站**通道接到前端路由表上。
//!
//! ## 为什么注册不放在投递里
//!
//! 点击回流是**应用生命周期级的接线**（一次注册，长期有效），投递是**每条通知的事件**。
//! 把前者塞进后者有三个可复现后果：
//!
//! 1. **冷启动丢点击**：注册若只在首次 `deliver()` 时发生，用户点「上次运行遗留」的通知中心
//!    条目时回调还不存在 —— 应用被带到前台但定位不到会话（静默）。
//! 2. **每次投递一次无效堆分配**：`Box<dyn Fn>` 构造后被 `OnceLock::set` 拒绝并丢弃，
//!    非 macOS 平台更是每条通知白造一个再扔掉。
//! 3. **语义含糊**：`set_click_handler` 的返回值把「首次注册成功」与「早就注册好了」挤在
//!    一个 `bool` 里，调用侧的 `let _ =` 无法区分，等于无声失败。
//!
//! 放在 boot 还解决了另半边顺序问题：前端 `useNotificationReflow` 的订阅晚于 Rust
//! boot 完成，冷启动时若用户立刻点击，事件会打空（`emit` 无监听者即丢弃）。故本模块
//! 把深链**先存下来**（[`take_pending_deep_link`]），前端准备好后主动拉一次 ——
//! 「推送 + 拉取」两条腿，任一条通即可回流。
//!
//! ## 两条腿不能都无条件写
//!
//! 曾写成「每次点击都暂存 + 前端挂载时拉一次」，那有个真实的残留缺陷（2026-10-17）：
//! 应用运行中点击时，事件腿已经送达并路由，但暂存槽里那条**永远不会有人消费** ——
//! 下次前端重新挂载（dev 下 HMR 常见，生产下任何重挂都不行）就重放一次旧路由。
//! 即：一个只应该补「发送失败」的机制，实际成了无条件双写。
//!
//! 现在用显式状态机区分两者：前端在 `listen()` 的 Promise **resolve 之后**
//! （而不是挂载时）调 [`claim_reflow_ready`] 认领就绪，**之后点击只走事件腿**；
//! 就绪前的点击只进暂存槽。
//!
//! “恰好一次”因此成立：
//! - 就绪前：**不 emit 只暂存** —— 反正没监听者，emit 必丢；
//! - 就绪后：**只 emit 不暂存** —— 监听已生效，emit 必达。
//!
//! ## 为什么必须是「一个锁里的状态机」而不是两个独立 static
//!
//! 曾用 `AtomicBool FRONTEND_READY` + `Mutex PENDING` 两个独立状态，并且**两种情况都 emit**。
//! 那有两个真竞态（2026-10-17 推导）：
//!
//! 1. **重复路由**：点击读到 `false` → 暂存 → 前端置位并取走 → 闭包继续 emit 且恰好送达
//!    （`listen()` 其实已生效）→ 前端收到两次。当时靠下游 `reflowFromDeepLink` 幂等
//!    兜底；但一旦回流挂上一次性副作用（计数/发请求/弹窗）就是真重复执行。
//! 2. **暂存丢失**：点击读到 `false` → 前端置位并取走（此时槽空）→ 闭包才暂存
//!    → 该点击永久卡在槽里，直到下次重挂载才被当成「新点击」重放。
//!
//! 两个静态无法原子地「读就绪 + 写暂存」，故根本修法不是加锁而是**把两件事实收进同一个
//! `enum` 状态**，并让「未就绪」分支不再 emit（它本来就无意义）。
//! 这样锁住一次判定就同时决定了「要不要暂存」和「要不要 emit」，两者不可能矛盾。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

use super::dispatch::NOTIFICATION_REFOCUS_EVENT;

/// 回流通道的两种状态 —— **单一事实源**（就绪与暂存不可分，见模块头）。
enum ReflowChannel {
    /// 前端未订阅：点击只能暂存（emit 必丢，故**不发**）。
    /// `Some(..)` = 最后一次点击的深链（只保留最新一条：用户连点两条通知，有意义的
    /// 目标是最后那条；重放早期的会让界面连着跳两次）。
    Pending(Option<String>),
    /// 前端已订阅：点击直走事件，**永不暂存**（否则残留会在下次重挂载时重放）。
    Ready,
}

static CHANNEL: Mutex<ReflowChannel> = Mutex::new(ReflowChannel::Pending(None));

/// 一次点击的处理方式（由 [`on_click`] 判定，闭包据此决定要不要 emit）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClickDisposition {
    /// 已存入暂存槽，**不得 emit**（无监听者）。
    Stashed,
    /// 前端已就绪，**应当 emit**。
    Emit,
}

/// 注册点击回流通道。由组合根在 `setup` 阶段调用一次（非幂等保护：boot 只跑一次）。
///
/// 平台差异在 `platform::system_notify` 内部（macOS 接 UN 委托，其余为 no-op），
/// 本函数无条件调用、零 `#[cfg]`（红线 10）。
pub fn attach(app: &AppHandle) {
    let route_app = app.clone();
    // macOS 上返回 true（UN 委托已接管）；其余平台返回 false = 该平台回流走插件
    // `onAction`（前端订阅），本通道不参与 —— 这是正常的平台差异，不是错误。
    let native = crate::platform::system_notify::set_click_handler(Box::new(move |deep_link| {
        // 「存还是发」由同一个锁内判定给出，不存在「又存又发」的中间态。
        if on_click(deep_link) == ClickDisposition::Emit {
            let _ = route_app.emit(NOTIFICATION_REFOCUS_EVENT, deep_link);
        }
    }));
    log::debug!(
        "[notify] click-through channel registered (native delegate: {native}, \
         plugin onAction path is used on platforms where false)"
    );
}

/// 点击处理判定：在单把锁内完成「读状态 + 写入暂存」并给出处置。
///
/// 独立成函数而非内联在闭包里，是为了让「恰好一次处理」这条契约可直测 ——
/// 内联在 `attach` 的闭包时，测试只能手写一份相同的判定来「模拟」，那断言的是测试
/// 自己的副本，把逻辑真正改坏也照样绿（2026-10-17 实测确认过的假绿形态）。
fn on_click(deep_link: &str) -> ClickDisposition {
    let mut channel = lock();
    match &mut *channel {
        ReflowChannel::Pending(slot) => {
            // 空串不覆盖已有的待处理值（与 `deep_link_of` 的「空串 = 无回流目标」同语义）。
            if !deep_link.is_empty() {
                *slot = Some(deep_link.to_string());
            }
            ClickDisposition::Stashed
        }
        ReflowChannel::Ready => ClickDisposition::Emit,
    }
}

/// 前端回流监听已生效：**认领就绪** 并取回在此之前到达的点击。
///
/// 这两件事必须是一个原子动作（同一把锁、一次调用）：拆成两个命令就会出现
/// 「已置位但没人监听」与「取走了但点击还没写入」两类丢点击窗口。
///
/// 时机要求：必须在 `listen()` 的 Promise **resolve 之后**调用 —— 那是「订阅真的生效」
/// 的已知事实点，早于此调用就等于把状态标错了。
///
/// 幂等：第二次起恒返回 `None`（已 Ready）。前端重挂载（dev HMR）因此不会重放旧路由。
#[must_use]
pub fn claim_reflow_ready() -> Option<String> {
    let mut channel = lock();
    match std::mem::replace(&mut *channel, ReflowChannel::Ready) {
        ReflowChannel::Pending(slot) => slot,
        ReflowChannel::Ready => None,
    }
}

/// 取锁（中毒时继续：一个 panic 的调用方不应让回流通道永久不可用）。
fn lock() -> std::sync::MutexGuard<'static, ReflowChannel> {
    CHANNEL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── TDD：暂存语义（无需 AppHandle 的那一半）─────────────────────────────────
//
// `attach` 要真实 `AppHandle`（全仓无 `tauri::test` 先例），平台侧选择器由
// `platform/system_notify/macos.rs` 的运行时查询钉住。暂存是纯状态契约，可直测。

#[cfg(test)]
mod tests {
    use super::*;

    /// 用例级串行闸：所有用例共享 `CHANNEL` 这个 `static`，而 `cargo test` 默认多线程
    /// 并发跑同一个二进制的用例 —— 不串行就会互相覆盖状态。
    ///
    /// 不是理论风险：2026-10-17 实测 `--test-threads=8` 连跑 25 轮有 1 轮红（一个用例读到
    /// 被另一个清空的状态）。间歇性 flaky 在 CI 上比确定性红更贵：它训练人重跑而不查因。
    /// 照 `common/file/watcher/manager/lifecycle_tests.rs` 的既有先例（进程级 Mutex
    /// 而非引入 `serial_test` 依赖 —— 用例很少，不值得加 crate）。
    static TEST_GUARD: Mutex<()> = Mutex::new(());

    /// 取串行闸并把通道复位到「未就绪、空槽」—— 上一个用例失败提前返回也不会污染下一个。
    fn guard() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *lock() = ReflowChannel::Pending(None);
        g
    }

    /// 未就绪：点击进槽且**不发事件**（无监听者，发了也是丢）。
    #[test]
    fn click_before_ready_is_stashed_and_not_emitted() {
        let _g = guard();
        assert_eq!(on_click("neeko://agent/s1"), ClickDisposition::Stashed);
        assert_eq!(
            claim_reflow_ready().as_deref(),
            Some("neeko://agent/s1"),
            "未就绪期的点击必须能被认领就绪时取回"
        );
    }

    /// 认领就绪即换状态：之后点击只发事件，**永不暂存**。
    ///
    /// 这是「无残留」的钉子：若就绪后仍暂存，那条值无人消费，下次重挂载（dev HMR 常态）
    /// 会被当成新点击重放旧路由。
    #[test]
    fn click_after_ready_is_emitted_and_never_stashed() {
        let _g = guard();
        let first = claim_reflow_ready();
        assert_eq!(first, None, "无待处理点击时认领应返回 None");

        assert_eq!(on_click("neeko://agent/s2"), ClickDisposition::Emit);

        // 再一次认领必须为空 —— 证明就绪后的点击没有落进槽里。
        assert_eq!(
            claim_reflow_ready(),
            None,
            "就绪后的点击不得留下可被重放的值"
        );
    }

    /// 核心不变量：**任何一次点击都不会既进槽又要求 emit**。
    ///
    /// 两个独立 static（旧的 `FRONTEND_READY` + `PENDING`）无法保证这点 —— 那个版本
    /// 会既暂存又 emit，导致前端重复路由。单 enum + 单锁把两者变成互斥状态。
    #[test]
    fn a_click_never_both_stashes_and_emits() {
        let _g = guard();
        // 未就绪：Stashed（不发）
        assert_eq!(on_click("neeko://agent/a"), ClickDisposition::Stashed);
        let taken = claim_reflow_ready();
        assert_eq!(taken.as_deref(), Some("neeko://agent/a"));
        // 就绪：Emit（不存）
        assert_eq!(on_click("neeko://agent/b"), ClickDisposition::Emit);
        assert_eq!(claim_reflow_ready(), None);
    }

    /// 只保留最新一条：用户连点两条通知，有意义的目标是最后那条
    /// （重放早期的会让界面连着跳两次）。
    #[test]
    fn newer_click_overwrites_the_pending_one() {
        let _g = guard();
        on_click("neeko://agent/s1");
        on_click("neeko://agent/s2");
        assert_eq!(claim_reflow_ready().as_deref(), Some("neeko://agent/s2"));
    }

    /// 空串不覆盖已有待处理值（与 `deep_link_of` 的「空串 = 无回流目标」同语义，
    /// 不制造第二种「无」）。
    #[test]
    fn empty_click_does_not_clobber_a_pending_one() {
        let _g = guard();
        on_click("neeko://agent/s1");
        on_click("");
        assert_eq!(
            claim_reflow_ready().as_deref(),
            Some("neeko://agent/s1"),
            "空点击不得抹掉真实待处理目标"
        );
    }

    /// 认领就绪幂等：重复调用恒返回 `None`（前端重挂载不得重放旧路由）。
    #[test]
    fn claiming_ready_twice_yields_nothing() {
        let _g = guard();
        on_click("neeko://agent/s1");
        assert_eq!(claim_reflow_ready().as_deref(), Some("neeko://agent/s1"));
        assert_eq!(claim_reflow_ready(), None);
        assert_eq!(claim_reflow_ready(), None);
    }
}
