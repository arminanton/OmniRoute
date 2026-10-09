//! Versioned, credential-free projection of TypeScript-owned routing decisions.
//!
//! This adapter is benchmark-only. It intentionally does not load database rows, provider
//! credentials, API keys, Redis state, or production caches. TypeScript remains the authority
//! that authenticates API keys, evaluates their limits and allowlists, loads/refreshes connection
//! state, interprets provider quota semantics, applies model rules, and chooses routing strategy
//! and affinity. Rust only rejects a context with an incompatible shape/version/validity window
//! and checks that the supplied candidate facts are internally safe to admit.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

pub const POLICY_CONTEXT_SCHEMA_VERSION: u16 = 1;
const MAX_POLICY_CONTEXT_JSON_BYTES: usize = 1024 * 1024;
const MAX_CANDIDATES: usize = 4096;
const MAX_POLICY_CONTEXT_TTL_MS: u64 = 30_000;

/// A short-lived policy snapshot. IDs in this wire type are opaque, per-request handles, not
/// database identifiers. Do not put API keys, OAuth credentials, prompt content, account names,
/// session keys, or provider-specific data in this structure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PolicyContextV1 {
    pub schema_version: u16,
    pub provider: String,
    pub requested_model: String,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    /// True only after TypeScript has checked key validity/revocation, schedule, endpoint/model
    /// policy, and key-level request/quota limits for this request.
    pub api_key_authorized_for_request: bool,
    pub candidates: Vec<CandidatePolicyV1>,
    /// A routing preference calculated by TypeScript without sending the session-affinity key.
    pub affinity_hint: Option<AffinityHintV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CandidatePolicyV1 {
    /// Opaque candidate handle, generated for this context and mapped back by the TS caller.
    pub candidate_ref: String,
    pub connection_enabled: bool,
    /// Result of the API-key connection allowlist check for this candidate.
    pub allowed_by_api_key: bool,
    /// TS aggregate for account-level terminal/health/suppression rules, excluding cooldown.
    pub account_usable: bool,
    /// Result of per-connection model exclusions, inventory, model locks, and provider scope.
    pub model_allowed: bool,
    pub cooldown_until_unix_ms: Option<u64>,
    pub quota_decision: QuotaDecision,
    pub in_flight: u32,
    /// `None` means TypeScript found no account-level cap. A zero cap admits no work.
    pub max_in_flight: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AffinityHintV1 {
    pub preferred_candidate_ref: String,
    pub expires_at_unix_ms: u64,
}

/// TypeScript collapses provider-specific quota policy into this explicit decision. Unknown quota
/// state is not silently treated as healthy.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuotaDecision {
    Allowed,
    PolicyBlocked,
    Exhausted,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IneligibilityReason {
    ApiKeyDenied,
    ConnectionDisabled,
    AccountUnavailable,
    ModelRestricted,
    CoolingDown,
    QuotaPolicyBlocked,
    QuotaExhausted,
    QuotaUnknown,
    AtCapacity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateEligibility {
    pub candidate_ref: String,
    pub eligible: bool,
    pub reasons: Vec<IneligibilityReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedPolicyContext {
    pub provider: String,
    pub requested_model: String,
    pub candidate_results: Vec<CandidateEligibility>,
    /// Preserved only if the hint is unexpired and its candidate remains eligible.
    pub preferred_candidate_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyContextError {
    InvalidJson,
    UnsupportedVersion(u16),
    InvalidProvider,
    InvalidModel,
    InvalidValidityWindow,
    InvalidCandidateRef,
    DuplicateCandidateRef,
    InvalidAffinityRef,
    PayloadTooLarge,
    TooManyCandidates,
}

impl std::fmt::Display for PolicyContextError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidJson => formatter.write_str("invalid policy context JSON"),
            Self::UnsupportedVersion(version) => {
                write!(
                    formatter,
                    "unsupported policy context schema version {version}"
                )
            }
            Self::InvalidProvider => formatter.write_str("invalid policy context provider"),
            Self::InvalidModel => formatter.write_str("invalid policy context model"),
            Self::InvalidValidityWindow => {
                formatter.write_str("policy context is not valid at the supplied time")
            }
            Self::InvalidCandidateRef => formatter.write_str("invalid candidate reference"),
            Self::DuplicateCandidateRef => formatter.write_str("duplicate candidate reference"),
            Self::InvalidAffinityRef => formatter.write_str("invalid affinity reference"),
            Self::PayloadTooLarge => formatter.write_str("policy context JSON exceeds size limit"),
            Self::TooManyCandidates => {
                formatter.write_str("policy context has too many candidates")
            }
        }
    }
}

impl std::error::Error for PolicyContextError {}

impl PolicyContextV1 {
    /// Parse an exact schema-v1 payload and evaluate its short validity window. Serde denies
    /// unknown fields and requires every non-optional field; future versions fail closed.
    pub fn parse_and_validate(
        json: &str,
        now_unix_ms: u64,
    ) -> Result<ValidatedPolicyContext, PolicyContextError> {
        if json.len() > MAX_POLICY_CONTEXT_JSON_BYTES {
            return Err(PolicyContextError::PayloadTooLarge);
        }
        let context: Self =
            serde_json::from_str(json).map_err(|_| PolicyContextError::InvalidJson)?;
        context.validate(now_unix_ms)
    }

    pub fn validate(self, now_unix_ms: u64) -> Result<ValidatedPolicyContext, PolicyContextError> {
        if self.schema_version != POLICY_CONTEXT_SCHEMA_VERSION {
            return Err(PolicyContextError::UnsupportedVersion(self.schema_version));
        }
        if self.provider.trim().is_empty() || self.provider.len() > 128 {
            return Err(PolicyContextError::InvalidProvider);
        }
        if self.requested_model.trim().is_empty() || self.requested_model.len() > 256 {
            return Err(PolicyContextError::InvalidModel);
        }
        if self.issued_at_unix_ms > now_unix_ms
            || now_unix_ms >= self.expires_at_unix_ms
            || self
                .expires_at_unix_ms
                .saturating_sub(self.issued_at_unix_ms)
                > MAX_POLICY_CONTEXT_TTL_MS
        {
            return Err(PolicyContextError::InvalidValidityWindow);
        }
        if self.candidates.len() > MAX_CANDIDATES {
            return Err(PolicyContextError::TooManyCandidates);
        }

        let mut refs = HashSet::with_capacity(self.candidates.len());
        for candidate in &self.candidates {
            if candidate.candidate_ref.trim().is_empty() || candidate.candidate_ref.len() > 128 {
                return Err(PolicyContextError::InvalidCandidateRef);
            }
            if !refs.insert(candidate.candidate_ref.clone()) {
                return Err(PolicyContextError::DuplicateCandidateRef);
            }
        }
        if let Some(hint) = &self.affinity_hint {
            if hint.preferred_candidate_ref.trim().is_empty()
                || hint.preferred_candidate_ref.len() > 128
                || hint.expires_at_unix_ms > self.expires_at_unix_ms
            {
                return Err(PolicyContextError::InvalidAffinityRef);
            }
        }

        let request_authorized = self.api_key_authorized_for_request;
        let candidate_results = self
            .candidates
            .iter()
            .map(|candidate| evaluate_candidate(candidate, request_authorized, now_unix_ms))
            .collect::<Vec<_>>();

        let preferred_candidate_ref = self.affinity_hint.and_then(|hint| {
            (now_unix_ms < hint.expires_at_unix_ms
                && candidate_results.iter().any(|candidate| {
                    candidate.eligible && candidate.candidate_ref == hint.preferred_candidate_ref
                }))
            .then_some(hint.preferred_candidate_ref)
        });

        Ok(ValidatedPolicyContext {
            provider: self.provider,
            requested_model: self.requested_model,
            candidate_results,
            preferred_candidate_ref,
        })
    }
}

fn evaluate_candidate(
    candidate: &CandidatePolicyV1,
    request_authorized: bool,
    now_unix_ms: u64,
) -> CandidateEligibility {
    let mut reasons = Vec::with_capacity(8);
    if !request_authorized || !candidate.allowed_by_api_key {
        reasons.push(IneligibilityReason::ApiKeyDenied);
    }
    if !candidate.connection_enabled {
        reasons.push(IneligibilityReason::ConnectionDisabled);
    }
    if !candidate.account_usable {
        reasons.push(IneligibilityReason::AccountUnavailable);
    }
    if !candidate.model_allowed {
        reasons.push(IneligibilityReason::ModelRestricted);
    }
    if candidate
        .cooldown_until_unix_ms
        .is_some_and(|until| until > now_unix_ms)
    {
        reasons.push(IneligibilityReason::CoolingDown);
    }
    match candidate.quota_decision {
        QuotaDecision::Allowed => {}
        QuotaDecision::PolicyBlocked => reasons.push(IneligibilityReason::QuotaPolicyBlocked),
        QuotaDecision::Exhausted => reasons.push(IneligibilityReason::QuotaExhausted),
        QuotaDecision::Unknown => reasons.push(IneligibilityReason::QuotaUnknown),
    }
    if candidate
        .max_in_flight
        .is_some_and(|limit| candidate.in_flight >= limit)
    {
        reasons.push(IneligibilityReason::AtCapacity);
    }
    CandidateEligibility {
        candidate_ref: candidate.candidate_ref.clone(),
        eligible: reasons.is_empty(),
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 10_000;

    fn candidate(candidate_ref: &str) -> CandidatePolicyV1 {
        CandidatePolicyV1 {
            candidate_ref: candidate_ref.into(),
            connection_enabled: true,
            allowed_by_api_key: true,
            account_usable: true,
            model_allowed: true,
            cooldown_until_unix_ms: None,
            quota_decision: QuotaDecision::Allowed,
            in_flight: 0,
            max_in_flight: Some(4),
        }
    }

    fn context() -> PolicyContextV1 {
        PolicyContextV1 {
            schema_version: POLICY_CONTEXT_SCHEMA_VERSION,
            provider: "antigravity".into(),
            requested_model: "gemini-3.8-flash".into(),
            issued_at_unix_ms: NOW - 1,
            expires_at_unix_ms: NOW + 1_000,
            api_key_authorized_for_request: true,
            candidates: vec![candidate("candidate-a")],
            affinity_hint: None,
        }
    }

    fn validated(context: PolicyContextV1) -> ValidatedPolicyContext {
        context.validate(NOW).expect("valid context")
    }

    #[test]
    fn round_trips_only_explicit_credential_free_fields() {
        let encoded = serde_json::to_string(&context()).expect("serialize");
        let payload: serde_json::Value = serde_json::from_str(&encoded).expect("JSON object");
        for forbidden_field in ["api_key", "access_token", "refresh_token", "session_key"] {
            assert!(
                payload.get(forbidden_field).is_none(),
                "unexpected {forbidden_field}"
            );
        }
        let result = PolicyContextV1::parse_and_validate(&encoded, NOW).expect("validate");
        assert!(result.candidate_results[0].eligible);
    }

    #[test]
    fn rejects_version_mismatch() {
        let mut value = context();
        value.schema_version = POLICY_CONTEXT_SCHEMA_VERSION + 1;
        assert_eq!(
            value.validate(NOW),
            Err(PolicyContextError::UnsupportedVersion(2))
        );
    }

    #[test]
    fn rejects_missing_required_and_unknown_fields() {
        let encoded = serde_json::to_string(&context()).expect("serialize");
        let missing = encoded.replace("\"api_key_authorized_for_request\":true,", "");
        assert_eq!(
            PolicyContextV1::parse_and_validate(&missing, NOW),
            Err(PolicyContextError::InvalidJson)
        );

        let unknown = encoded.replacen("{", "{\"access_token\":\"secret\",", 1);
        assert_eq!(
            PolicyContextV1::parse_and_validate(&unknown, NOW),
            Err(PolicyContextError::InvalidJson)
        );

        let candidate_unknown = encoded.replacen(
            "\"candidate_ref\":\"candidate-a\"",
            "\"candidate_ref\":\"candidate-a\",\"oauth_token\":\"secret\"",
            1,
        );
        assert_eq!(
            PolicyContextV1::parse_and_validate(&candidate_unknown, NOW),
            Err(PolicyContextError::InvalidJson)
        );
    }

    #[test]
    fn rejects_expired_or_not_yet_issued_context() {
        let mut expired = context();
        expired.expires_at_unix_ms = NOW;
        assert_eq!(
            expired.validate(NOW),
            Err(PolicyContextError::InvalidValidityWindow)
        );

        let mut future = context();
        future.issued_at_unix_ms = NOW + 1;
        assert_eq!(
            future.validate(NOW),
            Err(PolicyContextError::InvalidValidityWindow)
        );

        let mut long_lived = context();
        long_lived.expires_at_unix_ms = NOW + MAX_POLICY_CONTEXT_TTL_MS + 1;
        assert_eq!(
            long_lived.validate(NOW),
            Err(PolicyContextError::InvalidValidityWindow)
        );
    }

    #[test]
    fn bounds_context_payload_and_candidate_count() {
        let too_large = " ".repeat(MAX_POLICY_CONTEXT_JSON_BYTES + 1);
        assert_eq!(
            PolicyContextV1::parse_and_validate(&too_large, NOW),
            Err(PolicyContextError::PayloadTooLarge)
        );

        let mut too_many = context();
        too_many.candidates = (0..=MAX_CANDIDATES)
            .map(|index| candidate(&format!("candidate-{index}")))
            .collect();
        assert_eq!(
            too_many.validate(NOW),
            Err(PolicyContextError::TooManyCandidates)
        );
    }

    #[test]
    fn disabled_or_key_disallowed_connections_fail_closed() {
        let mut disabled = context();
        disabled.candidates[0].connection_enabled = false;
        let result = validated(disabled);
        assert_eq!(
            result.candidate_results[0].reasons,
            vec![IneligibilityReason::ConnectionDisabled]
        );

        let mut disallowed = context();
        disallowed.candidates[0].allowed_by_api_key = false;
        assert_eq!(
            validated(disallowed).candidate_results[0].reasons,
            vec![IneligibilityReason::ApiKeyDenied]
        );

        let mut unauthorized = context();
        unauthorized.api_key_authorized_for_request = false;
        assert!(!validated(unauthorized).candidate_results[0].eligible);
    }

    #[test]
    fn model_restrictions_cooldowns_and_quota_states_fail_closed() {
        let mut restricted = context();
        restricted.candidates[0].model_allowed = false;
        assert_eq!(
            validated(restricted).candidate_results[0].reasons,
            vec![IneligibilityReason::ModelRestricted]
        );

        let mut cooling = context();
        cooling.candidates[0].cooldown_until_unix_ms = Some(NOW + 1);
        assert_eq!(
            validated(cooling).candidate_results[0].reasons,
            vec![IneligibilityReason::CoolingDown]
        );

        let mut cooldown_over = context();
        cooldown_over.candidates[0].cooldown_until_unix_ms = Some(NOW);
        assert!(validated(cooldown_over).candidate_results[0].eligible);

        for (decision, expected) in [
            (
                QuotaDecision::PolicyBlocked,
                IneligibilityReason::QuotaPolicyBlocked,
            ),
            (
                QuotaDecision::Exhausted,
                IneligibilityReason::QuotaExhausted,
            ),
            (QuotaDecision::Unknown, IneligibilityReason::QuotaUnknown),
        ] {
            let mut quota_blocked = context();
            quota_blocked.candidates[0].quota_decision = decision;
            assert_eq!(
                validated(quota_blocked).candidate_results[0].reasons,
                vec![expected]
            );
        }

        let encoded = serde_json::to_string(&context()).expect("serialize");
        let future_state = encoded.replace("\"allowed\"", "\"future_quota_state\"");
        assert_eq!(
            PolicyContextV1::parse_and_validate(&future_state, NOW),
            Err(PolicyContextError::InvalidJson)
        );
    }

    #[test]
    fn enforces_capacity_and_keeps_affinity_only_for_an_eligible_candidate() {
        let mut full = context();
        full.candidates[0].in_flight = 4;
        full.affinity_hint = Some(AffinityHintV1 {
            preferred_candidate_ref: "candidate-a".into(),
            expires_at_unix_ms: NOW + 10,
        });
        let result = validated(full);
        assert_eq!(
            result.candidate_results[0].reasons,
            vec![IneligibilityReason::AtCapacity]
        );
        assert_eq!(result.preferred_candidate_ref, None);

        let mut pinned = context();
        pinned.affinity_hint = Some(AffinityHintV1 {
            preferred_candidate_ref: "candidate-a".into(),
            expires_at_unix_ms: NOW + 10,
        });
        assert_eq!(
            validated(pinned).preferred_candidate_ref.as_deref(),
            Some("candidate-a")
        );

        let mut expired_pin = context();
        expired_pin.affinity_hint = Some(AffinityHintV1 {
            preferred_candidate_ref: "candidate-a".into(),
            expires_at_unix_ms: NOW,
        });
        assert_eq!(validated(expired_pin).preferred_candidate_ref, None);

        let mut pin_outlives_context = context();
        pin_outlives_context.affinity_hint = Some(AffinityHintV1 {
            preferred_candidate_ref: "candidate-a".into(),
            expires_at_unix_ms: NOW + 1_001,
        });
        assert_eq!(
            pin_outlives_context.validate(NOW),
            Err(PolicyContextError::InvalidAffinityRef)
        );
    }

    #[test]
    fn rejects_duplicate_opaque_candidate_handles() {
        let mut duplicate = context();
        duplicate.candidates.push(candidate("candidate-a"));
        assert_eq!(
            duplicate.validate(NOW),
            Err(PolicyContextError::DuplicateCandidateRef)
        );
    }
}
