//! Benchmark-only mirror of OmniRoute's process-local positive API-key validation cache.
//!
//! The TypeScript implementation lives in `src/lib/db/apiKeys.ts`: it caches successful
//! validations for 60 seconds, does not cache denials, and clears validation/metadata caches
//! after key writes (including revoke). This module uses a monotonically increasing local
//! generation to represent that clear operation. It does not implement key hashing, SQLite,
//! Redis, metadata policy, or cross-process invalidation; callers must pass an opaque key hash,
//! never the credential itself.

use std::collections::{HashMap, VecDeque};

pub const API_KEY_VALIDATION_TTL_MS: i64 = 60_000;
const MAX_CACHE_SIZE: usize = 1_000;
const EVICT_COUNT: usize = 200;

/// Synthetic shared policy-generation source used only by the benchmark parity probe.
/// TypeScript does not currently publish this generation or an equivalent event contract.
#[derive(Debug, Default)]
pub struct SharedPolicyGeneration {
    generation: u64,
}

impl SharedPolicyGeneration {
    pub fn current(&self) -> u64 {
        self.generation
    }

    /// Simulate a committed key/policy mutation advancing the shared generation.
    pub fn advance_after_policy_write(&mut self) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.generation
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Entry {
    generation: u64,
    validated_at_ms: i64,
}

/// Process-local positive-validation cache model. `cache_validation_result` is called only
/// after the authoritative validator has returned; failed validations are intentionally absent.
#[derive(Debug, Default)]
pub struct ApiKeyValidationCache {
    generation: u64,
    shared_generation: u64,
    entries: HashMap<String, Entry>,
    insertion_order: VecDeque<String>,
}

impl ApiKeyValidationCache {
    /// Return `Some(true)` only while a successful validation remains in this generation and
    /// within the TypeScript cache's strict `< 60s` freshness window.
    pub fn cached_validation(&self, opaque_key_hash: &str, now_ms: i64) -> Option<bool> {
        let entry = self.entries.get(opaque_key_hash)?;
        if entry.generation != self.generation {
            return None;
        }
        let age_ms = now_ms.saturating_sub(entry.validated_at_ms);
        (age_ms < API_KEY_VALIDATION_TTL_MS).then_some(true)
    }

    /// Mirror `validateApiKey()`'s positive-only insertion: a denial is not cached.
    pub fn cache_validation_result(&mut self, opaque_key_hash: &str, valid: bool, now_ms: i64) {
        if !valid {
            return;
        }

        // Match TypeScript's insertion-ordered Map policy: inspect before insertion, evict the
        // first 20% only when already above 1,000, and do not move cache hits to the tail.
        if self.entries.len() > MAX_CACHE_SIZE {
            for _ in 0..EVICT_COUNT {
                let Some(oldest) = self.insertion_order.pop_front() else {
                    break;
                };
                self.entries.remove(&oldest);
            }
        }

        let key = opaque_key_hash.to_owned();
        if !self.entries.contains_key(&key) {
            self.insertion_order.push_back(key.clone());
        }
        self.entries.insert(
            key,
            Entry {
                generation: self.generation,
                validated_at_ms: now_ms,
            },
        );
    }

    /// Mirror the process-local `invalidateCaches()` call after successful key mutations.
    /// The version also makes stale snapshot detection explicit for future adapters.
    pub fn invalidate_after_key_write(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.entries.clear();
        self.insertion_order.clear();
    }

