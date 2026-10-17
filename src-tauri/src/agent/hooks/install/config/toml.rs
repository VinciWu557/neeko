//! 用户 `config.toml` 里 `notify` 键的**文本级**定点增删（Codex 通道）。
//!
//! **为什么是文本级，而不是解析-重序列化**：
//! Codex 的 `~/.codex/config.toml` 含用户的敏感内容与个人格式
//! （本机实测有 `experimental_bearer_token` / `http_headers` / 多个 `[model_providers.*]`）。
//! `toml::to_string` 会重排键序、丢注释、改引号风格 —— 「`notify` 之外逐字不变」
//! 这条硬约束（子任务 AC4）无法用解析-重序列化保证。
//! 文本级定点操作把改动面限制在**一行**，其余字节原样搬运。
//!
//! **为什么不用 `toml_edit`**：它虽保留格式，但仍是「解析整文档 → 重新渲染」，
//! 对注释与空白的保留有已知边界；而本需求窄到「一行数组的增删」。
//! 更小的实现 = 更可预测 + 可 100% 单测（红线 13）。YAGNI。
//!
//! # 语义（**关键**：`notify` 是「一条命令的 argv」，不是「命令列表」）
//!
//! Codex 实测（`research/codex-trust-spike.md`）：`notify = [exe, arg1, arg2, ...]`，
//! Codex 执行 `exe arg1 arg2 ... <json>`（JSON 作为**最后一个参数**追加）。
//! 即整个数组是**一条 argv**。
//!
//! 由此推出一条硬结论：**不能把自家 argv 追加到用户已有的 `notify` 后面** ——
//! 那会变成 `用户的exe 用户的args 我们的exe 我们的args`，是垃圾命令。
//! 故当用户已有**非自家**的 `notify` 时，本模块一律 `Noop`（不覆盖、不追加）：
//! 「宁可不装」优于「改坏用户的配置」。
//!
//! # 支持的形态（最小集，够用且可判定）
//!
//! - 单行字符串数组：`notify = ["a", "b"]`（双引号；允许尾随逗号与任意空白）
//! - 空数组：`notify = []`
//!
//! **不支持**（一律 `Noop`）：跨行数组、单引号字面量、内联表元素、数组后跟杂项。
mod text;
pub use text::{TomlMergeAction, TomlMergeOutcome};

/// 「这条 argv 元素是否指向 Neeko 的 shim」—— **单一源在 [`super::json`]**。
///
/// 本模块只按 argv 数组的粒度调用它。判据与标记清单不在此处复制：两份实现会漂移
/// （历史上已漂移过一次，见 `super::json::entry_targets_shim` 的文档）。
pub use super::json::entry_targets_shim;

use text::{
    is_ours, locate_key_line, parse_string_array, render_key_line, top_level_insert_offset,
};

/// 在 TOML 文本里增删 `key` 数组（`notify`）。
///
/// `entry` = 期望的 argv（Insert 用；Remove 忽略）。
///
/// # 动作语义
///
/// | 现状 | Insert | Remove |
/// | --- | --- | --- |
/// | 键不存在 | 追加一行 = `entry` | `Noop` |
/// | 值是自家 argv 且完全一致 | `Unchanged` | 删除整行（`Removed`） |
/// | 值是自家 argv 但不一致 | 替换为 `entry`（收敛，`Changed`） | 删除整行（`Removed`） |
/// | 值是**非自家** argv | `Noop`（不覆盖，见模块头） | `Noop` |
/// | 值非数组 / 形态不支持 | `Noop`（原样） | `Noop`（原样） |
#[must_use]
pub fn apply_notify(
    text: &str,
    key: &str,
    entry: &[String],
    action: TomlMergeAction,
    label: &str,
) -> (String, TomlMergeOutcome) {
    let (out, outcome) = apply_notify_inner(text, key, entry, action);
    if !verify_preserves_valid_toml(text, &out, outcome, label) {
        return (text.to_string(), TomlMergeOutcome::Noop);
    }
    (out, outcome)
}

