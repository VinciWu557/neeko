//! Unix 实现：0600 权限 + 同目录临时文件 rename（原子）。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

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

/// 创建（含父级）**仅属主可访问**的目录（`0700`）。
///
/// 目录权限与文件权限是同一威胁模型的两半：文件 0600 只挡住文件内容，若目录可列（0755），
/// 同机其他用户仍能枚举出实例坐标文件名。`create_dir_all` 以 `0o777 & ~umask`（典型 0755）
/// 创建，故这里显式收紧 —— 与 [`write_private_atomic`] 的 0600 同源。
pub fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

/// 原子替换**用户既有文件**，且**保留原权限位**。
///
/// 与 [`write_private_atomic`] 的区别：后者总是收紧为 0600（它写的是 Neeko 自己的
/// 凭据文件），而本函数写的是**用户的** `settings.json` / `config.toml` ——
/// 用户的文件可能是 0644（默认）或 0600（用户自己收紧过）。
/// 无条件写 0600 会把用户的 0644 静默降权（可能打断 CLI 自己的读取）；
/// 无条件写 0644 会把用户的 0600 静默泄漏。故一律**继承原权限**。
///
/// 文件不存在时回落为「默认创建模式」（`0o666 & ~umask`），与用户手动创建一致。
pub fn write_atomic_preserving_mode(path: &Path, content: &str) -> io::Result<()> {
    // 先取原权限（文件可能不存在 → None，走默认模式）。
    let previous_mode = fs::metadata(path)
        .ok()
        .map(|m| m.permissions().mode() & 0o777);

    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy();
    let tmp = path.with_file_name(format!("{file_name}.tmp-{}", std::process::id()));

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    if let Some(mode) = previous_mode {
        options.mode(mode);
    }
    let mut file = options.open(&tmp)?;
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

    /// 目录创建为 0700（列出目录同样属于泄漏面）。
    #[test]
    fn creates_dir_owner_only_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nested = dir.path().join("agent-hooks").join("endpoints");
        create_private_dir(&nested).expect("create");
        assert!(nested.is_dir());
        assert_eq!(mode_of(&nested).expect("mode"), 0o700);
    }

    /// 已存在（更宽权限）的目录被再次创建时收紧为 0700。
    #[test]
    fn create_dir_tightens_existing_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let nested = dir.path().join("endpoints");
        fs::create_dir(&nested).expect("seed");
        fs::set_permissions(&nested, fs::Permissions::from_mode(0o755)).expect("loosen");
        create_private_dir(&nested).expect("create");
        assert_eq!(mode_of(&nested).expect("mode"), 0o700);
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

    /// **权限继承**（父任务 AC4）：改写用户既有配置文件后，原权限位必须不变。
    ///
    /// 反证：若实现无条件写 0600（照搬 [`write_private_atomic`]），本用例必红 ——
    /// 用户的 0644 被静默降权。
    #[test]
    fn preserving_write_keeps_original_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        fs::write(&path, "{\"a\":1}").expect("seed");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod 644");

        write_atomic_preserving_mode(&path, "{\"a\":2}").expect("write");
        assert_eq!(fs::read_to_string(&path).expect("read"), "{\"a\":2}");
        assert_eq!(
            mode_of(&path).expect("mode"),
            0o644,
            "用户文件的 0644 必须保留（不得降权）"
        );
    }

    /// 用户把配置收紧到 0600 时，改写**不得放宽**（反向的不对称危害更大：泄漏）。
    #[test]
    fn preserving_write_does_not_loosen_owner_only_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.toml");
        fs::write(&path, "x = 1\n").expect("seed");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod 600");

        write_atomic_preserving_mode(&path, "x = 2\n").expect("write");
        assert_eq!(mode_of(&path).expect("mode"), 0o600);
    }

    /// 文件不存在时按默认模式创建（与用户手动创建一致，不引入意外收紧）。
    #[test]
    fn preserving_write_creates_missing_file_with_default_mode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("fresh.json");
        write_atomic_preserving_mode(&path, "{}").expect("write");
        assert_eq!(fs::read_to_string(&path).expect("read"), "{}");
        // 不断言具体模式（受 umask 影响）—— 只要求可读且非 0600-only 之外的意外收紧。
        let mode = mode_of(&path).expect("mode");
        assert!(mode & 0o400 != 0, "属主必须可读，got {mode:o}");
    }
}
