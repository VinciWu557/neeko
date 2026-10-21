//! Agent model discovery service (domain layer).
//!
//! OpenCode dynamically discovers supported models by executing
//! `opencode models --verbose` and parsing its NDJSON output; other agents
//! expose a statically configured model list. Both paths converge here so
//! that Tauri commands stay thin (skinny controller) and the parsing logic
//! is independently testable without a webview runtime.

use crate::common::agent::types::{AgentConfig, ModelInfo};
use crate::common::executor::{ExecError, ExecOutput};
use crate::AppError;
use std::future::Future;

/// Execute `opencode models --verbose` and return the discovered models.
///
/// `binary_path` overrides the `opencode` binary name (used by custom installs).
pub async fn discover_opencode_models(
    binary_path: Option<String>,
) -> Result<Vec<ModelInfo>, AppError> {
    use crate::common::executor::factory::ExecTarget;
    use crate::core::exec;

    let path = binary_path.unwrap_or_else(|| "opencode".into());
    let target = ExecTarget::Local;

    log::info!(
        "[discover_opencode_models] Executing: {} models --verbose",
        path
    );

    discover_opencode_models_with(|| exec::collect(&target, &path, &["models", "--verbose"], None))
        .await
}

/// Injectable core of [`discover_opencode_models`]: the caller supplies how to fetch `ExecOutput`.
///
/// 生产代码传入 `|| exec::collect(...)`，单测传入返回固定 `ExecOutput` 的闭包，
/// 类型上杜绝单测触达真实二进制（纯核/脏壳分离）。
pub async fn discover_opencode_models_with<F, Fut>(fetch: F) -> Result<Vec<ModelInfo>, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<ExecOutput, ExecError>>,
{
    let output = fetch().await.map_err(|e| {
        log::error!("[discover_opencode_models] Failed to execute: {e}");
        AppError::Io(format!("failed to execute opencode models: {e}"))
    })?;

    log::info!(
        "[discover_opencode_models] Exit code: {}, stdout length: {}, stderr length: {}",
        output.exit_code,
        output.stdout.len(),
        output.stderr.len()
    );

    models_from_exec_output(output)
}

/// Pure: turn a collected `ExecOutput` into `ModelInfo` list.
///
/// 处理非零退出码 + 解析 stdout NDJSON。单测直接构造 `ExecOutput`，零进程。
pub fn models_from_exec_output(output: ExecOutput) -> Result<Vec<ModelInfo>, AppError> {
    if output.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!(
            "[discover_opencode_models] Command failed (code {}): {}",
            output.exit_code,
            stderr.trim()
        );
        return Err(AppError::Io(format!(
            "opencode models failed (code {}): {}",
            output.exit_code,
            stderr.trim()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    log::debug!("[discover_opencode_models] stdout: {}", stdout);

    let models = parse_opencode_models_output(&stdout)?;
    log::info!(
        "[discover_opencode_models] Discovered {} models",
        models.len()
    );

    Ok(models)
}

/// Parse the output of `opencode models --verbose`.
///
/// The output format is NDJSON with optional slug prefixes:
/// ```text
/// opencode/big-pickle
/// {
///   "id": "big-pickle",
///   "providerID": "opencode",
///   "name": "Big Pickle",
///   ...
/// }
/// ```
pub fn parse_opencode_models_output(output: &str) -> Result<Vec<ModelInfo>, AppError> {
    let mut models = Vec::new();
    let mut current_slug: Option<String> = None;
    let mut current_json = String::new();
    let mut in_json = false;
    let mut brace_depth = 0;

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if !in_json {
            // Check if this line starts a JSON object.
            if trimmed.starts_with('{') {
                in_json = true;
                current_json = trimmed.to_string();
                brace_depth = trimmed.matches('{').count() - trimmed.matches('}').count();
                if brace_depth == 0 {
                    // Complete JSON on a single line.
                    if let Some(model) =
                        parse_opencode_model_json(&current_json, current_slug.as_deref())?
                    {
                        models.push(model);
                    }
                    current_slug = None;
                    current_json.clear();
                    in_json = false;
                }
            } else {
                // This is a slug line (e.g. "opencode/big-pickle").
                current_slug = Some(trimmed.to_string());
            }
        } else {
            // Continue accumulating JSON.
            current_json.push('\n');
            current_json.push_str(trimmed);
            let line_opens = trimmed.matches('{').count();
            let line_closes = trimmed.matches('}').count();
            if line_closes > line_opens {
                brace_depth = brace_depth.saturating_sub(line_closes - line_opens);
            } else {
                brace_depth += line_opens - line_closes;
            }
            if brace_depth == 0 {
                // JSON complete.
                if let Some(model) =
                    parse_opencode_model_json(&current_json, current_slug.as_deref())?
                {
                    models.push(model);
                }
                current_slug = None;
                current_json.clear();
                in_json = false;
            }
        }
    }

    Ok(models)
}

/// Parse a single OpenCode model JSON object into a `ModelInfo`.
pub fn parse_opencode_model_json(
    json: &str,
    slug: Option<&str>,
) -> Result<Option<ModelInfo>, AppError> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| AppError::Io(format!("failed to parse opencode model JSON: {e}")))?;

    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Io("opencode model missing 'id' field".into()))?;

    let provider_id = value
        .get("providerID")
        .and_then(|v| v.as_str())
        .unwrap_or("opencode");

    let bare_name = value.get("name").and_then(|v| v.as_str()).unwrap_or(id);

    // provider 信息没有独立的协议字段 —— OpenCode 的 ACP 实现也是把它拼进展示名
    // （`${providerID}/${name}`）。这里做同样的拼接，保证用户在跨 provider 的模型
    // 列表里仍能分辨来源，而不是丢掉这层信息。
    let name = format!("{provider_id}/{bare_name}");

    // 说明：`limit.context` / `variants[].reasoningEffort` / `cost` 这些字段这里不再
    // 解析 —— 它们不属于「模型条目」，在 ACP 里由 `category: "model_config"` 与
    // `"thought_level"` 的会话配置项承载（见 adapter/acp_config.rs）。保留解析会让
    // 通用类型重新长出私有字段。

    Ok(Some(ModelInfo {
        id: slug.unwrap_or(id).to_string(),
        name,
        description: None,
        // OpenCode 把 provider 拼进了 `name`（见上），不需要独立分组维度。
        group: None,
    }))
}

