//! Generic key-value cache over the shared `neeko.db` pool.
//!
//! The store understands `namespace`, `key`, `value`, `version` and `at` and
//! nothing else. `value` is opaque TEXT: callers serialise and validate their
//! own payloads, so adding a consumer to the cache never means changing the
//! schema or this file.

use anyhow::Result;
use rusqlite::{params, Connection};

/// Bind-variable limit per statement.
///
/// Older SQLite builds cap at 999; the bundled one allows 32766. Taking the low
/// figure means the chunking below is never the thing that decides whether this
/// works — but note the honest status: with the bundled SQLite, 5000 keys fit in
/// a single statement, so the chunk loop is defence in depth, not a fix for an
/// observed failure. It costs one `chunks()` call and buys immunity to a
/// `SQLITE_MAX_VARIABLE_NUMBER` we do not control.
const SQLITE_MAX_PARAMS: usize = 900;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::common::db::DbPool;

/// Facade over the `cache_entries` table.
pub struct CacheStore {
    pool: DbPool,
}

impl CacheStore {
    /// Wrap the shared pool.
    ///
    /// The pool is shared with `LibraryStore` — one pool per database file.
    ///
    /// **Precondition**: the caller must have run the migration chain on this
    /// pool (`LibraryStore::with_pool` does it, and is where the pool normally
    /// comes from). Without it the table does not exist and every cache command
    /// fails with `no such table: cache_entries`.
    #[must_use]
    pub const fn with_pool(pool: DbPool) -> Self {
        Self { pool }
    }

    /// The shared pool, so callers can prove they injected the same one.
    #[must_use]
    pub const fn pool(&self) -> &DbPool {
        &self.pool
    }

