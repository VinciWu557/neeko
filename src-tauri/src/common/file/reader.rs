//! Unified file reading core: one `read_file` with an explicit access scope,
//! parameterized channel (`ExecTarget`) and guards.
//!
//! 三个历史读取入口（`read_file_content` / `read_file_blocking` /
//! `lsp_read_preauthorized_file`）的差异只有三个维度：安全边界（scope）、
//! 目标机器（ExecTarget）、防护参数（大小上限/二进制检测）。本模块将其
//! 参数化为单一实现，调用方各自保留对外契约（IPC 命令名不变）。
//!
//! 安全边界：
//! - `InProject`：canonicalize 后必须位于 root 之内（防路径穿越，pillar 8）；
//! - `Trusted`：调用方已完成授权/信任校验（LSP 授权白名单、后端内部信任链），
//!   reader 仍执行 canonicalize（防 symlink）与可选大小上限——fail-closed。
//!
//! 行为保持说明：WSL/Remote 通道的 `InProject` 沿用现状（无远程 root 强校验），
//! 补齐远程 `realpath` 校验单独立项。

use std::path::{Path, PathBuf};

use crate::common::executor::factory::ExecTarget;
use crate::core::exec::{collect, run};
use crate::project::types::FileContent;
use crate::AppError;

/// 访问策略：决定 scope 校验的强度。
#[derive(Debug, Clone)]
pub enum FileAccessScope {
    /// 项目根内：canonicalize 后必须位于 root 之内。
    InProject {
        /// 项目根（canonicalize 前的原始路径亦可，reader 内部会 canonicalize）。
        root: PathBuf,
    },
    /// 信任通道：调用方已完成授权/信任校验，reader 仅做 canonicalize 与防护。
    Trusted,
}

/// 文件地址：**目标环境 + 基准目录 + 路径**。
///
/// 「去哪台机器、以哪个目录为基准、读哪个条目」是所有文件读取形态（文本 / 字节 /
/// 大小探测）共同需要的三个事实，因此只在这里定义一次 —— 文本请求与字节请求都内嵌它，
/// 命令层也就不必各自拼装同一组字段。
///
/// `base`/`path` 的拼接规则按目标环境语义解析（见 [`join_remote_path`]）：
/// Local 为宿主 `Path::join`（绝对 path 自动替换 base），WSL/SSH 为 POSIX 串拼接。
#[derive(Clone)]
pub struct FileAddress {
    /// 目标执行环境（决定 fs / shell 通道）。
    pub target: ExecTarget,
    /// 基准目录（相对 path 的拼接基准；空字符串 = path 为完整路径）。
    pub base: String,
    /// 相对 base 的文件路径，或完整路径。
    pub path: String,
}

impl FileAddress {
    /// 相对地址：`path` 相对 `base` 解析。
    #[must_use]
    pub fn new(target: ExecTarget, base: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            target,
            base: base.into(),
            path: path.into(),
        }
    }

    /// 绝对地址（`base` 为空）：受信通道（LSP / DAP）与已归一路径用这一形态。
    #[must_use]
    pub fn absolute(target: ExecTarget, path: impl Into<String>) -> Self {
        Self::new(target, String::new(), path)
    }
}

/// 文本读取请求。
#[derive(Clone)]
pub struct FileReadRequest {
    /// 去哪儿读（环境 + 基准 + 路径）。
    pub address: FileAddress,
    /// 大小上限（字节）；超限报 `AppError::File`。None = 不限。
    pub max_bytes: Option<u64>,
    /// 二进制检测：命中 NUL 字节时返回空 content（不向调用方泄二进制乱码）。
    pub detect_binary: bool,
}

