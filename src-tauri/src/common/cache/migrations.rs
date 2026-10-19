//! Schema migrations owned by the cache domain.
//!
//! The version *chain* lives in `common::db::migrations`; this file owns the
//! SQL for the version range that creates the cache tables.

use anyhow::Result;
use rusqlite::Connection;

/// v12 -> v13: add the generic key-value cache table.
///
/// `value` is opaque TEXT — the backend never inspects it. Serialisation and
/// validation belong to the consumer, so this table can serve every
/// "expensive to compute, cheap to recompute" case without learning any of
/// their domain concepts.
pub fn v12_to_v13(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS cache_entries (
            namespace TEXT NOT NULL,
            key       TEXT NOT NULL,
            value     TEXT NOT NULL,
            version   INTEGER NOT NULL,
            at        INTEGER NOT NULL,
            PRIMARY KEY (namespace, key)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_cache_entries_lru
            ON cache_entries(namespace, at);
        ",
    )?;
    Ok(())
}
