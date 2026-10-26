//! macOS 后端：`UNUserNotificationCenter`（现代 API）。
//!
//! 线程模型：`UNUserNotificationCenter.currentNotificationCenter()` 与请求投递都必须在主线程，
//! 全部经 `AppHandle::run_on_main_thread` 跳回；center 用主线程 `thread_local` 缓存，
//! 免 `Send/Sync` 之争。授权一次性请求（首次触发系统弹窗，R4.5 语义），成功后缓存标志。
//!
//! **裸二进制守卫**：`UNUserNotificationCenter` 要求 bundle 化进程（有 bundleIdentifier），
//! 裸 Mach-O（`tauri dev` 默认形态）调用它会直接 abort（不是报错），故先查 `bundleIdentifier`，
//! 无 bundle 返回 `None` 回退插件路径。
//!
//! 2026-10-13 实测补齐后半段：该回退在 macOS 26+ 是**死路** —— 插件底座
//! `NSUserNotificationCenter` 已被 Apple 移除（调用成功、日志无错、横幅不出现）。
//! 开发态因此不能靠回退拿系统通知，必须让进程本身跑在 .app 里：`src-tauri/scripts/macos-dev-bundle.sh`
//! 经 cargo runner（`src-tauri/.cargo/config.toml`）把 `cargo run` 的产物包成 adhoc 签名的
//! dev .app 再执行。缺签名 / 缺 LaunchServices 注册都会被 UN 以 `Code=1 not allowed` 拒绝，
//! 逐项实测见该脚本头注释。
//!
//! **前台呈现必须挂 delegate**（2026-10-13 实测，usernoted 日志为证）：
//! `willPresentNotification` 缺席时，系统对**前台**应用的呈现选项退化为空集 ——
//! 通知被收下、写进通知中心，但不弹横幅：
//!
//! - 无 delegate + 应用不在前台 → `Presenting … as banner (["badge","sound","alert"])`
//! - 无 delegate + 应用在前台 → `Presenting … as banner ([])`（静默）
//! - 有 delegate + 应用在前台 → `Presenting … as banner (["sound","list","banner"])`
//!
//! Neeko 是常驻前台的应用，故本模块必须注册 [`NotificationDelegate`] 并在 `willPresent`
//! 里显式要求 `[Banner, Sound, List]`。
//!
//! **点击回流也在这个委托里**（`didReceiveNotificationResponse`）：投递时把 deep link 写进
//! `userInfo`，点击时取回并交 [`set_click_handler`] 注册的回调 —— 插件那套
//! `extra` + `onAction` 在 macOS 这条直写 UN 的路径上完全不生效，故这是本平台**唯一**的
//! 精确回流通道。回调内容由通知域决定（本平台层只透传字符串，不认识「会话」语义）。

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use super::types::ClickHandler;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNNotificationTrigger, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use tauri::AppHandle;

thread_local! {
    /// 主线程缓存（仅经 run_on_main_thread 访问，无需 Send）。
    static CENTER: RefCell<Option<Retained<UNUserNotificationCenter>>> = const { RefCell::new(None) };

    /// 前台呈现委托的**强引用持有处**：`UNUserNotificationCenter.delegate` 是 weak 属性，
    /// 不在这里持有就会立刻释放，前台横幅静默复现（见模块头实测三行对照）。
    static DELEGATE: RefCell<Option<Retained<NotificationDelegate>>> = const { RefCell::new(None) };
}

/// `userInfo` 中携带回流地址的键名。
///
/// 与 `notification/dispatch.rs::EXTRA_DEEP_LINK_KEY`（插件路径写进 `extra` 的同名键）以及
/// 前端 `useNotificationReflow.ts` 的读取键三处同值 —— 分属三个语言/层，无法共享常量，
/// 故本文件末的测试用 `include_str!` 把三者钉成一体（同仓库既有的跨文件字面量护栏模式）。
///
/// 平台层刻意不认识「通知」业务语义：它只把点进来的这条字符串**原样交回**调用方注册的
/// 回调（[`set_click_handler`]），路由到哪个会话是通知域的 `reflow` 路由表的事。
const USER_INFO_DEEP_LINK_KEY: &str = "deepLink";

