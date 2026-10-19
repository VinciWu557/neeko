//! Generic key-value cache over the shared `neeko.db` pool.
//!
//! The store understands `namespace`, `key`, `value`, `version` and `at` and
//! nothing else. `value` is opaque TEXT: callers serialise and validate their
//! own payloads, so adding a consumer to the cache never means changing the
//! schema or this file.

use anyhow::Result;
use rusqlite::{params, Connection};
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
    #[must_use]
    pub const fn with_pool(pool: DbPool) -> Self {
        Self { pool }
    }

    /// Read the entries for `keys` in `namespace`.
    ///
    /// Unknown keys are simply absent from the result; a cache miss is not an
    /// error.
    pub fn get_many(&self, namespace: &str, keys: &[String]) -> Result<Vec<(String, String)>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.pool.get()?;
        let mut stmt = conn.prepare_cached(
            "SELECT key, value FROM cache_entries WHERE namespace = ?1 AND key = ?2",
        )?;
        let mut out = Vec::with_capacity(keys.len());
        for key in keys {
            let row: Option<(String, String)> = stmt
                .query_row(params![namespace, key], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .ok();
            if let Some(row) = row {
                out.push(row);
            }
        }
        Ok(out)
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
    /// writes are freshest, and `version` marks payload compatibility.
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
            .get_many("ns", &["a".into(), "b".into(), "missing".into()])
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
        assert!(store.get_many("ns", &[]).unwrap().is_empty());
    }

    /// A batch that fails partway must leave nothing behind.
    ///
    /// The failure is injected by a value that cannot be written; if the store
    /// committed per entry, the earlier rows would survive and the caller
    /// would believe a complete batch landed.
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
            .get_many("ns", &["a".into(), "b".into(), "c".into(), "pre".into()])
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
        assert!(store.get_many("a", &["k".into()]).unwrap().is_empty());
        assert_eq!(
            store.get_many("b", &["k".into()]).unwrap(),
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
            .get_many("ns", &["old".into(), "mid".into(), "new".into()])
            .unwrap();
        let mut keys: Vec<&str> = left.iter().map(|(k, _)| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["mid", "new"], "the oldest write must be evicted");

        assert_eq!(
            store.get_many("other", &["keep".into()]).unwrap().len(),
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
            .get_many("ns", &["a".into(), "b".into()])
            .unwrap()
            .is_empty());
    }

    /// Writes replace rather than duplicate, so a repeated flush of the same
    /// key cannot grow the table.
    #[test]
    fn put_same_key_twice_replaces() {
        let (_dir, store) = store();
        store.put_many("ns", &entries(&[("k", "1")]), 1).unwrap();
        store.put_many("ns", &entries(&[("k", "2")]), 2).unwrap();

        let got = store.get_many("ns", &["k".into()]).unwrap();
        assert_eq!(got, vec![("k".to_string(), "2".to_string())]);
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
            store.get_many("ns", &["k".into()]).unwrap(),
            vec![("k".to_string(), "v".to_string())]
        );
    }
}

#[cfg(test)]
mod sharing_tests {
    use super::*;

    /// The cache must use the library store's pool, not one of its own.
    ///
    /// `Pool::state()` reports the shared accounting of the underlying `Arc`,
    /// so a checkout through either facade moves the *same* idle counter. Two
    /// independent pools would each report their own. (`connections` is the
    /// number of established connections, which saturates — `idle_connections`
    /// is what a checkout actually moves.)
    #[test]
    fn cache_and_library_share_one_pool() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::common::db::open_pool(&dir.path().join("neeko.db"), 4).unwrap();
        let library = crate::library::LibraryStore::with_pool(pool.clone()).unwrap();
        let cache = CacheStore::with_pool(library.pool().clone());

        // Warm up so the idle count is non-zero and stable.
        drop(library.pool().get().unwrap());
        let before = library.pool().state().idle_connections;

        let held = cache.pool.get().unwrap();
        assert_eq!(
            library.pool().state().idle_connections,
            before - 1,
            "a checkout through the cache must move the library store's idle count; \
             separate pools would leave it unchanged"
        );

        drop(held);
        assert_eq!(library.pool().state().idle_connections, before);

        // An independently opened pool is genuinely separate.
        let other = crate::common::db::open_pool(&dir.path().join("neeko.db"), 4).unwrap();
        drop(other.get().unwrap());
        assert_eq!(
            library.pool().state().idle_connections,
            before,
            "an independent pool's checkout must not appear in this pool"
        );
    }
}