/// 统一文件读取核心。Local 走 `std::fs`（spawn_blocking 隔离），
/// WSL/Remote 走 shell（stat + cat，经统一 exec 通道）。
pub async fn read_file(
    scope: FileAccessScope,
    req: FileReadRequest,
) -> Result<FileContent, AppError> {
    match req.address.target {
        ExecTarget::Local => {
            let FileReadRequest {
                address,
                max_bytes,
                detect_binary,
                ..
            } = req;
            tokio::task::spawn_blocking(move || {
                read_file_local_blocking(
                    &scope,
                    &address.base,
                    &address.path,
                    max_bytes,
                    detect_binary,
                )
            })
            .await
            .map_err(|e| AppError::File(format!("file read join error: {e}")))?
        }
        ExecTarget::Wsl { .. } | ExecTarget::Remote { .. } => read_file_shell(scope, req).await,
    }
}

/// Local 通道阻塞实现（仅由 `spawn_blocking` 调用）。
fn read_file_local_blocking(
    scope: &FileAccessScope,
    base: &str,
    path: &str,
    max_bytes: Option<u64>,
    detect_binary: bool,
) -> Result<FileContent, AppError> {
    let canonical = canonical_in_scope(scope, base, path)?;

    let size = std::fs::metadata(&canonical)
        .map_err(|e| AppError::File(format!("Failed to read metadata: {}", e)))?
        .len();
    if let Some(cap) = max_bytes {
        if size > cap {
            return Err(AppError::File(format!(
                "File size {size} exceeds the {cap} byte limit"
            )));
        }
    }

    let is_binary = detect_binary && is_binary_file(&canonical)?;
    let content = if is_binary {
        String::new()
    } else {
        std::fs::read_to_string(&canonical)
            .map_err(|e| AppError::File(format!("Failed to read file: {}", e)))?
    };

    Ok(FileContent {
        path: path.to_string(),
        content,
        size,
        is_binary,
    })
}

/// WSL/Remote 通道：stat 拿大小、（可选）head 检测二进制、cat 读内容。
async fn read_file_shell(
    scope: FileAccessScope,
    req: FileReadRequest,
) -> Result<FileContent, AppError> {
    let full_str = join_remote_path(&req.address.base, &req.address.path);

    // scope 校验：Trusted 信任调用方；InProject 的远程 root 校验为已知欠账
    //（现状 read_file_content_shell 同样没有），补齐需远程 realpath，单独立项。
    let _ = scope;

    // argv 形态：`stat` / `head` / `cat` 均为独立可执行文件，不经 shell。
    let size: u64 = run(&req.address.target, "stat", &["-c", "%s", &full_str])
        .await
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if let Some(cap) = req.max_bytes {
        if size > cap {
            return Err(AppError::File(format!(
                "File size {size} exceeds the {cap} byte limit"
            )));
        }
    }

    let is_binary = if req.detect_binary {
        // 二进制判定在字节层完成：不再用 `head | grep '\\x00'` 管道。
        collect(
            &req.address.target,
            "head",
            &["-c", "8192", &full_str],
            None,
        )
        .await
        .map(|out| out.stdout.contains(&0))
        .unwrap_or(false)
    } else {
        false
    };

    let content = if is_binary {
        String::new()
    } else {
        run(&req.address.target, "cat", &[&full_str])
            .await
            .map_err(|e| AppError::File(format!("Failed to read file content: {}", e)))?
    };

    Ok(FileContent {
        path: req.address.path.clone(),
        content,
        size,
        is_binary,
    })
}

/// Local 路径拼接：宿主 `Path::join` 语义（绝对 `path` 自动替换 `base`）。
pub(super) fn local_join(base: &str, path: &str) -> PathBuf {
    if base.is_empty() {
        PathBuf::from(path)
    } else {
        Path::new(base).join(path)
    }
}

/// WSL / SSH 路径拼接：**POSIX 串拼接**，返回值直接作为远端 argv 里的路径。
///
/// 必须与 [`local_join`] 分开：远端目标（WSL / SSH）的路径语义永远是 POSIX，而宿主
/// `Path` 语义属于**执行命令的那台机器**。在 Windows 宿主上用 `Path::join` 拼远端路径会
/// 产出 `\` 分隔形态（且 `/home/u/x` 在 Windows 上**不是** absolute，`base` 不会被替换），
/// 远端 shell 拿到的是坏路径 —— 远程文件读取/预览在 Windows 上失效的根因正在这里。
///
/// 规则（顺序即契约）：
/// 1. `path` 以 `/` 开头 ⇒ 已是远端绝对路径，原样返回（`base` 不参与）；
/// 2. `base` 为空 ⇒ `path` 原样返回（调用方已给出完整路径的退化形态）；
/// 3. 否则 `{base 去尾分隔符}/{path 去前导 `./`}`。
pub(super) fn join_remote_path(base: &str, path: &str) -> String {
    if path.starts_with('/') {
        return path.to_string();
    }
    if base.is_empty() {
        return path.to_string();
    }
    let base = base.trim_end_matches('/');
    let path = path.strip_prefix("./").unwrap_or(path);
    format!("{base}/{path}")
}

