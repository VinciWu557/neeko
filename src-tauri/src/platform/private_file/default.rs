//! 非 Unix 实现（Windows）：profile 目录自带 per-user ACL；近似原子替换。

use std::fs;
use std::io;
use std::path::Path;

/// 原子写入 `path`。Windows 无跨进程安全的同名 rename-over，
/// 采用「先删后改名」：极小窗口内并发读者可能拿到 FileNotFound，
/// hook 侧契约是 fail-open 静默（下一拍重读即恢复），不构成故障。
pub fn write_private_atomic(path: &Path, content: &str) -> io::Result<()> {
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy();
    let tmp = path.with_file_name(format!("{file_name}.tmp-{}", std::process::id()));

    fs::write(&tmp, content)?;
    // 先删目标再改名：Windows 的 rename 实际走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，
    // 目标存在本身**不会**失败；真正的约束是目标被以不带 `FILE_SHARE_DELETE` 的方式打开时
    // 的共享冲突 —— 先删可避开该冲突，代价是极小窗口内读者可能 FileNotFound（hook 侧
    // fail-open，下一拍重读即恢复，见调用方契约）。
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    fs::rename(&tmp, path)
}
