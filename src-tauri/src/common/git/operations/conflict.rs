//! 冲突读路径的**派发缝**（与 `operations::get_file_diff` 同形）。
//!
//! 红线 4 的**唯一封顶出口**在本函数末尾：任何 transport 的 [`ConflictStages`] 都必须过
//! `cap_conflict_payload` 才返回（新增 transport 自动受约束）。

use anyhow::Result;

use crate::common::git::conflict::types::ConflictStages;
use crate::common::git::conflict::{cap_conflict_payload, local, shell};
use crate::common::git::transport::GitTransport;

/// 读一个冲突文件的三个 stage。
///
/// 契约（与单文件 diff 三态契约同族，`design.md` §2.4）：
/// ① path 无 unmerged 条目 → `Err`（语义 = 调用方回退普通 diff，不是空冲突）；
/// ② 有 unmerged 条目 → 返回三侧现状，缺失 stage 以 `content: None` 表达；
/// ③ binary → `kind = Binary`，三侧不解码内容。
///
/// 路径安全（红线 8）由命令层完成；本函数只做 I/O 与语义组装。
pub async fn read_conflict_stages(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_path: &str,
) -> Result<ConflictStages> {
    let stages = match transport.open_repo_async(work_dir).await {
        // 红线 3：git2 同步 + blob 探测 + merge 引擎整体隔离到阻塞池。
        Some(_repo) => {
            let work_dir_owned = work_dir.to_string();
            let file_path_owned = file_path.to_string();
            tokio::task::spawn_blocking(move || {
                local::read(std::path::Path::new(&work_dir_owned), &file_path_owned)
            })
            .await
            .map_err(|e| anyhow::anyhow!("git conflict read task join error: {e}"))??
        }
        None => shell::read(transport, work_dir, file_path).await?,
    };
    // 红线 4：三元载荷封顶（唯一出口）。
    Ok(cap_conflict_payload(stages))
}