/// 本地通道的路径解析：拼接 + `canonicalize` + scope 校验（红线 8）。
///
/// 文本读取、字节读取、大小探测三个形态共用本函数 —— `canonicalize` 与 scope 判定
/// 只允许存在一份实现（红线 8 的判据不能有第二套）。
pub(super) fn canonical_in_scope(
    scope: &FileAccessScope,
    base: &str,
    path: &str,
) -> Result<PathBuf, AppError> {
    let full = local_join(base, path);
    let canonical =
        std::fs::canonicalize(&full).map_err(|e| AppError::File(format!("Invalid path: {e}")))?;
    apply_scope(&canonical, scope)?;
    Ok(canonical)
}

pub(super) fn apply_scope(canonical: &Path, scope: &FileAccessScope) -> Result<(), AppError> {
    match scope {
        FileAccessScope::InProject { root } => {
            let canonical_root = root
                .canonicalize()
                .map_err(|e| AppError::File(format!("Invalid root path: {}", e)))?;
            if !canonical.starts_with(&canonical_root) {
                return Err(AppError::File("Path is outside root directory".to_string()));
            }
            Ok(())
        }
        FileAccessScope::Trusted => Ok(()),
    }
}

fn is_binary_file(path: &Path) -> Result<bool, AppError> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| AppError::File(format!("Failed to open file: {}", e)))?;
    let mut buffer = vec![0u8; 8192];
    let bytes_read = file
        .read(&mut buffer)
        .map_err(|e| AppError::File(e.to_string()))?;
    Ok(buffer[..bytes_read].contains(&0))
}

#[cfg(test)]
mod join_tests {
    use super::{join_remote_path, local_join};

    /// 远端拼接必须是 POSIX 语义：不论宿主是什么平台，产出里不得出现 `\`。
    ///
    /// 回归锁定：宿主 `Path::join` 在 Windows 上拼出 `/home/u/proj\src/main.rs`，
    /// 且 `/home/u/x` 不算 absolute ⇒ `base` 不被替换 ⇒ 远端拿到坏路径。
    #[test]
    fn remote_join_is_posix_regardless_of_host() {
        assert_eq!(
            join_remote_path("/home/u/proj", "src/main.rs"),
            "/home/u/proj/src/main.rs"
        );
        assert!(!join_remote_path("/home/u/proj", "src/main.rs").contains('\\'));
    }

    #[test]
    fn remote_join_keeps_absolute_path_and_avoids_double_separator() {
        // 绝对 path 不参与 base（与 local_join 的绝对路径替换语义对齐）
        assert_eq!(join_remote_path("/home/u/proj", "/etc/hosts"), "/etc/hosts");
        // base 尾部斜杠 / path 前导 ./ 都归一
        assert_eq!(
            join_remote_path("/home/u/proj/", "./img/a.png"),
            "/home/u/proj/img/a.png"
        );
        // base 缺省 ⇒ path 原样（调用方已给完整路径）
        assert_eq!(join_remote_path("", "/abs/a.png"), "/abs/a.png");
        assert_eq!(join_remote_path("", "rel/a.png"), "rel/a.png");
    }