/// **安全网**：编辑后的文本必须仍能被 TOML 解析器接受；否则丢弃本次编辑。
///
/// # 为什么必须有
///
/// [`top_level_insert_offset`] 靠「行首是 `[`」判定表头 —— 这对普通配置够用，但**顶层多行
/// 数组的续行**若以 `[` 开头（如 `matrix = [\n  [1, 2],\n]`）就会被误判为表头，插入点落到
/// 数组内部，产出**解析失败**的文件。实测（2026-10-16）用 `tomllib` 复现：
///
/// ```toml
/// model = "x"
/// matrix = [
/// notify = ["…"]      # ← 被插进数组内部
///   [1, 2],
/// ]
/// ```
///
/// 写坏用户的配置文件是不可接受的（用户配置是客人的家），故不能只靠「插入点算得对」——
/// 必须在**写盘前**用解析器复核。判据取「**输入能解析**（有可信 oracle）但**输出不能**」=
/// 我们的编辑破坏了它。输入本就畸形时不拿解析当 oracle（那会把「无法改进用户配置」
/// 误判成我们的错误），沿用各分支既有的 fail-safe。
fn verify_preserves_valid_toml(
    input: &str,
    output: &str,
    outcome: TomlMergeOutcome,
    label: &str,
) -> bool {
    if outcome == TomlMergeOutcome::Noop || input == output {
        return true; // 无变更：无需复核
    }
    if toml::from_str::<toml::Value>(input).is_err() {
        return true; // 输入本就不合法：解析不作数
    }
    if toml::from_str::<toml::Value>(output).is_ok() {
        return true;
    }
    // `label` 由调用方给（它知道自己在改哪个文件）—— 通用模块**不携带**任何 CLI 的
    // 私有文件名，与 `TrustSpec::state_file` 同一取向（红线 15 精神）。
    log::warn!(
        "[agent-hooks] refusing to write {label}: edit would produce invalid TOML \
         (leaving the user's file untouched)"
    );
    false
}

fn apply_notify_inner(
    text: &str,
    key: &str,
    entry: &[String],
    action: TomlMergeAction,
) -> (String, TomlMergeOutcome) {
    match locate_key_line(text, key) {
        None => match action {
            // 键不存在：Insert 在**顶层键区**插入（见 [`top_level_insert_offset`]）。
            //
            // 字节纪律：只**插入** `key = [...]\n`，不新增也不删除任何其它字节
            // （包括空行）—— 调用方据此保证「除新增行外逐字不变」（AC4）。
            TomlMergeAction::Insert => {
                let at = top_level_insert_offset(text);
                let mut out = String::with_capacity(text.len() + 64);
                out.push_str(&text[..at]);
                // 仅当插入点前一段不以换行结束时补一个换行，
                // 让新键自成一行而不与上一行粘连。其余字节一律不动。
                if at > 0 && !text[..at].ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&render_key_line(key, entry));
                out.push_str(&text[at..]);
                (out, TomlMergeOutcome::Changed)
            }
            TomlMergeAction::Remove => (text.to_string(), TomlMergeOutcome::Noop),
        },
        Some((line_start, line_end, line)) => {
            // 键存在但值不是可判定的字符串数组（跨行 / 单引号 / 内联表 / 非数组）→ fail-safe。
            let Some(items) = parse_string_array(line) else {
                return (text.to_string(), TomlMergeOutcome::Noop);
            };
            let ours = is_ours(&items);

            let (replacement, outcome) = match action {
                TomlMergeAction::Insert => {
                    if ours && items == entry {
                        return (text.to_string(), TomlMergeOutcome::Unchanged);
                    }
                    if ours {
                        // 自家但陈旧（如 shim 路径变了）→ 整条替换（收敛）。
                        (render_key_line(key, entry), TomlMergeOutcome::Changed)
                    } else if items.is_empty() {
                        // 空数组 = 没有命令 → 填上我们的。
                        (render_key_line(key, entry), TomlMergeOutcome::Changed)
                    } else {
                        // **用户已有自己的 notify**：不能追加（argv 语义），不覆盖。
                        return (text.to_string(), TomlMergeOutcome::Noop);
                    }
                }
                TomlMergeAction::Remove => {
                    if !ours {
                        return (text.to_string(), TomlMergeOutcome::Noop);
                    }
                    // 整行删除（留 `notify = []` 会让 Codex 尝试执行空命令）。
                    (String::new(), TomlMergeOutcome::Removed)
                }
            };

            let mut out = String::with_capacity(text.len() + 64);
            out.push_str(&text[..line_start]);
            out.push_str(&replacement);
            out.push_str(&text[line_end..]);
            (out, outcome)
        }
    }
}