    /// Apply a successfully delivered shared invalidation event. A newer generation clears
    /// this process's positives; old or duplicate events cannot roll state backward.
    pub fn apply_shared_generation(&mut self, generation: u64) -> bool {
        if generation <= self.shared_generation {
            return false;
        }
        self.shared_generation = generation;
        self.generation = self.generation.saturating_add(1);
        self.entries.clear();
        self.insertion_order.clear();
        true
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn shared_typescript_action_vectors_define_local_cache_parity() {
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/api-key-validation-cache-v1.json"))
                .expect("shared API-key cache fixture must be valid JSON");
        assert_eq!(fixture["schemaVersion"].as_u64(), Some(1));
        assert_eq!(
            fixture["policy"]["ttlMs"].as_i64(),
            Some(API_KEY_VALIDATION_TTL_MS)
        );
        assert_eq!(
            fixture["policy"]["maxEntries"].as_u64(),
            Some(MAX_CACHE_SIZE as u64)
        );
        assert_eq!(
            fixture["policy"]["evictEntries"].as_u64(),
            Some(EVICT_COUNT as u64)
        );

        for vector in fixture["vectors"].as_array().expect("vectors array") {
            let vector_name = vector["name"].as_str().expect("vector name");
            let mut cache = ApiKeyValidationCache::default();
            let mut authoritative_validity = HashMap::<String, bool>::new();

            for (action_index, action) in vector["actions"]
                .as_array()
                .expect("vector actions")
                .iter()
                .enumerate()
            {
                let op = action["op"].as_str().expect("action op");
                let key = action["key"].as_str();
                let at_ms = action["atMs"].as_i64().unwrap_or_default();
                let context = format!("{vector_name} action {action_index} ({op})");

                match op {
                    "seed-key" => {
                        authoritative_validity.insert(
                            key.expect("seed key").to_owned(),
                            action["valid"].as_bool().expect("seed validity"),
                        );
                    }
                    "seed-valid-range" => {
                        let prefix = action["prefix"].as_str().expect("range prefix");
                        let start = action["start"].as_u64().expect("range start");
                        let end = action["endInclusive"].as_u64().expect("range end");
                        for index in start..=end {
                            authoritative_validity.insert(format!("{prefix}{index}"), true);
                        }
                    }
                    "set-authoritative-validity" => {
                        authoritative_validity.insert(
                            key.expect("state key").to_owned(),
                            action["valid"].as_bool().expect("state validity"),
                        );
                    }
                    "validate" => {
                        apply_validation_action(
                            &mut cache,
                            &authoritative_validity,
                            key.expect("validation key"),
                            at_ms,
                            action["expected"].as_bool().expect("expected result"),
                            &context,
                        );
                    }
                    "validate-range" => {
                        let prefix = action["prefix"].as_str().expect("range prefix");
                        let start = action["start"].as_u64().expect("range start");
                        let end = action["endInclusive"].as_u64().expect("range end");
                        for index in start..=end {
                            let range_key = format!("{prefix}{index}");
                            apply_validation_action(
                                &mut cache,
                                &authoritative_validity,
                                &range_key,
                                at_ms,
                                true,
                                &format!("{context} key {range_key}"),
                            );
                        }
                    }
                    "write-invalidate" => {
                        authoritative_validity.insert(
                            key.expect("write key").to_owned(),
                            action["valid"].as_bool().expect("write validity"),
                        );
                        cache.invalidate_after_key_write();
                    }
                    "revoke" => {
                        authoritative_validity.insert(key.expect("revoke key").to_owned(), false);
                        cache.invalidate_after_key_write();
                    }
                    other => panic!("{context}: unsupported fixture operation {other}"),
                }
            }
        }
    }

    #[test]
    fn local_revocation_invalidates_the_writer_cache_immediately() {
        let mut cache = ApiKeyValidationCache::default();
        let mut authoritative_validity = HashMap::from([("key-a".to_owned(), true)]);
        cache.cache_validation_result("key-a", true, 1_000);
        assert_eq!(cache.cached_validation("key-a", 1_001), Some(true));

        authoritative_validity.insert("key-a".to_owned(), false);
        cache.invalidate_after_key_write();

        assert_eq!(cache.cached_validation("key-a", 1_002), None);
        let valid = *authoritative_validity.get("key-a").unwrap();
        cache.cache_validation_result("key-a", valid, 1_002);
        assert!(!valid);
        assert_eq!(cache.cached_validation("key-a", 1_003), None);
    }

    #[test]
    fn successful_shared_invalidation_clears_a_second_process_cache() {
        let mut writer = ApiKeyValidationCache::default();
        let mut reader = ApiKeyValidationCache::default();
        let mut shared_generation = SharedPolicyGeneration::default();
        writer.cache_validation_result("key-a", true, 1_000);
        reader.cache_validation_result("key-a", true, 1_000);
        assert_eq!(reader.cached_validation("key-a", 1_001), Some(true));

        // The writer commits the revoke, clears its local cache, then publishes the new epoch.
        writer.invalidate_after_key_write();
        let event_generation = shared_generation.advance_after_policy_write();
        assert_eq!(shared_generation.current(), event_generation);
        // A separate local write advances the cache-local counter independently of the shared
        // epoch. The shared event must still be recognized as new.
        reader.invalidate_after_key_write();
        reader.cache_validation_result("key-a", true, 1_001);
        assert!(reader.apply_shared_generation(event_generation));
        assert_eq!(reader.cached_validation("key-a", 1_002), None);
        assert!(!reader.apply_shared_generation(event_generation));
        assert!(!reader.apply_shared_generation(event_generation - 1));
    }

    #[test]
    fn missed_shared_invalidation_expires_local_positive_at_the_ttl_boundary() {
        let mut reader = ApiKeyValidationCache::default();
        let mut shared_generation = SharedPolicyGeneration::default();
        let authoritative_validity = HashMap::from([("key-a".to_owned(), false)]);
        reader.cache_validation_result("key-a", true, 1_000);
        let event_generation = shared_generation.advance_after_policy_write();

        // Simulate failed event delivery: the shared authority advanced, but the reader never
        // applied the event and can continue using its old positive only until its local TTL.
        assert_eq!(shared_generation.current(), event_generation);
        assert_eq!(reader.generation(), 0);
        assert_eq!(
            reader.cached_validation("key-a", 1_000 + API_KEY_VALIDATION_TTL_MS - 1),
            Some(true)
        );
        assert_eq!(
            reader.cached_validation("key-a", 1_000 + API_KEY_VALIDATION_TTL_MS),
            None
        );
        let valid = *authoritative_validity.get("key-a").unwrap();
        reader.cache_validation_result("key-a", valid, 1_000 + API_KEY_VALIDATION_TTL_MS);
        assert!(!valid);
        assert_eq!(
            reader.cached_validation("key-a", 1_000 + API_KEY_VALIDATION_TTL_MS + 1),
            None
        );
    }

    fn apply_validation_action(
        cache: &mut ApiKeyValidationCache,
        authoritative_validity: &HashMap<String, bool>,
        key: &str,
        now_ms: i64,
        expected: bool,
        context: &str,
    ) {
        let actual = cache.cached_validation(key, now_ms).unwrap_or_else(|| {
            let valid = *authoritative_validity
                .get(key)
                .unwrap_or_else(|| panic!("{context}: missing authoritative key state"));
            cache.cache_validation_result(key, valid, now_ms);
            valid
        });
        assert_eq!(actual, expected, "{context}: key {key} at {now_ms}ms");
    }
}
