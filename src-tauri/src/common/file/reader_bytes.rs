//! 二进制字节读取核心：「range 语义」的单一后端通道。
//!
//! 与 [`super::reader::read_file`]（文本）同构 —— 同 [`FileAddress`] 寻址、同 `ExecTarget`
//! 分派、同 `join_remote_path` / `canonical_in_scope` 路径解析；差异只有一处：返回**原始
//! 字节**而不是 String。
//!
//! # 为什么从一开始就带 offset/len
//!
//! PDF 的交叉引用表（xref）在文件尾部，打开 PDF 本质上是随机访问而非顺序读。
//! 「先把整个文件搬到前端」对大文件既不可能也不必要 —— pdf.js 只按需拉 xref 与可见页
//! 所需的对象块（`PDFDataRangeTransport`）。因此本通道的契约从第一天就带 range：
//! **整读 = 不传 offset 的特例**，小文件（图片）与大文件（PDF）共用同一入口。
//!
//! # 载荷上界是「至多返回」，不是「超限拒绝」
//!
//! 红线 4 要求单次 IPC 载荷有界。本模块把上界表达为 **`max_chunk`：单次调用最多返回这么
//! 多字节**（短读），而不是「请求超限就报错」。
//!
//! 这个区别不是风格问题，而是接口责任划分：
//! - 「报错」把分片循环推给每个调用方，而调用方只能自己抄一份上界常量（抄错即静默截断或
//!   直接失败 —— 图片 > 1MB 打不开、PDF range 请求挂死，都源自这个形状）；
//! - 「至多返回」让调用方只需 `loop { read(offset, 剩余量) }` 直到短读/越界，上界对调用方
//!   透明，且**总量不设上限**：500MB 的 PDF 只在需要时拉需要的块。
//!
//! 分段推进的唯一正确姿势（前端 `shared/api/fileBytes.ts` 的两处消费点都走它）：
//! 按返回的实际长度推进 offset，直到覆盖请求区间。
//!
//! # 通道选择
//!
//! - Local：`std::fs` seek + read，包在 `spawn_blocking` 里（红线 3）；
//! - WSL / SSH：`dd if=<path> iflag=skip_bytes,count_bytes skip=<off> count=<len>`
//!   （argv 直传经统一 exec 通道，红线 1/2）。`iflag` 依赖 GNU coreutils；**BSD/macOS
//!   远端不支持**该 iflag，会以 dd 的 stderr 原文报错（不静默返回短数据）。
//!   移植性改造（`tail -c` + `head -c` 管道形态）单独立项：本通道无本地可验证环境。

use crate::common::executor::factory::ExecTarget;
use crate::core::exec::collect;
use crate::AppError;

use super::reader::{canonical_in_scope, join_remote_path, FileAccessScope, FileAddress};

/// 单次载荷上界（1MB，与 pdf.js 默认 `rangeChunkSize` 对齐）。
///
/// **不是**文件大小上限：这是「一次最多给这么多」，调用方按返回长度继续推进即可读完
/// 任意大小的文件。前端不得再复制这个数值来做「够不够」判断 —— 短读本身就是契约。
pub const DEFAULT_MAX_CHUNK: u64 = 1024 * 1024;

/// 字节读取请求。寻址与 [`super::reader::FileReadRequest`] 共用 [`FileAddress`]。
#[derive(Clone)]
pub struct FileBytesRequest {
    /// 去哪儿读（环境 + 基准 + 路径）。
    pub address: FileAddress,
    /// 起始偏移（字节）；`None` = 从文件头开始。
    pub offset: Option<u64>,
    /// 期望读取长度；`None` = 读到文件尾。**实际返回可能更短**（见 `max_chunk`）。
    pub len: Option<u64>,
    /// 单次载荷上界（字节）：一次调用最多返回这么多，短读由调用方续读。
    pub max_chunk: u64,
}