/// 读取 `key` 数组的当前元素（供 status 判定）。
#[must_use]
pub fn read_notify(text: &str, key: &str) -> Option<Vec<String>> {
    let (_, _, line) = locate_key_line(text, key)?;
    parse_string_array(line)
}

/// 期望条目是否已就位（status 用）：恰为自家且与期望 argv 完全一致。
#[must_use]
pub fn notify_is_current(text: &str, key: &str, entry: &[String]) -> bool {
    match read_notify(text, key) {
        Some(items) => is_ours(&items) && items == entry,
        None => false,
    }
}

// ── TDD：文本级定点改的全部不变量（纯字符串，无路径依赖）─────────────────────────

#[cfg(test)]
mod tests {
    use super::text::{escape_basic_string, unescape_basic_string};
    use super::*;

    /// 测试专用薄包装：`label` 取一个与任何真实 CLI 都无关的值。
    ///
    /// 这样用例只表达**合并语义**，不重复书写「改的是哪个文件」—— 也顺带证明
    /// `label` 只影响日志文案、不影响任何行为。
    fn merge(
        text: &str,
        key: &str,
        entry: &[String],
        action: TomlMergeAction,
    ) -> (String, TomlMergeOutcome) {
        apply_notify(text, key, entry, action, "test.toml")
    }

    /// 期望 argv（Codex 实测形态：`[exe, shim, source, event_key]`）。
    fn entry() -> Vec<String> {
        vec![
            "/usr/local/bin/node".to_string(),
            "/Users/u/.codex/neeko-status.mjs".to_string(),
            "codex".to_string(),
            "turn_completed".to_string(),
        ]
    }

    /// 用户既有 config.toml（含敏感内容 + 多 section + 用户自己的格式）。
    fn user_config() -> String {
        [
            "model_provider = \"magpie\"",
            "model = \"x\"",
            "",
            "[model_providers.magpie]",
            "name = \"magpie\"",
            "experimental_bearer_token = \"SECRET-TOKEN\"",
            "",
            "[projects.\"/Users/u/proj\"]",
            "trust_level = \"trusted\"",
            "",
        ]
        .join("\n")
    }

