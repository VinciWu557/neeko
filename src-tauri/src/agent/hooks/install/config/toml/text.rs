//! `notify` 行的**文本级原语**：定位一行、解析/渲染单行数组、算顶层插入点。
//!
//! # 为什么与合并算法分开
//!
//! 这里的每个函数都是**纯字符串函数**（`&str` 进 → `偏移`/`Vec<String>` 出），
//! 可脱离任何合并语义单独验证；而 `super`（合并算法）关心的是「该 Insert 还是 Noop」。
//! 两者变化频率不同：文本形态的支持面（尾随逗号？单引号？）在本层变化，
//! 合并动作语义由调用方（`install::shape::notify_argv`）决定。
//!
//! 拆开后 `super` 的生产行数从 351 回到本任务 AC1 的 ≤300 线内。

/// 合并动作（策略集固定 → enum）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TomlMergeAction {
    /// 插入/更新自家条目。
    Insert,
    /// 移除自家条目。
    Remove,
}

/// 一次合并的结果（与 `config::json::MergeOutcome` 同族，供调用方分类）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TomlMergeOutcome {
    /// 文本已改写。
    Changed,
    /// 已是最新（幂等命中，文本未动）。
    Unchanged,
    /// 已移除条目。
    Removed,
    /// 无需处理 —— 含三种语义：
    /// 移除时本就没有；**fail-safe 拒绝处理**（形态不支持）；
    /// **用户已有非自家的 `notify`**（不覆盖，见模块头的语义说明）。
    Noop,
}

/// 定位 `key = [...]` 那一行：返回 (行首偏移, 行尾偏移含换行, 该行文本)。
///
/// 判据是「行首（允许前导空白）为 `key`，其后允许空白，再是 `=`」——
/// 避免误命中 `# notify = ...`（注释）或 `xnotify = ...`（后缀）。
pub(crate) fn locate_key_line<'a>(text: &'a str, key: &str) -> Option<(usize, usize, &'a str)> {
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let body = line.strip_suffix('\n').unwrap_or(line);
        let body = body.strip_suffix('\r').unwrap_or(body);
        let trimmed = body.trim_start();
        // 注释行不是键定义。
        if trimmed.starts_with('#') {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix(key) else {
            continue;
        };
        // `key` 之后必须紧跟空白或 `=`（排除 `notifyX = ...`）。
        if !rest.starts_with(|c: char| c == '=' || c.is_whitespace()) {
            continue;
        }
        if !rest.trim_start().starts_with('=') {
            continue;
        }
        return Some((line_start, offset, body));
    }
    None
}

/// 把一行 `key = [ ... ]` 解析为元素列表（仅双引号字符串）。
///
/// 返回 `None` = 形态不支持（跨行 / 单引号 / 含内联表 / 缺 `]`）→ 调用方 `Noop`。
pub(crate) fn parse_string_array(line: &str) -> Option<Vec<String>> {
    let open = line.find('[')?;
    let close = line.rfind(']')?;
    if close < open {
        return None;
    }
    // 数组之后除空白与注释外不得有内容（防 `notify = [] extra`）。
    let trailing = line[close + 1..].trim();
    if !trailing.is_empty() && !trailing.starts_with('#') {
        return None;
    }
    let inner = &line[open + 1..close];
    let mut out = Vec::new();
    for raw in inner.split(',') {
        let item = raw.trim();
        if item.is_empty() {
            continue; // 空数组 / 尾随逗号
        }
        // 只接受双引号字符串；单引号字面量与内联表一律判不支持（宁可不装也不误改）。
        let body = item.strip_prefix('"').and_then(|s| s.strip_suffix('"'))?;
        out.push(unescape_basic_string(body));
    }
    Some(out)
}

/// TOML basic string 的转义还原（仅处理会出现在路径里的那些）。
///
/// 路径里出现 `\` 只可能在 Windows（`C:\Users\...`）—— TOML basic string 要求写成 `\\`。
/// 本函数保证「解析出的字符串」与「写回时转义的字符串」互为逆运算（有单测钉死）。
pub(crate) fn unescape_basic_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// 转义为 TOML basic string 内容（`\` 与 `"` 需要转义）。
pub(crate) fn escape_basic_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 渲染 `key = ["a", "b"]` 一行。
pub(crate) fn render_key_line(key: &str, items: &[String]) -> String {
    let body = items
        .iter()
        .map(|i| format!("\"{}\"", escape_basic_string(i)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{key} = [{body}]\n")
}

/// 「这条 argv 元素是否指向 Neeko 的 shim」—— **单一源在 [`crate::agent::hooks::install::config::json`]**。
///
/// 本模块只按 argv 数组的粒度调用它。判据与标记清单不在此处复制：两份实现会漂移
/// （历史上已漂移过一次，见 `config::json::entry_targets_shim` 的文档）。
pub use crate::agent::hooks::install::config::json::entry_targets_shim;

/// 该数组是否指向 Neeko 的 shim（任一元素命中）。
pub(crate) fn is_ours(items: &[String]) -> bool {
    items.iter().any(|s| entry_targets_shim(s))
}

/// 找「顶层键区」的**插入点**：第一个 `[table]` / `[[array-of-table]]` 行的行首偏移。
///
/// # 为什么不能追加到文件末尾（2026-10-16 实测踩坑）
///
/// TOML 的**表作用域延续到下一个表头**。`~/.codex/config.toml` 末尾是
/// `[hooks.state."…"]` —— 在文件末尾追加 `notify = [...]` 会落在**那个表内部**，
/// 而不是顶层键！实测：`tomllib.loads` 显示 `"notify" in d == False`，值跑到
/// `hooks.state.<某个键>.notify` 去了。后果是 **Codex 从不调用 shim**（顶层无 `notify`），
/// 而文件看起来「写对了」。
///
/// 正确的插入点是**第一个表头之前**（那里一定是顶层键区）。
/// 无任何表头（纯顶层键文件）→ 文件末尾即顶层键区。
///
/// 只认行首（允许前导空白）的 `[`，避免把字符串值里的 `[` 当表头。
pub(crate) fn top_level_insert_offset(text: &str) -> usize {
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            return offset;
        }
        offset += line.len();
    }
    offset // 无表头：末尾即顶层键区
}
