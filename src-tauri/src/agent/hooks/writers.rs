//! pi / opencode hook 文件的安装 / 卸载 / 状态（design §2.5 客人义务，R6.5）。
//!
//! 分层：`*_all` 只做「遍历 [`super::targets::HOOK_TARGETS`] + 定位各 CLI 目录」，
//! 真正的文件面动作在 `*_at`（入参已给定目录）—— 目录解析是环境事实，动作是纯逻辑，
//! 后者可 100% 用 tempdir 直测，测试不需要污染真实用户目录。
//!
//! 契约：
//! - **独立文件即插拔**：只写 `neeko-status.*` 一个文件到各 CLI 的扩展/plugin 目录，
//!   绝不修改用户既有配置文件内容（对齐 orca 的 opencode plugin / pi extension 形态，
//!   避开 claude settings.json 式结构化合并难题）。
//! - **归属标记**：首行 `// @neeko-managed-hook v<版本>`；卸载/覆盖只认自家标记，
//!   无标记（或不可读）的同名文件视为他人资产，拒绝触碰。
//! - **幂等**：内容一致不重写（避免 mtime 抖动引起 CLI 端无谓重载）。
//! - **结果机器可读**：返回 [`HookApplyOutcome`]（status 枚举 + detail 文本），前端按 status
//!   分类呈现 —— 跨语言契约不许靠英文散文子串匹配（改个词就静默错分类）。

use std::path::{Path, PathBuf};

use super::targets::{HookTarget, HOOK_TARGETS};

/// 归属标记前缀（模板与卸载判定的单一契约）。
pub const MANAGED_MARKER: &str = "// @neeko-managed-hook";

/// 归属标记里应有的版本位（与 `Cargo.toml` 同源）。
fn version_token() -> String {
    format!("v{}", env!("CARGO_PKG_VERSION"))
}

fn render(template: &str) -> String {
    format!("{MANAGED_MARKER} {}\n{template}", version_token())
}

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
    /// 按客人义务跳过（同名他人文件等），非故障。
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
}

/// 已存在文件的归属：读一次首行标记，顺带得出版本是否当前。
enum Ownership {
    Foreign,
    Managed { version_current: bool },
}

/// 不可读（含非 UTF-8）一律按**他人资产**对待 —— 宁可拒绝覆盖也不能破坏用户文件（R6.5）。
fn ownership_of(path: &Path) -> Ownership {
    let first = std::fs::read_to_string(path)
        .ok()
        .and_then(|content| content.lines().next().map(str::to_string));
    match first.and_then(|line| line.strip_prefix(MANAGED_MARKER).map(str::to_string)) {
        None => Ownership::Foreign,
        Some(rest) => Ownership::Managed {
            version_current: rest.trim() == version_token(),
        },
    }
}

fn outcome(target: &HookTarget, status: HookApplyStatus, detail: String) -> HookApplyOutcome {
    HookApplyOutcome {
        source: target.source.to_string(),
        status,
        detail,
    }
}

/// 各 CLI 的安装状态（设置页数据行；一个 CLI 一行，目录未建也如实回报未安装）。
#[must_use]
pub fn status_all() -> Vec<HookInstallStatus> {
    HOOK_TARGETS
        .iter()
        .map(|target| match (target.dir)() {
            Some(dir) => status_at(target, &dir),
            None => HookInstallStatus {
                source: target.source.to_string(),
                path: String::new(),
                installed: false,
                version_current: false,
            },
        })
        .collect()
}

fn status_at(target: &HookTarget, dir: &Path) -> HookInstallStatus {
    let (installed, version_current) = match dir_to_file(target, dir) {
        Some(path) if path.is_file() => match ownership_of(&path) {
            Ownership::Foreign => (false, false),
            Ownership::Managed { version_current } => (true, version_current),
        },
        // 目录不存在 = 该 CLI 未在此机器初始化过配置面；状态查询不代创建（客人不喧宾）。
        _ => (false, false),
    };
    HookInstallStatus {
        source: target.source.to_string(),
        path: dir.join(target.file_name).display().to_string(),
        installed,
        version_current,
    }
}

/// 仅当 `dir` 已存在时给出目标文件路径。
fn dir_to_file(target: &HookTarget, dir: &Path) -> Option<PathBuf> {
    dir.is_dir().then(|| dir.join(target.file_name))
}

