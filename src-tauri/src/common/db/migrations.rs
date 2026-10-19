//! The single migration chain for `neeko.db`.
//!
//! `user_version` is a single integer per database file, so there can only be
//! one version chain — it lives here. Each step's SQL still belongs to the
//! domain that owns the tables; this module only decides which domain runs
//! which version range.
//!
//! Stage 1 keeps the chain where it was; the move happens next.

pub use crate::library::migrations::{run_migrations, LATEST_VERSION};
