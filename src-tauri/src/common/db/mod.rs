//! Database connection and migration utilities.
//!
//! `neeko.db` is the application's shared SQLite database. The pool and the
//! migration chain are both infrastructure: they know nothing about any
//! domain, and domains share one pool rather than opening their own.

pub mod migrations;
pub mod pool;

use rusqlite::Connection;
use std::path::Path;

pub use migrations::{run_migrations, LATEST_VERSION};
pub use pool::{open_memory_pool, open_pool, DbPool};

/// Open a SQLite database at `db_path` with WAL journal mode and foreign keys enabled.
pub fn open(db_path: &Path) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    Ok(conn)
}

/// Open an in-memory SQLite database with WAL journal mode and foreign keys enabled.
pub fn open_in_memory() -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    Ok(conn)
}
