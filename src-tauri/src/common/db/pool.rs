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
             PRAGMA busy_timeout=5000;\
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
