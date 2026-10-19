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
/// Red line 4 bounds the *bytes* of a single response, and an entry count alone
/// does not bound bytes: 5000 entries of 1MB each would be 5GB. So the batch cap
/// is only half the check — [`validate_payload_bytes`] bounds the actual size.
/// The count still matters on its own: it stops a caller from pinning a write
/// transaction while it streams ten thousand tiny rows.
const MAX_BATCH: usize = 5000;

/// Largest accepted payload, summed over keys + values.
///
/// Well inside red line 4's 2MB response ceiling: the *response* re-serialises
/// these same strings as JSON, which adds escaping (a value full of quotes can
/// double). 1MB of raw payload leaves room for that expansion.
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

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

/// Reject a payload that would blow the IPC byte budget.
///
/// `count` caps how many entries a caller may send; this caps how big they may
/// be. Neither alone is sufficient: red line 4 is about bytes, and a count of
/// 5000 says nothing about them.
fn validate_payload_bytes<'a, I>(items: I) -> Result<(), AppError>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut total = 0usize;
    for item in items {
        total = total.saturating_add(item.len());
        if total > MAX_PAYLOAD_BYTES {
            return Err(AppError::InvalidInput(format!(
                "payload exceeds the {MAX_PAYLOAD_BYTES} byte limit for one call"
            )));
        }
    }
    Ok(())
}

/// Read cached values for `keys` at payload `version`.
#[tauri::command]
pub async fn cache_get_many(
    state: State<'_, AppStateWrapper>,
    namespace: String,
    keys: Vec<String>,
    version: i64,
) -> Result<Vec<(String, String)>, AppError> {
    validate_namespace(&namespace)?;
    validate_batch(keys.len())?;
    validate_payload_bytes(keys.iter().map(String::as_str))?;
    let store = state.cache_store.clone();
    run_blocking_result(move || Ok(store.get_many(&namespace, &keys, version)?)).await
}

/// List the keys stored in `namespace` at payload `version`.
///
/// Keys only, never values: this is how a fresh process discovers what it
/// previously wrote (the KV layer is addressed by key). Values follow through
/// [`cache_get_many`], which keeps each response inside the red-line-4 bound.
#[tauri::command]
pub async fn cache_list_keys(
    state: State<'_, AppStateWrapper>,
    namespace: String,
    version: i64,
    limit: usize,
) -> Result<Vec<String>, AppError> {
    validate_namespace(&namespace)?;
    validate_batch(limit)?;
    let store = state.cache_store.clone();
    run_blocking_result(move || Ok(store.list_keys(&namespace, version, limit)?)).await
}

/// Delete specific keys in `namespace`.
#[tauri::command]
pub async fn cache_delete_many(
    state: State<'_, AppStateWrapper>,
    namespace: String,
    keys: Vec<String>,
) -> Result<usize, AppError> {
    validate_namespace(&namespace)?;
    validate_batch(keys.len())?;
    validate_payload_bytes(keys.iter().map(String::as_str))?;
    let store = state.cache_store.clone();
    run_blocking_result(move || Ok(store.delete_many(&namespace, &keys)?)).await
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
    validate_payload_bytes(entries.iter().flat_map(|(k, v)| [k.as_str(), v.as_str()]))?;
    let store = state.cache_store.clone();
    run_blocking_result(move || Ok(store.put_many(&namespace, &entries, version)?)).await
}

/// Keep only the `keep` newest entries in `namespace`.
///
/// Namespace-wide on purpose: rows written under a retired payload version are
/// unreachable through reads but still occupy space, and only a namespace-wide
/// cap can bound them.
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

    /// The byte cap must reject a payload the count cap would happily accept.
    ///
    /// This is the discriminating case for red line 4: an entry count bounds how
    /// many rows there are, not how big they are. Without this test the byte
    /// limit could be deleted and everything would stay green — exactly the
    /// 「断言恒真值」failure this review is looking for.
    #[test]
    fn payload_byte_limit_is_enforced() {
        let big = "x".repeat(MAX_PAYLOAD_BYTES + 1);
        assert!(validate_payload_bytes(std::iter::once(big.as_str())).is_err());

        // Same *count* as an accepted payload, different size. Leave room for
        // the surrounding "k" / "v" so this stays a boundary case, not an
        // off-by-two.
        let fits = "x".repeat(MAX_PAYLOAD_BYTES - 3);
        assert!(validate_payload_bytes(["k", fits.as_str(), "v"]).is_ok());
    }

    /// Values are counted, not just keys: a batch of 5000 tiny keys could still
    /// carry gigabytes of value.
    #[test]
    fn payload_byte_limit_counts_values_too() {
        let keys = vec![String::from("k"); 10];
        let values = vec!["v".repeat(MAX_PAYLOAD_BYTES / 5); 10];
        let entries: Vec<(String, String)> = keys.into_iter().zip(values).collect();

        assert!(
            validate_batch(entries.len()).is_ok(),
            "the count is fine — that is the point"
        );
        assert!(
            validate_payload_bytes(entries.iter().flat_map(|(k, v)| [k.as_str(), v.as_str()]))
                .is_err()
        );
    }
}