impl FileBytesRequest {
    /// 从文件头读到尾（受 `max_chunk` 约束的**首段**）：图片等小文件的首读形态。
    #[must_use]
    pub const fn head(address: FileAddress) -> Self {
        Self {
            address,
            offset: None,
            len: None,
            max_chunk: DEFAULT_MAX_CHUNK,
        }
    }
}

/// 读取文件字节（range 语义）。返回长度 ≤ `min(请求长度, 剩余字节, max_chunk)`。
pub async fn read_file_bytes(
    scope: FileAccessScope,
    req: FileBytesRequest,
) -> Result<Vec<u8>, AppError> {
    match req.address.target {
        ExecTarget::Local => {
            let FileBytesRequest {
                address,
                offset,
                len,
                max_chunk,
            } = req;
            tokio::task::spawn_blocking(move || {
                read_bytes_local_blocking(
                    &scope,
                    &address.base,
                    &address.path,
                    offset,
                    len,
                    max_chunk,
                )
            })
            .await
            .map_err(|e| AppError::File(format!("file bytes read join error: {e}")))?
        }
        ExecTarget::Wsl { .. } | ExecTarget::Remote { .. } => read_bytes_shell(scope, req).await,
    }
}

/// 文件大小（stat 通道，不读内容）：PDF 打开时先探长度，再按 range 拉取。
///
/// 与 [`read_file_bytes`] 同址（[`FileAddress`]）—— 同一份「去哪儿读」的事实只描述一次。
pub async fn read_file_size(scope: FileAccessScope, address: FileAddress) -> Result<u64, AppError> {
    let FileAddress { target, base, path } = address;
    match target {
        ExecTarget::Local => tokio::task::spawn_blocking(move || {
            let canonical = canonical_in_scope(&scope, &base, &path)?;
            std::fs::metadata(&canonical)
                .map(|m| m.len())
                .map_err(|e| AppError::File(format!("Failed to read metadata: {e}")))
        })
        .await
        .map_err(|e| AppError::File(format!("file size join error: {e}")))?,
        ExecTarget::Wsl { .. } | ExecTarget::Remote { .. } => {
            let full = join_remote_path(&base, &path);
            shell_file_size(&target, &full).await
        }
    }
}

// ── Local ────────────────────────────────────────────────────────────────────

/// Local 通道阻塞实现（仅由 `spawn_blocking` 调用）。
fn read_bytes_local_blocking(
    scope: &FileAccessScope,
    base: &str,
    path: &str,
    offset: Option<u64>,
    len: Option<u64>,
    max_chunk: u64,
) -> Result<Vec<u8>, AppError> {
    use std::io::{Read, Seek, SeekFrom};

    let canonical = canonical_in_scope(scope, base, path)?;
    let size = std::fs::metadata(&canonical)
        .map_err(|e| AppError::File(format!("Failed to read metadata: {e}")))?
        .len();
    let (start, want) = plan_range(offset, len, size, max_chunk)?;
    if want == 0 {
        return Ok(Vec::new());
    }

    let mut file = std::fs::File::open(&canonical)
        .map_err(|e| AppError::File(format!("Failed to open file: {e}")))?;
    if start > 0 {
        file.seek(SeekFrom::Start(start))
            .map_err(|e| AppError::File(format!("Failed to seek file: {e}")))?;
    }
    // `take(want)` + `read_to_end`：文件在读到一半被截断时返回实际字节，而不是 `read_exact`
    // 的 UnexpectedEof（并发编辑场景下后者会让预览整块失败）。
    // max_chunk 已保证 want 落在 usize 范围内；try_from 只是把假设写明。
    let capacity = usize::try_from(want)
        .map_err(|e| AppError::File(format!("Chunk size not addressable: {e}")))?;
    let mut buf = Vec::with_capacity(capacity);
    (&mut file)
        .take(want)
        .read_to_end(&mut buf)
        .map_err(|e| AppError::File(format!("Failed to read file bytes: {e}")))?;
    Ok(buf)
}

// ── Shell (WSL / SSH) ────────────────────────────────────────────────────────