/// 用 agent 自己声明的 `model_list_args` 跑一条命令并解析输出。
///
/// 解析方式按 `command` 分派 —— 输出格式是各家私有的，无法统一：
/// - `opencode`：NDJSON（slug 行 + JSON 对象），见 [`parse_opencode_models_output`]
/// - `pi`：固定宽度表格，见 [`parse_pi_models_output`]
///
/// 其余命令暂按「每行一个 `provider/model`」处理（最简单的约定），
/// 遇到真正接入的 agent 时再补专用解析器。
pub async fn list_models_by_command(config: &AgentConfig) -> Result<Vec<ModelInfo>, AppError> {
    use crate::common::executor::factory::ExecTarget;
    use crate::core::exec;

    let Some(args) = config.model_list_args.as_ref() else {
        return Err(AppError::Unsupported("agent has no model_list_args".into()));
    };
    if config.command.is_empty() {
        return Err(AppError::Unsupported(
            "agent has no command to run the model list".into(),
        ));
    }

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = exec::collect(&ExecTarget::Local, &config.command, &arg_refs, None)
        .await
        .map_err(|e| AppError::Io(format!("failed to list models: {e}")))?;

    if output.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Io(format!(
            "model list command failed (code {}): {}",
            output.exit_code,
            stderr.trim()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_models_stdout(&config.command, &stdout))
}

/// 按命令名选解析器。命令名可能是绝对路径，取文件名。
fn parse_models_stdout(command: &str, stdout: &str) -> Vec<ModelInfo> {
    let bin = std::path::Path::new(command)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(command);

    match bin {
        "opencode" => parse_opencode_models_output(stdout).unwrap_or_default(),
        "pi" => parse_pi_models_output(stdout),
        _ => parse_plain_model_lines(stdout),
    }
}

/// 兜底解析：每行一个 `provider/model`（或裸 model id）。
fn parse_plain_model_lines(stdout: &str) -> Vec<ModelInfo> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| ModelInfo {
            id: line.to_string(),
            name: line.to_string(),
            description: None,
            group: None,
        })
        .collect()
}

/// 执行 `pi --list-models` 并解析。
pub async fn discover_pi_models(binary_path: Option<String>) -> Result<Vec<ModelInfo>, AppError> {
    use crate::common::executor::factory::ExecTarget;
    use crate::core::exec;

    let path = binary_path.unwrap_or_else(|| "pi".into());
    let target = ExecTarget::Local;

    let output = exec::collect(&target, &path, &["--list-models"], None)
        .await
        .map_err(|e| AppError::Io(format!("failed to execute pi --list-models: {e}")))?;

    models_from_pi_output(output)
}

