//! `common::file::services` 域共享单元测试入口（原 tests.rs 839 行超健康线，
//! 按被测子模块拆分；`TestRoot` / `block_on` 为域内共享 helper）。

mod ignored_cache;
mod path_ops;
mod tree_read;

use std::future::Future;
use std::path::Path;

/// 进程内唯一的测试临时根 —— **持有**底层 `TempDir`（Drop 即回收），`Deref` 到 `Path`
/// 让调用点保持 `root.join(..)` / `&root` / `root.to_str()` 的既有写法。
///
/// 为什么不是裸 `PathBuf`：路径是「借来的名字」，所有权一旦丢失，清理就只能靠人工
/// `remove_dir_all`（原先 28 处调用点只有一部分写了，其余把整棵目录留在系统 TEMP）。
/// 需要 `PathBuf` 的少数点（如 `GitIgnoreFilter::new`）显式走 `root.to_path_buf()`。
struct TestRoot(tempfile::TempDir);

impl std::ops::Deref for TestRoot {
    type Target = Path;

    fn deref(&self) -> &Path {
        self.0.path()
    }
}

// 调用点里有 `fs::remove_dir_all(&root)` 这类 `impl AsRef<Path>` 形参（编译期证明的必需项）。
impl AsRef<Path> for TestRoot {
    fn as_ref(&self) -> &Path {
        self.0.path()
    }
}

/// 建一个前缀含测试名的临时根（测试名进前缀便于排查；唯一性由 tempfile 保证）。
fn temp_root(name: &str) -> TestRoot {
    let dir = tempfile::Builder::new()
        .prefix(&format!("neeko_file_mgmt_{name}_"))
        .tempdir()
        .expect("tempdir");
    TestRoot(dir)
}

/// 独立 tokio runtime 阻塞执行 async fn（供同步 `#[test]` 调用异步服务）
fn block_on<F: Future>(future: F) -> F::Output {
    tokio::runtime::Runtime::new().unwrap().block_on(future)
}