/// WSL/Remote 通道：stat 拿大小，`dd` 按 range 取字节（argv 形态，不经 shell）。
async fn read_bytes_shell(
    scope: FileAccessScope,
    req: FileBytesRequest,
) -> Result<Vec<u8>, AppError> {
    // scope 校验：Trusted 信任调用方；InProject 的远程 root 校验为已知欠账
    //（与 `read_file_shell` 同一处，补齐需远程 realpath，单独立项）。
    let _ = scope;

    let full = join_remote_path(&req.address.base, &req.address.path);
    let size = shell_file_size(&req.address.target, &full).await?;
    let (start, want) = plan_range(req.offset, req.len, size, req.max_chunk)?;
    if want == 0 {
        return Ok(Vec::new());
    }

    let skip_arg = format!("skip={start}");
    let count_arg = format!("count={want}");
    let if_arg = format!("if={full}");
    let out = collect(
        &req.address.target,
        "dd",
        &[
            &if_arg,
            "iflag=skip_bytes,count_bytes",
            &skip_arg,
            &count_arg,
        ],
        None,
    )
    .await
    .map_err(|e| AppError::File(format!("Failed to read file bytes: {e}")))?;

    if out.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::File(format!(
            "Failed to read file bytes (dd exit {}): {}",
            out.exit_code,
            stderr.trim()
        )));
    }
    Ok(out.stdout)
}

/// 远程 `stat -c %s`（Linux 语义）；失败即报错，不静默当 0 字节。
async fn shell_file_size(target: &ExecTarget, full: &str) -> Result<u64, AppError> {
    let out = collect(target, "stat", &["-c", "%s", full], None)
        .await
        .map_err(|e| AppError::File(format!("Failed to read file size: {e}")))?;
    if out.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::File(format!(
            "Failed to read file size: {}",
            stderr.trim()
        )));
    }
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u64>()
        .map_err(|e| AppError::File(format!("Failed to parse file size: {e}")))
}

// ── 共用 ─────────────────────────────────────────────────────────────────────

