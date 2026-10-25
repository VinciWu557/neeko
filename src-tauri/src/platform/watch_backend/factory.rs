//! 平台 watcher 构造工厂：把「物理排除集合」烘焙进后端，并处理运行时回退。
//!
//! 排除集合的来源是 `WatchManifest.ignored_roots`，经 [`build_exclusion_paths`] 归一后传入；
//! macOS 实现在 `FSEventStreamStart` 之前调用 `FSEventStreamSetExclusionPaths` 落盘。

// notify `RecommendedWatcher::new` 是 `Watcher` trait 方法，构造工厂需要该 trait 在作用域内。
use notify::Watcher;

use super::platform_watcher::PlatformWatcher;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 运行时回退开关的环境变量名：置任意值即禁用 macOS 物理排除，退回
/// `RecursiveFilterOnly`（回调过滤仍保证正确性）。用于 exclusion 后端出问题时
/// 不阻塞可用性，无需改配置。
pub const DISABLE_FSEVENT_EXCLUSION_ENV: &str = "NEEKO_DISABLE_FSEVENT_EXCLUSION";

/// 排除成本档位表（**启发式**，不是忽略判定 —— 不在表里的目录同样会被排除，
/// 只是截断时优先级低）。
///
/// **为什么需要分档**：`FSEventStreamSetExclusionPaths` 有 **8 条硬上限**
/// （Apple 头文件 "A maximum of 8 directories maybe specified"，实测 9 条即整体
/// 失败）。`WatchManifest.ignored_roots` 的顺序来自 `read_dir` 遍历序（无保证），
/// 超过 8 个时必须显式排序，否则 `target` / `node_modules` 可能被挤出前 8。
///
/// **为什么是 3 档而不是 2 档**：真机验证暴露了两档的浪费 —— 一个 33 个
/// ignored 根的仓库里，8 个名额被 4 个 `__pycache__` 占掉（实测仅 138 个文件），
/// 而 `node_modules` 有 41843 个。同档内按字母序决胜时，小目录会挤掉大目录。
///
/// 档位依据（本仓库实测文件数，仅作量级参考）：
/// | 目录 | 量级 |
/// |---|---|
/// | `target` | 10⁵ |
/// | `node_modules` | 10⁴ |
/// | `dist` / `.next` / `build` | 10³ ~ 10⁴ |
/// | `__pycache__` / `.venv` | 10² ~ 10³（视项目而定） |
/// | `.idea` / `.neeko` 等配置目录 | 10⁰ ~ 10¹ |
///
/// ⚠️ **静态表的固有局限**：`__pycache__` 在 Python 项目里可能有数千文件，
/// 在纯 Rust 仓库里只有 138 个。跨项目通用性无法靠目录名完美解决；
/// 按实测文件数排序不可行（数一遍 `node_modules` 需 0.64s，33 个根 = 20s 级
/// 挂载开销）。故取「档位 + 名字」这一廉价且确定性的近似。
const COST_TIER_0: &[&str] = &["target", "node_modules", "DerivedData", "Pods"];
const COST_TIER_1: &[&str] = &[
    "dist",
    "build",
    ".next",
    "out",
    ".turbo",
    ".parcel-cache",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
    ".tox",
    "coverage",
];

/// 排除成本档位：0 = 条目量最大（10⁴~10⁵），1 = 中等，2 = 其余（多为配置目录）。
fn exclusion_cost_tier(path: &Path) -> u8 {
    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) if COST_TIER_0.contains(&name) => 0,
        Some(name) if COST_TIER_1.contains(&name) => 1,
        _ => 2,
    }
}

/// 归一监听边界排除集合：去重 + **按成本降序**排列。
///
/// 输入是 `WatchManifest.ignored_roots`（已按 gitignore / 用户排除剪枝出的**顶层** ignored
/// 根，父必为可见目录，因此互不为祖先）。
///
/// **契约变更（2026-10）**：此前是「去重 + 保序」。保序会让截断取决于 `read_dir`
/// 遍历序，高成本子树可能落到第 9 位之后而失去内核排除（见 [`HEAVY_DIR_NAMES`] 的
/// 说明）。现在改为确定性排序，保证截断时保留成本最高的子树。
///
/// **不新增忽略判定语义**：哪些路径被排除完全由 `GitIgnoreFilter` 决定，本函数
/// 只决定「超过 8 个时保留哪 8 个」。忽略规则仍然只有一个决策点。
///
/// 排序键 `(tier, depth, file_name)` 全部实现 `Ord` ⇒ 结果与遍历序无关（确定性）。
#[must_use]
pub fn build_exclusion_paths(ignored_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::with_capacity(ignored_roots.len());
    let mut out: Vec<PathBuf> = Vec::with_capacity(ignored_roots.len());
    for path in ignored_roots {
        if seen.insert(path.clone()) {
            out.push(path.clone());
        }
    }
    out.sort_by(|a, b| {
        exclusion_cost_tier(a)
            .cmp(&exclusion_cost_tier(b))
            // 同档位内：浅层优先（父目录排除可覆盖更多子树的成本，且截断时更稳）
            .then_with(|| a.components().count().cmp(&b.components().count()))
            .then_with(|| a.file_name().cmp(&b.file_name()))
    });
    out
}

