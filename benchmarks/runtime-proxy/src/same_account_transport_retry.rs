//! Benchmark-only mirror of the safe same-account retry gate in
//! `src/sse/services/sameAccountTransportRetry.ts`.
//!
//! This isolates the pure decision from HTTP dispatch, waiting, account rotation, and
//! production transport state. In particular, an HTTP 5xx alone is never proof that a
//! generation was not accepted: retry requires explicit `transport_queue` provenance with
//! `requestStarted == false`. The shared vectors are also consumed by a TypeScript test so the
//! production helper and this Rust probe agree on the selected decision boundary.

use serde::Deserialize;

pub const SAME_ACCOUNT_TRANSPORT_RETRY_MAX: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetryVector {
    name: String,
    input: RetryInput,
    expected: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetryInput {
    status: u16,
    attempt: u32,
    #[serde(default)]
    has_forced_connection: bool,
    #[serde(default)]
    has_emitted_output: bool,
    dispatch_phase: Option<String>,
    request_started: Option<bool>,
    #[serde(default)]
    uncertain_acceptance: bool,
    error_code: Option<String>,
    error_type: Option<String>,
    error_text: Option<String>,
}

/// Mirrors the conservative subset of `shouldRetrySameAccountTransport` represented by the
/// deterministic fixture. This is benchmark/test code only; production routing remains TS.
fn should_retry_same_account(input: &RetryInput) -> bool {
    if input.has_forced_connection
        || input.has_emitted_output
        || input.attempt >= SAME_ACCOUNT_TRANSPORT_RETRY_MAX
        || input.uncertain_acceptance
    {
        return false;
    }

    if input.error_type.as_deref().is_some_and(|error_type| {
        matches!(
            error_type,
            "lease_error"
                | "account_semaphore_capacity"
                | "logical_retry_budget"
                | "upstream_acceptance_uncertain"
                | "local_stream_buffer_limit"
        )
    }) {
        return false;
    }

    if let Some(code) = input.error_code.as_deref() {
        if code.starts_with("LEASE_")
            || matches!(
                code,
                "proxy_unreachable" | "PROXY_UNREACHABLE" | "EAI_AGAIN" | "ENOTFOUND"
            )
        {
            return false;
        }
    }

    if matches!(input.status, 429 | 401 | 400) {
        return false;
    }

    let text = input
        .error_text
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let code = input
        .error_code
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let error_type = input.error_type.as_deref().unwrap_or_default();
    let policy_rejection = matches!(
        code.as_str(),
        "content_policy_violation"
            | "safety_violation"
            | "safety_check_failed"
            | "policy_violation"
            | "upstream_policy_rejection"
    ) || error_type == "upstream_policy_rejection"
        || text.contains("blocked by our safety systems")
        || text.contains("blocked by the safety systems")
        || text.contains("potentially unintended activity")
        || (text.contains("request was blocked") && text.contains("safety"));
    if policy_rejection
        || text.contains("quota threshold")
        || text.contains("quota exhausted")
        || text.contains("credits exhausted")
        || text.contains("invalid_request")
        || text.contains("prompt is too long")
        || text.contains("context length")
        || text.contains("context-length")
        || text.contains("context_length")
        || text.contains("contextlength")
        || text.contains("unsupported model")
    {
        return false;
    }

    matches!(input.status, 502 | 503 | 504 | 507)
        && input.dispatch_phase.as_deref() == Some("transport_queue")
        && input.request_started == Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        schema_version: u64,
        vectors: Vec<RetryVector>,
    }

    #[test]
    fn same_account_retry_decisions_match_shared_typescript_vectors() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../fixtures/same-account-transport-retry-v1.json"
        ))
        .expect("shared retry fixture must be valid JSON");
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.vectors.len() >= 20);

        for vector in fixture.vectors {
            assert_eq!(
                should_retry_same_account(&vector.input),
                vector.expected,
                "{}: {:?}",
                vector.name,
                vector.input
            );
        }
    }
}