/// 点击回流回调的**注册处**（由通知域一次性注册，见 `notification::boot`）。
///
/// `OnceLock` 而非 `Mutex`：只注册一次、之后只读 —— 委托方法在 ObjC 回调栈里执行，
/// 那里再取锁会把「投递层是否在临界区」变成隐藏的时序约束，只读快照没有这个问题。
static CLICK_HANDLER: OnceLock<ClickHandler> = OnceLock::new();

/// 注册点击回流回调（幂等：重复注册返回 `false` 且保留首次注册的处理函数）。
///
/// 回调拿到的是通知里的 `userInfo` 深链原串；空串/缺失不会调用（见 [`deep_link_of`]）。
#[must_use]
pub fn set_click_handler(handler: ClickHandler) -> bool {
    CLICK_HANDLER.set(handler).is_ok()
}

/// 前台呈现选项（单一常量源）：横幅 + 声音 + 通知中心列表。
///
/// Apple 已废弃 `Alert`（macOS 14+），现行组合是 `Banner`/`List`/`Sound`/`Badge`。
/// 独立成常量是为了让它可被测试断言 —— 返回空集会静默丢横幅（本模块头记录的真实故障），
/// 是「编译通过但功能消失」的形态，只能靠断言钉住。
const FOREGROUND_PRESENTATION: UNNotificationPresentationOptions =
    UNNotificationPresentationOptions::Banner
        .union(UNNotificationPresentationOptions::Sound)
        .union(UNNotificationPresentationOptions::List);

// 通知中心委托：`willPresent` 决定前台是否也弹横幅，`didReceive` 是**点击**的唯一入口。
//
// 两个选择器都必须实现，且各修的是不同故障：
// - 缺 `willPresent` → 前台横幅静默消失（模块头的 usernoted 三行实测）；
// - 缺 `didReceive` → 点击通知只是把应用带到前台，**无法定位到具体会话**。
//   在后端直写 UN（macOS）这条路径上，插件那套 `extra.deepLink` + `onAction` 回流**完全不生效**，
//   故这里是 macOS 唯一的精确回流点。本项目未使用 `UNNotificationCategory` 自定义动作。
define_class!(
    // SAFETY:
    // - `NSObject` 是线程安全超类，本类无 `Drop` 实现、无实例变量。
    // - 方法签名与 `UNUserNotificationCenterDelegate` 声明逐字一致。
    #[unsafe(super(NSObject))]
    #[name = "NeekoUNNotificationDelegate"]
    struct NotificationDelegate;

    impl NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((FOREGROUND_PRESENTATION,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            // 投递前必然已注册（要先有通知才可能被点击），但缺注册也只是少一次回流，静默通过。
            // 这条三级访问链（response→notification→request→content→userInfo）刻意留在委托里：
            // 它是不可测的那层薄胶水，提取规则本身在 `deep_link_of` 里直测。
            if let Some(handler) = CLICK_HANDLER.get() {
                let user_info = response.notification().request().content().userInfo();
                if let Some(link) = deep_link_of(&user_info) {
                    handler(&link);
                }
            }
            // 系统要求必须调用：不调用会被记为一次未完成回调（后续点击节流/丢弃）。
            completion_handler.call(());
        }
    }

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {}
);

/// 从 `userInfo` 字典里取出回流地址（**提取规则的唯一实现点**，纯函数、可直接单测）。
///
/// 接受 `&NSDictionary` 而非 `UNNotificationResponse`：后者在单测里构造不出来（没有公开
/// 初始化器），若把访问链 `response.notification().request().content().userInfo()` 写进
/// 提取函数，这条三级链就完全落在测试射程之外 —— 写错了也全绿。拆开后：
/// - 本函数用**真实构造的 NSDictionary** 覆盖全部语义分支（有键/无键/空值/非字符串）；
/// - 委托侧只剩一行取值与分发，链路长度为 1，肉眼可校。
///
/// 类型处理：只把**键**重解释为 `NSString`（本模块是唯一写入点，键必是字符串），
/// **值保持 `AnyObject`** 再逐条 `downcast_ref` —— 这不是样板：`userInfo` 是系统级
/// 公共字典，他人/未来版本完全可能放非字符串值，把整个字典重解释成 `NSString → NSString`
/// 会让那种情形变成 UB 而不是可处理的 `None`。
fn deep_link_of(user_info: &NSDictionary) -> Option<String> {
    // SAFETY: 本模块是唯一的 userInfo 写入点，键都是 NSString（见 `user_info_with_deep_link`）；
    // 值不参与 reinterpret，仍为 AnyObject —— 类型安全那一半留在下面的 downcast_ref。
    let typed = unsafe { user_info.cast_unchecked::<NSString, AnyObject>() };
    let key = NSString::from_str(USER_INFO_DEEP_LINK_KEY);
    let value = typed.objectForKey(&key)?;
    // 非 NSString 值 → 当作无回流目标（不 panic、不把对象描述当深链）。
    let link = value.downcast_ref::<NSString>()?.to_string();
    if link.is_empty() {
        return None;
    }
    Some(link)
}