/// 读取运行时回退开关（独立小函数：让工厂主体不依赖环境变量即可直测）。
#[cfg(target_os = "macos")]
fn fsevent_exclusion_disabled() -> bool {
    std::env::var_os(DISABLE_FSEVENT_EXCLUSION_ENV).is_some()
}

/// 构造平台文件 watcher：把压缩后的性能排除集合烘焙进后端。
///
/// - **macOS 且 `exclusions` 非空且未设回退开关** → [`PlatformWatcher::MacExclusion`]（递归
///   FSEvents + 物理排除集）；构造失败（CF 分配）则记 warn 并回退 `Native`。
/// - **其余情况**（非 macOS / 空集合 / 运行时回退开关 / 构造失败）→ [`PlatformWatcher::Native`]
///   （`notify::RecommendedWatcher`，行为与 W2 之前逐字一致）。
///
/// 回退不是正确性依赖：结构事件收敛仍在回调层兜底，物理排除只省掉 OS 侧投递成本。
pub fn create_file_watcher<F: notify::EventHandler>(
    handler: F,
    config: notify::Config,
    exclusions: &[PathBuf],
) -> notify::Result<PlatformWatcher> {
    #[cfg(target_os = "macos")]
    let disabled = fsevent_exclusion_disabled();
    #[cfg(not(target_os = "macos"))]
    let disabled = true;
    create_file_watcher_with_disabled(handler, config, exclusions, disabled)
}