    /// 键不存在 → 插入到**顶层键区**；其余内容逐字不变（AC4）。
    ///
    /// 回归钉子（2026-10-16 实测）：早期实现把新键追加到**文件末尾**，
    /// 而 TOML 的表作用域延续到下一个表头 —— 文件末尾若是 `[hooks.state."…"]`，
    /// 新键会落入**该表内部**，`tomllib` 解析后顶层根本没有 `notify`（Codex 因此从不调用 shim）。
    /// 本用例用 `toml` 解析器回读断言，而不是字符串包含 —— 后者正是漏掉该 bug 的原因。
    #[test]
    fn insert_appends_key_when_absent_preserving_everything_else() {
        let before = user_config();
        let (after, outcome) = merge(&before, "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(outcome, TomlMergeOutcome::Changed);
        // 逐字不变判据：**删掉插入的那一行后，剩余内容必须与原文完全相同**。
        // （不能用「原文是子串」—— 插入点在第一个表头之前，原文被插成两段。）
        let stripped: String = after
            .split_inclusive('\n')
            .filter(|l| !l.starts_with("notify = "))
            .collect();
        assert_eq!(
            stripped, before,
            "除新增的 notify 行外，其余内容必须逐字不变"
        );
        assert!(after.contains("SECRET-TOKEN"), "用户 token 必须保留");
        assert_eq!(after.lines().count(), before.lines().count() + 1);

        // **语义断言**（回归钉子）：顶层真的解析出 notify，且它没落进任何表。
        let parsed: toml::Value = toml::from_str(&after).expect("must stay valid TOML");
        let top = parsed
            .get("notify")
            .and_then(toml::Value::as_array)
            .expect("顶层必须有 notify（而非落进最后一个表）");
        assert_eq!(top.len(), entry().len());
        let projects = parsed
            .get("projects")
            .and_then(toml::Value::as_table)
            .expect("projects 表必须在");
        for (_k, v) in projects {
            assert!(
                v.get("notify").is_none(),
                "notify 不得落进 [projects.*] 表内部"
            );
        }
    }

    /// **回归钉子（真实场景）**：文件末尾是 `[hooks.state."…"]` 表（本机 Codex 的真实形态），
    /// 插入后 `notify` 必须在顶层，而不是在该表内部。
    ///
    /// 反证：把实现退回「追加到文件末尾」，本用例必红。
    #[test]
    fn insert_lands_at_top_level_even_when_file_ends_with_a_table() {
        let text = concat!(
            "model = \"m\"\n",
            "\n",
            "[hooks.state]\n",
            "\n",
            "[hooks.state.\"/Users/u/.codex/hooks.json:stop:0:0\"]\n",
            "trusted_hash = \"sha256:abc\"\n",
        );
        let (after, _) = merge(text, "notify", &entry(), TomlMergeAction::Insert);
        let parsed: toml::Value = toml::from_str(&after).expect("valid TOML");
        assert!(
            parsed.get("notify").is_some(),
            "notify 必须在顶层：\n{after}"
        );
        let state = parsed
            .get("hooks")
            .and_then(|h| h.get("state"))
            .and_then(toml::Value::as_table)
            .expect("hooks.state 表");
        for (_k, v) in state {
            assert!(v.get("notify").is_none(), "不得落进 hooks.state 子表");
        }
        assert!(after.contains("trusted_hash"), "用户内容保留");
    }

    /// 插入点在**第一个表头之前**：顶层键区里（而非末尾）。
    #[test]
    fn inserted_key_sits_before_the_first_table_header() {
        let text = "model = \"m\"\n\n[model_providers.x]\nname = \"x\"\n";
        let (after, _) = merge(text, "notify", &entry(), TomlMergeAction::Insert);
        let notify_at = after.find("notify = ").expect("inserted");
        let table_at = after.find("[model_providers.x]").expect("table");
        assert!(notify_at < table_at, "notify 必须在表头之前：\n{after}");
        // 语义回读同样成立。
        let parsed: toml::Value = toml::from_str(&after).expect("valid TOML");
        assert!(parsed.get("notify").is_some());
        assert_eq!(parsed["model"].as_str(), Some("m"));
    }

    /// 无表头的纯顶层键文件 → 追加到末尾仍是顶层。
    #[test]
    fn insert_into_flat_file_without_tables() {
        let (after, _) = merge(
            "model = \"m\"\n",
            "notify",
            &entry(),
            TomlMergeAction::Insert,
        );
        let parsed: toml::Value = toml::from_str(&after).expect("valid TOML");
        assert!(parsed.get("notify").is_some());
        assert_eq!(parsed["model"].as_str(), Some("m"));
    }

    /// 幂等：同条目插两次 → `Unchanged`，文本零改写。
    #[test]
    fn insert_is_idempotent() {
        let (once, _) = merge(&user_config(), "notify", &entry(), TomlMergeAction::Insert);
        let (twice, outcome) = merge(&once, "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(outcome, TomlMergeOutcome::Unchanged);
        assert_eq!(once, twice, "幂等命中不得改写文本");
    }

    /// 自家条目陈旧（如 shim 路径变了）→ 整条替换（收敛，不留两条）。
    #[test]
    fn insert_converges_stale_own_entry() {
        let text = "model = \"x\"\nnotify = [\"/old/node\", \"/old/neeko-status.mjs\", \"codex\", \"turn_completed\"]\n";
        let (after, outcome) = merge(text, "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(outcome, TomlMergeOutcome::Changed);
        let items = read_notify(&after, "notify").expect("parsed");
        assert_eq!(items, entry(), "必须整条替换为期望 argv");
        assert_eq!(
            items.iter().filter(|s| entry_targets_shim(s)).count(),
            1,
            "不得留下旧的自家条目"
        );
        assert!(after.starts_with("model = \"x\"\n"), "无关键保留");
    }

    /// **用户已有自己的 notify**（非自家）→ `Noop` + 原样（argv 语义决定不能追加）。
    ///
    /// 反证：若实现改成「追加自家 argv」，会得到
    /// `["/their/tool.sh", "--flag", "/usr/local/bin/node", ...]` —— 垃圾命令。
    #[test]
    fn insert_skips_when_user_has_own_notify() {
        let text = "notify = [\"/their/tool.sh\", \"--flag\"]\n";
        let (after, outcome) = merge(text, "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(outcome, TomlMergeOutcome::Noop);
        assert_eq!(after, text, "用户自己的 notify 必须原样保留");
    }

    /// 空数组视为「没有命令」→ 填上我们的。
    #[test]
    fn empty_array_gets_the_entry() {
        let (after, outcome) = merge("notify = []\n", "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(outcome, TomlMergeOutcome::Changed);
        assert_eq!(read_notify(&after, "notify").expect("parsed"), entry());
    }

    /// fail-safe：`notify` 非数组 → `Noop` + 原样（绝不破坏用户结构）。
    #[test]
    fn non_array_value_is_untouched() {
        for text in [
            "notify = \"a string\"\n",
            "notify = { k = 1 }\n",
            "notify = 42\n",
            "notify = true\n",
        ] {
            let (after, outcome) = merge(text, "notify", &entry(), TomlMergeAction::Insert);
            assert_eq!(outcome, TomlMergeOutcome::Noop, "text={text:?}");
            assert_eq!(after, text, "必须原样返回：{text:?}");
        }
    }

    /// fail-safe：跨行数组 / 单引号字面量 / 内联表 / 数组后跟杂项 → `Noop`。
    #[test]
    fn unsupported_shapes_are_untouched() {
        for text in [
            "notify = [\n  \"/a/neeko-status.mjs\",\n]\n",
            "notify = ['/a/neeko-status.mjs']\n",
            "notify = [{ path = \"/a/neeko-status.mjs\" }]\n",
            "notify = [\"a\"] extra\n",
        ] {
            let (after, outcome) = merge(text, "notify", &entry(), TomlMergeAction::Insert);
            assert_eq!(outcome, TomlMergeOutcome::Noop, "text={text:?}");
            assert_eq!(after, text, "必须原样返回：{text:?}");
        }
    }

    /// 注释行与相似键名不得被误认为 `notify` 定义。
    #[test]
    fn comments_and_similar_keys_are_not_matched() {
        let text = concat!(
            "# notify = [\"/a/neeko-status.mjs\"]\n",
            "xnotify = [\"/a/neeko-status.mjs\"]\n",
            "notify_extra = [\"/a/neeko-status.mjs\"]\n",
        );
        let (after, outcome) = merge(text, "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(outcome, TomlMergeOutcome::Changed, "应追加真 notify 键");
        assert!(after.starts_with(text), "相似行不得被改动：\n{after}");
    }

    /// 移除：自家 → 整行删除（不留 `notify = []` 空壳）。
    #[test]
    fn remove_prunes_the_whole_line() {
        let text = "model = \"x\"\nnotify = [\"/node\", \"/a/neeko-status.mjs\", \"codex\", \"turn_completed\"]\n";
        let (gone, outcome) = merge(text, "notify", &entry(), TomlMergeAction::Remove);
        assert_eq!(outcome, TomlMergeOutcome::Removed);
        assert_eq!(gone, "model = \"x\"\n", "必须删整行：{gone:?}");
    }

    /// 移除时非自家 / 键不存在 → `Noop` + 原样。
    #[test]
    fn remove_without_ours_is_noop() {
        let foreign = "notify = [\"/their/tool.sh\"]\n";
        let (after, outcome) = merge(foreign, "notify", &entry(), TomlMergeAction::Remove);
        assert_eq!(outcome, TomlMergeOutcome::Noop);
        assert_eq!(after, foreign, "他人的 notify 不得删");

        let absent = "model = \"x\"\n";
        let (after, outcome) = merge(absent, "notify", &entry(), TomlMergeAction::Remove);
        assert_eq!(outcome, TomlMergeOutcome::Noop);
        assert_eq!(after, absent);
    }

    /// 路径段判据：裸文件名 / 前缀相似的不得被误判为自家（防删改他人 hook）。
    ///
    /// 判据只看**落盘的 shim 文件名**（`neeko-status.mjs`）；模板文件名
    /// `neeko-report.mjs` **从不落盘**，不算自家（此前两模块在此漂移，已统一到单一源）。
    #[test]
    fn ownership_detection_requires_a_path_segment() {
        assert!(entry_targets_shim("/Users/u/.codex/neeko-status.mjs"));
        assert!(entry_targets_shim("C:\\Users\\u\\.codex\\neeko-status.mjs"));
        assert!(!entry_targets_shim("neeko-status.mjs"), "裸文件名不得命中");
        assert!(
            !entry_targets_shim("/a/xneeko-status.mjs"),
            "前缀相似不得命中"
        );
        assert!(!entry_targets_shim("/a/other-tool.sh"));
        assert!(
            !entry_targets_shim("C:\\Users\\u\\.codex\\neeko-report.mjs"),
            "模板文件名不是落盘 shim，不得被当作自家"
        );
    }

    /// 转义往返：含反斜杠（Windows 路径）与引号的条目能正确写入并读回。
    #[test]
    fn escape_round_trips_backslashes_and_quotes() {
        for raw in [
            "C:\\Users\\u\\.codex\\neeko-status.mjs",
            "/a/with\"quote/neeko-status.mjs",
            "/a/plain/neeko-status.mjs",
        ] {
            assert_eq!(unescape_basic_string(&escape_basic_string(raw)), raw);
        }
        let argv = vec!["node".to_string(), "C:\\u\\neeko-status.mjs".to_string()];
        let (text, _) = merge("", "notify", &argv, TomlMergeAction::Insert);
        assert_eq!(read_notify(&text, "notify").expect("parsed"), argv);
    }

    /// 文件末尾无换行时也要正确插入（不得把新键拼到上一行尾部）。
    #[test]
    fn append_handles_missing_trailing_newline() {
        let (after, _) = merge("model = \"x\"", "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(after.lines().count(), 2, "got: {after:?}");
        assert!(
            after.contains("model = \"x\"\n"),
            "原行不得被拼接：{after:?}"
        );
        let parsed: toml::Value = toml::from_str(&after).expect("valid TOML");
        assert!(parsed.get("notify").is_some());
    }

    /// 空文本（全新文件）也能插入。
    #[test]
    fn insert_into_empty_text() {
        let (after, outcome) = merge("", "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(outcome, TomlMergeOutcome::Changed);
        assert_eq!(read_notify(&after, "notify").expect("parsed"), entry());
    }

    /// `notify_is_current`：status 判据（自家且 argv 完全一致）。
    #[test]
    fn notify_is_current_requires_exact_own_entry() {
        let (text, _) = merge("", "notify", &entry(), TomlMergeAction::Insert);
        assert!(notify_is_current(&text, "notify", &entry()));
        let mut other = entry();
        other[1] = "/other/neeko-status.mjs".to_string();
        assert!(
            !notify_is_current(&text, "notify", &other),
            "argv 不同不算当前"
        );
        assert!(
            !notify_is_current("notify = [\"/their/tool.sh\"]\n", "notify", &entry()),
            "他人的 notify 不算当前"
        );
        assert!(!notify_is_current("model = \"x\"\n", "notify", &entry()));
    }

    /// **安全网钉子**（2026-10-16 实测反例）：顶层**多行数组的续行**以 `[` 开头时，
    /// `top_level_insert_offset` 会把它误判为表头 → 插入点落在数组内部 →
    /// 产出**解析失败**的 TOML。
    ///
    /// 本用例钉住的是**后果**而非插入点算法：无论定位怎么退化，**绝不能写出坏文件**。
    /// 期望行为 = 检测到输出不可解析 → 退回 `Noop` 并**原样保留**输入。
    ///
    /// 反证：删掉 `verify_preserves_valid_toml` 这道安全网，本用例必红
    /// （输出会变成解析失败的文本）。
    #[test]
    fn refuses_edits_that_would_produce_invalid_toml() {
        let text = "model = \"x\"\nmatrix = [\n  [1, 2],\n  [3, 4],\n]\n[tui]\n";
        // 前置条件：输入本身合法（否则解析不能当 oracle）。
        assert!(
            toml::from_str::<toml::Value>(text).is_ok(),
            "夹具必须是合法 TOML，否则本用例不成立"
        );
        let (after, outcome) = merge(text, "notify", &entry(), TomlMergeAction::Insert);

        // 两种可接受结果：要么原样退回，要么插到合法位置。
        assert!(
            toml::from_str::<toml::Value>(&after).is_ok(),
            "绝不能写出非法 TOML（用户文件不可信）:\n{after}"
        );
        if outcome == TomlMergeOutcome::Noop {
            assert_eq!(after, text, "Noop 必须原样保留输入");
        } else {
            let parsed: toml::Value = toml::from_str(&after).expect("parsed");
            assert!(
                parsed.get("notify").is_some(),
                "非 Noop 时 notify 必须落在**顶层**：\n{after}"
            );
            assert!(
                parsed.get("matrix").is_some(),
                "用户的 matrix 不得丢失：\n{after}"
            );
        }
    }

    /// 安全网不得过度收紧：合法输入下的正常插入仍须成功（否则等于禁用本功能）。
    #[test]
    fn safety_net_does_not_block_valid_inserts() {
        let text = "# 注释\nmodel = \"x\"\n[tui]\nx = 1\n";
        let (after, outcome) = merge(text, "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(outcome, TomlMergeOutcome::Changed, "合法输入必须照常插入");
        let parsed: toml::Value = toml::from_str(&after).expect("parsed");
        assert!(parsed.get("notify").is_some());
        assert!(parsed.get("model").is_some());
    }

    /// **单一判据**回归：`entry_targets_shim` 就是 `config::json::command_targets_shim`。
    ///
    /// 反证：把本模块的本地实现改回来（多认 `neeko-report.mjs`），
    /// 本用例第二组断言必红 —— 那份清单与真正落盘的文件名无关。
    #[test]
    fn shim_predicate_has_a_single_source() {
        // 真正落盘的 shim 文件名（= targets.rs 所有 target 的 file_name）。
        assert!(entry_targets_shim("/u/.codex/neeko-status.mjs"));
        assert!(entry_targets_shim("\"C:\\u\\.codex\\neeko-status.mjs\""));
        // 裸文件名、前缀粘连、他人脚本：一律不是自家。
        assert!(!entry_targets_shim("neeko-status.mjs"), "裸名不得命中");
        assert!(
            !entry_targets_shim("/a/xneeko-status.mjs"),
            "前缀粘连不得命中"
        );
        assert!(!entry_targets_shim("/a/other-tool.sh"));
        // **模板文件名不是落盘文件名** —— 判据只认后者（两模块曾在此漂移）。
        assert!(
            !entry_targets_shim("/a/neeko-report.mjs"),
            "模板名（neeko-report.mjs）从不落盘，不得被当作自家 shim"
        );
        // 与 merger 同一函数身份：任一侧改动都会同时影响另一侧（结构性单一源）。
        assert_eq!(
            entry_targets_shim("/x/neeko-status.mjs"),
            crate::agent::hooks::install::config::json::command_targets_shim("/x/neeko-status.mjs")
        );
    }

    /// 行内注释（TOML 合法）不得破坏解析。
    #[test]
    fn inline_comment_after_array_is_tolerated() {
        let text = "notify = [] # 我的备注\n";
        let (after, outcome) = merge(text, "notify", &entry(), TomlMergeAction::Insert);
        assert_eq!(outcome, TomlMergeOutcome::Changed, "空数组应被填充");
        assert_eq!(read_notify(&after, "notify").expect("parsed"), entry());
    }
}