/// range 规划 + 上界收敛（Local 与 shell 通道共用，保证两环境行为逐字一致）。
///
/// 返回 `(起始偏移, 本次要读字节数)`：
/// - `offset > size` ⇒ 显式错误（静默返回空会被前端当成「空文件/损坏文件」，错误信息更难懂）；
/// - 其余一律**收敛**：`want = min(请求长度, 剩余字节, max_chunk)`。
///   请求超过 `max_chunk` 不是错误 —— 那是调用方该续读的短读，不是失败。
fn plan_range(
    offset: Option<u64>,
    len: Option<u64>,
    size: u64,
    max_chunk: u64,
) -> Result<(u64, u64), AppError> {
    let start = offset.unwrap_or(0);
    if start > size {
        return Err(AppError::File(format!(
            "Offset {start} is beyond file size {size}"
        )));
    }
    let remaining = size - start;
    let want = len.unwrap_or(remaining).min(remaining).min(max_chunk);
    Ok((start, want))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    fn local_target() -> ExecTarget {
        ExecTarget::Local
    }

    struct Fixture {
        _dir: TempDir,
        root: std::path::PathBuf,
        outside: std::path::PathBuf,
    }

    /// 夹具路径一律由 `tempdir()` 推导（红线 13）。
    fn fixture() -> Fixture {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("root");
        fs::create_dir_all(root.join("docs")).unwrap();
        // 0..=9 的确定性字节序列，便于断言 range 窗口
        fs::write(root.join("data.bin"), (0u8..10).collect::<Vec<u8>>()).unwrap();
        fs::write(root.join("docs/page.bin"), [42u8, 43]).unwrap();
        fs::write(root.join("empty.bin"), b"").unwrap();
        let outside_dir = dir.path().join("outside");
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("outer.bin"), [7u8, 8, 9]).unwrap();
        Fixture {
            _dir: dir,
            root,
            outside: outside_dir.join("outer.bin"),
        }
    }

    fn req(path: &Path, offset: Option<u64>, len: Option<u64>) -> FileBytesRequest {
        FileBytesRequest {
            address: FileAddress::absolute(local_target(), path.to_string_lossy()),
            offset,
            len,
            max_chunk: DEFAULT_MAX_CHUNK,
        }
    }

    fn in_project(fx: &Fixture) -> FileAccessScope {
        FileAccessScope::InProject {
            root: fx.root.clone(),
        }
    }

    #[tokio::test]
    async fn whole_read_returns_all_bytes() {
        let fx = fixture();
        let bytes = read_file_bytes(in_project(&fx), req(&fx.root.join("data.bin"), None, None))
            .await
            .unwrap();
        assert_eq!(bytes, (0u8..10).collect::<Vec<u8>>());
    }

    #[tokio::test]
    async fn relative_address_resolves_against_base() {
        // 与文本读取同一寻址形态：base 是「md 文件所在目录」这类消费者给的基准
        let fx = fixture();
        let bytes = read_file_bytes(
            in_project(&fx),
            FileBytesRequest::head(FileAddress::new(
                local_target(),
                fx.root.to_string_lossy(),
                "docs/page.bin",
            )),
        )
        .await
        .unwrap();
        assert_eq!(bytes, vec![42u8, 43]);
    }

    #[tokio::test]
    async fn range_read_returns_exact_window() {
        let fx = fixture();
        let bytes = read_file_bytes(
            in_project(&fx),
            req(&fx.root.join("data.bin"), Some(3), Some(4)),
        )
        .await
        .unwrap();
        assert_eq!(bytes, vec![3u8, 4, 5, 6]);
    }

    #[tokio::test]
    async fn range_read_to_tail_when_len_absent() {
        let fx = fixture();
        let bytes = read_file_bytes(
            in_project(&fx),
            req(&fx.root.join("data.bin"), Some(8), None),
        )
        .await
        .unwrap();
        assert_eq!(bytes, vec![8u8, 9]);
    }

    #[tokio::test]
    async fn range_past_eof_is_clamped_not_error() {
        // 调用方按固定步长推进，尾部分片必然越过文件尾 —— 裁到实际剩余量。
        let fx = fixture();
        let bytes = read_file_bytes(
            in_project(&fx),
            req(&fx.root.join("data.bin"), Some(8), Some(64)),
        )
        .await
        .unwrap();
        assert_eq!(bytes, vec![8u8, 9]);
    }

    #[tokio::test]
    async fn oversized_request_returns_short_read_not_error() {
        // 契约核心：请求超过单次上界 ⇒ **短读**（调用方续读），不是报错。
        // 报错形态会让「图片 > 1MB」「pdf.js 一次要一大段」两条主路径直接不可用。
        let fx = fixture();
        let mut r = req(&fx.root.join("data.bin"), None, None);
        r.max_chunk = 4;
        let bytes = read_file_bytes(in_project(&fx), r).await.unwrap();
        assert_eq!(bytes, vec![0u8, 1, 2, 3]);
    }

    #[tokio::test]
    async fn consecutive_short_reads_reassemble_the_whole_file() {
        // 调用方按返回长度推进 offset 就能读完任意大小 —— 这正是不设「文件大小上限」的依据。
        let fx = fixture();
        let root = fx.root.clone();
        let path = root.join("data.bin");
        let size = read_file_size(
            in_project(&fx),
            FileAddress::absolute(local_target(), path.to_string_lossy()),
        )
        .await
        .unwrap();
        assert_eq!(size, 10);

        let mut out = Vec::new();
        let mut offset = 0u64;
        while offset < size {
            let mut r = req(&path, Some(offset), Some(size - offset));
            r.max_chunk = 3;
            let chunk = read_file_bytes(in_project(&fx), r).await.unwrap();
            assert!(!chunk.is_empty(), "短读不该返回空（除非已到尾部）");
            offset += chunk.len() as u64;
            out.extend_from_slice(&chunk);
        }
        assert_eq!(out, (0u8..10).collect::<Vec<u8>>());
    }

    #[tokio::test]
    async fn offset_beyond_size_is_explicit_error() {
        let fx = fixture();
        let err = read_file_bytes(
            in_project(&fx),
            req(&fx.root.join("data.bin"), Some(11), None),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::File(ref m) if m.contains("beyond file size")));
    }

    #[tokio::test]
    async fn empty_file_reads_empty() {
        let fx = fixture();
        let bytes = read_file_bytes(in_project(&fx), req(&fx.root.join("empty.bin"), None, None))
            .await
            .unwrap();
        assert!(bytes.is_empty());
    }

    #[tokio::test]
    async fn in_project_rejects_path_outside_root() {
        let fx = fixture();
        let err = read_file_bytes(in_project(&fx), req(&fx.outside, None, None))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::File(ref m) if m.contains("outside root")));
    }

    #[tokio::test]
    async fn in_project_rejects_base_escaping_root() {
        // base 由渲染点提供（md 目录 / skill 目录），但它不是逃逸通道：canonicalize + scope
        // 判定与文本读取共用同一实现，越界仍然拒绝。
        let fx = fixture();
        let err = read_file_bytes(
            in_project(&fx),
            FileBytesRequest::head(FileAddress::new(
                local_target(),
                fx.root.to_string_lossy(),
                "../outside/outer.bin",
            )),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::File(ref m) if m.contains("outside root")));
    }

    #[tokio::test]
    async fn trusted_reads_outside_root() {
        let fx = fixture();
        let bytes = read_file_bytes(FileAccessScope::Trusted, req(&fx.outside, None, None))
            .await
            .unwrap();
        assert_eq!(bytes, vec![7u8, 8, 9]);
    }

    #[tokio::test]
    async fn missing_file_is_file_error() {
        let fx = fixture();
        let err = read_file_bytes(
            in_project(&fx),
            req(&fx.root.join("missing.bin"), None, None),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::File(_)));
    }

    #[tokio::test]
    async fn size_matches_metadata() {
        let fx = fixture();
        let size = read_file_size(
            in_project(&fx),
            FileAddress::new(local_target(), fx.root.to_string_lossy(), "data.bin"),
        )
        .await
        .unwrap();
        assert_eq!(size, 10);
    }

    #[tokio::test]
    async fn size_rejects_path_outside_root() {
        let fx = fixture();
        let err = read_file_size(
            in_project(&fx),
            FileAddress::absolute(local_target(), fx.outside.to_string_lossy()),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::File(ref m) if m.contains("outside root")));
    }

    #[test]
    fn plan_range_converges_instead_of_rejecting() {
        // 无参 → 整读
        assert_eq!(plan_range(None, None, 10, 1024).unwrap(), (0, 10));
        // 偏移 + 长度
        assert_eq!(plan_range(Some(2), Some(3), 10, 1024).unwrap(), (2, 3));
        // 精确到尾部
        assert_eq!(plan_range(Some(0), Some(10), 10, 1024).unwrap(), (0, 10));
        // 越过尾部 → 裁剪
        assert_eq!(plan_range(Some(9), Some(10), 10, 1024).unwrap(), (9, 1));
        // 空文件
        assert_eq!(plan_range(None, None, 0, 1024).unwrap(), (0, 0));
        // 越界偏移 → 仍报错（唯一保留的错误分支）
        assert!(plan_range(Some(11), None, 10, 1024).is_err());
        // 超上界 → 收敛为短读
        assert_eq!(plan_range(None, None, 10, 4).unwrap(), (0, 4));
        assert_eq!(plan_range(None, Some(9), 100, 4).unwrap(), (0, 4));
        assert_eq!(plan_range(Some(9), None, 10, 4).unwrap(), (9, 1));
        // 上界为 0 时退化为空（调用方会拿到 0 字节并停下，不会死循环）
        assert_eq!(plan_range(None, None, 10, 0).unwrap(), (0, 0));
    }
}
