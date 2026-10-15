//! 批 1 读路径夹具测试（八类）。
//!
//! 真值来源是真实仓库的 index unmerged 条目 —— **不 mock index**。夹具路径一律由
//! `tempdir()` 推导（红线 13），仓库配置钉死换行语义（红线 11：`core.autocrlf=false` +
//! `.gitattributes * -text`）。
//!
//! 每条用例都在**两条 transport**上跑：`ExecTarget::Local`（走 git2 → `local::read`）与
//! [`ShellLocalTransport`]（`open_repo_async` 恒 `None` → 走 `shell::read`），断言两者同契约。

use std::path::Path;

use crate::common::executor::factory::ExecTarget;
use crate::common::git::operations::read_conflict_stages;
use crate::common::git::transport::GitTransport;
use crate::common::git::{ConflictKind, ConflictStages};
use anyhow::Result;
use async_trait::async_trait;

/// 走真实 git 进程、但 `open_repo_async` 恒返回 `None` 的 transport：强制走 shell 分支。
struct ShellLocalTransport;

#[async_trait]
impl GitTransport for ShellLocalTransport {
    async fn run_git(&self, args: &[&str], work_dir: &str) -> Result<String> {
        ExecTarget::Local.run_git(args, work_dir).await
    }

    async fn run_git_opts(
        &self,
        args: &[&str],
        work_dir: &str,
        opts: crate::common::git::transport::GitExecOptions<'_>,
    ) -> Result<String> {
        ExecTarget::Local.run_git_opts(args, work_dir, opts).await
    }

    async fn run_git_with_stdin(
        &self,
        args: &[&str],
        work_dir: &str,
        opts: crate::common::git::transport::GitExecOptions<'_>,
        stdin: &[u8],
    ) -> Result<String> {
        ExecTarget::Local
            .run_git_with_stdin(args, work_dir, opts, stdin)
            .await
    }

    fn open_repo(&self, _path: &str) -> Option<git2::Repository> {
        None
    }

    async fn open_repo_async(&self, _path: &str) -> Option<git2::Repository> {
        None
    }

    fn exec_target(&self) -> ExecTarget {
        ExecTarget::Local
    }

    async fn is_git_repo(&self, _path: &str) -> bool {
        true
    }
}