/// 安装（幂等）。逐 CLI 返回回执，失败项含原因。
#[must_use]
pub fn install_all() -> Vec<HookApplyOutcome> {
    HOOK_TARGETS
        .iter()
        .map(|target| match (target.dir)() {
            Some(dir) => install_at(target, &dir),
            None => outcome(
                target,
                HookApplyStatus::Failed,
                "cannot locate user config directory".to_string(),
            ),
        })
        .collect()
}

/// 卸载：只删带自家标记的文件（他人资产与不存在都安全跳过；不存在不产生回执行）。
#[must_use]
pub fn uninstall_all() -> Vec<HookApplyOutcome> {
    HOOK_TARGETS
        .iter()
        .filter_map(|target| (target.dir)().and_then(|dir| uninstall_at(target, &dir)))
        .collect()
}

fn install_at(target: &HookTarget, dir: &Path) -> HookApplyOutcome {
    // 安装 = 用户显式同意的动作：投放目录不存在则创建（空目录对 CLI 无害）；
    // 「客人」边界守在文件内容 —— 同名他人文件（无自家标记）绝不覆盖。
    let path = dir.join(target.file_name);
    if let Err(err) = std::fs::create_dir_all(dir) {
        return outcome(
            target,
            HookApplyStatus::Failed,
            format!("mkdir {}: {err}", dir.display()),
        );
    }
    if path.is_file() && matches!(ownership_of(&path), Ownership::Foreign) {
        return outcome(
            target,
            HookApplyStatus::Skipped,
            format!("{} exists and is not Neeko-managed", target.file_name),
        );
    }
    let content = render(target.template);
    if std::fs::read_to_string(&path).is_ok_and(|existing| existing == content) {
        return outcome(target, HookApplyStatus::Unchanged, String::new());
    }
    match std::fs::write(&path, &content) {
        Ok(()) => outcome(target, HookApplyStatus::Applied, String::new()),
        Err(err) => outcome(target, HookApplyStatus::Failed, err.to_string()),
    }
}

fn uninstall_at(target: &HookTarget, dir: &Path) -> Option<HookApplyOutcome> {
    let path = dir.join(target.file_name);
    if !path.is_file() {
        return None; // 从未安装：不产生噪音行
    }
    Some(match ownership_of(&path) {
        Ownership::Foreign => outcome(
            target,
            HookApplyStatus::Skipped,
            format!("{} is not Neeko-managed, kept", target.file_name),
        ),
        Ownership::Managed { .. } => match std::fs::remove_file(&path) {
            Ok(()) => outcome(target, HookApplyStatus::Removed, String::new()),
            Err(err) => outcome(target, HookApplyStatus::Failed, err.to_string()),
        },
    })
}

/// 开机收敛决策（design §2.5 生命周期治理：设置是意图，文件是事实，单向对齐）。
///
/// 返回需要执行的动作：意图开而任一 CLI 未装/版本旧 → `Install`；意图关而有已装文件 →
/// `Uninstall`；一致 → `None`。纯函数便于测试；两个动作本身幂等（重复执行无害）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReconcileAction {
    /// 安装/重写受管 hook 文件。
    Install,
    /// 删除自家标记的受管 hook 文件。
    Uninstall,
}

/// 计算开机/保存后的收敛动作（见 [`ReconcileAction`] 方向语义）。
///
/// 目标数取自事实表（不再各自维护计数常量）：列表短于目标数说明调用方只拿到了部分事实，
/// 意图为开时必须补装。
#[must_use]
pub fn reconcile_action(want: bool, statuses: &[HookInstallStatus]) -> Option<ReconcileAction> {
    let all_good = statuses.len() == HOOK_TARGETS.len()
        && statuses.iter().all(|s| s.installed && s.version_current);
    let any_installed = statuses.iter().any(|s| s.installed);
    match (want, all_good, any_installed) {
        (true, false, _) => Some(ReconcileAction::Install),
        (false, _, true) => Some(ReconcileAction::Uninstall),
        _ => None,
    }
}

// ── TDD：受管文件语义（标记/幂等/他人文件保护）、收敛决策与双端契约 ───────────────
//      动作函数一律按 (target, dir) 显式传临时目录，不触真实用户目录（红线 13）。──

#[cfg(test)]
mod tests {
    use super::*;

    /// 指向临时目录的测试 target（`dir` 字段在 `*_at` 路径上不被调用）。
    fn target(file_name: &'static str) -> HookTarget {
        HookTarget {
            source: "demo",
            file_name,
            template: "BODY",
            dir: || None,
        }
    }

