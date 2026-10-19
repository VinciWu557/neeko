//! Generic local cache over the shared `neeko.db` database.
//!
//! Infrastructure, not a business domain: the store knows namespaces and
//! opaque values, never what is being cached.

pub mod commands;
pub mod migrations;
pub mod store;

pub use migrations::v12_to_v13;
pub use store::CacheStore;
