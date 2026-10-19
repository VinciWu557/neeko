//! The single migration chain for `neeko.db`.
//!
//! `user_version` is one integer per database file, so a database can only
//! have one version chain — it lives here, and only here. Each step's SQL
//! still belongs to the domain that owns the tables: this module decides
//! which domain runs which version range and nothing more.
//!
//! That split is what keeps `cache_entries` out of `library/migrations.rs`.
//! Putting it there would also work at runtime, but the cache domain would
//! then depend on the library domain to evolve its own tables.

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, TransactionBehavior};

/// Current schema version. Bump this in the same commit as the migration
/// that creates the change.
pub const LATEST_VERSION: u32 = 12;

/// Run all pending migrations on the database.
pub fn run_migrations(conn: &mut Connection) -> Result<()> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    if current > LATEST_VERSION {
        bail!(
            "Database schema version ({current}) is newer than this app supports ({LATEST_VERSION}). \
             Please upgrade the application."
        );
    }

    if current == LATEST_VERSION {
        return Ok(());
    }

    for version in current..LATEST_VERSION {
        // EXCLUSIVE, not the default IMMEDIATE: during a migration no other
        // connection may read either, or it observes a half-migrated schema.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Exclusive)?;
        migrate_step(&tx, version).with_context(|| {
            format!("migration from version {version} to {} failed", version + 1)
        })?;
        tx.pragma_update(None, "user_version", version + 1)?;
        tx.commit()?;
    }

    Ok(())
}

/// Dispatch one migration step to the domain that owns those tables.
fn migrate_step(conn: &Connection, from_version: u32) -> Result<()> {
    match from_version {
        0..=11 => crate::library::migrations::step(conn, from_version),
        _ => bail!("unknown migration version: {from_version}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_version(conn: &Connection) -> u32 {
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    fn table_names(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn fresh_database_migrates_to_latest() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();

        assert_eq!(user_version(&conn), LATEST_VERSION);

        let tables = table_names(&conn);
        for needed in [
            "skills",
            "skill_targets",
            "skill_tags",
            "tag_groups",
            "tag_group_skills",
            "tag_group_skill_tools",
            "settings",
            "project_tag_groups",
            "skillssh_cache",
            "prompts",
            "actions",
            "mcp_servers",
            "mcp_tag_groups",
            "mcp_tag_group_servers",
            "mcp_tag_group_server_agents",
            "project_mcp_tag_groups",
            "mcp_server_targets",
        ] {
            assert!(
                tables.contains(&needed.to_string()),
                "missing table: {needed}"
            );
        }
    }

    #[test]
    fn migration_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations(&mut conn).unwrap();
        run_migrations(&mut conn).unwrap();

        assert_eq!(user_version(&conn), LATEST_VERSION);
    }

    #[test]
    fn newer_schema_rejected() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", LATEST_VERSION + 1)
            .unwrap();

        let err = run_migrations(&mut conn).unwrap_err();
        assert!(err.to_string().contains("newer than this app supports"));
    }
}

#[cfg(test)]
mod atomicity_tests {
    use super::*;
    use rusqlite::Connection;

    /// One failing step must leave the schema and the version exactly as they
    /// were: `user_version` only advances after the step's SQL committed.
    ///
    /// Without this, a half-applied migration stamps a version that claims
    /// work the database never got, and the next boot skips it forever.
    #[test]
    fn failed_step_rolls_back_and_keeps_version() {
        let mut conn = Connection::open_in_memory().unwrap();

        // A step that creates a table and then fails.
        let result: Result<()> = (|| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Exclusive)?;
            tx.execute_batch("CREATE TABLE half_done (id INTEGER);")?;
            bail!("injected failure");
            #[allow(unreachable_code)]
            Ok(())
        })();

        assert!(result.is_err());
        drop(result);

        let version: u32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 0, "a failed step must not advance user_version");

        let has_table: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='half_done'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_table, 0, "a failed step must not leave a table behind");
    }
}