    fn write_at(path: &Path, content: &str) {
        std::fs::write(path, content).expect("write");
    }

    /// install_at：目录不存在时创建并写入（安装是用户显式同意，建投放目录属正常语义）。
    #[test]
    fn install_creates_missing_dir_and_writes() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let nested = tmp.path().join("not-yet");
        let got = install_at(&target("neeko-status.js"), &nested);
        assert_eq!(got.status, HookApplyStatus::Applied, "{got:?}");
        assert_eq!(got.source, "demo");
        assert!(nested.join("neeko-status.js").is_file());
    }

    /// install_at：首次 Applied，再次同内容 = Unchanged（幂等，无 mtime 抖动）。
    #[test]
    fn install_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let t = target("neeko-status.js");
        assert_eq!(install_at(&t, tmp.path()).status, HookApplyStatus::Applied);
        assert_eq!(
            install_at(&t, tmp.path()).status,
            HookApplyStatus::Unchanged
        );
    }

    /// 同名他人文件（无标记）绝不覆盖；不可读（非 UTF-8）同判他人资产。
    #[test]
    fn foreign_file_is_never_touched() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("neeko-status.js");
        let t = target("neeko-status.js");

        write_at(&file, "// someone else's plugin\nconsole.log(1)");
        let got = install_at(&t, tmp.path());
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert!(std::fs::read_to_string(&file)
            .expect("read")
            .contains("someone else"));

        let raw = vec![0xff_u8, 0xfe, 0x00, 0x01];
        std::fs::write(&file, &raw).expect("write bytes");
        assert_eq!(install_at(&t, tmp.path()).status, HookApplyStatus::Skipped);
        assert_eq!(std::fs::read(&file).expect("read"), raw);
    }

    /// status_at：受管且版本一致 / 版本旧 / 他人文件 / 目录缺失四态。
    #[test]
    fn status_reflects_marker_and_version() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("neeko-status.js");
        let t = target("neeko-status.js");

        write_at(&file, &render(t.template));
        let s = status_at(&t, tmp.path());
        assert!(s.installed && s.version_current);

        write_at(&file, &format!("{MANAGED_MARKER} v0.0.0\nbody"));
        let s = status_at(&t, tmp.path());
        assert!(s.installed && !s.version_current);

        write_at(&file, "// foreign\n");
        assert!(!status_at(&t, tmp.path()).installed);

        let missing = tmp.path().join("nope");
        let s = status_at(&t, &missing);
        assert!(!s.installed && !s.version_current);
        assert_eq!(
            s.path,
            missing.join("neeko-status.js").display().to_string()
        );
    }

    /// uninstall_at：只删受管文件；他人文件 Skipped；从未安装不产生回执行。
    #[test]
    fn uninstall_only_removes_managed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(
            &tmp.path().join("managed.js"),
            &format!("{MANAGED_MARKER} v1\nbody"),
        );
        write_at(&tmp.path().join("foreign.js"), "// foreign\n");

        let got = uninstall_at(&target("managed.js"), tmp.path()).expect("outcome");
        assert_eq!(got.status, HookApplyStatus::Removed);
        assert!(!tmp.path().join("managed.js").exists());

        let got = uninstall_at(&target("foreign.js"), tmp.path()).expect("outcome");
        assert_eq!(got.status, HookApplyStatus::Skipped);
        assert!(tmp.path().join("foreign.js").is_file());

        assert!(uninstall_at(&target("never-installed.js"), tmp.path()).is_none());
    }

    /// 目录缺失时 status 不越权创建目录（查询是只读的）。
    #[test]
    fn status_never_creates_directories() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("absent");
        status_at(&target("neeko-status.js"), &missing);
        assert!(!missing.exists());
    }

    /// 模板自校验：每个受管 CLI 的嵌入模板必须含 endpoint 重读、token 头与 loopback 锚点
    /// （防手改丢关键行为）。断言引用**常量本身** —— 任一侧改名，测试立刻红。
    #[test]
    fn embedded_templates_keep_contract_anchors() {
        use crate::agent::hooks::{endpoint, server};
        for target in HOOK_TARGETS {
            for anchor in [
                "endpoint.env",
                endpoint::ENV_KEY_PORT,
                endpoint::ENV_KEY_TOKEN,
                server::TOKEN_HEADER,
                "127.0.0.1",
            ] {
                assert!(
                    target.template.contains(anchor),
                    "{} 模板缺少契约锚点 {anchor:?}（endpoint 重读 / token / loopback）",
                    target.source
                );
            }
            // 主题上报（R7.5）：双模板都必须带 title 字段，否则副标题整条链静默失效。
            assert!(
                target.template.contains("title:"),
                "{} 模板未上报 title（会话主题链路断裂）",
                target.source
            );
        }
        // 主题的**原生来源**各 CLI 不同，锚点分别钉死：opencode 靠 Session.title 增量事件，
        // pi 靠 session_info 命名 + 首条用户消息回退。
        let opencode = HOOK_TARGETS
            .iter()
            .find(|t| t.source == "opencode")
            .expect("opencode target");
        assert!(
            opencode.template.contains("session.updated"),
            "opencode 模板缺少 session.updated 订阅（标题后到时拿不到真名）"
        );
        // 「等待用户行动」在 opencode 1.19 是**两个独立事件族**：permission.asked（权限门）
        // 与 question.asked（ask 类工具阻塞）。实测只订阅前者时，question 类阻塞在任何系统
        // 通知里都不出现 —— 两条锚点都必须钉住。
        for anchor in ["permission.asked", "question.asked"] {
            assert!(
                opencode.template.contains(anchor),
                "opencode 模板缺少 {anchor} 订阅（等待用户行动的通知会静默丢失）"
            );
        }
        let pi = HOOK_TARGETS
            .iter()
            .find(|t| t.source == "pi")
            .expect("pi target");
        for anchor in ["getSessionName", "getEntries"] {
            assert!(
                pi.template.contains(anchor),
                "pi 模板缺少主题锚点 {anchor:?}（原生名 / 首条用户消息回退）"
            );
        }
        // pi 的 ui_prompt_start 载荷只有 `{kind, title?}`（无 text/message）：
        // 缺 kind/title 读取时 detail 恒为 null，通知正文退化成类别兜底。
        for anchor in ["ui_prompt_start", "event.title", "event.kind"] {
            assert!(
                pi.template.contains(anchor),
                "pi 模板缺少 {anchor:?}（等待输入的详情会静默丢失）"
            );
        }
    }

    /// 开机收敛决策：意图/事实不一致的方向正确性（含"列表短于目标数"须补装）。
    #[test]
    fn reconcile_converges_intent_to_files() {
        let st = |installed: bool, cur: bool| HookInstallStatus {
            source: "demo".into(),
            path: String::new(),
            installed,
            version_current: cur,
        };
        let both = || vec![st(true, true), st(true, true)];
        assert_eq!(both().len(), HOOK_TARGETS.len());
        // 意图开：一侧缺装 → Install；列表短于目标（部分事实）→ Install；一版旧 → Install
        let mut half = both();
        half[1].installed = false;
        assert_eq!(
            reconcile_action(true, &half),
            Some(ReconcileAction::Install)
        );
        assert_eq!(
            reconcile_action(true, &both()[..1]),
            Some(ReconcileAction::Install)
        );
        let mut stale = both();
        stale[0].version_current = false;
        assert_eq!(
            reconcile_action(true, &stale),
            Some(ReconcileAction::Install)
        );
        // 意图开且两套最新 → 无动作
        assert_eq!(reconcile_action(true, &both()), None);
        // 意图关：无已装 → 无动作；有已装 → Uninstall
        let none_installed = vec![st(false, false), st(false, false)];
        assert_eq!(reconcile_action(false, &none_installed), None);
        assert_eq!(
            reconcile_action(false, &both()),
            Some(ReconcileAction::Uninstall)
        );
    }

    /// 回执/状态序列化形状与前端 TS 镜像同源（跨语言契约不许各自漂移）。
    #[test]
    fn outcomes_match_frontend_type_mirror() {
        const FRONTEND: &str = include_str!("../../../../src/shared/types/notification.ts");
        let json = serde_json::to_value(HookApplyStatus::Unchanged).expect("ser");
        assert_eq!(json, serde_json::json!("unchanged"));
        for variant in ["applied", "unchanged", "removed", "skipped", "failed"] {
            assert!(
                FRONTEND.contains(&format!("'{variant}'")),
                "前端 HookApplyStatus 镜像缺少 {variant}（改枚举必须双端同步）"
            );
        }
        for field in ["source", "status", "detail", "versionCurrent"] {
            assert!(
                FRONTEND.contains(&format!("{field}:")),
                "前端 notification.ts 镜像缺少字段 {field}"
            );
        }
    }
}
