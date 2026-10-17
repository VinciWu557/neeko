//! 受管文件的**归属**判定：自家标记、内容寻址版本位、他人资产守卫。
//!
//! # 为什么单独一个模块
//!
//! 「这个文件是不是 Neeko 装上去的」是**三条安装腿**（`Standalone` / `Structured` /
//! `NotifyArgv`）与三条卸载腿**共同的**前置判据。它此前与安装/卸载/状态逻辑混在一个
//! 971 行的文件里，于是「同一契约有几个实现点」不可读 —— 而历史上正是这里漏了两条腿的
//! 守卫（`shim_foreign_guard` 只有 `Standalone` 调用），造成用户同名脚本被覆盖。
//!
//! 抽为独立模块后，「归属判据」的**实现**只有一处可改（`ownership_of`）；
//! 对外可见性按最小必要收窄（`pub(crate)`，只给 `install::` 内用）。
//!
//! 注：写 shim 之前的**守卫**在 [`crate::agent::hooks::install::shim::io::shim_foreign_guard`]（它守的是"写"这个动作）。
//!
//! # 契约
//!
//! - 首行 `// @neeko-managed-hook v<版本>+<模板hash>` = 自家；
//! - **不可读（含非 UTF-8）一律按他人资产对待** —— 宁可拒绝覆盖也不能破坏用户文件；
//! - 版本位是**内容寻址**的（见 [`content_token`]），故判「是否当前」必须传入当前模板。

use std::path::{Path, PathBuf};

use crate::agent::hooks::targets::HookTarget;

/// 归属标记前缀（模板与卸载判定的单一契约）。
pub(crate) const MANAGED_MARKER: &str = "// @neeko-managed-hook";

/// 归属标记里应有的版本位（**内容寻址**）：`v{应用版本}+{模板正文 hash}`。
///
/// 为什么含 hash：`version_current` 是「已装 hook 文件是否过期」的**缓存键**，
/// 它必须从**被缓存的内容本身**派生（内容寻址），而不是从发布版本号派生 —— 后者只在
/// 发版时递增，「同版本号内改模板」会永远不被识别 ⇒ 已装机器静默不更新。
/// 应用版本仍保留在标记里，供人眼辨识（D13）。
#[must_use]
pub(crate) fn content_token(template: &str) -> String {
    format!(
        "v{}+{:016x}",
        env!("CARGO_PKG_VERSION"),
        fnv1a(template.as_bytes())
    )
}

