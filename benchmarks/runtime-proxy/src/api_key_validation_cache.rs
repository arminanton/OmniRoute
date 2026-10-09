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

    pub fn generation(&self) -> u64 {
        self.generation
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caches_only_positive_validation_and_expires_at_the_strict_ttl_boundary() {
        let mut cache = ApiKeyValidationCache::default();
        cache.cache_validation_result("hash-valid", true, 1_000);
        cache.cache_validation_result("hash-denied", false, 1_000);

        assert_eq!(cache.cached_validation("hash-valid", 60_999), Some(true));
        assert_eq!(cache.cached_validation("hash-valid", 61_000), None);
        assert_eq!(cache.cached_validation("hash-denied", 1_001), None);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn successful_key_mutation_advances_generation_and_invalidates_cached_authorization() {
        let mut cache = ApiKeyValidationCache::default();
        cache.cache_validation_result("hash-key", true, 5_000);
        let prior_generation = cache.generation();
        assert_eq!(cache.cached_validation("hash-key", 5_001), Some(true));

        cache.invalidate_after_key_write();

        assert_eq!(cache.generation(), prior_generation + 1);
        assert_eq!(cache.cached_validation("hash-key", 5_002), None);
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn bounded_eviction_preserves_map_insertion_order_not_hit_recency() {
        let mut cache = ApiKeyValidationCache::default();
        for index in 0..=MAX_CACHE_SIZE {
            cache.cache_validation_result(&format!("hash-{index}"), true, 10);
        }
        // Reads do not change insertion order in the TypeScript Map.
        assert_eq!(cache.cached_validation("hash-0", 11), Some(true));
        // Size is already > 1,000, so the next insertion evicts the first 200 keys.
        cache.cache_validation_result("hash-new", true, 12);

        assert_eq!(cache.len(), 802);
        assert_eq!(cache.cached_validation("hash-0", 13), None);
        assert_eq!(cache.cached_validation("hash-199", 13), None);
        assert_eq!(cache.cached_validation("hash-200", 13), Some(true));
        assert_eq!(cache.cached_validation("hash-new", 13), Some(true));
    }
}