    #[test]
    fn local_join_keeps_host_semantics() {
        // 宿主语义：绝对 path 替换 base（Windows/macOS 都由 std 保证）
        let joined = local_join("/repo/docs", "/abs/a.png");
        assert_eq!(joined, std::path::PathBuf::from("/abs/a.png"));
        let joined = local_join("/repo/docs", "img/a.png");
        assert_eq!(joined, std::path::Path::new("/repo/docs").join("img/a.png"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn local_target() -> ExecTarget {
        ExecTarget::Local
    }

    fn req(path: &Path, max_bytes: Option<u64>, detect_binary: bool) -> FileReadRequest {
        FileReadRequest {
            address: FileAddress::absolute(local_target(), path.to_string_lossy()),
            max_bytes,
            detect_binary,
        }
    }

    struct Fixture {
        _dir: TempDir,
        root: PathBuf,
        outside: PathBuf,
    }

    fn fixture() -> Fixture {
        // root 与 outside 同 TempDir 但分离目录：并行测试安全，且 outside 确在 root 外
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("inner.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("bin.dat"), [0u8, 1, 2, 0, 3]).unwrap();
        let outside_dir = dir.path().join("outside");
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("outer.rs"), "outside").unwrap();
        Fixture {
            _dir: dir,
            root,
            outside: outside_dir.join("outer.rs"),
        }
    }

    #[tokio::test]
    async fn in_project_reads_file_within_root() {
        let fx = fixture();
        let out = read_file(
            FileAccessScope::InProject {
                root: fx.root.clone(),
            },
            req(&fx.root.join("inner.rs"), None, true),
        )
        .await
        .unwrap();
        assert_eq!(out.content, "fn main() {}\n");
        assert!(!out.is_binary);
    }

    #[tokio::test]
    async fn in_project_rejects_path_outside_root() {
        let fx = fixture();
        let err = read_file(
            FileAccessScope::InProject {
                root: fx.root.clone(),
            },
            req(&fx.outside, None, true),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::File(ref m) if m.contains("outside root")));
    }

    #[tokio::test]
    async fn trusted_reads_outside_root_without_root_check() {
        let fx = fixture();
        let out = read_file(FileAccessScope::Trusted, req(&fx.outside, None, true))
            .await
            .unwrap();
        assert_eq!(out.content, "outside");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn trusted_still_canonicalizes_symlink() {
        let fx = fixture();
        std::os::unix::fs::symlink(fx.root.join("inner.rs"), fx.root.join("link.rs")).unwrap();
        let out = read_file(
            FileAccessScope::Trusted,
            req(&fx.root.join("link.rs"), None, true),
        )
        .await
        .unwrap();
        assert_eq!(out.content, "fn main() {}\n");
    }

    #[tokio::test]
    async fn max_bytes_caps_read() {
        let fx = fixture();
        let err = read_file(
            FileAccessScope::Trusted,
            req(&fx.root.join("inner.rs"), Some(4), false),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::File(ref m) if m.contains("exceeds")));
    }

    #[tokio::test]
    async fn detect_binary_returns_empty_content_for_binary_file() {
        let fx = fixture();
        let out = read_file(
            FileAccessScope::Trusted,
            req(&fx.root.join("bin.dat"), None, true),
        )
        .await
        .unwrap();
        assert!(out.is_binary);
        assert_eq!(out.content, "");
    }

    #[tokio::test]
    async fn detect_binary_off_reads_binary_as_text() {
        let fx = fixture();
        let out = read_file(
            FileAccessScope::Trusted,
            req(&fx.root.join("bin.dat"), None, false),
        )
        .await
        .unwrap();
        assert!(out.content.contains('\u{0}'));
        assert!(!out.is_binary);
    }

    #[tokio::test]
    async fn missing_file_is_file_error() {
        let fx = fixture();
        let err = read_file(
            FileAccessScope::InProject {
                root: fx.root.clone(),
            },
            req(&fx.root.join("missing.rs"), None, true),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::File(_)));
    }

    #[tokio::test]
    async fn base_relative_path_resolves_against_base() {
        let fx = fixture();
        let out = read_file(
            FileAccessScope::InProject {
                root: fx.root.clone(),
            },
            FileReadRequest {
                address: FileAddress::new(local_target(), fx.root.to_string_lossy(), "inner.rs"),
                max_bytes: None,
                detect_binary: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(out.content, "fn main() {}\n");
    }
}