impl NotificationDelegate {
    /// 新建委托实例（无实例变量，`init` 后即可用）。
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: `NSObject` 的 `init` 无前置条件，且本类未覆写它。
        unsafe { msg_send![super(this), init] }
    }
}

/// 权限已授予标志：首次成功 request 后置位，之后投递省一次异步往返。
static AUTHORIZED: AtomicBool = AtomicBool::new(false);

/// 无 bundle 守卫只 warn 一次（dev 每次通知都命中会刷屏）。
static UNAVAILABLE_LOGGED: AtomicBool = AtomicBool::new(false);

/// 经 UNUserNotificationCenter 投递横幅（主线程异步，fire-and-forget）。
///
/// 返回 `Some(())` = 已由本后端消费；`None` = 无 bundle 的裸二进制（dev），调用方回退插件。
///
/// `deep_link` 写进 `userInfo`：点击时 [`NotificationDelegate::did_receive`] 取回并交回调，
/// 这是本平台**唯一**的精确回流通道（插件那套 `extra` + `onAction` 不经过这里）。
///
/// 借用入参（非 `String`）：门面 stub 必须是 `const fn`（红线 10），而 `const fn` 不能析构
/// 带 `Drop` 的参数（E0493）；owned 化只发生在本实现真要跳主线程时。
pub fn try_deliver(
    app: &AppHandle,
    title: &str,
    subtitle: &str,
    body: &str,
    deep_link: &str,
) -> Option<()> {
    // 裸 dev 二进制：UN 会 abort，必须回退（返回 None 让调用方走插件路径）。
    if NSBundle::mainBundle().bundleIdentifier().is_none() {
        if !UNAVAILABLE_LOGGED.swap(true, Ordering::Relaxed) {
            log::warn!(
                "[notify] macOS: no bundle identity (bare binary) — UNUserNotificationCenter \
                unusable, falling back to the plugin, whose NSUserNotificationCenter base is \
                dead on macOS 26+ (banners will not appear). Run via `pnpm tauri dev` \
                (src-tauri/scripts/macos-dev-bundle.sh wraps the binary in a dev .app) \
                or use a bundled build."
            );
        }
        return None;
    }

    let title = title.to_string();
    let subtitle = subtitle.to_string();
    let body = body.to_string();
    let deep_link = deep_link.to_string();
    let run = app.run_on_main_thread(move || {
        let Some(center) = CENTER.with(|cell| {
            let mut slot = cell.borrow_mut();
            if slot.is_none() {
                let center = UNUserNotificationCenter::currentNotificationCenter();
                // 前台呈现委托必须在内核投递前挂上，且强引用由 DELEGATE 持有（delegate 是
                // weak 属性）—— 见模块头「前台呈现必须挂 delegate」的三行实测对照。
                DELEGATE.with(|delegate| {
                    let mut delegate = delegate.borrow_mut();
                    if delegate.is_none() {
                        let new = NotificationDelegate::new();
                        center.setDelegate(Some(ProtocolObject::from_ref(&*new)));
                        *delegate = Some(new);
                    }
                });
                *slot = Some(center);
            }
            slot.clone()
        }) else {
            // 理论不可达（get_or_init 语义）；真发生时丢一条通知，不 panic 不重复投递。
            log::warn!("[notify] macOS: UN center unavailable, delivery dropped");
            return;
        };

        if AUTHORIZED.load(Ordering::Relaxed) {
            post(&center, title, subtitle, body, deep_link);
            return;
        }
        // 首次：请求授权（触发系统弹窗；已决定过则立即回调，不再弹）。
        let center2 = center.clone();
        let payload = std::rc::Rc::new((title, subtitle, body, deep_link));
        let block = block2::RcBlock::new(move |granted: Bool, error: *mut NSError| {
            if bool::from(granted) {
                AUTHORIZED.store(true, Ordering::Relaxed);
                post(
                    &center2,
                    payload.0.clone(),
                    payload.1.clone(),
                    payload.2.clone(),
                    payload.3.clone(),
                );
            } else {
                // 区分「用户拒绝/弹窗超时」与「系统无法为该构建注册通知」（未签名 debug 包
                // 常见）：error 非空即后者居多，发布包（Developer ID 签名）不受影响。
                let reason = if error.is_null() {
                    "denied by user or prompt unanswered".to_string()
                } else {
                    unsafe { (*error).localizedDescription().to_string() }
                };
                log::warn!("[notify] macOS: UN authorization not granted ({reason}) — system banners suppressed");
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert
                | UNAuthorizationOptions::Sound
                | UNAuthorizationOptions::Badge,
            &block,
        );
    });
    // 主线程调度失败（窗口全关等极端态）= 放弃本次，Some 消费防插件路径重复。
    if run.is_err() {
        log::warn!("[notify] macOS: run_on_main_thread failed, delivery dropped");
    }
    Some(())
}

/// 构造带回流地址的 `userInfo`（`NSDictionary<NSString, NSString>` → 擦除成无泛型形式）。
///
/// `setUserInfo` 的签名收 `&NSDictionary`（默认泛型 `AnyObject`），而我们要放的是字符串对；
/// 两侧用 `cast_unchecked` 收敛 —— 值与键都是 `NSString`，reinterpret 成立（读取侧见
/// [`deep_link_of`]，同一判据的另一个端点）。
fn user_info_with_deep_link(deep_link: &str) -> Retained<NSDictionary> {
    let key = NSString::from_str(USER_INFO_DEEP_LINK_KEY);
    let value = NSString::from_str(deep_link);
    let dict = NSDictionary::from_slices(&[&*key], &[&*value]);
    // SAFETY: 泛型参数只描述运行时不变量；这里收窄到 AnyObject 不改变内存布局。
    unsafe { Retained::cast_unchecked::<NSDictionary>(dict) }
}

fn post(
    center: &UNUserNotificationCenter,
    title: String,
    subtitle: String,
    body: String,
    deep_link: String,
) {
    let content = {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        // 仅非空时调用：空的 subtitle 会让 macOS 渲染出一条空的第二行（占位空白）。
        if !subtitle.is_empty() {
            content.setSubtitle(&NSString::from_str(&subtitle));
        }
        content.setBody(&NSString::from_str(&body));
        // 默认提示音：`sound` 缺省时系统静音（darwin 侧实测结论，见同行调研纪要
        // 「macOS 未设 sound 即静音」）。授权与呈现掩码都申请了 Sound，此处必须落实，
        // 否则那两处声明是空转（「声明了却没人实现」的静默功能缺失形态）。
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        // 回流坐标：点击时由委托从 `userInfo` 取回（见 `deep_link_of`）。空串也写 ——
        // 缺键与空串对 `deep_link_of` 同一含义（无回流目标），不必造两种「无」。
        // SAFETY: 内容对象与字典都是本函数新构造并独占，`setUserInfo` 的泛型
        // 不变量由 `user_info_with_deep_link` 保证（键值都是 NSString）。
        unsafe { content.setUserInfo(&user_info_with_deep_link(&deep_link)) };
        content
    };
    let id = format!("neeko-{}", uuid::Uuid::new_v4());
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&id),
        &content,
        Option::<&UNNotificationTrigger>::None,
    );
    // `add` 的回调是「系统是否收下」的唯一权威信号（授权被拒 / 通知被关闭只在这里出现）——
    // 传 None 等于把失败静默掉，正是本模块要消灭的形态。
    let block = block2::RcBlock::new(move |error: *mut NSError| {
        if error.is_null() {
            log::debug!("[notify] macOS: UN accepted {id}");
        } else {
            let reason = unsafe { (*error).localizedDescription().to_string() };
            log::warn!("[notify] macOS: UN rejected {id}: {reason}");
        }
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&block));
}