    /// Read the entries for `keys` in `namespace` at payload `version`.
    ///
    /// Unknown keys are simply absent from the result; a cache miss is not an
    /// error.
    ///
    /// `version` is part of the filter, not decoration: rows written under a
    /// different payload version are invisible. Bumping the version therefore
    /// invalidates the namespace without a migration or a delete — which is the
    /// whole point of carrying the column alongside the value.
    pub fn get_many(
        &self,
        namespace: &str,
        keys: &[String],
        version: i64,
    ) -> Result<Vec<(String, String)>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.pool.get()?;
        // One statement for the whole batch. The front end loads a namespace by
        // asking for up to `maxEntries` keys at once (5000 by default), so a
        // `query_row` per key would mean 5000 statement executions on every
        // cold cache open — on the editor's open path. That per-key loop was
        // the original implementation and is the thing this shape removes.
        let mut out = Vec::with_capacity(keys.len());
        for chunk in keys.chunks(SQLITE_MAX_PARAMS - 2) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT key, value FROM cache_entries
                 WHERE namespace = ?1 AND version = ?2 AND key IN ({placeholders})"
            );
            let mut stmt = conn.prepare_cached(&sql)?;
            let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 2);
            params.push(&namespace);
            params.push(&version);
            for key in chunk {
                params.push(key);
            }
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            out.extend(rows.collect::<Result<Vec<_>, _>>()?);
        }
        Ok(out)
    }

    /// List the keys present in `namespace` at payload `version`.
    ///
    /// The caller needs the key set to enumerate a namespace at all: the KV
    /// layer is addressed by key, so "load what I previously wrote" requires
    /// knowing what that was. Returning keys only (never values) keeps the
    /// payload inside the red-line-4 IPC bound even at the entry cap — values
    /// then come back through [`get_many`](Self::get_many).
    ///
    /// `limit` bounds the response; callers pass the same cap they evict to.
    pub fn list_keys(&self, namespace: &str, version: i64, limit: usize) -> Result<Vec<String>> {
        let conn = self.pool.get()?;
        let mut stmt = conn.prepare_cached(
            "SELECT key FROM cache_entries
             WHERE namespace = ?1 AND version = ?2
             ORDER BY at DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![namespace, version, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| row.get::<_, String>(0),
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Delete specific keys in `namespace`, in one transaction.
    ///
    /// Separate from [`evict`](Self::evict) because the front end decides which
    /// keys to drop (by write time, over the rows it actually holds) and then
    /// tells the backend exactly those. `evict` cannot express that: it keeps
    /// the newest N of *all* rows in the namespace, which diverges as soon as
    /// the backend holds rows the caller never loaded.
    pub fn delete_many(&self, namespace: &str, keys: &[String]) -> Result<usize> {
        if keys.is_empty() {
            return Ok(0);
        }
        let mut conn = self.pool.get()?;
        let tx = conn.transaction()?;
        let mut removed = 0;
        {
            let mut stmt =
                tx.prepare_cached("DELETE FROM cache_entries WHERE namespace = ?1 AND key = ?2")?;
            for key in keys {
                removed += stmt.execute(params![namespace, key])?;
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    /// Write entries in one transaction.
    ///
    /// Either every entry lands or none does. Returning early on `?` drops the
    /// transaction, which rolls back — so a batch that fails halfway cannot
    /// leave a partially written cache that the caller believes is complete.
    pub fn put_many(
        &self,
        namespace: &str,
        entries: &[(String, String)],
        version: i64,
    ) -> Result<()> {
        self.put_many_at(namespace, entries, version, now_ms())
    }

    /// [`put_many`](Self::put_many) with an injected timestamp.
    ///
    /// The clock is a parameter so eviction ordering can be tested without
    /// sleeping between writes.
    pub fn put_many_at(
        &self,
        namespace: &str,
        entries: &[(String, String)],
        version: i64,
        at: i64,
    ) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut conn = self.pool.get()?;
        write_entries(&mut conn, namespace, entries, version, at)
    }

    /// Delete every entry in `namespace`.
    pub fn clear(&self, namespace: &str) -> Result<usize> {
        let conn = self.pool.get()?;
        Ok(conn.execute(
            "DELETE FROM cache_entries WHERE namespace = ?1",
            params![namespace],
        )?)
    }

    /// Keep only the `keep` most recently written entries in `namespace`.
    ///
    /// Ordered by `at` (write time), not `version`: eviction is about which
    /// writes are freshest, and `version` marks payload compatibility. The
    /// namespace-wide scope is what caps the table even when rows belong to a
    /// retired payload version (they are unreachable through `get_many` but
    /// still occupy space).
    pub fn evict(&self, namespace: &str, keep: usize) -> Result<usize> {
        let conn = self.pool.get()?;
        Ok(conn.execute(
            "DELETE FROM cache_entries
             WHERE namespace = ?1
               AND key NOT IN (
                 SELECT key FROM cache_entries
                 WHERE namespace = ?1
                 ORDER BY at DESC, key DESC
                 LIMIT ?2
               )",
            params![namespace, i64::try_from(keep).unwrap_or(i64::MAX)],
        )?)
    }
}

/// The transaction body, split out so tests can drive it against a raw
/// connection.
fn write_entries(
    conn: &mut Connection,
    namespace: &str,
    entries: &[(String, String)],
    version: i64,
    at: i64,
) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT OR REPLACE INTO cache_entries(namespace, key, value, version, at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for (key, value) in entries {
            stmt.execute(params![namespace, key, value, version, at])?;
        }
        // `stmt` borrows `tx`; it must drop before commit.
    }
    tx.commit()?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::db::{open_memory_pool, DbPool};

    fn store() -> (tempfile::TempDir, CacheStore) {
        let dir = tempfile::tempdir().unwrap();
        let pool: DbPool = crate::common::db::open_pool(&dir.path().join("cache.db"), 4).unwrap();
        let mut conn = pool.get().unwrap();
        crate::common::db::run_migrations(&mut conn).unwrap();
        drop(conn);
        (dir, CacheStore::with_pool(pool))
    }

    fn entries(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn put_then_get_roundtrips() {
        let (_dir, store) = store();
        store
            .put_many("ns", &entries(&[("a", "1"), ("b", "2")]), 1)
            .unwrap();

        let mut got = store
            .get_many("ns", &["a".into(), "b".into(), "missing".into()], 1)
            .unwrap();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("a".to_string(), "1".to_string()),
                ("b".to_string(), "2".to_string())
            ]
        );
    }

    #[test]
    fn get_many_with_no_keys_is_empty() {
        let (_dir, store) = store();
        assert!(store.get_many("ns", &[], 1).unwrap().is_empty());
    }

    /// A batch that fails partway must leave nothing behind.
    ///
    /// The failure is injected by a value that cannot be written; if the store
    /// committed per entry, the earlier rows would survive and the caller
    /// would believe a complete batch landed.
    ///
    /// This is also how AC9 ("one transaction, not one per entry") is enforced.
    /// `total_changes()` cannot distinguish the two — verified against SQLite:
    /// a single transaction and N independent commits both report N changes. A
    /// timing-based "did a reader ever see a partial batch" assertion is worse
    /// (it passes on broken code whenever the writer is fast — exactly the假绿
    /// failure mode this task exists to avoid). Rollback is deterministic: a
    /// per-entry implementation has already committed the earlier rows and
    /// cannot take them back, so this test goes red.
    #[test]
    fn put_many_is_atomic() {
        let (_dir, store) = store();
        store
            .put_many("ns", &entries(&[("pre", "kept")]), 1)
            .unwrap();

        // A table-level trigger is the only way to fail mid-batch through the
        // public API: the second insert aborts the transaction.
        {
            let conn = store.pool.get().unwrap();
            conn.execute_batch(
                "CREATE TRIGGER reject_b BEFORE INSERT ON cache_entries
                 WHEN NEW.key = 'b' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
            .unwrap();
        }

        let result = store.put_many("ns", &entries(&[("a", "1"), ("b", "2"), ("c", "3")]), 1);
        assert!(result.is_err(), "the batch must fail");

        let after = store
            .get_many("ns", &["a".into(), "b".into(), "c".into(), "pre".into()], 1)
            .unwrap();
        assert_eq!(
            after,
            vec![("pre".to_string(), "kept".to_string())],
            "only the row written before the failing batch may exist"
        );
    }

    #[test]
    fn clear_only_touches_its_namespace() {
        let (_dir, store) = store();
        store.put_many("a", &entries(&[("k", "1")]), 1).unwrap();
        store.put_many("b", &entries(&[("k", "2")]), 1).unwrap();

        let removed = store.clear("a").unwrap();
        assert_eq!(removed, 1);
        assert!(store.get_many("a", &["k".into()], 1).unwrap().is_empty());
        assert_eq!(
            store.get_many("b", &["k".into()], 1).unwrap(),
            vec![("k".to_string(), "2".to_string())]
        );
    }

    #[test]
    fn evict_keeps_newest_n_by_write_time() {
        let (_dir, store) = store();
        for (i, key) in ["old", "mid", "new"].iter().enumerate() {
            store
                .put_many_at(
                    "ns",
                    &entries(&[(key, "v")]),
                    1,
                    100 + i64::try_from(i).unwrap(),
                )
                .unwrap();
        }
        store
            .put_many_at("other", &entries(&[("keep", "v")]), 1, 1)
            .unwrap();

        let removed = store.evict("ns", 2).unwrap();
        assert_eq!(removed, 1);

        let left = store
            .get_many("ns", &["old".into(), "mid".into(), "new".into()], 1)
            .unwrap();
        let mut keys: Vec<&str> = left.iter().map(|(k, _)| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["mid", "new"], "the oldest write must be evicted");

        assert_eq!(
            store.get_many("other", &["keep".into()], 1).unwrap().len(),
            1,
            "other namespaces must be untouched"
        );
    }

    #[test]
    fn evict_to_zero_removes_everything_in_namespace() {
        let (_dir, store) = store();
        store
            .put_many("ns", &entries(&[("a", "1"), ("b", "2")]), 1)
            .unwrap();
        let removed = store.evict("ns", 0).unwrap();
        assert_eq!(removed, 2);
        assert!(store
            .get_many("ns", &["a".into(), "b".into()], 1)
            .unwrap()
            .is_empty());
    }

    /// A read spanning several chunks must return every row, exactly once.
    ///
    /// This does NOT prove the chunking is required — with the bundled SQLite a
    /// 5000-parameter statement is accepted (verified: chunking removed, this
    /// still passes). What it does prove is the chunk arithmetic: off-by-one in
    /// the per-chunk placeholder count, or a dropped final chunk, would silently
    /// lose rows at a boundary that no small fixture reaches.
    #[test]
    fn get_many_spans_multiple_parameter_chunks() {
        let (_dir, store) = store();
        let total = SQLITE_MAX_PARAMS + 50;
        let entries: Vec<(String, String)> = (0..total)
            .map(|i| (format!("k{i}"), format!("v{i}")))
            .collect();
        store.put_many("ns", &entries, 1).unwrap();

        let keys: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
        let got = store.get_many("ns", &keys, 1).unwrap();

        assert_eq!(
            got.len(),
            total,
            "every row must survive the chunk boundary"
        );
    }

    /// Writes replace rather than duplicate, so a repeated flush of the same
    /// key cannot grow the table.
    #[test]
    fn put_same_key_twice_replaces() {
        let (_dir, store) = store();
        store.put_many("ns", &entries(&[("k", "1")]), 1).unwrap();
        store.put_many("ns", &entries(&[("k", "2")]), 2).unwrap();

        // The replacement carries the new version, so it is only visible to a
        // reader at that version — which is also the assertion that `version`
        // is actually stored per row rather than ignored.
        let got = store.get_many("ns", &["k".into()], 2).unwrap();
        assert_eq!(got, vec![("k".to_string(), "2".to_string())]);
        assert!(
            store.get_many("ns", &["k".into()], 1).unwrap().is_empty(),
            "the row was overwritten, so nothing remains at the old version"
        );
    }

    /// A payload-version bump must make old entries invisible without a delete.
    ///
    /// This is the contract the front end relies on to retire "translations
    /// produced under the previous prompt": if the read ignores `version`, the
    /// old rule's output keeps being served and the rule change looks like it
    /// did nothing.
    #[test]
    fn newer_version_does_not_see_older_entries() {
        let (_dir, store) = store();
        store
            .put_many("ns", &entries(&[("k", "old-rule-output")]), 1)
            .unwrap();

        assert!(
            store.get_many("ns", &["k".into()], 2).unwrap().is_empty(),
            "a bumped version must not be served rows written at the old one"
        );
        assert_eq!(
            store.get_many("ns", &["k".into()], 1).unwrap().len(),
            1,
            "the old rows still exist — the version is a filter, not a delete"
        );
    }

    /// `delete_many` removes exactly the given keys and leaves the rest.
    #[test]
    fn delete_many_removes_only_the_named_keys() {
        let (_dir, store) = store();
        store
            .put_many("ns", &entries(&[("a", "1"), ("b", "2"), ("c", "3")]), 1)
            .unwrap();
        store
            .put_many("other", &entries(&[("a", "keep")]), 1)
            .unwrap();

        let removed = store.delete_many("ns", &["a".into(), "c".into()]).unwrap();
        assert_eq!(removed, 2);

        assert!(store.get_many("ns", &["a".into()], 1).unwrap().is_empty());
        assert_eq!(store.get_many("ns", &["b".into()], 1).unwrap().len(), 1);
        assert_eq!(
            store.get_many("other", &["a".into()], 1).unwrap().len(),
            1,
            "other namespaces must be untouched"
        );
    }

    /// An in-memory pool still works through the whole store, which is what
    /// the test fixture in `LibraryStore::open_in_memory` relies on.
    #[test]
    fn works_against_in_memory_pool() {
        let pool = open_memory_pool().unwrap();
        let mut conn = pool.get().unwrap();
        crate::common::db::run_migrations(&mut conn).unwrap();
        drop(conn);

        let store = CacheStore::with_pool(pool);
        store.put_many("ns", &entries(&[("k", "v")]), 1).unwrap();
        assert_eq!(
            store.get_many("ns", &["k".into()], 1).unwrap(),
            vec![("k".to_string(), "v".to_string())]
        );
    }

    /// `list_keys` reports only the current version and honours the cap, so the
    /// front end can enumerate a namespace without an unbounded read.
    #[test]
    fn list_keys_filters_by_version_and_limit() {
        let (_dir, store) = store();
        store
            .put_many_at("ns", &entries(&[("old", "v")]), 1, 100)
            .unwrap();
        store
            .put_many_at("ns", &entries(&[("a", "v"), ("b", "v")]), 2, 200)
            .unwrap();

        let mut keys = store.list_keys("ns", 2, 10).unwrap();
        keys.sort();
        assert_eq!(keys, vec!["a".to_string(), "b".to_string()]);

        assert_eq!(
            store.list_keys("ns", 2, 1).unwrap().len(),
            1,
            "the limit must bound the response"
        );
        assert!(
            store.list_keys("ns", 3, 10).unwrap().is_empty(),
            "a version nobody wrote at yields nothing"
        );
    }
}

#[cfg(test)]
mod sharing_tests {
    use super::*;

    /// The cache must use the library store's pool, not one of its own.
    ///
    /// Discriminating signal: **exhaustion is shared**. With every connection of
    /// the library pool held (it is sized 2 here), a checkout through the cache
    /// must time out — because it waits on the same `Arc` accounting. A second
    /// pool over the same *file* would hand out a connection immediately.
    ///
    /// `idle_connections` was the original probe and is **not** usable: r2d2
    /// calls `establish_idle_connections` right after a checkout, so the idle
    /// counter is replenished from a background thread and `before - 1` is a
    /// race (verified by probe). `std::ptr::eq` on `&DbPool` is also wrong — the
    /// two accessors return different fields, so the addresses differ even when
    /// the inner `Arc` is shared.
    #[test]
    fn cache_and_library_share_one_pool() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("neeko.db");
        let pool = crate::common::db::open_pool(&path, 2).unwrap();
        let library = crate::library::LibraryStore::with_pool(pool).unwrap();
        let cache = CacheStore::with_pool(library.pool().clone());

        // Exhaust the shared pool.
        let held: Vec<_> = (0..2).map(|_| library.pool().get().unwrap()).collect();

        assert!(
            cache
                .pool()
                .get_timeout(std::time::Duration::from_millis(200))
                .is_err(),
            "a checkout through the cache must wait on the library pool's accounting; \
             a separate pool would hand out a connection immediately"
        );

        drop(held);
        assert!(
            cache
                .pool()
                .get_timeout(std::time::Duration::from_millis(200))
                .is_ok(),
            "releasing the connections must release them for the cache too"
        );

        // Control: an independently opened pool over the same file is not
        // affected by the shared pool's state — otherwise the assertion above
        // would pass for the wrong reason.
        let other = crate::common::db::open_pool(&path, 2).unwrap();
        let other_held: Vec<_> = (0..2).map(|_| other.get().unwrap()).collect();
        assert!(
            cache
                .pool()
                .get_timeout(std::time::Duration::from_millis(200))
                .is_ok(),
            "exhausting a *different* pool must not block this one"
        );
        drop(other_held);
    }
}

#[cfg(test)]
mod transaction_count_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static BEGIN_COUNT: AtomicUsize = AtomicUsize::new(0);
    static INSERT_COUNT: AtomicUsize = AtomicUsize::new(0);

    /// `trace` takes a plain `fn` pointer, so the observed statements are
    /// counted in statics rather than a captured closure.
    fn counting_tracer(sql: &str) {
        let upper = sql.trim_start().to_ascii_uppercase();
        if upper.starts_with("BEGIN") {
            BEGIN_COUNT.fetch_add(1, Ordering::SeqCst);
        } else if upper.starts_with("INSERT") {
            INSERT_COUNT.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn reset() {
        BEGIN_COUNT.store(0, Ordering::SeqCst);
        INSERT_COUNT.store(0, Ordering::SeqCst);
    }

    /// AC9: a batch is one transaction, not one per entry.
    ///
    /// `total_changes()` cannot tell the two apart (measured: a single
    /// transaction of 3 inserts and 3 independent commits both report 3), so
    /// the discriminator has to be the statements themselves. Tracing counts
    /// the `BEGIN`s: one for the whole batch, versus N for a per-entry
    /// implementation.
    ///
    /// This is the case AC8 cannot cover: AC8 only fails a batch, so a
    /// per-entry implementation that never fails would pass it.
    #[test]
    fn put_many_opens_exactly_one_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::common::db::open_pool(&dir.path().join("c.db"), 4).unwrap();
        {
            let mut conn = pool.get().unwrap();
            crate::common::db::run_migrations(&mut conn).unwrap();
        }
        let store = CacheStore::with_pool(pool);

        // Trace one connection and hand it to the write path. `trace` is set on
        // a raw `Connection`, so the batch is driven directly rather than
        // through the pool.
        let mut conn = rusqlite::Connection::open(dir.path().join("c.db")).unwrap();
        reset();
        conn.trace(Some(counting_tracer));

        let entries: Vec<(String, String)> =
            (0..5).map(|i| (format!("k{i}"), format!("v{i}"))).collect();
        write_entries(&mut conn, "ns", &entries, 1, 42).unwrap();
        conn.trace(None);

        assert_eq!(
            INSERT_COUNT.load(Ordering::SeqCst),
            5,
            "all five rows must be written"
        );
        assert_eq!(
            BEGIN_COUNT.load(Ordering::SeqCst),
            1,
            "a batch must open one transaction, not one per entry (AC9)"
        );

        // The rows are really there.
        let keys: Vec<String> = entries.iter().map(|(k, _)| k.clone()).collect();
        assert_eq!(store.get_many("ns", &keys, 1).unwrap().len(), 5);
    }
}
