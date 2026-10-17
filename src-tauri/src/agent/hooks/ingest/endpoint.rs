//! endpoint 坐标发布（design §2.5「坐标发现与鉴权」，R6.1 / R6.8）。
//!
//! **v5 多实例契约**：坐标根目录 `~/.neeko/agent-hooks/endpoints/`（POSIX 0700）下
//! **每实例一个文件** `endpoints/<instance_id>.env`（POSIX 0600），内容仍是 `KEY=value` 行格式
//! （pi/opencode 上报模板逐行解析，node fs 跨平台读任意文件，无需 Windows `.cmd` 变体）：
//!
//! ```text
//! NEEKO_AGENT_HOOK_PORT=53124
//! NEEKO_AGENT_HOOK_TOKEN=<uuid-v4>
//! ```
//!
//! 为什么不是单文件：单文件是「全局唯一会合点」，结构上无法同时表示 N 个活实例 ——
//! 打包版 + `pnpm tauri dev` 同开时后启动者覆写它，先退出者留下**死坐标**，上报端读到的
//! 永远是最后写入的那一个（实测事故见 implement.md Phase F）。改为目录后上报端扫描**全部**
//! `*.env` 逐个 POST，任一坐标失活由 fail-open 跳过，其余实例继续收通知。
//!
//! 契约：
//! - 每次 Neeko 启动写自己的实例文件（随机端口 + 每次启动随机 token），不触碰其他实例的文件；
//! - 私有权限 + 原子替换（platform::private_file，读者不见半截文件）；
//! - **退出时不删除** —— 删除会制造「重启窗口期回调失败」；死坐标由上报端 fail-open 跳过；
//! - **启动时回收死坐标**（见 [`prune_stale_endpoints`]）—— 「退出不删」若不配回收，
//!   文件会随启动次数**无界累积**（实测 2026-10-16：27 个文件里只有 1 个端口在监听），
//!   而每个 `*.env` 都含一份 token，上报端每次还要 `readdir` 全目录逐个 POST。

use std::path::{Path, PathBuf};

/// endpoint 文件内环境变量名（上报模板与本文件是同一契约的两端）。
pub const ENV_KEY_PORT: &str = "NEEKO_AGENT_HOOK_PORT";
/// token 的 env 键名。
pub const ENV_KEY_TOKEN: &str = "NEEKO_AGENT_HOOK_TOKEN";
/// 单文件覆盖 env 键（调试/测试夹具；指向单个 `.env` 文件而非目录）。
pub const ENV_KEY_OVERRIDE: &str = "NEEKO_AGENT_HOOK_ENDPOINT";

/// 坐标根目录名（`{neeko_dir}/agent-hooks/endpoints`）。公开：模板锚点测试引用它钉住目录形态。
pub const ENDPOINTS_DIR_NAME: &str = "endpoints";
/// 旧单文件坐标文件名（v5 退役，启动时清理一次）。
const LEGACY_ENDPOINT_FILE: &str = "endpoint.env";

/// 一次发布的坐标。由 [`crate::agent::hooks::ingest::server::spawn`] 构造并落盘（生命周期 = 一次进程）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EndpointPublication {
    /// 本实例标识（进程启动时生成的随机 uuid，仅内存持有，用作文件名）。
    pub instance_id: String,
    /// endpoint 文件绝对路径（`endpoints/<instance_id>.env`）。
    pub path: PathBuf,
    /// ingest 监听端口（bind :0 实得）。
    pub port: u16,
    /// 本次启动的随机 token（uuid v4）。
    pub token: String,
}

impl EndpointPublication {
    /// 坐标根目录（多实例共存的会合点）。
    #[must_use]
    pub fn endpoints_dir(neeko_dir: &Path) -> PathBuf {
        neeko_dir.join("agent-hooks").join(ENDPOINTS_DIR_NAME)
    }

    /// 旧单文件坐标路径（v5 退役；仅用于一次性清理，见 [`remove_legacy_endpoint`]）。
    #[must_use]
    pub fn legacy_endpoint_file(neeko_dir: &Path) -> PathBuf {
        neeko_dir.join("agent-hooks").join(LEGACY_ENDPOINT_FILE)
    }

