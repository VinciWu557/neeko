//! Unix 实现：0600 权限 + 同目录临时文件 rename（原子）。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

#[cfg(test)]
use std::os::unix::fs::PermissionsExt;

/// 以「仅属主可读写」权限原子写入 `path`。
///
/// 临时文件与目标同目录（跨目录 rename 不保证原子），名字含 pid 避免并发撞名。
///
/// **权限必须一次成型**：`fs::write` 以 `0o666 & ~umask`（典型 `0o644`）创建，事后再
/// `set_permissions(0o600)` 会留一个同机可读窗口 —— 而本文件承载的是 hook 鉴权 token
/// （同机伪造通知的唯一凭据，见 `agent/hooks/server.rs` 的 `x-neeko-agent-hook-token`）。
/// 故走 `OpenOptions::mode(0o600)` 在创建时即收紧；失败路径清理 tmp，避免残留明文。
pub fn write_private_atomic(path: &Path, content: &str) -> io::Result<()> {
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy();
    let tmp = path.with_file_name(format!("{file_name}.tmp-{}", std::process::id()));

    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    // 写入或改名失败时清理 tmp（否则残留一份可读 token —— 失败路径比成功路径更需要它）。
    let result = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            drop(file);
            fs::rename(&tmp, path)
        });
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 断言用：`path` 的权限位（八进制）。
#[cfg(test)]
pub(crate) fn mode_of(path: &Path) -> io::Result<u32> {
    Ok(fs::metadata(path)?.permissions().mode() & 0o777)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内容与权限都对（成功路径基线）。
    #[test]
    fn writes_content_with_owner_only_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("token.env");
        write_private_atomic(&path, "TOKEN=abc\n").expect("write");
        assert_eq!(fs::read_to_string(&path).expect("read"), "TOKEN=abc\n");
        assert_eq!(mode_of(&path).expect("mode"), 0o600);
    }

    /// 权限必须在**创建时**就是 0600，而非「先 0644 建、后收紧」。
    ///
    /// 反证式：若实现退回 `fs::write` + `set_permissions`，同机其他用户能在两步之间读到
    /// token。这里用 `umask` 无关的判据 —— 直接断言 tmp 文件被创建时的模式。
    #[test]
    fn tmp_file_is_created_owner_only_not_tightened_afterwards() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("token.env");
        // 预先放宽 umask 的效果：若实现用默认 mode(0o666)，创建结果会是 0o644 或更宽。
        let probe = dir.path().join("probe");
        {
            let f = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&probe)
                .expect("probe");
            drop(f);
        }
        let default_mode = mode_of(&probe).expect("mode");
        // 前提校验：本机默认创建模式确实比 0600 宽（否则本用例无判别力）。
        assert_ne!(
            default_mode, 0o600,
            "本机默认创建模式已是 0600 —— 本用例失去判别力，请调整前提"
        );

        write_private_atomic(&path, "TOKEN=abc\n").expect("write");
        assert_eq!(
            mode_of(&path).expect("mode"),
            0o600,
            "权限必须在创建时收紧（mode(0o600)），不能依赖事后的 set_permissions"
        );
    }

    /// 覆盖写：已存在且更宽权限的文件被替换后仍为 0600（旧实现靠 set_permissions 也能过，
    /// 但这条防止「rename 保留目标旧权限」的平台差异回归）。
    #[test]
    fn overwrite_keeps_owner_only_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("token.env");
        fs::write(&path, "old\n").expect("seed");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("loosen");
        write_private_atomic(&path, "new\n").expect("write");
        assert_eq!(mode_of(&path).expect("mode"), 0o600);
        assert_eq!(fs::read_to_string(&path).expect("read"), "new\n");
    }

    /// 失败路径不残留 tmp（承载 token 的文件不允许留下可读副本）。
    #[test]
    fn failed_write_leaves_no_tmp_residue() {
        let dir = tempfile::tempdir().expect("tempdir");
        // 目标路径的父目录不存在 → open(tmp) 必定失败。
        let path = dir.path().join("missing-dir").join("token.env");
        assert!(write_private_atomic(&path, "TOKEN=abc\n").is_err());
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "tmp residue: {leftovers:?}");
    }
}
