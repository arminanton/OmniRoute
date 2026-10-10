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
    use rusqlite::{Connection, OptionalExtension, params};
    use serde_json::Value;

    /// Run the positive cache in front of a SQLite `api_keys` row shaped like the authority
    /// queried by `validateApiKey()` in `src/lib/db/apiKeys.ts`. Kept test-only: this prototype
    /// does not own production credentials or a production database connection.
    fn validate_from_sqlite(
        cache: &mut ApiKeyValidationCache,
        db: &Connection,
        opaque_key_hash: &str,
        presented_key: &str,
        now_ms: i64,
    ) -> rusqlite::Result<bool> {
        if cache
            .cached_validation(opaque_key_hash, now_ms)
            .is_some_and(|valid| valid)
        {
            return Ok(true);
        }

        let row = db
            .query_row(
                "SELECT is_active, is_banned, revoked_at, expires_at FROM api_keys
                 WHERE key = ?1 OR key_hash = ?2",
                params![presented_key, opaque_key_hash],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;

        let valid = row.is_some_and(|(is_active, is_banned, revoked_at, expires_at)| {
            let expired = expires_at
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .and_then(parse_iso_expiry_timestamp_ms)
                .is_some_and(|expires_at_ms| expires_at_ms <= now_ms);

            // Match rowParsers.ts: inactive only when exactly 0; banned only when exactly 1.
            is_active != Some(0)
                && is_banned != Some(1)
                && !revoked_at.is_some_and(|value| !value.trim().is_empty())
                && !expired
        });
        cache.cache_validation_result(opaque_key_hash, valid, now_ms);
        Ok(valid)
    }

    /// Parse the ISO date-only and date-time-with-explicit-zone shapes used by the shared vectors.
    /// JavaScript's Date.parse accepts a broader grammar; unsupported/malformed values intentionally
    /// return None because validateApiKey() ignores expiry strings for which Date.parse is non-finite.
    fn parse_iso_expiry_timestamp_ms(value: &str) -> Option<i64> {
        let bytes = value.as_bytes();
        if !bytes.is_ascii() || bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }

        let number = |start: usize, end: usize| -> Option<i64> {
            let slice = bytes.get(start..end)?;
            if !slice.iter().all(u8::is_ascii_digit) {
                return None;
            }
            std::str::from_utf8(slice).ok()?.parse().ok()
        };

        let year = number(0, 4)?;
        let month = number(5, 7)?;
        let day = number(8, 10)?;
        if !(1..=9999).contains(&year) || !(1..=12).contains(&month) {
            return None;
        }
        let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let days_in_month = match month {
            2 if leap_year => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        if !(1..=days_in_month).contains(&day) {
            return None;
        }

        let days_since_epoch = days_from_civil(year, month, day);
        // ECMAScript parses ISO date-only values as UTC midnight. Keep this deterministic subset
        // explicit: date-times without a zone depend on the process-local timezone and are omitted.
        if bytes.len() == 10 {
            return Some(days_since_epoch * 86_400_000);
        }
        if bytes.len() < 20 || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
            return None;
        }

        let hour = number(11, 13)?;
        let minute = number(14, 16)?;
        let second = number(17, 19)?;
        if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=59).contains(&second) {
            return None;
        }

        let mut remainder = &bytes[19..];
        let mut fraction_ms = 0;
        if remainder.first() == Some(&b'.') {
            let zone_start = remainder
                .iter()
                .position(|byte| *byte == b'Z' || *byte == b'+' || *byte == b'-')?;
            let fraction = &remainder[1..zone_start];
            if fraction.is_empty() || !fraction.iter().all(u8::is_ascii_digit) {
                return None;
            }
            let millis_digits = &fraction[..fraction.len().min(3)];
            let parsed: i64 = std::str::from_utf8(millis_digits).ok()?.parse().ok()?;
            fraction_ms = parsed * 10_i64.pow((3 - millis_digits.len()) as u32);
            remainder = &remainder[zone_start..];
        }

        // Only explicit UTC or ISO-8601 ±HH:MM zones are mirrored here. Local-time dates and
        // JavaScript's legacy/non-ISO Date.parse forms remain outside this prototype's contract.
        let offset_minutes = match remainder {
            [b'Z'] => 0,
            [
                sign @ (b'+' | b'-'),
                offset_hour_tens,
                offset_hour_ones,
                b':',
                offset_minute_tens,
                offset_minute_ones,
            ] => {
                if !offset_hour_tens.is_ascii_digit()
                    || !offset_hour_ones.is_ascii_digit()
                    || !offset_minute_tens.is_ascii_digit()
                    || !offset_minute_ones.is_ascii_digit()
                {
                    return None;
                }
                let offset_hour =
                    i64::from(offset_hour_tens - b'0') * 10 + i64::from(offset_hour_ones - b'0');
                let offset_minute = i64::from(offset_minute_tens - b'0') * 10
                    + i64::from(offset_minute_ones - b'0');
                if offset_hour > 23 || offset_minute > 59 {
                    return None;
                }
                let magnitude = offset_hour * 60 + offset_minute;
                if *sign == b'+' { magnitude } else { -magnitude }
            }
            _ => return None,
        };

        let local_clock_ms = hour * 3_600_000 + minute * 60_000 + second * 1_000 + fraction_ms;
        Some(days_since_epoch * 86_400_000 + local_clock_ms - offset_minutes * 60_000)
    }

    fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
        let adjusted_year = year - i64::from(month <= 2);
        let era = adjusted_year.div_euclid(400);
        let year_of_era = adjusted_year - era * 400;
        let adjusted_month = month + if month > 2 { -3 } else { 9 };
        let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468
    }

    fn sqlite_api_key_authority() -> Connection {
        let db = empty_sqlite_api_key_authority();
        db.execute_batch(
            "INSERT INTO api_keys (id, key, key_hash, is_active, is_banned)
             VALUES ('fixture-id', 'fixture-presented-key', 'opaque-hash-1', 1, 0);",
        )
        .expect("create source-shaped API-key row");
        db
    }

    fn empty_sqlite_api_key_authority() -> Connection {
        let db = Connection::open_in_memory().expect("open in-memory API-key database");
        db.execute_batch(
            "CREATE TABLE api_keys (
                id TEXT PRIMARY KEY,
                key TEXT NOT NULL UNIQUE,
                key_hash TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                is_banned INTEGER NOT NULL DEFAULT 0,
                revoked_at TEXT,
                expires_at TEXT
             );",
        )
        .expect("create source-shaped API-key table");
        db
    }

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
    fn shared_expiry_parse_vectors_match_iso_subset_used_by_typescript() {
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/api-key-validation-cache-v1.json"))
                .expect("shared API-key cache fixture must be valid JSON");

        for vector in fixture["expiryParseCases"]
            .as_array()
            .expect("expiry parse cases array")
        {
            let name = vector["name"].as_str().expect("case name");
            let value = vector["value"].as_str().expect("expiry string");
            let actual = parse_iso_expiry_timestamp_ms(value);
            let expected = vector["expectedEpochMs"].as_i64();
            assert_eq!(actual, expected, "{name}: parse {value:?}");
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
    fn sqlite_revoke_clears_writer_but_other_worker_positive_expires_at_ttl() {
        let db = sqlite_api_key_authority();
        let mut writer_cache = ApiKeyValidationCache::default();
        let mut other_worker_cache = ApiKeyValidationCache::default();
        let key_hash = "opaque-hash-1";
        let presented_key = "fixture-presented-key";

        assert!(
            validate_from_sqlite(&mut writer_cache, &db, key_hash, presented_key, 1_000,)
                .expect("writer validates active key")
        );
        assert!(
            validate_from_sqlite(&mut other_worker_cache, &db, key_hash, presented_key, 1_000,)
                .expect("second worker validates active key")
        );

        // Match revokeApiKey(): commit the SQLite lifecycle fields first, then clear the
        // process-local cache in the worker which performed the write.
        db.execute(
            "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?1), is_active = 0 WHERE id = ?2",
            params!["2026-10-10T00:00:00.000Z", "fixture-id"],
        )
        .expect("persist key revocation");
        writer_cache.invalidate_after_key_write();

        assert!(
            !validate_from_sqlite(&mut writer_cache, &db, key_hash, presented_key, 1_001,)
                .expect("writer sees revoke after local invalidation")
        );

        // A second process has an independent positive cache. With no delivered invalidation
        // event, it can use that snapshot only until its remaining local 60-second TTL ends.
        assert!(
            validate_from_sqlite(&mut other_worker_cache, &db, key_hash, presented_key, 1_001,)
                .expect("other worker still has its cached positive")
        );
        assert!(
            !validate_from_sqlite(
                &mut other_worker_cache,
                &db,
                key_hash,
                presented_key,
                61_000,
            )
            .expect("other worker reloads revoked SQLite row at TTL boundary")
        );
        assert_eq!(other_worker_cache.cached_validation(key_hash, 61_001), None);
    }

    #[test]
    fn sqlite_lifecycle_gates_match_shared_typescript_vectors() {
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/api-key-validation-cache-v1.json"))
                .expect("shared API-key cache fixture must be valid JSON");

        for case in fixture["lifecycleCases"]
            .as_array()
            .expect("lifecycle cases array")
        {
            let name = case["name"].as_str().expect("case name");
            let key = case["key"].as_str().expect("fixture key");
            let key_hash = format!("hash-{key}");
            let db = empty_sqlite_api_key_authority();
            db.execute(
                "INSERT INTO api_keys (id, key, key_hash, is_active, is_banned, revoked_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    format!("fixture-{name}"),
                    key,
                    key_hash,
                    case["isActive"].as_i64().expect("isActive"),
                    case["isBanned"].as_i64().expect("isBanned"),
                    case["revokedAt"].as_str(),
                    case["expiresAt"].as_str(),
                ],
            )
            .expect("insert lifecycle fixture row");

            let mut cache = ApiKeyValidationCache::default();
            for check in case["checks"].as_array().expect("lifecycle checks") {
                let actual = validate_from_sqlite(
                    &mut cache,
                    &db,
                    &key_hash,
                    key,
                    check["nowMs"].as_i64().expect("check nowMs"),
                )
                .expect("validate lifecycle fixture row");
                assert_eq!(
                    actual,
                    check["expected"].as_bool().expect("check expected"),
                    "{name} at {}ms",
                    check["nowMs"],
                );
            }
        }
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
