//! Connection pool for the shared `neeko.db` database.
//!
//! A single pool is created once at boot and injected into every domain that
//! needs `neeko.db` access. Domains never open their own pool: two pools over
//! the same file means two owners for the same handle and no way to bound the
//! connection count.

use anyhow::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::Path;

/// The one pool type for `neeko.db`. Domains take this, never a raw
/// connection or their own pool.
pub type DbPool = Pool<SqliteConnectionManager>;

/// Open a pooled connection to `db_path`.
///
/// `max_size` caps concurrent connections. Writes still serialise (SQLite has
/// a single writer), so the pool's value is letting readers run while a write
/// is in flight — under WAL a reader sees a consistent snapshot instead of
/// waiting for the writer to commit.
pub fn open_pool(db_path: &Path, max_size: u32) -> Result<DbPool> {
    let manager = SqliteConnectionManager::file(db_path).with_init(|conn| {
        // Every pragma below is per-connection, and the pool creates
        // connections lazily, so this must live in `with_init` rather than
        // running once after `build()`. A connection that misses
        // `busy_timeout` fails the moment another writer holds the lock.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;\
             PRAGMA busy_timeout=7000;\
             PRAGMA foreign_keys=ON;",
        )
    });
    let pool = Pool::builder().max_size(max_size).build(manager)?;
    Ok(pool)
}

/// Open a pooled in-memory database.
///
/// Capped at one connection on purpose: `SqliteConnectionManager::memory()`
/// yields a *new empty database* per connection, so a larger pool would hand
/// out databases that share nothing.
pub fn open_memory_pool() -> Result<DbPool> {
    let manager = SqliteConnectionManager::memory()
        .with_init(|conn| conn.execute_batch("PRAGMA foreign_keys=ON;"));
    let pool = Pool::builder().max_size(1).build(manager)?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::mpsc;
    use std::time::Duration;

    fn setup_repo() -> (tempfile::TempDir, DbPool) {
        let dir = tempfile::tempdir().unwrap();
        let pool = open_pool(&dir.path().join("neeko.db"), 4).unwrap();
        {
            let conn = pool.get().unwrap();
            conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
                .unwrap();
            conn.execute("INSERT INTO t (id, v) VALUES (1, 'seed')", [])
                .unwrap();
        }
        (dir, pool)
    }

    /// A reader must not wait for an in-flight write to commit.
    ///
    /// This is the entire reason for the pool. With a `Mutex<Connection>` the
    /// reader blocks on the mutex until the writer is done; under WAL with
    /// separate connections it reads a snapshot taken when its read
    /// transaction began.
    #[test]
    fn read_does_not_block_on_in_flight_write() {
        let (_dir, pool) = setup_repo();

        let writer_pool = pool.clone();
        let (writer_holds_lock, writer_has_lock) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let mut conn = writer_pool.get().unwrap();
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .unwrap();
            tx.execute("UPDATE t SET v = 'uncommitted' WHERE id = 1", [])
                .unwrap();
            writer_holds_lock.send(()).unwrap();
            // Hold the write open long enough for the reader to have to wait
            // if it were going to.
            std::thread::sleep(Duration::from_millis(200));
            tx.commit().unwrap();
        });

        writer_has_lock.recv().unwrap();

        let reader_pool = pool.clone();
        let reader = std::thread::spawn(move || {
            let conn = reader_pool.get().unwrap();
            let value: String = conn
                .query_row("SELECT v FROM t WHERE id = 1", [], |row| row.get(0))
                .expect("reader must not fail while a write is in flight");
            value
        });

        // The reader returns while the writer still holds its transaction.
        let value = reader.join().unwrap();
        assert_eq!(
            value, "seed",
            "reader must see the pre-commit snapshot, not block or read uncommitted data"
        );

        writer.join().unwrap();
    }

    /// The pool must hand out distinct connections, otherwise the test above
    /// could pass for the wrong reason.
    #[test]
    fn pool_hands_out_more_than_one_connection() {
        let (_dir, pool) = setup_repo();
        let a = pool.get().unwrap();
        let b = pool.get().unwrap();
        let a_ptr = &*a as *const Connection;
        let b_ptr = &*b as *const Connection;
        assert_ne!(
            a_ptr, b_ptr,
            "pool must provide independent connections, not one shared handle"
        );
    }

    /// busy_timeout is per-connection and set in `with_init`; a connection
    /// created after the pool is built must still carry it.
    ///
    /// The value is deliberately not rusqlite's default (5000): asserting on
    /// the default would stay green even with the pragma deleted, which is
    /// how this test first passed without testing anything.
    #[test]
    fn late_connection_keeps_busy_timeout() {
        let (_dir, pool) = setup_repo();
        // Force a fresh connection well after build time.
        let conns: Vec<_> = (0..4).map(|_| pool.get().unwrap()).collect();
        for conn in conns {
            let timeout: i64 = conn
                .pragma_query_value(None, "busy_timeout", |row| row.get(0))
                .unwrap();
            assert_eq!(timeout, 7000, "with_init must apply to every connection");
        }
    }
}
