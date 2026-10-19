//! Tauri commands for the generic cache.
//!
//! Red line 6: these validate arguments and dispatch. All SQL lives in
//! `store`. Red line 3: every database call runs on the blocking executor.

use tauri::State;

use crate::app_state::AppStateWrapper;
use crate::common::error::AppError;
use crate::common::runtime::run_blocking_result;

/// Largest batch accepted in one call.
///
/// Red line 4: a single command may not return multi-megabyte JSON, and the
/// same bound applies to what we accept. 5000 opaque entries is far beyond
/// any current consumer and keeps a runaway caller from pinning a write
/// transaction while it streams.
const MAX_BATCH: usize = 5000;

/// Longest accepted namespace.
const MAX_NAMESPACE_LEN: usize = 64;

/// Reject namespaces that could split one domain into two spellings.
///
/// The namespace is bound as a SQL parameter, so this is not an injection
/// defence — it stops `Comment` and `comment` from becoming separate caches.
fn validate_namespace(namespace: &str) -> Result<(), AppError> {
    if namespace.is_empty() {
        return Err(AppError::InvalidInput("namespace must not be empty".into()));
    }
    if namespace.len() > MAX_NAMESPACE_LEN {
        return Err(AppError::InvalidInput(format!(
            "namespace exceeds {MAX_NAMESPACE_LEN} characters"
        )));
    }
    if !namespace
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
    {
        return Err(AppError::InvalidInput(
            "namespace may only contain a-z, 0-9, '.', '_' and '-'".into(),
        ));
    }
    Ok(())
}

fn validate_batch(len: usize) -> Result<(), AppError> {
    if len > MAX_BATCH {
        return Err(AppError::InvalidInput(format!(
            "batch of {len} exceeds the {MAX_BATCH} entry limit"
        )));
    }
    Ok(())
}

/// Read cached values for `keys`.
#[tauri::command]
pub async fn cache_get_many(
    state: State<'_, AppStateWrapper>,
    namespace: String,
    keys: Vec<String>,
) -> Result<Vec<(String, String)>, AppError> {
    validate_namespace(&namespace)?;
    validate_batch(keys.len())?;
    let store = state.cache_store.clone();
    run_blocking_result(move || Ok(store.get_many(&namespace, &keys)?)).await
}

/// Write `entries` in a single transaction.
#[tauri::command]
pub async fn cache_put_many(
    state: State<'_, AppStateWrapper>,
    namespace: String,
    entries: Vec<(String, String)>,
    version: i64,
) -> Result<(), AppError> {
    validate_namespace(&namespace)?;
    validate_batch(entries.len())?;
    let store = state.cache_store.clone();
    run_blocking_result(move || Ok(store.put_many(&namespace, &entries, version)?)).await
}

/// Keep only the `keep` newest entries in `namespace`.
#[tauri::command]
pub async fn cache_evict(
    state: State<'_, AppStateWrapper>,
    namespace: String,
    keep: usize,
) -> Result<usize, AppError> {
    validate_namespace(&namespace)?;
    let store = state.cache_store.clone();
    run_blocking_result(move || Ok(store.evict(&namespace, keep)?)).await
}

/// Drop every entry in `namespace`.
#[tauri::command]
pub async fn cache_clear(
    state: State<'_, AppStateWrapper>,
    namespace: String,
) -> Result<usize, AppError> {
    validate_namespace(&namespace)?;
    let store = state.cache_store.clone();
    run_blocking_result(move || Ok(store.clear(&namespace)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_conventional_namespaces() {
        for ok in ["comment-i18n", "doc.translation", "a_b", "x", "v1"] {
            assert!(validate_namespace(ok).is_ok(), "should accept {ok}");
        }
    }

    #[test]
    fn rejects_namespaces_that_would_split_a_domain() {
        for bad in [
            "",
            "Comment",
            "has space",
            "sla/sh",
            "ünï",
            "a".repeat(65).as_str(),
        ] {
            assert!(validate_namespace(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn batch_limit_is_enforced() {
        assert!(validate_batch(MAX_BATCH).is_ok());
        assert!(validate_batch(MAX_BATCH + 1).is_err());
    }
}