/// 在测试中执行本地 git 命令并断言成功（红线上：只读/写夹具走统一执行接口）。
async fn git(dir: &Path, args: &[&str]) {
    let out = crate::core::exec::collect(
        &ExecTarget::Local,
        "git",
        args,
        Some(&dir.to_string_lossy()),
    )
    .await
    .expect("spawn git");
    assert!(
        out.exit_code == 0,
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

/// 执行 git 并允许非零退出（merge 冲突是预期失败）。
async fn git_allow_fail(dir: &Path, args: &[&str]) {
    let _ = crate::core::exec::collect(
        &ExecTarget::Local,
        "git",
        args,
        Some(&dir.to_string_lossy()),
    )
    .await
    .expect("spawn git");
}

fn write(dir: &Path, rel: &str, content: &[u8]) {
    let full = dir.join(rel);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(full, content).expect("write fixture");
}

/// 初始化确定性临时仓库（含一个 base 提交）。
async fn init_repo(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    let p = dir.path();
    git(p, &["init", "-q", "-b", "main"]).await;
    git(p, &["config", "user.email", "t@t"]).await;
    git(p, &["config", "user.name", "t"]).await;
    git(p, &["config", "core.autocrlf", "false"]).await;
    write(p, ".gitattributes", b"* -text\n");
    for (rel, content) in files {
        write(p, rel, content);
    }
    git(p, &["add", "-A"]).await;
    git(p, &["commit", "-qm", "base"]).await;
    dir
}

fn work_dir(dir: &tempfile::TempDir) -> String {
    dir.path().to_string_lossy().to_string()
}

/// 两条 transport 都必须给出同样契约的读结果。
async fn read_both(dir: &tempfile::TempDir, path: &str) -> (ConflictStages, ConflictStages) {
    let wd = work_dir(dir);
    let local = read_conflict_stages(&ExecTarget::Local, &wd, path)
        .await
        .expect("local read");
    let shell = read_conflict_stages(&ShellLocalTransport, &wd, path)
        .await
        .expect("shell read");
    assert_eq!(local, shell, "local 与 shell 读路径必须同契约");
    (local, shell)
}

/// 构造 `ours` / `theirs` 两分支对同一文件的冲突合并。
async fn make_uulike(dir: &tempfile::TempDir, rel: &str, ours: &[u8], theirs: &[u8]) {
    let p = dir.path();
    git(p, &["checkout", "-qb", "other"]).await;
    write(p, rel, theirs);
    git(p, &["add", "-A"]).await;
    git(p, &["commit", "-qm", "theirs"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    write(p, rel, ours);
    git(p, &["add", "-A"]).await;
    git(p, &["commit", "-qm", "ours"]).await;
    git_allow_fail(p, &["merge", "other"]).await;
}

// ── 1. UU：双方改同文件 ────────────────────────────────────────────────────

#[tokio::test]
async fn uu_both_modified_has_three_sides_and_regions_without_markers() {
    let dir = init_repo(&[("f.txt", b"line1\nline2\nline3\n")]).await;
    make_uulike(
        &dir,
        "f.txt",
        b"line1\nours\nline3\n",
        b"line1\ntheirs\nline3\n",
    )
    .await;

    let (stages, _) = read_both(&dir, "f.txt").await;
    assert_eq!(stages.kind, ConflictKind::BothModified);
    assert!(stages.ancestor.is_some());
    assert!(stages.ours.is_some());
    assert!(stages.theirs.is_some());
    assert!(!stages.regions.is_empty(), "UU 必须有区域");
    // 三侧内容真值来自 stage blob，绝不含工作区 marker（未解决的 conflict 标记不是内容）。
    for side in [&stages.ancestor, &stages.ours, &stages.theirs]
        .into_iter()
        .flatten()
    {
        if let Some(content) = side.content.as_deref() {
            assert!(
                !content.contains("<<<<<<<"),
                "side 不得含 marker: {content:?}"
            );
            assert!(
                !content.contains(">>>>>>>"),
                "side 不得含 marker: {content:?}"
            );
        }
    }
    assert_eq!(
        stages.ours.as_ref().and_then(|s| s.content.as_deref()),
        Some("line1\nours\nline3\n")
    );
}

// ── 2. AA：双方各自新增同名（无 base）─────────────────────────────────────

#[tokio::test]
async fn aa_both_added_has_no_ancestor_and_regions() {
    let dir = init_repo(&[("seed.txt", b"seed\n")]).await;
    let p = dir.path();
    git(p, &["checkout", "-qb", "other"]).await;
    write(p, "newf.txt", b"theirs\n");
    git(p, &["add", "newf.txt"]).await;
    git(p, &["commit", "-qm", "add-theirs"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    write(p, "newf.txt", b"ours\n");
    git(p, &["add", "newf.txt"]).await;
    git(p, &["commit", "-qm", "add-ours"]).await;
    git_allow_fail(p, &["merge", "other"]).await;

    let (stages, _) = read_both(&dir, "newf.txt").await;
    assert_eq!(stages.kind, ConflictKind::BothAdded);
    assert!(stages.ancestor.is_none(), "AA 无 base stage");
    assert!(stages.ours.is_some() && stages.theirs.is_some());
    assert!(!stages.regions.is_empty(), "AA 用空 base 也能产出区域");
}

// ── 3. DU：我方删 / 对方改（缺 ours）─────────────────────────────────────

#[tokio::test]
async fn du_modify_delete_missing_ours_is_null_and_no_regions() {
    let dir = init_repo(&[("c.txt", b"base\n")]).await;
    let p = dir.path();
    git(p, &["checkout", "-qb", "other"]).await;
    write(p, "c.txt", b"theirs\n");
    git(p, &["commit", "-qam", "theirs-mod"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    git(p, &["rm", "-q", "c.txt"]).await;
    git(p, &["commit", "-qm", "ours-del"]).await;
    git_allow_fail(p, &["merge", "other"]).await;

    let (stages, _) = read_both(&dir, "c.txt").await;
    assert_eq!(stages.kind, ConflictKind::ModifyDelete);
    assert!(stages.ours.is_none(), "DU 缺 ours → None（绝不归一为空串）");
    assert!(stages.theirs.is_some());
    assert!(stages.regions.is_empty(), "删除不是内容，不做区域合并");
}

// ── 4. UD：我方改 / 对方删（缺 theirs）───────────────────────────────────

#[tokio::test]
async fn ud_modify_delete_missing_theirs_is_null_and_no_regions() {
    let dir = init_repo(&[("c.txt", b"base\n")]).await;
    let p = dir.path();
    git(p, &["checkout", "-qb", "other"]).await;
    git(p, &["rm", "-q", "c.txt"]).await;
    git(p, &["commit", "-qm", "theirs-del"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    write(p, "c.txt", b"ours\n");
    git(p, &["commit", "-qam", "ours-mod"]).await;
    git_allow_fail(p, &["merge", "other"]).await;

    let (stages, _) = read_both(&dir, "c.txt").await;
    assert_eq!(stages.kind, ConflictKind::ModifyDelete);
    assert!(stages.theirs.is_none(), "UD 缺 theirs → None");
    assert!(stages.ours.is_some());
    assert!(stages.regions.is_empty());
}

// ── 5. rename/rename：三侧路径各不相同，不可区域合并 ─────────────────────

#[tokio::test]
async fn rename_rename_has_three_distinct_paths_and_no_regions() {
    let dir = init_repo(&[("a.txt", b"a\n")]).await;
    let p = dir.path();
    git(p, &["checkout", "-qb", "other"]).await;
    git(p, &["mv", "a.txt", "z.txt"]).await;
    git(p, &["commit", "-qm", "ren-other"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    git(p, &["mv", "a.txt", "c.txt"]).await;
    git(p, &["commit", "-qm", "ren-main"]).await;
    git_allow_fail(p, &["merge", "other"]).await;

    let (stages, _) = read_both(&dir, "a.txt").await;
    assert_eq!(stages.kind, ConflictKind::RenameRename);
    let paths: Vec<Option<&str>> = [
        stages.ancestor.as_ref(),
        stages.ours.as_ref(),
        stages.theirs.as_ref(),
    ]
    .into_iter()
    .map(|s| s.and_then(|s| s.path.as_deref()))
    .collect();
    assert_eq!(
        paths,
        vec![Some("a.txt"), Some("c.txt"), Some("z.txt")],
        "rename/rename 三侧路径必须各不相同"
    );
    assert!(stages.regions.is_empty());

    // 三侧中任一路径都可定位到本冲突（入口按变更列表 path 打开）。
    for path in ["a.txt", "c.txt", "z.txt"] {
        let (s, _) = read_both(&dir, path).await;
        assert_eq!(s.kind, ConflictKind::RenameRename, "path={path}");
    }
}

// ── 6. binary：不可文本合并，三侧不解码 ──────────────────────────────────

#[tokio::test]
async fn binary_conflict_has_no_decoded_content() {
    let dir = init_repo(&[("b.bin", b"\x00\x01BINbase")]).await;
    make_uulike(&dir, "b.bin", b"\x00\x01BINours", b"\x00\x01BINtheirs").await;

    let (stages, _) = read_both(&dir, "b.bin").await;
    assert_eq!(stages.kind, ConflictKind::Binary);
    for side in [&stages.ancestor, &stages.ours, &stages.theirs]
        .into_iter()
        .flatten()
    {
        assert!(side.is_binary);
        assert!(side.content.is_none(), "binary 侧不得解码内容");
    }
    assert!(stages.regions.is_empty());
}

// ── 7. 已解决（stage 0）→ Err ─────────────────────────────────────────────

#[tokio::test]
async fn resolved_path_returns_err_not_empty_conflict() {
    let dir = init_repo(&[("f.txt", b"clean\n")]).await;
    let wd = work_dir(&dir);
    assert!(
        read_conflict_stages(&ExecTarget::Local, &wd, "f.txt")
            .await
            .is_err(),
        "无 unmerged 条目 → Err（调用方回退普通 diff）"
    );
    assert!(read_conflict_stages(&ShellLocalTransport, &wd, "f.txt")
        .await
        .is_err());
}

// ── 8. 三元载荷：三侧各 ~900KB → 序列化 ≤ 2MB ────────────────────────────

#[tokio::test]
async fn three_sides_near_900kb_serialize_under_ipc_limit() {
    let big = |tag: &str| format!("{tag}{}\n", "a".repeat(100_000)).repeat(9);
    let base = big("b");
    let ours = big("o");
    let theirs = big("t");
    let dir = init_repo(&[("big.txt", base.as_bytes())]).await;
    make_uulike(&dir, "big.txt", ours.as_bytes(), theirs.as_bytes()).await;

    let (stages, _) = read_both(&dir, "big.txt").await;
    assert_eq!(stages.kind, ConflictKind::BothModified);
    let bytes = serde_json::to_vec(&stages).expect("serialize").len();
    assert!(
        bytes <= 2_000_000,
        "三侧各 ~900KB 的载荷序列化必须 ≤ 2MB，got {bytes}"
    );
}

// ── 9. cherry-pick（无 MERGE_HEAD）也走同一 rename 归组 ───────────────────
//
// 回归：`shell.rs::other_commit` 曾用 `.ok()?` 逐个探测 `MERGE_HEAD` / `CHERRY_PICK_HEAD` /
// `REVERT_HEAD` —— 第一个 ref 不存在时 `rev-parse --verify --quiet` 非零退出（`Err`），`?`
// 直接返回 `None`，于是 cherry-pick / revert 场景永远取不到另一侧 → 重命名映射为空 →
// rename/rename 退化成 modify_delete（两 transport 分叉）。

#[tokio::test]
async fn cherry_pick_rename_rename_stays_rename_rename_on_both_transports() {
    let dir = init_repo(&[("a.txt", b"a\n")]).await;
    let p = dir.path();
    git(p, &["checkout", "-qb", "other"]).await;
    git(p, &["mv", "a.txt", "z.txt"]).await;
    git(p, &["commit", "-qm", "ren-other"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    git(p, &["mv", "a.txt", "c.txt"]).await;
    git(p, &["commit", "-qm", "ren-main"]).await;
    // cherry-pick 只写 CHERRY_PICK_HEAD（无 MERGE_HEAD）—— 正是回归点。
    git_allow_fail(p, &["cherry-pick", "other"]).await;

    let (stages, _) = read_both(&dir, "a.txt").await;
    assert_eq!(stages.kind, ConflictKind::RenameRename);
    assert_eq!(
        stages.ours.as_ref().and_then(|s| s.path.as_deref()),
        Some("c.txt")
    );
    assert_eq!(
        stages.theirs.as_ref().and_then(|s| s.path.as_deref()),
        Some("z.txt")
    );
}

// ── 10. 非 UTF-8 字节：两 transport 的 size / content 必须一致 ──────────────
//
// 回归：shell 版 `ConflictSide.size` 曾用 lossy `String` 长度（`run_git` 只返回 `String`），
// 而 local（git2 原始字节）报原始长度 —— 同一个含非法 UTF-8 的文件在两条 transport 上报出
// 不同 `size`（实测 `\x00\xff\x01` 侧 local=7 / shell=9）。已修正：shell 另经
// `git cat-file -s <oid>` 取原始字节数，与 local 的 `blob.content().len()` 同口径。

#[tokio::test]
async fn non_utf8_text_content_and_size_match_across_transports() {
    let dir = init_repo(&[("t.txt", b"line\xff\n")]).await;
    make_uulike(&dir, "t.txt", b"ours\xff\n", b"theirs\xff\n").await;

    let (stages, _) = read_both(&dir, "t.txt").await;
    assert_eq!(stages.kind, ConflictKind::BothModified);
    assert!(
        !stages.ours.as_ref().expect("ours").is_binary,
        "无 NUL 的非法 UTF-8 不是二进制"
    );
}

#[tokio::test]
async fn non_utf8_binary_size_matches_across_transports() {
    let dir = init_repo(&[("b2.bin", b"\x00\xff\x01base")]).await;
    make_uulike(&dir, "b2.bin", b"\x00\xff\x01ours", b"\x00\xff\x01theirs").await;

    // read_both 内部 assert_eq!(local, shell) —— size 分叉会让它红。
    let (stages, _) = read_both(&dir, "b2.bin").await;
    assert_eq!(stages.kind, ConflictKind::Binary);
}

/// 惰性重命名映射不得改变分类结论（端到端钉子）。
///
/// 仓库里**确实存在重命名**（`diff -M <merge-base> HEAD` 非空 ⇒ `rename_maps` 若被调用会返回
/// 非空映射），而 UU 冲突文件 `f.txt` 三侧同路径 ⇒ 走惰性跳过分支。两条路径必须给出同一结论：
/// 「少跑一次全仓 tree diff」不得换来静默误判。
///
/// 变异验证：把 `probe::needs_rename_maps` 改成恒 `true`（永远算映射）本条仍须绿 ——
/// 说明跳过与否不影响语义；改成恒 `false` 则 rename/rename 用例红（见
/// `rename_rename_has_three_distinct_paths_and_no_regions`）。
#[tokio::test]
async fn lazy_rename_maps_do_not_change_classification_when_repo_has_renames() {
    let dir = init_repo(&[("f.txt", b"line1\nline2\n"), ("a.txt", b"same-bytes\n")]).await;
    let p = dir.path();
    // other 侧只改 f.txt（制造 UU）。
    git(p, &["checkout", "-qb", "other"]).await;
    write(p, "f.txt", b"line1\ntheirs\n");
    git(p, &["commit", "-qam", "theirs"]).await;
    // main 侧改 f.txt（UU）+ 重命名 a.txt → b.txt（内容不变 ⇒ `-M` 必配对成 R100）。
    git(p, &["checkout", "-q", "main"]).await;
    write(p, "f.txt", b"line1\nours\n");
    git(p, &["mv", "a.txt", "b.txt"]).await;
    git(p, &["commit", "-qam", "ours"]).await;
    git_allow_fail(p, &["merge", "other"]).await;

    // 前提取证：本仓库的重命名映射**非空**（否则这条用例测不到「跳过 vs 计算」的差异）。
    let base = crate::core::exec::collect(
        &ExecTarget::Local,
        "git",
        &["merge-base", "HEAD", "other"],
        Some(&work_dir(&dir)),
    )
    .await
    .expect("spawn git");
    assert_eq!(base.exit_code, 0);
    let base_oid = String::from_utf8_lossy(&base.stdout).trim().to_string();
    let renamed = crate::core::exec::collect(
        &ExecTarget::Local,
        "git",
        &["diff", "--name-status", "-M", &base_oid, "HEAD"],
        Some(&work_dir(&dir)),
    )
    .await
    .expect("spawn git");
    let renamed_text = String::from_utf8_lossy(&renamed.stdout).to_string();
    assert!(
        renamed_text.lines().any(|l| l.starts_with('R')),
        "夹具前提：`diff -M` 必须检出重命名（实测输出 `{renamed_text}`），否则本条测不到差异"
    );

    // 惰性跳过分支上的 UU：三侧齐备、区域非空、可区域合并（与「算映射」路径同结论）。
    let (stages, _) = read_both(&dir, "f.txt").await;
    assert_eq!(stages.kind, ConflictKind::BothModified);
    assert!(stages.region_mergeable);
    assert!(!stages.regions.is_empty(), "UU 必须有区域");
    assert!(stages.ancestor.is_some() && stages.ours.is_some() && stages.theirs.is_some());
}

// ══════════════════════════════════════════════════════════════════════════════
// 批 3 · 决议写回（Layer 2）—— 删除侧四条分支 + binary + rename/rename + 区域 splice
// ══════════════════════════════════════════════════════════════════════════════

use crate::common::git::operations::apply_conflict_resolution;
use crate::common::git::{ConflictResolution, RegionTake, TakeSide};

/// 在 `dir` 里跑 git 并返回 stdout（trim 后）。
async fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = crate::core::exec::collect(
        &ExecTarget::Local,
        "git",
        args,
        Some(&dir.to_string_lossy()),
    )
    .await
    .expect("spawn git");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// `git ls-files -u -- <path>` 的条目数（0 = 该 path 已退出 unmerged）。
async fn unmerged_count(dir: &Path, path: &str) -> usize {
    let out = git_out(dir, &["ls-files", "-u", "--", path]).await;
    if out.is_empty() {
        0
    } else {
        out.lines().count()
    }
}

/// `git status --porcelain -- <path>`（逐例不同，见 PRD AC 表）。
async fn porcelain(dir: &Path, path: &str) -> String {
    git_out(dir, &["status", "--porcelain", "--", path]).await
}

/// 工作区字节（原始，不做换行归一 —— binary 用）。
fn worktree_bytes(dir: &Path, path: &str) -> Option<Vec<u8>> {
    std::fs::read(dir.join(path)).ok()
}

/// 工作区文本（行尾无关：`\r\n` → `\n`，红线 11）。文本决议一律用它断言。
fn worktree_text(dir: &Path, path: &str) -> Option<String> {
    worktree_bytes(dir, path).map(|b| String::from_utf8_lossy(&b).replace("\r\n", "\n"))
}

/// 造 UU 冲突（双方改同文件，三侧同路径）。
async fn make_uu(dir: &tempfile::TempDir, path: &str, base: &[u8], ours: &[u8], theirs: &[u8]) {
    let p = dir.path();
    write(p, path, base);
    git(p, &["add", "-A"]).await;
    git(p, &["commit", "-qm", "base"]).await;
    git(p, &["checkout", "-qb", "other"]).await;
    write(p, path, theirs);
    git(p, &["commit", "-qam", "theirs"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    write(p, path, ours);
    git(p, &["commit", "-qam", "ours"]).await;
    git_allow_fail(p, &["merge", "other"]).await;
}

/// 造 DU 冲突（我方删、对方改）。
async fn make_du(dir: &tempfile::TempDir, path: &str, base: &[u8], theirs: &[u8]) {
    let p = dir.path();
    write(p, path, base);
    git(p, &["add", "-A"]).await;
    git(p, &["commit", "-qm", "base"]).await;
    git(p, &["checkout", "-qb", "other"]).await;
    write(p, path, theirs);
    git(p, &["commit", "-qam", "theirs"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    git(p, &["rm", "-q", path]).await;
    git(p, &["commit", "-qm", "ours-del"]).await;
    git_allow_fail(p, &["merge", "other"]).await;
}

/// 造 UD 冲突（我方改、对方删）。
async fn make_ud(dir: &tempfile::TempDir, path: &str, base: &[u8], ours: &[u8]) {
    let p = dir.path();
    write(p, path, base);
    git(p, &["add", "-A"]).await;
    git(p, &["commit", "-qm", "base"]).await;
    git(p, &["checkout", "-qb", "other"]).await;
    git(p, &["rm", "-q", path]).await;
    git(p, &["commit", "-qm", "theirs-del"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    write(p, path, ours);
    git(p, &["commit", "-qam", "ours"]).await;
    git_allow_fail(p, &["merge", "other"]).await;
}

// ── DU：采用对方（存在侧）→ 写 stage 3 内容 + porcelain `A  c.txt` ──────────────
#[tokio::test]
async fn du_take_theirs_writes_stage3_and_porcelain_is_added() {
    let dir = init_repo(&[]).await;
    make_du(&dir, "c.txt", b"base\n", b"theirs\n").await;
    let p = dir.path();
    let wd = work_dir(&dir);

    apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "c.txt",
        ConflictResolution::WholeFile {
            take: TakeSide::Theirs,
        },
    )
    .await
    .expect("resolve DU take theirs");

    assert_eq!(unmerged_count(p, "c.txt").await, 0, "unmerged 必须退出");
    assert_eq!(porcelain(p, "c.txt").await, "A  c.txt");
    assert_eq!(
        worktree_text(p, "c.txt").as_deref(),
        Some("theirs\n"),
        "工作区 = stage 3 内容"
    );
}

// ── DU：采用我方（删除侧）→ 文件不存在 + porcelain 空 ────────────────────────────
#[tokio::test]
async fn du_take_ours_deletes_file_and_porcelain_is_empty() {
    let dir = init_repo(&[]).await;
    make_du(&dir, "c.txt", b"base\n", b"theirs\n").await;
    let p = dir.path();
    let wd = work_dir(&dir);

    apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "c.txt",
        ConflictResolution::WholeFile {
            take: TakeSide::Ours,
        },
    )
    .await
    .expect("resolve DU take ours");

    assert_eq!(unmerged_count(p, "c.txt").await, 0);
    assert_eq!(porcelain(p, "c.txt").await, "", "两侧均无此文件 → 净无变更");
    assert!(
        worktree_bytes(p, "c.txt").is_none(),
        "采用删除侧 → 文件必须不存在（不是空文件）"
    );
}

// ── UD：采用我方（存在侧）→ 写 stage 2 内容 + porcelain 空 ──────────────────────
#[tokio::test]
async fn ud_take_ours_writes_stage2_and_porcelain_is_empty() {
    let dir = init_repo(&[]).await;
    make_ud(&dir, "c.txt", b"base\n", b"ours\n").await;
    let p = dir.path();
    let wd = work_dir(&dir);

    apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "c.txt",
        ConflictResolution::WholeFile {
            take: TakeSide::Ours,
        },
    )
    .await
    .expect("resolve UD take ours");

    assert_eq!(unmerged_count(p, "c.txt").await, 0);
    assert_eq!(porcelain(p, "c.txt").await, "", "内容 = HEAD → 无变更");
    assert_eq!(
        worktree_text(p, "c.txt").as_deref(),
        Some("ours\n"),
        "工作区 = stage 2 内容"
    );
}

// ── UD：采用对方（删除侧）→ 文件不存在 + porcelain `D  c.txt` ────────────────────
#[tokio::test]
async fn ud_take_theirs_deletes_file_and_porcelain_is_deleted() {
    let dir = init_repo(&[]).await;
    make_ud(&dir, "c.txt", b"base\n", b"ours\n").await;
    let p = dir.path();
    let wd = work_dir(&dir);

    apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "c.txt",
        ConflictResolution::WholeFile {
            take: TakeSide::Theirs,
        },
    )
    .await
    .expect("resolve UD take theirs");

    assert_eq!(unmerged_count(p, "c.txt").await, 0);
    assert_eq!(
        porcelain(p, "c.txt").await,
        "D  c.txt",
        "从 HEAD 存在 → 删除"
    );
    assert!(worktree_bytes(p, "c.txt").is_none());
}

// ── UU：整文件二选一（region_mergeable 为真时同样可达，PRD AC 表要求）────────────
#[tokio::test]
async fn uu_whole_file_take_theirs_writes_stage3_and_clears_unmerged() {
    let dir = init_repo(&[]).await;
    make_uu(
        &dir,
        "f.txt",
        b"a\nbase\nc\n",
        b"a\nours\nc\n",
        b"a\ntheirs\nc\n",
    )
    .await;
    let p = dir.path();
    let wd = work_dir(&dir);

    // 前提：UU 可区域合并，但整文件决议仍应可达。
    let (stages, _) = read_both(&dir, "f.txt").await;
    assert!(stages.region_mergeable);

    apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "f.txt",
        ConflictResolution::WholeFile {
            take: TakeSide::Theirs,
        },
    )
    .await
    .expect("UU whole-file take theirs");

    assert_eq!(unmerged_count(p, "f.txt").await, 0);
    assert_eq!(
        worktree_text(p, "f.txt").as_deref(),
        Some("a\ntheirs\nc\n"),
        "工作区 = stage 3 整文件内容"
    );
}

// ── binary：采用存在侧不得删文件（T18 回归钉子）────────────────────────────────
#[tokio::test]
async fn binary_take_theirs_keeps_file_with_raw_stage3_bytes() {
    // 变异验证：把分派判据从 `side_of(take).is_some()` 改回 `content.is_some()`，
    // 本用例必须变红（binary 侧 content=None → 会被误判成删除侧）。
    let dir = init_repo(&[]).await;
    make_uu(
        &dir,
        "b.bin",
        b"\x00\x01BASE",
        b"\x00\x01OURS",
        b"\x00\x01THEIRS",
    )
    .await;
    let p = dir.path();
    let wd = work_dir(&dir);

    // 前提：读路径把它判成 binary 且 content 不解码。
    let (stages, _) = read_both(&dir, "b.bin").await;
    assert_eq!(stages.kind, ConflictKind::Binary);
    assert!(
        stages.theirs.as_ref().is_some_and(|s| s.content.is_none()),
        "夹具前提：binary 侧 stage 存在但 content 为 None"
    );

    apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "b.bin",
        ConflictResolution::WholeFile {
            take: TakeSide::Theirs,
        },
    )
    .await
    .expect("resolve binary take theirs");

    assert_eq!(unmerged_count(p, "b.bin").await, 0);
    let bytes = worktree_bytes(p, "b.bin").expect("binary 文件必须仍存在（不得被误删）");
    assert_eq!(bytes, b"\x00\x01THEIRS", "工作区 = stage 3 原始字节");
}

// ── UU：区域决议必须覆盖全部区域（全函数）────────────────────────────────
#[tokio::test]
async fn uu_region_resolution_splices_all_regions_and_clears_unmerged() {
    let dir = init_repo(&[]).await;
    // 造一个含两个冲突区域的 UU：行 1 与行 3 各自冲突。
    make_uu(
        &dir,
        "f.txt",
        b"a\nbase1\nb\nbase2\nc\n",
        b"a\nour1\nb\nour2\nc\n",
        b"a\ntheir1\nb\ntheir2\nc\n",
    )
    .await;
    let p = dir.path();
    let wd = work_dir(&dir);

    let (stages, _) = read_both(&dir, "f.txt").await;
    assert!(stages.region_mergeable);
    assert_eq!(stages.regions.len(), 2, "夹具前提：两个区域");

    // 全部区域一次决议：区 0 取我方、区 1 取对方。
    apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "f.txt",
        ConflictResolution::Regions {
            decisions: vec![(0, RegionTake::Ours), (1, RegionTake::Theirs)],
        },
    )
    .await
    .expect("resolve both UU regions");

    assert_eq!(
        unmerged_count(p, "f.txt").await,
        0,
        "写回后 unmerged 必须退出"
    );
    let text = worktree_text(p, "f.txt").expect("file exists");
    assert!(text.contains("our1") && text.contains("their2"));
    assert!(!text.contains("their1") && !text.contains("our2"));
    assert!(!text.contains("<<<<<<<"), "全部决议后不得再留 marker");
}

// ── 反证：未覆盖全部区域 / 未知 id 必须显式拒绝（不得把带 marker 的文件标成已解决）──
#[tokio::test]
async fn partial_or_stale_region_decisions_are_rejected_not_silently_resolved() {
    let dir = init_repo(&[]).await;
    make_uu(
        &dir,
        "f.txt",
        b"a\nbase1\nb\nbase2\nc\n",
        b"a\nour1\nb\nour2\nc\n",
        b"a\ntheir1\nb\ntheir2\nc\n",
    )
    .await;
    let p = dir.path();
    let wd = work_dir(&dir);

    // 只决议区 0：不得放行（否则 `git add` 会把含 marker 的文件标成已解决）。
    let err = apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "f.txt",
        ConflictResolution::Regions {
            decisions: vec![(0, RegionTake::Ours)],
        },
    )
    .await
    .expect_err("部分决议必须被拒");
    assert!(err.to_string().contains("every region"), "{err}");
    assert_eq!(
        unmerged_count(p, "f.txt").await,
        3,
        "被拒后不得改动 index（UU 仍有 3 条 unmerged stage）"
    );

    // 未知 id（前端视图陈旧）：同样拒绝。
    let err = apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "f.txt",
        ConflictResolution::Regions {
            decisions: vec![(0, RegionTake::Ours), (99, RegionTake::Theirs)],
        },
    )
    .await
    .expect_err("未知 region id 必须被拒");
    assert!(err.to_string().contains("unknown region id 99"), "{err}");
    assert_eq!(unmerged_count(p, "f.txt").await, 3);
}

// ── 显式拒绝：不可区域合并的 kind 收到 Regions 决议 ──────────────────────────────
#[tokio::test]
async fn region_resolution_on_modify_delete_is_rejected() {
    let dir = init_repo(&[]).await;
    make_du(&dir, "c.txt", b"base\n", b"theirs\n").await;
    let wd = work_dir(&dir);

    let err = apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "c.txt",
        ConflictResolution::Regions {
            decisions: vec![(0, RegionTake::Ours)],
        },
    )
    .await
    .expect_err("modify_delete 不可区域合并 → 必须报错");
    assert!(
        err.to_string().contains("region-level resolution"),
        "错误必须指名不适用，得到：{err}"
    );
}

// ── 显式拒绝：binary + Regions ──────────────────────────────────────────────────
#[tokio::test]
async fn region_resolution_on_binary_is_rejected() {
    let dir = init_repo(&[]).await;
    make_uu(&dir, "b.bin", b"\x00BASE", b"\x00OURS", b"\x00THEIRS").await;
    let wd = work_dir(&dir);

    let err = apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "b.bin",
        ConflictResolution::Regions {
            decisions: vec![(0, RegionTake::Theirs)],
        },
    )
    .await
    .expect_err("binary 不可区域合并 → 必须报错");
    assert!(err.to_string().contains("region-level resolution"), "{err}");
}

// ── 显式拒绝：rename/rename + WholeFile（T19 非目标）────────────────────────────
#[tokio::test]
async fn rename_rename_whole_file_resolution_is_rejected() {
    let dir = init_repo(&[("a.txt", b"a\n")]).await;
    let p = dir.path();
    git(p, &["checkout", "-qb", "other"]).await;
    git(p, &["mv", "a.txt", "z.txt"]).await;
    git(p, &["commit", "-qm", "ren-other"]).await;
    git(p, &["checkout", "-q", "main"]).await;
    git(p, &["mv", "a.txt", "c.txt"]).await;
    git(p, &["commit", "-qm", "ren-main"]).await;
    git_allow_fail(p, &["merge", "other"]).await;
    let wd = work_dir(&dir);

    let err = apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "a.txt",
        ConflictResolution::WholeFile {
            take: TakeSide::Ours,
        },
    )
    .await
    .expect_err("rename/rename 决议非目标 → 必须报错");
    assert!(err.to_string().contains("rename/rename"), "{err}");
}

// ── 写后语义：git diff HEAD 不再是冲突态 ────────────────────────────────────────
#[tokio::test]
async fn resolved_file_has_normal_diff_semantics() {
    let dir = init_repo(&[]).await;
    make_du(&dir, "c.txt", b"base\n", b"theirs\n").await;
    let p = dir.path();
    let wd = work_dir(&dir);

    apply_conflict_resolution(
        &ExecTarget::Local,
        &wd,
        "c.txt",
        ConflictResolution::WholeFile {
            take: TakeSide::Theirs,
        },
    )
    .await
    .expect("resolve");

    // 写后 `git diff HEAD -- c.txt` 应正常显示新增，而不是 `--cc` 合并格式。
    let diff = git_out(p, &["diff", "HEAD", "--", "c.txt"]).await;
    assert!(
        diff.contains("+theirs"),
        "普通 diff 应显示新增行，得到：{diff}"
    );
    assert!(!diff.contains("@@@"), "不得再是冲突合并格式");
}