/// 纯核：把 `pi --list-models` 的 `ExecOutput` 转成模型列表（零进程）。
pub fn models_from_pi_output(output: ExecOutput) -> Result<Vec<ModelInfo>, AppError> {
    if output.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Io(format!(
            "pi --list-models failed (code {}): {}",
            output.exit_code,
            stderr.trim()
        )));
    }
    Ok(parse_pi_models_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// 解析 `pi --list-models` 的**固定宽度表格**输出。
///
/// 形状（实测）：
///
/// ```text
/// provider                                 model                                               context  max-out  thinking  images
/// ark-coding-plan                          ark-code-latest                                     128K     16.4K    no        no
/// ```
///
/// # 为什么按列位置而不是按空白切分
///
/// provider 与 model 列宽固定、用空格填充；model 名字里**不含空格**，但
/// `max-out` 之类可能为 `-`。按空白 `split` 在列值含空格时会串位，而按表头
/// 给出的起始列切片是稳定的。表头位置在解析时动态读出，不硬编码 —— 上游加列也
/// 不会静默错位（读不到 model 列就返回空，而不是给出错乱的 id）。
///
/// # id 用 `provider/model`
///
/// 与 opencode 的 `provider/model` 复合串保持一致（见 `ModelInfo::id` 的
/// 「语义不透明」说明）。这样历史会话记录的 `provider/model` 能直接匹配回列表。
#[must_use]
pub fn parse_pi_models_output(output: &str) -> Vec<ModelInfo> {
    let mut lines = output.lines();
    let Some(header) = lines.next() else {
        return Vec::new();
    };

    // 表头每个词 -> 起始列。找不到 provider / model 就放弃（格式不认识）。
    let columns: Vec<(usize, &str)> = header
        .match_indices(|c: char| !c.is_whitespace())
        .filter(|(i, _)| *i == 0 || header.as_bytes()[i - 1].is_ascii_whitespace())
        .map(|(i, _)| {
            let rest = &header[i..];
            let end = rest
                .find(char::is_whitespace)
                .map_or(header.len(), |e| i + e);
            (i, &header[i..end])
        })
        .collect();

    let column_start = |name: &str| columns.iter().find(|(_, n)| *n == name).map(|(i, _)| *i);
    let (Some(provider_at), Some(model_at)) = (column_start("provider"), column_start("model"))
    else {
        return Vec::new();
    };
    // model 列到下一个具名列之间
    let model_end = columns
        .iter()
        .map(|(i, _)| *i)
        .find(|i| *i > model_at)
        .unwrap_or(header.len());

    lines
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let provider = line.get(provider_at..model_at)?.trim();
            let model = line.get(model_at..model_end)?.trim();
            if provider.is_empty() || model.is_empty() {
                return None;
            }
            Some(ModelInfo {
                // 这条路径的 id 是 `provider/model` 复合串，本身已唯一。
                // （与 rpc 的 `get_available_models` 不同 —— 那边 id 是裸名，
                // 同名项靠 `group` 区分。见 `pi_rpc/config.rs`。）
                id: format!("{provider}/{model}"),
                name: format!("{provider}/{model}"),
                description: None,
                group: Some(provider.to_string()),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_opencode_models_output_parses_slug_and_json() {
        let input = r#"opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "cost": {
    "input": 0,
    "output": 0
  },
  "limit": {
    "context": 200000
  },
  "variants": {}
}
opencode/claude-fable-5
{
  "id": "claude-fable-5",
  "providerID": "opencode",
  "name": "Claude Fable 5",
  "cost": {
    "input": 10,
    "output": 50
  },
  "limit": {
    "context": 1000000
  },
  "variants": {}
}"#;

        let models = parse_opencode_models_output(input).expect("parse should succeed");
        assert_eq!(models.len(), 2);

        // `id` 保持原始 slug（含 provider 前缀），`name` 也带 provider —— 后者是
        // 因为 `ModelInfo` 已不再有 `provider_id` 字段，来源信息只能在展示名里保留。
        assert_eq!(models[0].id, "opencode/big-pickle");
        assert_eq!(models[0].name, "opencode/Big Pickle");

        assert_eq!(models[1].id, "opencode/claude-fable-5");
        assert_eq!(models[1].name, "opencode/Claude Fable 5");
    }

    // ── pi --list-models（固定宽度表格）──────────────────────────────────

    const PI_TABLE: &str = "\
provider                                 model                                               context  max-out  thinking  images
ark-coding-plan                          ark-code-latest                                     128K     16.4K    no        no
ark-coding-plan                          deepseek-v4-flash                                   1.0M     393.2K   no        no
cc-switch-xiaomi-mi-mo                   mimo-v2.5                                           1.0M     131.1K   yes       yes
";

    /// 表格按列位置切片，产出 `provider/model` 复合 id。
    #[test]
    fn parses_pi_table_into_provider_model_ids() {
        let models = parse_pi_models_output(PI_TABLE);
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec![
                "ark-coding-plan/ark-code-latest",
                "ark-coding-plan/deepseek-v4-flash",
                "cc-switch-xiaomi-mi-mo/mimo-v2.5",
            ]
        );
    }

    /// 表头变化（上游加列）时不得错位：读不到 provider / model 列就返回空，
    /// 而不是给出错乱的 id。
    #[test]
    fn returns_empty_when_the_table_shape_is_unrecognized() {
        assert!(parse_pi_models_output("some other output\nwith lines\n").is_empty());
        assert!(parse_pi_models_output("").is_empty());
        // 只有表头、没有数据行
        assert!(parse_pi_models_output("provider  model\n").is_empty());
    }

    /// 空行与只有空白的行要被跳过。
    #[test]
    fn skips_blank_rows() {
        let models = parse_pi_models_output(PI_TABLE);
        assert_eq!(models.len(), 3, "blank rows must not become entries");
    }

    /// 兜底解析器：每行一个 id。
    #[test]
    fn plain_line_parser_keeps_one_id_per_line() {
        let models = parse_plain_model_lines("a/one\n\n# comment\nb/two\n");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "a/one");
        assert_eq!(models[1].id, "b/two");
    }

    /// 按命令名选解析器：绝对路径取文件名。
    #[test]
    fn dispatches_parser_by_command_basename() {
        assert_eq!(parse_models_stdout("/usr/local/bin/pi", PI_TABLE).len(), 3);
        // 未知命令走兜底
        assert_eq!(parse_models_stdout("some-agent", "x/y\nz/w\n").len(), 2);
    }

    #[test]
    fn parse_opencode_models_output_handles_empty_input() {
        let models = parse_opencode_models_output("").expect("parse should succeed");
        assert!(models.is_empty());
    }

    /// `variants` / `cost` / `limit` 等私有字段**不再进入** `ModelInfo` ——
    /// 它们属于 ACP 的 `model_config` / `thought_level` 配置项，不是模型条目属性。
    /// 这里锁住「解析仍成功、但产物只有一个协议形状」。
    #[test]
    fn parse_opencode_model_json_ignores_private_rich_fields() {
        let json = r#"{
  "id": "test-model",
  "providerID": "opencode",
  "name": "Test Model",
  "cost": { "input": 0, "output": 0 },
  "limit": { "context": 200000 },
  "variants": {
    "thinking": { "reasoningEffort": "high" },
    "normal": {}
  }
}"#;

        let model = parse_opencode_model_json(json, Some("opencode/test-model"))
            .expect("parse should succeed")
            .expect("model should be Some");

        assert_eq!(model.id, "opencode/test-model");
        assert_eq!(model.name, "opencode/Test Model");
        assert_eq!(model.description, None);
    }
    // ── 纯核：ExecOutput → ModelInfo（零进程，不触二进制）─────────────────────

    #[test]
    fn models_from_exec_output_success() {
        let output = ExecOutput {
            stdout: b"opencode/big-pickle\n{\"id\":\"big-pickle\",\"providerID\":\"opencode\",\"name\":\"Big Pickle\",\"cost\":{\"input\":0,\"output\":0},\"limit\":{\"context\":200000},\"variants\":{}}".to_vec(),
            stderr: vec![],
            exit_code: 0,
        };
        let models = models_from_exec_output(output).expect("should succeed");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "opencode/big-pickle");
    }

    #[test]
    fn models_from_exec_output_empty_stdout() {
        let output = ExecOutput {
            stdout: vec![],
            stderr: vec![],
            exit_code: 0,
        };
        let models = models_from_exec_output(output).expect("should succeed");
        assert!(models.is_empty());
    }

    #[test]
    fn models_from_exec_output_nonzero_fails() {
        let output = ExecOutput {
            stdout: vec![],
            stderr: b"auth required".to_vec(),
            exit_code: 1,
        };
        let err = models_from_exec_output(output).expect_err("should fail on nonzero");
        assert!(err.to_string().contains("code 1"));
        assert!(err.to_string().contains("auth required"));
    }

    // ── 注入核：discover_with（单测注入 fake fetch，类型上杜绝真实二进制）───

    #[tokio::test]
    async fn discover_with_success() {
        let fake_stdout = b"opencode/stub\n{\"id\":\"stub\",\"providerID\":\"opencode\",\"name\":\"Stub\",\"cost\":{\"input\":10,\"output\":20},\"limit\":{\"context\":100},\"variants\":{}}".to_vec();
        let result = discover_opencode_models_with(|| async {
            Ok(ExecOutput {
                stdout: fake_stdout.clone(),
                stderr: vec![],
                exit_code: 0,
            })
        })
        .await
        .expect("should succeed");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "opencode/stub");
    }

    #[tokio::test]
    async fn discover_with_fetch_error_maps_to_io() {
        let result = discover_opencode_models_with(|| async {
            Err(ExecError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "not found",
            )))
        })
        .await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("failed to execute"));
    }

    #[tokio::test]
    async fn discover_with_nonzero_propagates() {
        let result = discover_opencode_models_with(|| async {
            Ok(ExecOutput {
                stdout: vec![],
                stderr: b"boom".to_vec(),
                exit_code: 2,
            })
        })
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("code 2"));
    }
}