/// FNV-1a（64-bit）—— 跨 Rust 版本稳定的内容哈希。
///
/// **禁用 `std::hash::DefaultHasher`**：它的输出不保证跨 Rust 版本/平台稳定，
/// 用它会让「同一模板在不同构建下算出不同键」⇒ 每次升级都误判过期。
#[must_use]
pub(crate) fn fnv1a(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// 把模板正文渲染为**落盘内容**（标记头 + 正文）。
///
/// 标记格式的单点：三条安装腿都调它，故「标记长什么样」只在一处定义。
#[must_use]
pub(crate) fn render(template: &str) -> String {
    format!("{MANAGED_MARKER} {}\n{template}", content_token(template))
}

/// 已存在文件的归属：读一次首行标记，顺带得出版本是否当前。
pub(crate) enum Ownership {
    /// 无自家标记（或不可读/非 UTF-8）：**他人资产**，拒绝覆盖与删除。
    Foreign,
    /// 自家受管文件（首行标记匹配）。
    Managed {
        /// 标记里的版本位是否等于当前模板算出的期望键。
        version_current: bool,
    },
}

impl Ownership {
    /// 是否自家受管文件（不关心版本是否当前）。
    #[must_use]
    pub const fn is_managed(&self) -> bool {
        matches!(self, Self::Managed { .. })
    }

    /// 自家 **且** 版本已当前（「无需重装」的判据）。
    #[must_use]
    pub const fn is_current(&self) -> bool {
        matches!(
            self,
            Self::Managed {
                version_current: true
            }
        )
    }
}

/// 判定已存在文件的归属。
///
/// `expected_token` = 当前模板的 [`content_token`]：版本位是内容寻址的，判「是否当前」
/// 必须拿到当前模板才能算出期望键（三条调用路径 `status` / `install` / `uninstall` 同口径）。
#[must_use]
pub(crate) fn ownership_of(path: &Path, expected_token: &str) -> Ownership {
    let first = std::fs::read_to_string(path)
        .ok()
        .and_then(|content| content.lines().next().map(str::to_string));
    match first.and_then(|line| line.strip_prefix(MANAGED_MARKER).map(str::to_string)) {
        None => Ownership::Foreign,
        Some(rest) => Ownership::Managed {
            version_current: rest.trim() == expected_token,
        },
    }
}

/// shim 的绝对路径（`file_name` 落在该 CLI 的配置目录下）。
///
/// # 为什么住在最低层（`ownership`）
///
/// 「shim 落在哪」是最底层的事实，`ownership` / `shim_io` / `status` 都要用。
/// 它一度住在 `shim_io`，于是 `ownership` 与 `status` 只能各自 `dir.join(file_name)`
/// 重新拼一遍 —— 根因就是层位过高。下沉后生产段该表达式**只剩本函数这一处**。
#[must_use]
pub(crate) fn shim_path(target: &HookTarget, dir: &Path) -> PathBuf {
    dir.join(target.file_name)
}

/// 某 target 的 shim 文件归属（`file_name` 落在 `dir` 下）。
#[must_use]
pub(crate) fn ownership_of_target(target: &HookTarget, dir: &Path) -> Ownership {
    ownership_of(&shim_path(target, dir), &content_token(target.template))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FNV-1a 的标准取值（`""` → OFFSET 基值）。
    ///
    /// 钉住「用的是 FNV-1a 而非某个会随 Rust 版本漂移的哈希」——这是
    /// `content_token` 内容寻址稳定性的前提（见 `fnv1a` 文档里的禁用理由）。
    #[test]
    fn fnv1a_matches_the_standard_offsets() {
        assert_eq!(fnv1a(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    /// 内容寻址：同一模板 → 同一键；改一个字节 → 键变；且带**应用版本前缀**（人眼可辨识）。
    ///
    /// 三条断言各守一件事：
    /// 1. 幂等 → 已装文件不会因重复安装被判过期；
    /// 2. 内容敏感 → 「同版本号内改模板」必须被识别（否则已装机器静默不更新）；
    /// 3. 前缀可见 → 用户/排障时能看出是哪个版本装的。
    ///
    /// 反证：把 `content_token` 退回 `v{CARGO_PKG_VERSION}`（不含正文哈希），第 2 条必红。
    #[test]
    fn content_token_is_stable_and_content_addressed() {
        let a = content_token("BODY");
        assert_eq!(a, content_token("BODY"), "同一模板两次必须算出同一键");
        assert_ne!(a, content_token("BODY "), "模板改一字节 → 键必须变");
        assert!(
            a.starts_with(&format!("v{}+", env!("CARGO_PKG_VERSION"))),
            "标记键必须带应用版本前缀（人眼可辨识）：{a}"
        );
    }

    /// 归属三态：自家+当前 / 自家+陈旧 / 他人（含非 UTF-8 须按他人对待）。
    #[test]
    fn ownership_distinguishes_managed_foreign_and_stale() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cur = tmp.path().join("current.mjs");
        std::fs::write(&cur, render("BODY")).expect("write");
        assert!(ownership_of(&cur, &content_token("BODY")).is_current());

        let stale = tmp.path().join("stale.mjs");
        std::fs::write(&stale, format!("{MANAGED_MARKER} v0.0.1+dead\nBODY")).expect("write");
        let o = ownership_of(&stale, &content_token("BODY"));
        assert!(o.is_managed(), "有标记即自家");
        assert!(!o.is_current(), "版本位不符 = 陈旧");

        let foreign = tmp.path().join("foreign.mjs");
        std::fs::write(&foreign, "// mine\nconsole.log(1)").expect("write");
        assert!(!ownership_of(&foreign, &content_token("BODY")).is_managed());

        let binary = tmp.path().join("binary.mjs");
        std::fs::write(&binary, [0xff_u8, 0xfe, 0x00, 0x01]).expect("write");
        assert!(
            !ownership_of(&binary, &content_token("BODY")).is_managed(),
            "非 UTF-8 必须按他人资产对待"
        );
    }
}
