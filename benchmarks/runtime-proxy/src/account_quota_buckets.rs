//! Benchmark-only mirror of OmniRoute's process-local provider quota buckets.
//!
//! The policy mirrors `src/lib/quota/accountBuckets.ts`: a connection/window is saturated at
//! 100%, below-threshold observations clear old saturation, and reset is lazy at `now >= reset`.
//! Usage-reset strings are represented here as an already-parsed epoch timestamp; JavaScript's
//! broad `Date.parse()` grammar is deliberately outside this pure Rust policy slice. This module
//! is not connected to provider accounts, usage fetching, or production routing.

use std::collections::HashMap;

pub const SATURATION_THRESHOLD_PCT: f64 = 100.0;

#[derive(Debug, Clone, Copy, PartialEq)]
struct BucketEntry {
    resets_at_ms: i64,
}

/// The normalized subset of one TypeScript `UsageQuotaSlim` record consumed by bucket policy.
/// `used_pct: None` represents a malformed/missing `used` value, which TypeScript skips.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UsageQuota {
    pub used_pct: Option<f64>,
    /// Equivalent to `Date.parse(resetAt)`; zero/None means unknown reset time.
    pub reset_at_ms: Option<i64>,
}

/// Process-local saturated-account state, kept separate from the synthetic scheduler's boolean
/// `quota_exhausted` input so policy can be tested against the TypeScript lazy-reset behavior.
#[derive(Debug, Default)]
pub struct AccountQuotaBuckets {
    entries: HashMap<String, BucketEntry>,
}

impl AccountQuotaBuckets {
    /// Missing or malformed identity is fail-open. An expired entry is removed on read, exactly
    /// when `now_ms >= resets_at_ms`; unknown reset time keeps a saturated bucket until updated.
    pub fn is_saturated(&mut self, connection_id: &str, window_key: &str, now_ms: i64) -> bool {
        if connection_id.is_empty() || window_key.is_empty() {
            return false;
        }
        let key = store_key(connection_id, window_key);
        let Some(entry) = self.entries.get(&key).copied() else {
            return false;
        };
        if entry.resets_at_ms > 0 && now_ms >= entry.resets_at_ms {
            self.entries.remove(&key);
            return false;
        }
        true
    }

    /// Record one usage observation. An observation after its own reset is stale and clears the
    /// bucket; finite values below 100% also clear previous saturation.
    pub fn record_usage(
        &mut self,
        connection_id: &str,
        window_key: &str,
        used_pct: f64,
        reset_at_ms: Option<i64>,
        now_ms: i64,
    ) {
        if connection_id.is_empty() || window_key.is_empty() {
            return;
        }
        let key = store_key(connection_id, window_key);
        let resets_at_ms = reset_at_ms.filter(|value| *value > 0).unwrap_or(0);
        if resets_at_ms > 0 && now_ms >= resets_at_ms {
            self.entries.remove(&key);
            return;
        }
        if !used_pct.is_finite() || used_pct < SATURATION_THRESHOLD_PCT {
            self.entries.remove(&key);
            return;
        }
        self.entries.insert(key, BucketEntry { resets_at_ms });
    }

    /// Translate the `getClaudeUsage().quotas` key convention used by the TypeScript helper.
    /// Missing result/maps and malformed records are no-ops, preserving prior observations.
    pub fn update_account_buckets(
        &mut self,
        connection_id: &str,
        quotas: Option<&HashMap<String, UsageQuota>>,
        now_ms: i64,
    ) {
        if connection_id.is_empty() {
            return;
        }
        let Some(quotas) = quotas else {
            return;
        };

        self.process_quota_entry(connection_id, "5h", quotas.get("session (5h)"), now_ms);
        self.process_quota_entry(connection_id, "7d", quotas.get("weekly (7d)"), now_ms);

        for (source_key, entry) in quotas {
            if let Some(model) = weekly_model_window(source_key) {
                self.process_quota_entry(
                    connection_id,
                    &format!("7d:{model}"),
                    Some(entry),
                    now_ms,
                );
            }
        }
    }

    fn process_quota_entry(
        &mut self,
        connection_id: &str,
        window_key: &str,
        entry: Option<&UsageQuota>,
        now_ms: i64,
    ) {
        let Some(UsageQuota {
            used_pct: Some(used_pct),
            reset_at_ms,
        }) = entry
        else {
            return;
        };
        self.record_usage(connection_id, window_key, *used_pct, *reset_at_ms, now_ms);
    }
}

fn store_key(connection_id: &str, window_key: &str) -> String {
    // Match the TypeScript Map key format used by accountBuckets.ts.
    format!("{connection_id}::{window_key}")
}

fn weekly_model_window(key: &str) -> Option<&str> {
    let model = key.strip_prefix("weekly ")?.strip_suffix(" (7d)")?;
    // JavaScript's /^weekly (.+) \(7d\)$/ requires at least one non-line-terminator character.
    (!model.is_empty() && !model.contains(['\n', '\r', '\u{2028}', '\u{2029}'])).then_some(model)
}

#[cfg(test)]
mod tests {
    use super::{AccountQuotaBuckets, UsageQuota};
    use std::collections::HashMap;

    #[test]
    fn shared_vectors_match_typescript_account_bucket_contract() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/account-quota-buckets-v1.json"))
                .expect("shared account quota bucket vectors must be valid JSON");
        assert_eq!(fixture["schemaVersion"].as_u64(), Some(1));