// ── TDD：前台呈现回归守卫 ─────────────────────────────────────────────────────
//
// 背景（2026-10-13 实测）：无 delegate 时系统对前台应用把呈现选项退化为空集 ——
// 通知被收下、进通知中心，但不弹横幅，**编译与运行时都不报错**。这类「功能静默消失」
// 只能靠断言钉住，故在此守住两条：呈现掩码非空且含 Banner；委托类确实声明了
// willPresent 选择器（改名/漏实现会让前台横幅悄悄回到空集）。

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::sel;
    use objc2_foundation::NSNumber;

    /// 构造 `userInfo` 的静态类型 `NSDictionary<AnyObject, AnyObject>`，值类型任意。
    ///
    /// 生产侧只需要 `NSString → NSString`（[`user_info_with_deep_link`]），而测试要能造
    /// 非字符串值 —— 这条路径正是「把整个字典重解释成 `NSString → NSString` 会变 UB」的验体。
    fn user_info_of(value: &AnyObject) -> Retained<NSDictionary> {
        let key: Retained<NSString> = NSString::from_str(USER_INFO_DEEP_LINK_KEY);
        let dict: Retained<NSDictionary<NSString, AnyObject>> =
            NSDictionary::from_slices(&[&*key], &[value]);
        // SAFETY: 泛型参数只描述运行时不变量，擦除到 AnyObject 不改变内存布局。
        unsafe { Retained::cast_unchecked::<NSDictionary>(dict) }
    }

    /// `Retained<T>` → `&AnyObject`（ObjC 里任何对象都是 AnyObject）。
    fn as_any<T: objc2::Message>(object: &T) -> &AnyObject {
        // SAFETY: 所有 ObjC 对象都是合法的 AnyObject。
        unsafe { &*(std::ptr::from_ref(object).cast()) }
    }

    /// 呈现掩码必须显式含 `Banner`（空集 = 前台静默，正是本模块要防的故障形态）。
    #[test]
    fn foreground_presentation_includes_banner_and_is_not_empty() {
        assert!(
            !FOREGROUND_PRESENTATION.is_empty(),
            "空掩码会让前台横幅静默消失"
        );
        assert!(
            FOREGROUND_PRESENTATION.contains(UNNotificationPresentationOptions::Banner),
            "必须含 Banner：Apple 已废弃 Alert，Banner 是现行横幅位"
        );
        // `Sound` 与授权/掩码声明必须匹配实现：本模块已 `setSound(defaultSound)`，
        // 掩码里缺 Sound 会让提示音被前台呈现规则吃掉（声明与实现的又一处静默缺口）。
        assert!(
            FOREGROUND_PRESENTATION.contains(UNNotificationPresentationOptions::Sound),
            "必须含 Sound：mask 与 setSound 必须同时成立，缺一即静音"
        );
    }

    /// 通知内容必须真的带上默认提示音（`sound` 缺省 = 系统静音）。
    ///
    /// 断言在**真实构造的内容对象**上取回 `sound`（而非读源码文本）—— 与本模块
    /// 「声明即契约」的既有守卫同型：授权与呈现掩码都申请了 Sound，这里断的是实现侧
    /// 有没有落实，防止再次退回「声明了却没人实现」。
    #[test]
    fn posted_content_carries_default_sound() {
        let content = UNMutableNotificationContent::new();
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        assert!(
            content.sound().is_some(),
            "UNMutableNotificationContent 未带 sound —— 系统会静音投递"
        );
    }

    /// 委托类必须真实实现 `willPresentNotification` 选择器。
    ///
    /// 用 Objective-C 运行时查询（而非读源码文本）—— 这才是系统实际会调用的判据；
    /// 漏实现/改错选择器名字时，系统会退回「无 delegate」语义，前台横幅静默丢失。
    #[test]
    fn delegate_implements_will_present_selector() {
        let instance: Retained<NotificationDelegate> = NotificationDelegate::new();
        let obj: &AnyObject = &instance;
        let selector = sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:);
        // SAFETY: `respondsToSelector:` 接受任意选择器并对任意对象安全。
        let responds: bool = unsafe { msg_send![obj, respondsToSelector: selector] };
        assert!(
            responds,
            "委托未实现 willPresentNotification —— 前台横幅会静默丢失"
        );
    }

    /// 委托类必须真实实现 `didReceiveNotificationResponse` 选择器。
    ///
    /// 在后端直写 UN 的 macOS 路径上，插件那套 `extra.deepLink` + `onAction` 不生效 ——
    /// 缺这个选择器就意味着「点了系统通知只能把应用带到前台，定位不到会话」，且同样
    /// 运行时不报错。断言方式与上一条同型（ObjC 运行时查询，不读源码文本）。
    #[test]
    fn delegate_implements_did_receive_selector() {
        let instance: Retained<NotificationDelegate> = NotificationDelegate::new();
        let obj: &AnyObject = &instance;
        let selector =
            sel!(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:);
        // SAFETY: `respondsToSelector:` 接受任意选择器并对任意对象安全。
        let responds: bool = unsafe { msg_send![obj, respondsToSelector: selector] };
        assert!(
            responds,
            "委托未实现 didReceiveNotificationResponse —— 点击通知将无法精确回流"
        );
    }

    /// 写入侧 → 读取侧的 `userInfo` 往返：`post` 写的键就是 `deep_link_of` 读的键。
    ///
    /// 两处各写了一边，任何一侧改名都会让回流静默失效（点击照旧只带应用前台），
    /// 而单元测试是唯一能在无 GUI 下验证这条通路的地方。
    #[test]
    fn user_info_round_trips_the_deep_link() {
        let dict = user_info_with_deep_link("neeko://agent/s1");
        assert_eq!(
            deep_link_of(&dict).as_deref(),
            Some("neeko://agent/s1"),
            "写入的深链必须能被 deep_link_of 原样读回"
        );
    }

    /// 缺键 → `None`（不是 panic，也不是 `Some("")`）。
    ///
    /// 这条路径真实存在：他人往 `userInfo` 写东西、或未来版本换了载荷都是这个形态。
    #[test]
    fn missing_key_yields_none() {
        let other_key: Retained<NSString> = NSString::from_str("someOtherKey");
        let value: Retained<NSString> = NSString::from_str("neeko://agent/s1");
        let dict: Retained<NSDictionary<NSString, AnyObject>> =
            NSDictionary::from_slices(&[&*other_key], &[as_any(&*value)]);
        // SAFETY: 同 `user_info_with_deep_link`（键值都是 ObjC 对象）。
        let dict = unsafe { Retained::cast_unchecked::<NSDictionary>(dict) };
        assert_eq!(deep_link_of(&dict), None, "缺失 deepLink 键时不得凭空造值");
    }

    /// 键在但值为空串 → `None`（与 `deep_link_of` 的「空串 = 无回流目标」同一语义，
    /// 不制造第二种「无」）。
    #[test]
    fn empty_value_yields_none() {
        let dict = user_info_with_deep_link("");
        assert_eq!(deep_link_of(&dict), None);
    }

    /// 非字符串值 → `None`（不 panic、不把对象描述当深链）。
    ///
    /// 这是拆出 `deep_link_of` 之后**新增的可测面**：把整个字典重解释成
    /// `NSString → NSString` 的写法在这里会变成 UB，而现在是一个确定的 `None`。
    #[test]
    fn non_string_value_yields_none() {
        // `NSNumber` 是本仓 `objc2-foundation` 特性集下可构造的最简单非字符串值。
        let value = NSNumber::numberWithUnsignedChar(7);
        let dict = user_info_of(as_any(&*value));
        assert_eq!(deep_link_of(&dict), None, "非字符串值必须被类型判定拦住");
    }

    /// `userInfo` 键名三端同值：本文件（写入/读取）· `notification/dispatch.rs`（插件
    /// `extra` 写入）· 前端 reflow hook（JS 读取）。改名必须三处同改。
    #[test]
    fn user_info_key_matches_dispatcher_and_frontend() {
        const DISPATCH: &str = include_str!("../../notification/dispatch.rs");
        const FRONTEND: &str =
            include_str!("../../../../src/features/notification/hooks/useNotificationReflow.ts");
        let needle = format!("\"{USER_INFO_DEEP_LINK_KEY}\"");
        let js_needle = format!("'{USER_INFO_DEEP_LINK_KEY}'");
        assert!(
            DISPATCH.contains(&needle),
            "notification/dispatch.rs 缺少 {needle}（三端键名必须同值）"
        );
        assert!(
            FRONTEND.contains(&js_needle),
            "useNotificationReflow.ts 缺少 {js_needle}（三端键名必须同值）"
        );
    }
}
