#![allow(clippy::unwrap_used, clippy::expect_used, missing_docs)]

use crate::common::git::types::DiffResult;
use git2::Repository;
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use super::key::{diff_cache_key, repo_key_prefix};

// ─── LRU Diff Cache ───────────────────────────────────────────────────────

const DIFF_CACHE_CAP: usize = 50;

/// 单个文件的 `(mtime_ns, size)` 指纹。
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    /// File modification time (nanoseconds since UNIX epoch).
    mtime_ns: u64,
    /// File byte size.
    size: u64,
}

fn stat_fingerprint(path: &Path) -> Option<FileFingerprint> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    Some(FileFingerprint {
        mtime_ns,
        size: meta.len(),
    })
}

/// 工作区 diff 的**全输入**指纹 —— diff 是 `f(HEAD, index, 工作区文件)`，
/// 命中判据必须覆盖全部输入。只比工作区文件会漏掉「HEAD 移动（外部 commit）/
/// index 变化而文件未动」，于是返回 commit 前的旧 diff（已提交却仍显示变更高亮）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct DiffInputFingerprint {
    /// HEAD commit oid；`None` = unborn（无任何提交，diff 退化为 index↔工作区）。
    head_oid: Option<String>,
    /// index 文件指纹；`None` = 无 index。
    index: Option<FileFingerprint>,
    /// 工作区文件指纹；`None` = 文件不在盘上。
    worktree: Option<FileFingerprint>,
}

/// 采集 `f(HEAD, index, 工作区文件)` 三元指纹。
///
/// 阻塞 I/O（`Repository::open` / `stat`），只能在 `spawn_blocking` 内调用
/// （`operations::get_file_diff` 已包裹）。
#[must_use]
fn capture_diff_input_fingerprint(repo_path: &Path, file_path: &str) -> DiffInputFingerprint {
    // index 属于该单元自己的 gitdir（linked worktree 是私有 gitdir），
    // 只能经 `Repository::path()` 取得，不得手拼 `repo_path/.git/index`。
    let repo = Repository::open(repo_path).ok();
    let head_oid = repo
        .as_ref()
        .and_then(|r| r.head().ok())
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id().to_string());
    let index = repo
        .as_ref()
        .and_then(|r| stat_fingerprint(&r.path().join("index")));
    DiffInputFingerprint {
        head_oid,
        index,
        worktree: stat_fingerprint(&repo_path.join(file_path)),
    }
}

#[derive(Debug, Clone)]
struct DiffEntry {
    result: DiffResult,
    fingerprint: DiffInputFingerprint,
}

struct LruCache {
    map: Mutex<HashMap<String, usize>>,
    queue: Mutex<VecDeque<(String, DiffEntry)>>,
}

impl LruCache {
    fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            queue: Mutex::new(VecDeque::new()),
        }
    }

    fn get(&self, key: &str) -> Option<DiffEntry> {
        let mut queue = self.queue.lock().ok()?;
        let mut map = self.map.lock().ok()?;
        if let Some(&idx) = map.get(key) {
            if let Some(entry) = queue.get(idx) {
                let val = entry.1.clone();
                queue.remove(idx);
                queue.push_back((key.to_string(), val.clone()));
                self.rebuild_indices(&mut map, &queue);
                return Some(val);
            }
        }
        None
    }

    fn set(&self, key: String, val: DiffEntry) {
        let mut queue = self
            .queue
            .lock()
            .expect("infallible: LRU queue lock should not be poisoned");
        let mut map = self
            .map
            .lock()
            .expect("infallible: LRU map lock should not be poisoned");

        if let Some(&idx) = map.get(&key) {
            queue.remove(idx);
        }

        while queue.len() >= DIFF_CACHE_CAP {
            if let Some((old_key, _)) = queue.pop_front() {
                map.remove(&old_key);
            }
        }

        queue.push_back((key.clone(), val));
        self.rebuild_indices(&mut map, &queue);
    }

    fn invalidate_repo(&self, repo_path: &Path) {
        let mut queue = self
            .queue
            .lock()
            .expect("infallible: LRU queue lock should not be poisoned");
        let mut map = self
            .map
            .lock()
            .expect("infallible: LRU map lock should not be poisoned");
        let prefix = repo_key_prefix(repo_path);
        queue.retain(|(k, _)| !k.starts_with(&prefix));
        self.rebuild_indices(&mut map, &queue);
    }

    fn rebuild_indices(
        &self,
        map: &mut HashMap<String, usize>,
        queue: &VecDeque<(String, DiffEntry)>,
    ) {
        let _ = self;
        map.clear();
        for (i, (key, _)) in queue.iter().enumerate() {
            map.insert(key.clone(), i);
        }
    }
}