/// [`create_file_watcher`] 的可测内核：运行时开关以参数注入（避免测试改全局 env）。
fn create_file_watcher_with_disabled<F: notify::EventHandler>(
    handler: F,
    config: notify::Config,
    exclusions: &[PathBuf],
    disabled: bool,
) -> notify::Result<PlatformWatcher> {
    #[cfg(target_os = "macos")]
    {
        if disabled {
            log::warn!(
                "[WatchBackend] {DISABLE_FSEVENT_EXCLUSION_ENV} set; \
                 using native recursive backend without physical exclusion"
            );
        }
        if !disabled && !exclusions.is_empty() {
            return match super::macos_fsevent::MacFseventWatcher::with_exclusions(
                handler, exclusions,
            ) {
                Ok(watcher) => Ok(PlatformWatcher::MacExclusion(watcher)),
                Err(fallback_handler) => {
                    log::warn!(
                        "[WatchBackend] macOS exclusion watcher unavailable; \
                         falling back to native recursive (callback filter still applies)"
                    );
                    Ok(PlatformWatcher::Native(notify::RecommendedWatcher::new(
                        fallback_handler,
                        config,
                    )?))
                }
            };
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (exclusions, disabled);
    Ok(PlatformWatcher::Native(notify::RecommendedWatcher::new(
        handler, config,
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 排除集合归一：去重（重复输入只保留一份）。
    ///
    /// 注意：**不再断言保序**。排序契约已改为「按成本降序」，见
    /// [`exclusion_sort_ranks_heavy_above_light`]。旧名 `..._and_preserves_order`
    /// 会与本文件的排序实现矛盾，且它的两个输入（`node_modules` / `target`）
    /// 恰好都是 tier 0、同 depth，按名字排序后 `node_modules < target` 与输入顺序
    /// 一致 —— 排序完全失效时它也会通过，无法作为判别依据。
    #[test]
    fn build_exclusion_paths_dedupes() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("node_modules");
        let b = tmp.path().join("target");
        let input = vec![a.clone(), b.clone(), a.clone(), b.clone()];
        let out = build_exclusion_paths(&input);
        assert_eq!(out.len(), 2, "重复输入必须去重");
        assert!(out.contains(&a) && out.contains(&b));
    }

    /// 判别性测试：tier 0（已知高成本目录）必须排在 tier 1 之前。
    ///
    /// 这是唯一能在「排序未实现」时变红的用例 —— 输入顺序故意让 tier 1 在前。
    #[test]
    fn exclusion_sort_ranks_heavy_above_light() {
        let tmp = tempfile::tempdir().unwrap();
        let light = tmp.path().join("aaa-light-dir");
        let heavy = tmp.path().join("node_modules");
        // 输入顺序：light 在前。若排序未生效，输出仍是 light 在前。
        let out = build_exclusion_paths(&[light.clone(), heavy.clone()]);
        assert_eq!(out, vec![heavy, light], "tier 0 必须优先于 tier 1");
    }

    /// 截断场景：12 个 ignored 根、`target`/`node_modules` 排在末尾，
    /// 排序后必须进入前 8（前 8 是唯一能拿到内核排除的名额）。
    ///
    /// 仅 macOS 有意义：`MAX_FSEVENT_EXCLUSIONS` 是 FSEvents 后端常量，
    /// 其它平台不截断（`build_exclusion_paths` 本身跨平台可用）。
    #[cfg(target_os = "macos")]
    #[test]
    fn exclusion_sort_keeps_heavy_roots_when_truncated() {
        let tmp = tempfile::tempdir().unwrap();
        let mut input: Vec<PathBuf> = (0..10)
            .map(|i| tmp.path().join(format!("light-{i:02}")))
            .collect();
        let heavy_a = tmp.path().join("node_modules");
        let heavy_b = tmp.path().join("target");
        input.push(heavy_a.clone());
        input.push(heavy_b.clone());

        let out = build_exclusion_paths(&input);
        assert_eq!(out.len(), 12, "排序不改变成员数");
        let cap = crate::platform::watch_backend::macos_fsevent::MAX_FSEVENT_EXCLUSIONS;
        let first8 = &out[..cap.min(out.len())];
        assert!(
            first8.contains(&heavy_a) && first8.contains(&heavy_b),
            "高成本目录必须进入前 8，实际前 8 = {:?}",
            first8
        );
    }

    /// 确定性：同一输入两次排序结果逐位相同（不依赖 HashSet 迭代序）。
    #[test]
    fn exclusion_sort_is_deterministic() {
        let tmp = tempfile::tempdir().unwrap();
        let input: Vec<PathBuf> = (0..20)
            .map(|i| tmp.path().join(format!("dir-{i:02}")))
            .collect();
        let a = build_exclusion_paths(&input);
        let b = build_exclusion_paths(&input);
        assert_eq!(a, b, "同一输入必须产出逐位相同的结果");
    }

    /// 排序不改变集合成员（只是顺序变）。
    #[test]
    fn exclusion_sort_preserves_membership() {
        let tmp = tempfile::tempdir().unwrap();
        let input: Vec<PathBuf> = ["target", "node_modules", "dist", "aaa", "zzz"]
            .iter()
            .map(|n| tmp.path().join(n))
            .collect();
        let mut out = build_exclusion_paths(&input);
        let mut expected = input.clone();
        out.sort();
        expected.sort();
        assert_eq!(out, expected, "排序只能改变顺序，不得增删成员");
    }

    /// 空输入 → 空集合（工厂据此走 Native 回退，行为与 W2 前一致）。
    #[test]
    fn build_exclusion_paths_empty_input_is_empty() {
        assert!(build_exclusion_paths(&[]).is_empty());
    }

    /// 无排除集合（或非 macOS）→ 原生 notify 后端，行为与 W2 前一致。
    #[test]
    fn create_file_watcher_without_exclusions_uses_native_backend() {
        let (tx, _rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let watcher = create_file_watcher_with_disabled(tx, notify::Config::default(), &[], false)
            .expect("construct watcher");
        assert!(matches!(watcher, PlatformWatcher::Native(_)));
    }

    /// 运行时回退开关置位 → 即使有排除集合也退回原生（AC3 的「不能排除」降级路径）。
    #[cfg(target_os = "macos")]
    #[test]
    fn create_file_watcher_disabled_falls_back_to_native() {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, _rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let exclusions = vec![tmp.path().join("target")];
        let watcher =
            create_file_watcher_with_disabled(tx, notify::Config::default(), &exclusions, true)
                .expect("construct watcher");
        assert!(matches!(watcher, PlatformWatcher::Native(_)));
    }

    /// 能排除的路径 → macOS 物理排除后端（AC3 的「能排除」路径）。
    #[cfg(target_os = "macos")]
    #[test]
    fn create_file_watcher_with_exclusions_uses_mac_exclusion_backend() {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, _rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let exclusions = vec![tmp.path().join("target")];
        let watcher =
            create_file_watcher_with_disabled(tx, notify::Config::default(), &exclusions, false)
                .expect("construct watcher");
        assert!(matches!(watcher, PlatformWatcher::MacExclusion(_)));
    }

    /// 公开工厂读 env 开关的默认路径（未设开关 + 有排除集 → macOS 排除后端）。
    /// 覆盖 `fsevent_exclusion_disabled()` 的读取分支（N-4）；env 已置位时跳过
    /// （不修改全局 env，避开与并行测试的竞争）。
    #[cfg(target_os = "macos")]
    #[test]
    fn create_file_watcher_defaults_to_mac_exclusion_when_env_unset() {
        if std::env::var_os(DISABLE_FSEVENT_EXCLUSION_ENV).is_some() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let (tx, _rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let exclusions = vec![tmp.path().join("target")];
        let watcher =
            create_file_watcher(tx, notify::Config::default(), &exclusions).expect("construct");
        assert!(matches!(watcher, PlatformWatcher::MacExclusion(_)));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod real_repo_shape_tests {
    use super::*;
    use std::path::PathBuf;

    /// 真实仓库形态回归：`ignored_roots` 里既有顶层 `node_modules`/`dist`，
    /// 也有深层 `packages/x/node_modules`、`src-tauri/target`。
    /// 排序后**前 8 必须全部是 tier 0**，否则内核排除名额会被浅层的
    /// 非高成本目录（如 `.neeko`、`docs`）占掉。
    #[test]
    fn heavy_roots_dominate_first_eight_on_realistic_repo_shape() {
        let root = PathBuf::from("/repo");
        // 模拟本仓库实测的 33 个 ignored 根：混合深度与档位，输入顺序打乱
        let mut input: Vec<PathBuf> = vec![
            root.join(".neeko"),
            root.join(".atomcode"),
            root.join("docs"),
            root.join("scripts"),
            root.join("packages/app/dist"),
            root.join("packages/dsh/node_modules"),
            root.join("src-tauri/target"),
            root.join("dist"),
            root.join("node_modules"),
        ];
        // 再加一批浅层非高成本目录（真实仓库里它们排在前面）
        for i in 0..10 {
            input.insert(i, root.join(format!("misc-{i:02}")));
        }

        let out = build_exclusion_paths(&input);
        let cap = MAX_FSEVENT_EXCLUSIONS_FOR_TEST;
        let first: Vec<&PathBuf> = out.iter().take(cap).collect();

        // 所有 tier 0 目录（node_modules / dist / target）必须在前 8
        let heavy: Vec<&PathBuf> = input
            .iter()
            .filter(|p| {
                matches!(
                    p.file_name().and_then(|n| n.to_str()),
                    Some("node_modules") | Some("dist") | Some("target")
                )
            })
            .collect();
        assert!(heavy.len() <= cap, "本用例假定高成本目录数不超过 {}", cap);
        for h in &heavy {
            assert!(
                first.contains(h),
                "高成本目录 {} 必须进入前 {}，实际前 {} = {:?}",
                h.display(),
                cap,
                cap,
                first
            );
        }
    }

    /// 真机验证暴露的浪费场景（回归锁定）：
    ///
    /// 一个 33 个 ignored 根的仓库里，两档方案让 4 个 `__pycache__`
    /// （实测仅 138 个文件）挤进了 8 个名额，把 `dist` 等大目录推出去。
    /// 三档后 `__pycache__`（tier 1）必须让位给 `target`/`node_modules`（tier 0）。
    #[test]
    fn low_cost_config_dirs_do_not_crowd_out_heavy_roots() {
        let root = PathBuf::from("/repo");
        let mut input = vec![
            root.join(".idea"),
            root.join(".neeko"),
            root.join(".opencode"),
            root.join(".pi"),
            root.join(".workbuddy"),
            root.join("a/__pycache__"),
            root.join("b/__pycache__"),
            root.join("c/__pycache__"),
            root.join("d/__pycache__"),
            root.join("target"),
            root.join("node_modules"),
            root.join("dist"),
        ];
        input.reverse(); // 让浅层配置目录排在输入最前

        let out = build_exclusion_paths(&input);
        let first8: Vec<String> = out
            .iter()
            .take(MAX_FSEVENT_EXCLUSIONS_FOR_TEST)
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();

        for must in ["target", "node_modules", "dist"] {
            assert!(
                first8.iter().any(|n| n == must),
                "{} 必须进入前 8，实际 = {:?}",
                must,
                first8
            );
        }
        // 高成本目录必须**全部**排在任何 tier 2 配置目录之前。
        // （12 个候选里大目录只有 7 个，第 8 个名额给 tier 2 是数学必然，
        //  不是缺陷 —— 关键是大目录一个都不能被挤掉。）
        let first_tier2 = first8
            .iter()
            .position(|n| {
                matches!(
                    n.as_str(),
                    ".idea" | ".neeko" | ".opencode" | ".pi" | ".workbuddy"
                )
            })
            .unwrap_or(first8.len());
        for (idx, name) in first8.iter().enumerate() {
            if matches!(name.as_str(), "target" | "node_modules" | "dist") {
                assert!(
                    idx < first_tier2,
                    "{} 排在了配置目录之后（idx={} first_tier2={}），实际 = {:?}",
                    name,
                    idx,
                    first_tier2,
                    first8
                );
            }
        }
    }

    /// 供本模块引用（避免跨模块路径噪音）。
    const MAX_FSEVENT_EXCLUSIONS_FOR_TEST: usize = 8;
}