        for vector in fixture["vectors"].as_array().expect("vector array") {
            let name = vector["name"].as_str().expect("vector name");
            let mut buckets = AccountQuotaBuckets::default();
            for action in vector["actions"].as_array().expect("action array") {
                let operation = action["op"].as_str().expect("operation");
                let connection_id = action["connectionId"].as_str().expect("connection ID");
                let window_key = action["windowKey"].as_str().expect("window key");
                let now_ms = action["nowMs"].as_i64().expect("now timestamp");
                match operation {
                    "record" => buckets.record_usage(
                        connection_id,
                        window_key,
                        action["usedPct"].as_f64().expect("used percentage"),
                        action["resetAtMs"].as_i64(),
                        now_ms,
                    ),
                    "check" => assert_eq!(
                        buckets.is_saturated(connection_id, window_key, now_ms),
                        action["expected"].as_bool().expect("expected saturation"),
                        "{name}: {action:?}"
                    ),
                    other => panic!("{name}: unsupported fixture operation {other}"),
                }
            }
        }
    }

    #[test]
    fn saturation_threshold_and_lazy_reset_match_typescript_boundary() {
        let mut buckets = AccountQuotaBuckets::default();
        buckets.record_usage("connection-a", "5h", 99.999, Some(5_000), 1_000);
        assert!(!buckets.is_saturated("connection-a", "5h", 1_000));

        buckets.record_usage("connection-a", "5h", 100.0, Some(5_000), 1_000);
        assert!(buckets.is_saturated("connection-a", "5h", 4_999));
        assert!(!buckets.is_saturated("connection-a", "5h", 5_000));
        assert!(!buckets.is_saturated("connection-a", "5h", 5_001));
    }

    #[test]
    fn missing_or_invalid_reset_persists_until_a_new_observation() {
        let mut buckets = AccountQuotaBuckets::default();
        buckets.record_usage("connection-a", "7d", 100.0, None, 1_000);
        assert!(buckets.is_saturated("connection-a", "7d", i64::MAX));

        buckets.record_usage("connection-a", "7d", 100.0, Some(0), 2_000);
        assert!(buckets.is_saturated("connection-a", "7d", 2_000));

        buckets.record_usage("connection-a", "7d", 85.0, None, 3_000);
        assert!(!buckets.is_saturated("connection-a", "7d", 3_000));
    }

    #[test]
    fn stale_saturated_observation_after_reset_clears_instead_of_reopening_bucket() {
        let mut buckets = AccountQuotaBuckets::default();
        buckets.record_usage("connection-a", "5h", 100.0, Some(2_000), 1_000);
        buckets.record_usage("connection-a", "5h", 100.0, Some(2_000), 2_000);
        assert!(!buckets.is_saturated("connection-a", "5h", 2_000));
    }

    #[test]
    fn account_and_window_keys_are_independent_and_empty_ids_fail_open() {
        let mut buckets = AccountQuotaBuckets::default();
        buckets.record_usage("connection-a", "5h", 100.0, None, 1_000);
        buckets.record_usage("connection-b", "7d", 100.0, None, 1_000);
        assert!(buckets.is_saturated("connection-a", "5h", 1_000));
        assert!(!buckets.is_saturated("connection-a", "7d", 1_000));
        assert!(buckets.is_saturated("connection-b", "7d", 1_000));
        assert!(!buckets.is_saturated("", "5h", 1_000));
        assert!(!buckets.is_saturated("connection-a", "", 1_000));
    }

    #[test]
    fn usage_payload_names_map_fixed_and_model_specific_windows() {
        let mut buckets = AccountQuotaBuckets::default();
        let quotas = HashMap::from([
            (
                "session (5h)".to_owned(),
                UsageQuota {
                    used_pct: Some(100.0),
                    reset_at_ms: Some(10_000),
                },
            ),
            (
                "weekly (7d)".to_owned(),
                UsageQuota {
                    used_pct: Some(40.0),
                    reset_at_ms: None,
                },
            ),
            (
                "weekly sonnet (7d)".to_owned(),
                UsageQuota {
                    used_pct: Some(100.0),
                    reset_at_ms: Some(20_000),
                },
            ),
            (
                "weekly opus (7d)".to_owned(),
                UsageQuota {
                    used_pct: Some(70.0),
                    reset_at_ms: None,
                },
            ),
            (
                "weekly  (7d)".to_owned(),
                UsageQuota {
                    used_pct: Some(100.0),
                    reset_at_ms: None,
                },
            ),
        ]);

        buckets.update_account_buckets("connection-a", Some(&quotas), 1_000);
        assert!(buckets.is_saturated("connection-a", "5h", 1_000));
        assert!(!buckets.is_saturated("connection-a", "7d", 1_000));
        assert!(buckets.is_saturated("connection-a", "7d:sonnet", 1_000));
        assert!(!buckets.is_saturated("connection-a", "7d:opus", 1_000));
        assert!(!buckets.is_saturated("connection-a", "7d:", 1_000));
    }

    #[test]
    fn absent_payload_or_malformed_entry_does_not_clear_existing_bucket() {
        let mut buckets = AccountQuotaBuckets::default();
        buckets.record_usage("connection-a", "5h", 100.0, None, 1_000);
        buckets.update_account_buckets("connection-a", None, 2_000);
        assert!(buckets.is_saturated("connection-a", "5h", 2_000));

        let malformed = HashMap::from([(
            "session (5h)".to_owned(),
            UsageQuota {
                used_pct: None,
                reset_at_ms: None,
            },
        )]);
        buckets.update_account_buckets("connection-a", Some(&malformed), 3_000);
        assert!(buckets.is_saturated("connection-a", "5h", 3_000));
    }
}
