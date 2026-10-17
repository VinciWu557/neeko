//! hook 启动命令的**无害化规则**（纯字符串，与宿主 OS 无关）。
//!
//! # 为什么规则体不做 `#[cfg]` 门控
//!
//! 与 `platform/path_identity/rules.rs` 同一理由：这些规则是**纯字符串函数**，
//! 三端编译、三端测试；平台差异只体现在「怎么拼命令」（在 `unix.rs` / `windows.rs`）。
//! 若把校验放进某个平台文件，另一平台就是**不可见的失败域** —— 恶性注入面尤其不该只在
//! CI 的目标平台上被验证。
//!
//! # 为什么需要校验
//!
//! `source` / `event_key` 会被拼进写进用户 CLI 配置的命令行。它们目前**全部**来自
//! `targets.rs` 的静态数据表（编译期常量，不含空格或分号），因此这不是「当前存在漏洞」，
//! 而是**纵深防御**：「数据表将来加一行」不该成为一个注入面 —— 把「不该出现的字符」
//! 变成可检测的失败（skip）而非静默的命令注入。

/// `source` / `event_key` 的允许字符集：ASCII 字母、数字、下划线、连字符。
///
/// 这是 `targets.rs` 数据表的既有事实（`"approval_requested"` / `"pi"` …）。
#[must_use]
pub fn is_safe_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// ── 测试期 node 解析覆盖（确定性夹具）──────────────────────────────────────────────
//
// # 为什么需要（第一性原理）
//
// `resolve_node()` 读的是**宿主进程的 PATH**。这让所有走安装腿的测试成为
// 「环境依赖测试」：本机装了 node 就绿，没装就红（2026-10-16 实测：剔除 PATH 后
// 9 个用例直接失败）。测试的判据应当是**代码行为**，而不是「这台机器碰巧装了什么」。
//
// # 为什么用 thread-local 而不是改写 PATH
//
// `cargo test` 默认多线程并行，`std::env::set_var` 是**进程全局**的：
// 一个用例改 PATH 会影响同时运行的其它用例（本仓 `targets.rs` 的 `ScopedEnv`
// 就有这个已知竞态，只是那些用例恰好互不冲突）。thread-local 覆盖天然按测试线程隔离，
// 无串扰、无需串行锁。
//
// # 为什么放在 `rules.rs`
//
// 本文件是**纯字符串/纯逻辑**、三端同源码（无 `#[cfg]`），故覆盖机制也天然跨平台 ——
// 不必在每个平台实现里各写一份。平台文件只在 `resolve_on_path` 里查一次。

#[cfg(test)]
thread_local! {
    /// 当前测试线程的 node 覆盖：`Some(Some(p))` = 强制解析为 `p`；
    /// `Some(None)` = 强制解析失败（模拟无 node）；`None` = 走真实 PATH。
    static NODE_OVERRIDE: std::cell::RefCell<Option<Option<String>>> =
        const { std::cell::RefCell::new(None) };
}

/// 读当前测试线程的 node 覆盖（生产构建恒为 `None`）。
///
/// 返回 `Some(_)` 表示「本线程已被测试接管」—— 内容可能是 `None`（模拟无 node），
/// 故调用方必须用 `Option<Option<_>>` 区分「没接管」与「接管并指定为无」。
///
/// 两条 clippy lint 在此就地豁免（**不是整模块压制**）：
/// - `missing_const_for_fn`：`const fn` 内不能调用 `LocalKey::with`，物理上做不到；
/// - `must_use_candidate`：返回值本身是 `Option<Option<_>>`，调用点必然显式解构
///   （`if let Some(x) = …`），加属性只增加噪音。
#[allow(clippy::missing_const_for_fn, clippy::must_use_candidate)]
pub fn test_node_override() -> Option<Option<String>> {
    #[cfg(test)]
    {
        NODE_OVERRIDE.with(|cell| cell.borrow().clone())
    }
    #[cfg(not(test))]
    {
        None
    }
}

/// 在**测试**中把 `node` 解析结果固定为 `Some(path)`（返回守卫，drop 时还原）。
#[cfg(test)]
#[must_use]
pub fn with_fake_node(path: &std::path::Path) -> FakeNodeGuard {
    let previous = NODE_OVERRIDE.with(|c| c.replace(Some(Some(path.to_string_lossy().into()))));
    FakeNodeGuard { previous }
}

/// 在**测试**中模拟「本机没有 node」（返回守卫，drop 时还原）。
#[cfg(test)]
#[must_use]
pub fn without_node() -> FakeNodeGuard {
    let previous = NODE_OVERRIDE.with(|c| c.replace(Some(None)));
    FakeNodeGuard { previous }
}

/// [`with_fake_node`] / [`without_node`] 的 RAII 守卫。
#[cfg(test)]
pub struct FakeNodeGuard {
    previous: Option<Option<String>>,
}

#[cfg(test)]
impl Drop for FakeNodeGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        NODE_OVERRIDE.with(|c| *c.borrow_mut() = previous);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_data_table_tokens() {
        for good in ["pi", "opencode", "omp", "codex", "claude", "turn_completed"] {
            assert!(is_safe_token(good), "{good:?} 应被接受");
        }
    }

    #[test]
    fn rejects_shell_metacharacters_and_empty() {
        for bad in [
            "",
            "x; rm -rf /",
            "a b",
            "a'b",
            "a\"b",
            "$(whoami)",
            "a|b",
            "a&b",
            "a>b",
            "a`b`",
            "a\nb",
            "路径",
        ] {
            assert!(!is_safe_token(bad), "{bad:?} 必须被拒绝");
        }
    }
}