    /// 以 Neeko 配置目录（`~/.neeko`）为根构造发布对象。
    #[must_use]
    pub fn new(neeko_dir: &Path, instance_id: String, port: u16, token: String) -> Self {
        let path = Self::endpoints_dir(neeko_dir).join(format!("{instance_id}.env"));
        Self {
            instance_id,
            path,
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

    /// 原子私有写入（含父目录创建，目录 0700）。失败由调用方 best-effort 记日志（通知是旁路）。
    pub fn publish(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            crate::platform::private_file::create_private_dir(parent)?;
        }
        crate::platform::private_file::write_private_atomic(&self.path, &self.render())
    }
}

/// 一次性迁移：删除旧单文件坐标（v5 多实例退役）。
///
/// 上报端只支持目录形态；若旧文件仍在，会与新目录形态并存，故启动时无论是否存在都尝试清理一次。
/// 不存在视为成功（幂等）。**不删除**本实例自己的 `endpoints/*.env`（退出不删，见模块头）。
pub fn remove_legacy_endpoint(neeko_dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(EndpointPublication::legacy_endpoint_file(neeko_dir)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// 启动时回收**死坐标**：端口不再监听（且不是本实例）的 `*.env` 删除。
///
/// # 为什么必须有（第一性原理）
///
/// 「退出时不删坐标」的理由是「删除会制造重启窗口期回调失败」—— 这条理由只对**活实例**
/// 成立。已退出的实例不会复活，其坐标文件是纯负债：
///
/// 1. **凭据累积**：每个 `.env` 含一份 `NEEKO_AGENT_HOOK_TOKEN`，落在磁盘上的副本数
///    等于历史启动次数；
/// 2. **上报成本线性增长**：`neeko-report.mjs` 每次上报 `readdirSync` 整个目录并逐个
///    `readFileSync` + POST，绝大多数请求打向早已关闭的端口。
///
/// 判据取「端口是否还有进程监听」而非 mtime：mtime 会把「长期运行但恰好很久没重启」的
/// 活实例误删（那是真事故），而端口探活是坐标**语义本身**的判据 —— 坐标的用途就是被连。
///
/// `keep` = 本实例的 instance_id（自己的文件永不删，即使端口尚未就绪）。
///
/// 返回被删除的个数（失败逐个记 warning，不阻断启动：通知是旁路）。
#[must_use]
pub fn prune_stale_endpoints(neeko_dir: &Path, keep: &str) -> usize {
    let dir = EndpointPublication::endpoints_dir(neeko_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0; // 目录不存在 = 从未发布过坐标
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(instance_id) = name.strip_suffix(".env") else {
            continue; // 只认 `*.env`，其他文件不属于本契约
        };
        if instance_id == keep {
            continue; // 自己的坐标
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue; // 读不到就跳过（可能是并发写入中）
        };
        let Some(port) = parse_port(&content) else {
            // 无法解析（半截文件 / 手工改坏）→ 同样视为死坐标，删掉更干净；
            // 但保守起见只在**确实不是活端口**时删，故解析失败也删（它不可用）。
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
            continue;
        };
        if port_is_listening(port) {
            continue; // 活实例：保留
        }
        match std::fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(err) => log::warn!(
                "[agent-hooks] prune stale endpoint {} failed: {err}",
                path.display()
            ),
        }
    }
    if removed > 0 {
        log::info!("[agent-hooks] pruned {removed} stale endpoint coord(s)");
    }
    removed
}

/// 从坐标文件内容里取出端口。
fn parse_port(content: &str) -> Option<u16> {
    content.lines().find_map(|line| {
        line.strip_prefix(ENV_KEY_PORT)
            .and_then(|rest| rest.strip_prefix('='))
            .and_then(|value| value.trim().parse().ok())
    })
}

/// 该端口是否有进程在 loopback 上监听（`TcpStream::connect` 成功即算）。
///
/// 不用 `lsof`/`netstat`：那需要 spawn 外部进程（红线 1 的统一执行接口约束 + 平台差异），
/// 而一次 connect 是**同一语义**的最轻判据，且天然跨平台。
fn port_is_listening(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    // 超时给得很短：本机 loopback 要么立刻成功，要么立刻 EHOSTUNREACH/ECONNREFUSED。
    TcpStream::connect_timeout(&addr.into(), std::time::Duration::from_millis(80)).is_ok()
}

// ── TDD：多实例共存 / 权限 / 旧文件迁移（夹具一律 tempdir 推导，红线 13）──────────

#[cfg(test)]
mod tests {
    use super::*;

    fn publication(neeko_dir: &Path, id: &str, port: u16, token: &str) -> EndpointPublication {
        EndpointPublication::new(neeko_dir, id.to_string(), port, token.to_string())
    }

    /// 渲染为键值行；路径落在 `agent-hooks/endpoints/<instance_id>.env`。
    #[test]
    fn render_is_key_value_lines() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let p = publication(&tmp.path().join(".neeko"), "inst-1", 53124, "tok-abc");
        assert_eq!(
            p.render(),
            "NEEKO_AGENT_HOOK_PORT=53124\nNEEKO_AGENT_HOOK_TOKEN=tok-abc\n"
        );
        assert!(p.path.ends_with(
            Path::new("agent-hooks")
                .join("endpoints")
                .join("inst-1.env")
        ));
    }

    /// **多实例共存**：两个 publication 各自落一个文件，互不覆写（R6.8 的核心不变量）。
    #[test]
    fn two_publications_coexist_without_overwrite() {
        let neeko = tempfile::tempdir().expect("tempdir");
        let neeko_dir = neeko.path().join(".neeko");

        let first = publication(&neeko_dir, "inst-a", 1111, "t1");
        let second = publication(&neeko_dir, "inst-b", 2222, "t2");
        first.publish().expect("first publish");
        second.publish().expect("second publish");

        assert_ne!(first.path, second.path, "each instance gets its own file");
        assert_eq!(
            std::fs::read_to_string(&first.path).expect("read first"),
            first.render(),
            "later instance must not overwrite an earlier one"
        );
        assert_eq!(
            std::fs::read_to_string(&second.path).expect("read second"),
            second.render()
        );

        // 目录里两个坐标文件并存。
        let mut names: Vec<_> = std::fs::read_dir(EndpointPublication::endpoints_dir(&neeko_dir))
            .expect("dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["inst-a.env", "inst-b.env"]);
    }

    /// 同实例重复 publish 覆盖自身（重启/重发幂等），不残留临时文件。
    #[test]
    fn publish_overwrites_own_file_atomically() {
        let neeko = tempfile::tempdir().expect("tempdir");
        let neeko_dir = neeko.path().join(".neeko");
        let p = publication(&neeko_dir, "inst-1", 1111, "t1");
        p.publish().expect("first publish");

        let p2 = publication(&neeko_dir, "inst-1", 2222, "t2");
        p2.publish().expect("second publish");
        assert_eq!(
            std::fs::read_to_string(&p2.path).expect("re-read"),
            p2.render()
        );

        let leftovers: Vec<_> = std::fs::read_dir(EndpointPublication::endpoints_dir(&neeko_dir))
            .expect("dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "tmp residue: {leftovers:?}");
    }

    /// 旧单文件清理：存在则删；不存在幂等；不触碰 `endpoints/` 下的新坐标。
    #[test]
    fn remove_legacy_endpoint_is_idempotent_and_keeps_new_coords() {
        let neeko = tempfile::tempdir().expect("tempdir");
        let neeko_dir = neeko.path().join(".neeko");
        let legacy = EndpointPublication::legacy_endpoint_file(&neeko_dir);
        std::fs::create_dir_all(legacy.parent().expect("parent")).expect("mkdir");
        std::fs::write(&legacy, "NEEKO_AGENT_HOOK_PORT=1\n").expect("seed legacy");

        let live = publication(&neeko_dir, "inst-1", 3333, "t3");
        live.publish().expect("publish");

        remove_legacy_endpoint(&neeko_dir).expect("remove legacy");
        assert!(!legacy.exists(), "legacy single file must be gone");
        assert!(live.path.is_file(), "new per-instance coord must survive");

        // 再次调用：不存在也成功（启动路径不区分是否迁移过）。
        remove_legacy_endpoint(&neeko_dir).expect("second remove is idempotent");
    }

    /// Unix：坐标文件 0600（token 不应对同机其他用户可读）。
    #[cfg(unix)]
    #[test]
    fn publish_sets_owner_only_permissions_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let neeko = tempfile::tempdir().expect("tempdir");
        let neeko_dir = neeko.path().join(".neeko");
        let p = publication(&neeko_dir, "inst-1", 1234, "t");
        p.publish().expect("publish");
        let mode = std::fs::metadata(&p.path)
            .expect("meta")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "endpoint file must be owner-only");
    }

    /// 死坐标回收：端口无人监听 → 删除；本实例（`keep`）→ 永不删。
    ///
    /// 这是「退出不删坐标」的配套：不删的理由只对活实例成立，死实例的坐标是纯负债
    /// （token 副本 + 上报端 readdir/POST 成本）。
    #[test]
    fn prunes_dead_endpoints_but_keeps_own_and_listening_ones() {
        let neeko = tempfile::tempdir().expect("tempdir");
        let neeko_dir = neeko.path().join(".neeko");

        // 一个真实监听端口（模拟活实例）：bind 到 :0 后取实得端口，坐标里写它。
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let live_port = listener.local_addr().expect("addr").port();

        let dead = publication(&neeko_dir, "dead", 1, "t-dead");
        let live = publication(&neeko_dir, "live", live_port, "t-live");
        let mine = publication(&neeko_dir, "mine", 1, "t-mine");
        dead.publish().expect("dead");
        live.publish().expect("live");
        mine.publish().expect("mine");

        let removed = prune_stale_endpoints(&neeko_dir, "mine");
        assert_eq!(removed, 1, "只应删掉死的那个");
        assert!(!dead.path.exists(), "死坐标必须删");
        assert!(live.path.exists(), "活坐标必须保留（端口在监听）");
        assert!(mine.path.exists(), "本实例坐标永不删（即使端口 1 未监听）");
    }

    /// 解析失败（半截 / 手工改坏）的坐标也清掉 —— 它不可能被正确使用。
    #[test]
    fn prunes_unparseable_endpoint_files() {
        let neeko = tempfile::tempdir().expect("tempdir");
        let neeko_dir = neeko.path().join(".neeko");
        let dir = EndpointPublication::endpoints_dir(&neeko_dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let broken = dir.join("broken.env");
        std::fs::write(&broken, "garbage without port\n").expect("seed");

        assert_eq!(prune_stale_endpoints(&neeko_dir, "mine"), 1);
        assert!(!broken.exists());
    }

    /// 不存在目录 → 0，不 panic（首次启动路径）。
    #[test]
    fn prune_is_total_on_missing_dir() {
        let neeko = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            prune_stale_endpoints(&neeko.path().join(".neeko"), "mine"),
            0
        );
    }

    /// `parse_port` 只认 `NEEKO_AGENT_HOOK_PORT=` 行。
    #[test]
    fn parse_port_reads_only_the_port_key() {
        assert_eq!(
            parse_port("NEEKO_AGENT_HOOK_PORT=53124\nNEEKO_AGENT_HOOK_TOKEN=x\n"),
            Some(53124)
        );
        assert_eq!(parse_port("NEEKO_AGENT_HOOK_TOKEN=x\n"), None);
        assert_eq!(parse_port("NEEKO_AGENT_HOOK_PORT=not-a-number\n"), None);
    }

    /// Unix：坐标目录 0700（文件名本身也是泄漏面）。
    #[cfg(unix)]
    #[test]
    fn endpoints_dir_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let neeko = tempfile::tempdir().expect("tempdir");
        let neeko_dir = neeko.path().join(".neeko");
        publication(&neeko_dir, "inst-1", 1234, "t")
            .publish()
            .expect("publish");
        let mode = std::fs::metadata(EndpointPublication::endpoints_dir(&neeko_dir))
            .expect("meta")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700, "endpoints dir must be owner-only");
    }
}
