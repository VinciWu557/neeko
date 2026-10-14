//! endpoint 文件坐标发布（design §2.5，R6.1）。
//!
//! `~/.neeko/agent-hooks/endpoint.env`：`KEY=value` 行格式（pi/opencode 上报模板逐行解析，
//! node fs 跨平台读任意文件，无需 Windows `.cmd` 变体）。契约：
//! - 每次 Neeko 启动重写（随机端口 + 每次启动随机 token）；
//! - 私有权限 + 原子替换（platform::private_file，读者不见半截文件）；
//! - **退出时不删除** —— 删除会制造「重启窗口期回调失败」；下次启动覆盖即可。

use std::path::{Path, PathBuf};

/// endpoint 文件内环境变量名（上报模板与本文件是同一契约的两端）。
pub const ENV_KEY_PORT: &str = "NEEKO_AGENT_HOOK_PORT";
/// token 的 env 键名。
pub const ENV_KEY_TOKEN: &str = "NEEKO_AGENT_HOOK_TOKEN";

/// 一次发布的坐标。由 [`super::server::spawn`] 构造并落盘（生命周期 = 一次进程）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EndpointPublication {
    /// endpoint 文件绝对路径。
    pub path: PathBuf,
    /// ingest 监听端口（bind :0 实得）。
    pub port: u16,
    /// 本次启动的随机 token（uuid v4）。
    pub token: String,
}

impl EndpointPublication {
    /// 以 Neeko 配置目录（`~/.neeko`）为根构造发布对象。
    #[must_use]
    pub fn new(neeko_dir: &Path, port: u16, token: String) -> Self {
        Self {
            path: neeko_dir.join("agent-hooks").join("endpoint.env"),
            port,
            token,
        }
    }

    /// 渲染文件内容（`KEY=value` 行 + 尾换行）。
    #[must_use]
    pub fn render(&self) -> String {
        format!(
            "{ENV_KEY_PORT}={}\n{ENV_KEY_TOKEN}={}\n",
            self.port, self.token
        )
    }

    /// 原子私有写入（含父目录创建）。失败由调用方 best-effort 记日志（通知是旁路）。
    pub fn publish(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        crate::platform::private_file::write_private_atomic(&self.path, &self.render())
    }
}

// ── TDD：契约内容与发布幂等 ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_is_key_value_lines() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let p = EndpointPublication::new(&tmp.path().join(".neeko"), 53124, "tok-abc".into());
        assert_eq!(
            p.render(),
            "NEEKO_AGENT_HOOK_PORT=53124\nNEEKO_AGENT_HOOK_TOKEN=tok-abc\n"
        );
        assert!(p
            .path
            .ends_with(Path::new("agent-hooks").join("endpoint.env")));
    }

    /// publish 可重复执行（重启覆盖），读回内容即最新坐标。
    #[test]
    fn publish_overwrites_atomically_and_is_rereadable() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let first = EndpointPublication::new(&tmp.path().join(".neeko"), 1111, "t1".into());
        first.publish().expect("first publish");
        assert_eq!(
            std::fs::read_to_string(&first.path).expect("read"),
            first.render()
        );

        let second = EndpointPublication::new(&tmp.path().join(".neeko"), 2222, "t2".into());
        second.publish().expect("second publish");
        assert_eq!(
            std::fs::read_to_string(&second.path).expect("re-read"),
            second.render()
        );

        // 临时文件不残留（原子替换完成）。
        let leftovers: Vec<_> = std::fs::read_dir(second.path.parent().expect("parent"))
            .expect("dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "tmp residue: {leftovers:?}");
    }

    /// Unix：文件权限 0600（token 不应对同机其他用户可读）。
    #[cfg(unix)]
    #[test]
    fn publish_sets_owner_only_permissions_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let p = EndpointPublication::new(&tmp.path().join(".neeko"), 1234, "t".into());
        p.publish().expect("publish");
        let mode = std::fs::metadata(&p.path)
            .expect("meta")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "endpoint.env must be owner-only");
    }
}
