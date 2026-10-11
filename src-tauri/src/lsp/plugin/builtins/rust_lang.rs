use super::super::types::{InstallOp, LspInstallMethod, LspPlugin};

/// rust-analyzer 的扩展能力声明：
///
/// 1. `experimental/runnables` 的客户端能力（`experimental.runnables.kinds`）——
///    实测（1.97.1，2026-09-11）：不声明时该方法不返回结果；声明后按 position 请求
///    可拿到确定性参数（含 workspace member 的 `--package` 与完整测试路径）。
/// 2. `experimental.serverStatusNotification` —— 声明后 RA 才会发
///    `experimental/serverStatus`（`quiescent: bool`）。**消费点**：
///    `notify::handle_server_status_notification`（reader 分发 `experimental/serverStatus`），
///    把「加载中」投影成 busy、`quiescent=true` 才回到 ready —— 声明与消费必须同 diff
///    （红线 14）。实测（1.99.0，2026-10-11）：不声明 0 条；声明后 false → true 各一条。
///
/// 按插件声明而非全局注入：其它语言（gopls / jdtls）的 initialize 载荷保持逐字节不变。
#[must_use]
fn client_capabilities() -> serde_json::Value {
    serde_json::json!({
        "experimental": {
            "runnables": { "kinds": ["cargo", "shell"] },
            "serverStatusNotification": true
        }
    })
}

pub fn plugins() -> Vec<LspPlugin> {
    vec![LspPlugin::builtin(
        "rust",
        &["rs"],
        "rust-analyzer",
        &["rust-analyzer"],
        Some(LspInstallMethod::new(
            "rustup",
            InstallOp::exec("rustup", &["component", "add", "rust-analyzer"]),
        )),
    )
    .with_root_markers(&["Cargo.toml"])
    .with_detect_priority(10)
    // 冷启动慢（cargo metadata + proc-macro 编译 + 首轮 cargo check + 标准库按需加载）：
    // 实测单请求 18–19s；同仓库存在第二个 rust-analyzer（VS Code）时实测首跳 89s
    // （见 `.trellis/spec/backend/lsp-domain.md`「冷启动就绪语义」）。取 120s（与 jdtls
    // 同款）覆盖竞争环境的最坏观测；红线 15：超时预算是插件数据，不按语言分支。
    .with_request_timeout_ms(120_000)
    .with_client_capabilities(client_capabilities())]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 护栏：rust-analyzer 插件必须声明 `experimental.runnables` 能力 —— 否则
    /// `experimental/runnables` 无结果（实测 1.97.1），P1 的确定性参数全部退化为快路径。
    #[test]
    fn rust_plugin_declares_runnables_client_capability() {
        let plugins = plugins();
        let rust = plugins.first().expect("rust plugin exists");
        let caps = rust
            .client_capabilities
            .as_ref()
            .expect("rust-analyzer must declare client capabilities");
        assert_eq!(
            caps["experimental"]["runnables"]["kinds"],
            serde_json::json!(["cargo", "shell"])
        );
        // 服务端命令与探测元数据不受影响
        assert_eq!(rust.server_binary, "rust-analyzer");
        assert_eq!(rust.root_markers, vec!["Cargo.toml".to_string()]);
    }

    /// 护栏（红线 14：声明与消费同 diff）：`serverStatusNotification` 声明必须存在 ——
    /// 消费点 `notify::handle_server_status_notification`；缺失会让「Running」重新
    /// 早于服务器自述就绪（冷启动请求 18–19s 期间显示 Running）。
    #[test]
    fn rust_plugin_declares_server_status_notification_capability() {
        let plugins = plugins();
        let rust = plugins.first().expect("rust plugin exists");
        let caps = rust
            .client_capabilities
            .as_ref()
            .expect("rust-analyzer must declare client capabilities");
        assert_eq!(
            caps["experimental"]["serverStatusNotification"],
            serde_json::json!(true)
        );
    }

    /// 护栏：冷启动慢的服务器必须声明大于通用默认（15s）的请求超时 ——
    /// 实测 definition 冷启动 18–19s、竞争环境下首跳 89s，缺声明会让首次跳转直接超时。
    #[test]
    fn rust_plugin_declares_cold_start_request_timeout() {
        let plugins = plugins();
        let rust = plugins.first().expect("rust plugin exists");
        assert_eq!(
            rust.request_timeout_ms,
            Some(120_000),
            "rust-analyzer 冷启动请求可达 ~89s，必须放大预算"
        );
    }
}