static DIFF_CACHE: LazyLock<LruCache> = LazyLock::new(LruCache::new);

/// Get cached worktree diff or compute — fingerprint-checked.
///
/// Only calls `fetch` when fingerprint (mtime+size) disagrees or entry missing.
pub fn get_cached_worktree_diff(
    repo_path: &Path,
    file_path: &str,
    collapse: bool,
    fetch: impl FnOnce() -> anyhow::Result<DiffResult>,
) -> anyhow::Result<DiffResult> {
    let key = diff_cache_key(repo_path, file_path, collapse);
    if let Some(entry) = DIFF_CACHE.get(&key) {
        if capture_diff_input_fingerprint(repo_path, file_path) == entry.fingerprint {
            return Ok(entry.result);
        }
    }
    let fingerprint = capture_diff_input_fingerprint(repo_path, file_path);
    let result = fetch()?;
    DIFF_CACHE.set(
        key,
        DiffEntry {
            result: result.clone(),
            fingerprint,
        },
    );
    Ok(result)
}

/// Invalidate LRU diff cache for a repo.
pub(crate) fn invalidate_file_caches(repo_path: &Path) {
    DIFF_CACHE.invalidate_repo(repo_path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn fetch_with_label(
        computed: Arc<Mutex<Vec<String>>>,
        label: &'static str,
    ) -> impl FnOnce() -> anyhow::Result<DiffResult> {
        move || {
            computed.lock().unwrap().push(label.to_string());
            Ok(DiffResult {
                hunks: vec![],
                truncated: label.is_empty(),
            })
        }
    }

    #[test]
    fn worktree_diff_hits_cache_when_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let file = "a.txt";
        std::fs::write(repo.join(file), "hello").unwrap();
        let computed = Arc::new(Mutex::new(Vec::new()));

        get_cached_worktree_diff(
            repo,
            file,
            true,
            fetch_with_label(computed.clone(), "first"),
        )
        .unwrap();
        get_cached_worktree_diff(
            repo,
            file,
            true,
            fetch_with_label(computed.clone(), "second"),
        )
        .unwrap();

        assert_eq!(
            *computed.lock().unwrap(),
            vec!["first".to_string()],
            "文件未变时第二次调用必须命中缓存（fetch 只执行一次）"
        );
    }

    #[test]
    fn worktree_diff_recomputes_when_file_changed() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let file = "a.txt";
        std::fs::write(repo.join(file), "hello").unwrap();
        let computed = Arc::new(Mutex::new(Vec::new()));

        get_cached_worktree_diff(
            repo,
            file,
            true,
            fetch_with_label(computed.clone(), "hello"),
        )
        .unwrap();
        std::fs::write(repo.join(file), "much longer content").unwrap();
        get_cached_worktree_diff(repo, file, true, fetch_with_label(computed.clone(), "new"))
            .unwrap();

        assert_eq!(
            *computed.lock().unwrap(),
            vec!["hello".to_string(), "new".to_string()],
            "文件已修改时指纹不一致必须重算（回归：旧实现命中旧缓存）"
        );
    }

    #[test]
    fn worktree_diff_recomputes_when_file_removed() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let file = "a.txt";
        let path = repo.join(file);
        std::fs::write(&path, "hello").unwrap();
        let computed = Arc::new(Mutex::new(Vec::new()));

        get_cached_worktree_diff(
            repo,
            file,
            true,
            fetch_with_label(computed.clone(), "exists"),
        )
        .unwrap();
        std::fs::remove_file(&path).unwrap();
        get_cached_worktree_diff(
            repo,
            file,
            true,
            fetch_with_label(computed.clone(), "removed"),
        )
        .unwrap();

        assert_eq!(
            *computed.lock().unwrap(),
            vec!["exists".to_string(), "removed".to_string()],
            "文件被删除后指纹变化（Some→None）必须重算"
        );
    }

    #[test]
    fn worktree_diff_collapse_is_separate_key() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let file = "a.txt";
        std::fs::write(repo.join(file), "hello").unwrap();
        let computed = Arc::new(Mutex::new(Vec::new()));

        get_cached_worktree_diff(
            repo,
            file,
            true,
            fetch_with_label(computed.clone(), "collapsed"),
        )
        .unwrap();
        get_cached_worktree_diff(
            repo,
            file,
            false,
            fetch_with_label(computed.clone(), "full"),
        )
        .unwrap();

        assert_eq!(
            *computed.lock().unwrap(),
            vec!["collapsed".to_string(), "full".to_string()],
            "collapse 不同应各自缓存（键隔离）"
        );
    }

    /// 建一个含一次提交的仓库，`a.txt` 已提交且工作区干净。
    fn init_repo_with_commit(repo_path: &Path) -> Repository {
        let repo = Repository::init(repo_path).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "test").unwrap();
            config.set_str("user.email", "test@test.com").unwrap();
        }
        std::fs::write(repo_path.join("a.txt"), "hello").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = git2::Signature::now("test", "test@test.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
                .unwrap();
        }
        repo
    }

    /// 回归（外部 commit）：HEAD 移动而工作区文件与 index 都没动，命中判据必须
    /// 因 HEAD oid 变化而失效——只比工作区文件指纹会命中 commit 前的旧 diff。
    #[test]
    fn worktree_diff_recomputes_when_head_moves() {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path();
        let repo = init_repo_with_commit(repo_path);
        let computed = Arc::new(Mutex::new(Vec::new()));

        get_cached_worktree_diff(
            repo_path,
            "a.txt",
            true,
            fetch_with_label(computed.clone(), "before"),
        )
        .unwrap();

        // 空 commit：复用父 tree，不写 index、不动 a.txt，只把 HEAD 往前推一格。
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = parent.tree().unwrap();
        let sig = git2::Signature::now("test", "test@test.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "empty", &tree, &[&parent])
            .unwrap();

        get_cached_worktree_diff(
            repo_path,
            "a.txt",
            true,
            fetch_with_label(computed.clone(), "after"),
        )
        .unwrap();

        assert_eq!(
            *computed.lock().unwrap(),
            vec!["before".to_string(), "after".to_string()],
            "HEAD 移动（文件与 index 未动）后必须重算"
        );
    }

    /// index 变化（stage）而工作区文件与 HEAD 未动时，命中判据也必须失效。
    #[test]
    fn worktree_diff_recomputes_when_index_changes() {
        let dir = tempfile::tempdir().unwrap();
        let repo_path = dir.path();
        let repo = init_repo_with_commit(repo_path);
        let computed = Arc::new(Mutex::new(Vec::new()));

        get_cached_worktree_diff(
            repo_path,
            "a.txt",
            true,
            fetch_with_label(computed.clone(), "before"),
        )
        .unwrap();

        // 只 stage 一个新文件：a.txt 未动、HEAD 未动，只有 index 变化。
        std::fs::write(repo_path.join("b.txt"), "b").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("b.txt")).unwrap();
            index.write().unwrap();
        }

        get_cached_worktree_diff(
            repo_path,
            "a.txt",
            true,
            fetch_with_label(computed.clone(), "after"),
        )
        .unwrap();

        assert_eq!(
            *computed.lock().unwrap(),
            vec!["before".to_string(), "after".to_string()],
            "index 变化后必须重算"
        );
    }
}
