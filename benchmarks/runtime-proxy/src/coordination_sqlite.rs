//! Benchmark-only Rust client for OmniRoute's `omni-coordination/v1` SQLite protocol.
//!
//! This is deliberately separate from the process-local `MultiGateAdmission` model and from
//! production source. It creates and validates the same schema as TypeScript, so both
//! implementations can safely use a dedicated local SQLite/WAL file. Adaptive reservations use
//! the same persisted feedback-window state and conservative initial limit as the TypeScript
//! coordinator.

use std::{collections::BTreeMap, sync::Mutex, time::Duration};

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

pub const COORDINATION_PROTOCOL: &str = "omni-coordination/v1";
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoordinationRequirement {
    pub key: String,
    pub limit: usize,
    pub adaptive: bool,
    pub initial_limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FencedLease {
    pub id: String,
    pub fence: i64,
    pub expires_at: i64,
}

/// Provider feedback accepted by the TypeScript coordinator's `observe` method.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoordinationOutcome {
    Success,
    ConcurrencyOverload,
    Ignored,
}

impl CoordinationOutcome {
    fn from_protocol(value: &str) -> Result<Self, CoordinatorError> {
        match value {
            "success" => Ok(Self::Success),
            "concurrency_overload" => Ok(Self::ConcurrencyOverload),
            "ignored" => Ok(Self::Ignored),
            _ => Err(CoordinatorError::Invalid(
                "coordination outcome must be success|concurrency_overload|ignored".into(),
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdaptationState {
    current_limit: usize,
    recovery_ceiling: usize,
    short_latency_ewma: f64,
    long_latency_ewma: f64,
    pressure: String,
    window_active_cost_integral: f64,
    window_completed: u64,
    window_latency_samples: u64,
    window_start_ms: i64,
    freeze_growth: bool,
    critical_decrease_consumed: bool,
    utilization: f64,
}

impl AdaptationState {
    fn new(initial_limit: usize, now: i64) -> Self {
        Self {
            current_limit: initial_limit,
            recovery_ceiling: initial_limit,
            short_latency_ewma: 0.0,
            long_latency_ewma: 0.0,
            pressure: "normal".into(),
            window_active_cost_integral: 0.0,
            window_completed: 0,
            window_latency_samples: 0,
            window_start_ms: now,
            freeze_growth: false,
            critical_decrease_consumed: false,
            utilization: 0.0,
        }
    }
}

const ADAPTATION_WINDOW_MS: i64 = 30_000;
const MAX_SAFE_NUMBER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug)]
pub enum CoordinatorError {
    Invalid(String),
    QueueFull,
    IncompatibleProtocol,
    Database(rusqlite::Error),
    Json(serde_json::Error),
    Poisoned,
}

impl std::fmt::Display for CoordinatorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::QueueFull => formatter.write_str("shared admission queue is full"),
            Self::IncompatibleProtocol => formatter.write_str("incompatible coordination protocol"),
            Self::Database(error) => write!(formatter, "coordination SQLite error: {error}"),
            Self::Json(error) => write!(formatter, "coordination resource JSON error: {error}"),
            Self::Poisoned => formatter.write_str("coordination SQLite lock was poisoned"),
        }
    }
}

impl std::error::Error for CoordinatorError {}

impl From<rusqlite::Error> for CoordinatorError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

impl From<serde_json::Error> for CoordinatorError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// A connection owner must be unique per live process/client, as in the TypeScript adapter.
pub struct SqliteCoordinator {
    db: Mutex<Connection>,
    owner: String,
}

impl SqliteCoordinator {
    pub fn open(filename: &str, owner: impl Into<String>) -> Result<Self, CoordinatorError> {
        let owner = owner.into();
        if owner.trim().is_empty() {
            return Err(CoordinatorError::Invalid(
                "coordination owner is required".into(),
            ));
        }

        let db = Connection::open(filename)?;
        db.busy_timeout(Duration::from_millis(1_000))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS coordination_protocol (version TEXT PRIMARY KEY);
             INSERT OR IGNORE INTO coordination_protocol VALUES ('omni-coordination/v1');
             CREATE TABLE IF NOT EXISTS coordination_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT);
             CREATE TABLE IF NOT EXISTS coordination_leases
               (id TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL, expires INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS coordination_resources
               (lease_id TEXT NOT NULL, resource TEXT NOT NULL, cap INTEGER NOT NULL,
                PRIMARY KEY (lease_id, resource));
             CREATE INDEX IF NOT EXISTS coordination_resource ON coordination_resources(resource);
             CREATE TABLE IF NOT EXISTS coordination_adaptation
               (resource TEXT PRIMARY KEY, state TEXT NOT NULL, sampled_at INTEGER NOT NULL,
                configured_cap INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS coordination_blocks
               (resource TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS coordination_waiters
               (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                owner TEXT NOT NULL, resources TEXT NOT NULL, expires INTEGER NOT NULL);",
        )?;

        let versions = {
            let mut statement = db.prepare("SELECT version FROM coordination_protocol")?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        if versions.len() != 1 || versions[0] != COORDINATION_PROTOCOL {
            return Err(CoordinatorError::IncompatibleProtocol);
        }

        Ok(Self {
            db: Mutex::new(db),
            owner,
        })
    }

    pub fn enqueue(
        &self,
        requirements: &[CoordinationRequirement],
        expires_at: i64,
        max_queue_size: usize,
        now: i64,
    ) -> Result<String, CoordinatorError> {
        if requirements.is_empty() {
            return Err(CoordinatorError::Invalid(
                "coordination reservation requires at least one gate".into(),
            ));
        }

        let mut normalized = BTreeMap::<String, (usize, usize, bool)>::new();
        for requirement in requirements {
            if requirement.key.is_empty() || requirement.limit == 0 {
                return Err(CoordinatorError::Invalid(
                    "coordination gate key and limit must be nonempty/positive".into(),
                ));
            }
            checked_js_integer(requirement.limit)?;
            let initial = requirement.initial_limit.unwrap_or(requirement.limit);
            checked_js_integer(initial)?;
            if initial == 0 || initial > requirement.limit {
                return Err(CoordinatorError::Invalid(
                    "initial coordination limit must be positive and no greater than limit".into(),
                ));
            }
            normalized
                .entry(requirement.key.clone())
                .and_modify(|current| {
                    current.0 = current.0.min(requirement.limit);
                    current.1 = current.1.min(initial);
                    current.2 |= requirement.adaptive;
                })
                .or_insert((requirement.limit, initial, requirement.adaptive));
        }

        let resources = Value::Array(
            normalized
                .iter()
                .map(|(key, (limit, initial, adaptive))| {
                    json!({
                        "key": key,
                        "limit": limit,
                        "adaptive": adaptive,
                        "initialLimit": initial.min(limit),
                    })
                })
                .collect(),
        )
        .to_string();

        self.atomic(|transaction| {
            prune(transaction, now)?;
            if max_queue_size > 0 {
                let waiters = waiter_resource_sets(transaction)?;
                let full = normalized.keys().any(|key| {
                    waiters
                        .iter()
                        .filter(|resources| resources.iter().any(|resource| resource == key))
                        .count()
                        >= max_queue_size
                });
                if full {
                    return Err(CoordinatorError::QueueFull);
                }
            }

            let id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO coordination_waiters (id,owner,resources,expires) VALUES (?,?,?,?)",
                params![id, self.owner, resources, expires_at],
            )?;
            Ok(id)
        })
    }

    pub fn try_acquire(
        &self,
        id: &str,
        ttl_ms: i64,
        now: i64,
    ) -> Result<Option<FencedLease>, CoordinatorError> {
        if ttl_ms < 1_000 {
            return Err(CoordinatorError::Invalid(
                "coordination lease TTL must be at least 1000ms".into(),
            ));
        }
        let expires_at = now.saturating_add(ttl_ms);
        self.atomic(|transaction| {
            prune(transaction, now)?;
            let row = transaction
                .query_row(
                    "SELECT sequence,resources FROM coordination_waiters WHERE id=? AND owner=?",
                    params![id, self.owner],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            let Some((sequence, resources_json)) = row else {
                return Ok(None);
            };
            let requirements = parse_resources(&resources_json)?;

            let older_waiters = {
                let mut statement = transaction
                    .prepare("SELECT resources FROM coordination_waiters WHERE sequence < ?")?;
                statement
                    .query_map([sequence], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for older_json in older_waiters {
                let older = parse_resources(&older_json)?;
                if older.iter().any(|older_requirement| {
                    requirements
                        .iter()
                        .any(|requirement| requirement.0 == older_requirement.0)
                }) {
                    return Ok(None);
                }
            }

            for (key, limit, initial_limit, adaptive) in &requirements {
                let admission_cap = if *adaptive {
                    adaptive_limit(transaction, key, *limit, Some(*initial_limit), now)?
                } else {
                    *limit
                };
                let blocked_until = transaction
                    .query_row(
                        "SELECT until_ms FROM coordination_blocks WHERE resource=?",
                        [key],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .unwrap_or(0);
                if blocked_until > now {
                    return Ok(None);
                }

                let (running, active_cap) = transaction.query_row(
                    "SELECT COUNT(*) AS n, MIN(cap) AS cap FROM coordination_resources WHERE resource=?",
                    [key],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
                )?;
                if running >= active_cap.unwrap_or(*limit as i64).min(admission_cap as i64) {
                    return Ok(None);
                }
            }

            transaction.execute("INSERT INTO coordination_sequence DEFAULT VALUES", [])?;
            let fence = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO coordination_leases VALUES (?,?,?,?)",
                params![id, self.owner, fence, expires_at],
            )?;
            for (key, limit, _initial_limit, _adaptive) in &requirements {
                transaction.execute(
                    "INSERT INTO coordination_resources VALUES (?,?,?)",
                    params![id, key, *limit as i64],
                )?;
            }
            transaction.execute("DELETE FROM coordination_waiters WHERE id=?", [id])?;
            Ok(Some(FencedLease {
                id: id.to_owned(),
                fence,
                expires_at,
            }))
        })
    }

    pub fn renew(
        &self,
        lease: &FencedLease,
        ttl_ms: i64,
        now: i64,
    ) -> Result<bool, CoordinatorError> {
        if ttl_ms < 1_000 {
            return Err(CoordinatorError::Invalid(
                "coordination lease TTL must be at least 1000ms".into(),
            ));
        }
        let db = self.db.lock().map_err(|_| CoordinatorError::Poisoned)?;
        let changed = db.execute(
            "UPDATE coordination_leases SET expires=? WHERE id=? AND owner=? AND fence=? AND expires>?",
            params![now.saturating_add(ttl_ms), lease.id, self.owner, lease.fence, now],
        )?;
        Ok(changed == 1)
    }

    pub fn valid(&self, lease: &FencedLease, now: i64) -> Result<bool, CoordinatorError> {
        let db = self.db.lock().map_err(|_| CoordinatorError::Poisoned)?;
        let found = db
            .query_row(
                "SELECT id FROM coordination_leases WHERE id=? AND owner=? AND fence=? AND expires>?",
                params![lease.id, self.owner, lease.fence, now],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        Ok(found)
    }

    pub fn release(&self, lease: &FencedLease) -> Result<(), CoordinatorError> {
        self.atomic(|transaction| {
            let exists = transaction
                .query_row(
                    "SELECT id FROM coordination_leases WHERE id=? AND owner=? AND fence=?",
                    params![lease.id, self.owner, lease.fence],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                return Ok(());
            }
            transaction.execute(
                "DELETE FROM coordination_resources WHERE lease_id=?",
                [&lease.id],
            )?;
            transaction.execute("DELETE FROM coordination_leases WHERE id=?", [&lease.id])?;
            Ok(())
        })
    }

    pub fn cancel(&self, id: &str) -> Result<(), CoordinatorError> {
        let db = self.db.lock().map_err(|_| CoordinatorError::Poisoned)?;
        db.execute(
            "DELETE FROM coordination_waiters WHERE id=? AND owner=?",
            params![id, self.owner],
        )?;
        Ok(())
    }

    /// Record successful or explicit concurrency-overload feedback for an adaptive resource.
    /// Unknown resources and ignored outcomes are no-ops, matching TypeScript. Latency values
    /// that are negative or non-finite are normalized to zero by the shared EWMA update.
    pub fn observe(
        &self,
        resource: &str,
        outcome: CoordinationOutcome,
        latency_ms: f64,
        now: i64,
    ) -> Result<(), CoordinatorError> {
        if outcome == CoordinationOutcome::Ignored {
            return Ok(());
        }
        self.atomic(|transaction| {
            let configured_cap = transaction
                .query_row(
                    "SELECT configured_cap FROM coordination_adaptation WHERE resource=?",
                    [resource],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            let Some(configured_cap) = configured_cap else {
                return Ok(());
            };
            if configured_cap <= 0 {
                return Err(CoordinatorError::Invalid(
                    "persisted coordination cap must be positive".into(),
                ));
            }
            let cap = usize::try_from(configured_cap).map_err(|_| {
                CoordinatorError::Invalid("persisted coordination cap is out of range".into())
            })?;

            // This samples in-flight occupancy and closes any elapsed window before applying
            // this feedback, exactly as the TypeScript observe path does.
            adaptive_limit(transaction, resource, cap, None, now)?;
            let raw_state = transaction.query_row(
                "SELECT state FROM coordination_adaptation WHERE resource=?",
                [resource],
                |row| row.get::<_, String>(0),
            )?;
            let mut state: AdaptationState = serde_json::from_str(&raw_state)?;
            match outcome {
                CoordinationOutcome::Ignored => unreachable!(),
                CoordinationOutcome::ConcurrencyOverload => {
                    set_critical_pressure(&mut state);
                    if !state.critical_decrease_consumed {
                        state.current_limit =
                            ((state.current_limit as f64 * 0.5).floor() as usize).max(1);
                        state.critical_decrease_consumed = true;
                    }
                }
                CoordinationOutcome::Success => {
                    state.window_completed = state.window_completed.saturating_add(1);
                    note_latency(&mut state, latency_ms);
                }
            }
            transaction.execute(
                "UPDATE coordination_adaptation SET state=? WHERE resource=?",
                params![serde_json::to_string(&state)?, resource],
            )?;
            Ok(())
        })
    }

    /// String-shaped protocol adapter useful to fixtures that mirror the TypeScript API.
    pub fn observe_protocol(
        &self,
        resource: &str,
        outcome: &str,
        latency_ms: f64,
        now: i64,
    ) -> Result<(), CoordinatorError> {
        self.observe(
            resource,
            CoordinationOutcome::from_protocol(outcome)?,
            latency_ms,
            now,
        )
    }

    pub fn block(&self, resource: &str, until_ms: i64) -> Result<(), CoordinatorError> {
        let db = self.db.lock().map_err(|_| CoordinatorError::Poisoned)?;
        db.execute(
            "INSERT INTO coordination_blocks(resource,until_ms) VALUES (?,?) \
             ON CONFLICT(resource) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)",
            params![resource, until_ms],
        )?;
        Ok(())
    }

    pub fn unblock(&self, resource: &str) -> Result<(), CoordinatorError> {
        let db = self.db.lock().map_err(|_| CoordinatorError::Poisoned)?;
        db.execute(
            "DELETE FROM coordination_blocks WHERE resource=?",
            [resource],
        )?;
        Ok(())
    }

    fn atomic<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> Result<T, CoordinatorError>,
    ) -> Result<T, CoordinatorError> {
        let mut db = self.db.lock().map_err(|_| CoordinatorError::Poisoned)?;
        let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = operation(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }
}

fn checked_js_integer(value: usize) -> Result<u64, CoordinatorError> {
    let value = u64::try_from(value).map_err(|_| {
        CoordinatorError::Invalid("coordination limit exceeds SQLite integer range".into())
    })?;
    if value > MAX_JS_SAFE_INTEGER {
        return Err(CoordinatorError::Invalid(
            "coordination limit must be a JavaScript safe integer".into(),
        ));
    }
    Ok(value)
}

fn prune(transaction: &Transaction<'_>, now: i64) -> Result<(), CoordinatorError> {
    transaction.execute(
        "DELETE FROM coordination_resources WHERE lease_id IN \
         (SELECT id FROM coordination_leases WHERE expires <= ?)",
        [now],
    )?;
    transaction.execute("DELETE FROM coordination_leases WHERE expires <= ?", [now])?;
    transaction.execute("DELETE FROM coordination_waiters WHERE expires <= ?", [now])?;
    Ok(())
}

fn waiter_resource_sets(
    transaction: &Transaction<'_>,
) -> Result<Vec<Vec<String>>, CoordinatorError> {
    let raw = {
        let mut statement = transaction.prepare("SELECT resources FROM coordination_waiters")?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    raw.iter().map(|value| resource_keys(value)).collect()
}

fn parse_resources(text: &str) -> Result<Vec<(String, usize, usize, bool)>, CoordinatorError> {
    let value: Value = serde_json::from_str(text)?;
    let array = value.as_array().ok_or_else(|| {
        CoordinatorError::Invalid("coordination resources must be a JSON array".into())
    })?;
    array
        .iter()
        .map(|entry| {
            let key = entry
                .get("key")
                .and_then(Value::as_str)
                .filter(|key| !key.is_empty())
                .ok_or_else(|| {
                    CoordinatorError::Invalid("invalid coordination resource key".into())
                })?;
            let limit = entry
                .get("limit")
                .and_then(Value::as_u64)
                .filter(|limit| *limit > 0 && *limit <= MAX_JS_SAFE_INTEGER)
                .ok_or_else(|| {
                    CoordinatorError::Invalid("invalid coordination resource limit".into())
                })?;
            let initial_limit = entry
                .get("initialLimit")
                .and_then(Value::as_u64)
                .unwrap_or(limit);
            if initial_limit == 0 || initial_limit > limit {
                return Err(CoordinatorError::Invalid(
                    "invalid initial coordination resource limit".into(),
                ));
            }
            let adaptive = entry
                .get("adaptive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok((
                key.to_owned(),
                limit as usize,
                initial_limit as usize,
                adaptive,
            ))
        })
        .collect()
}

fn resource_keys(text: &str) -> Result<Vec<String>, CoordinatorError> {
    Ok(parse_resources(text)?
        .into_iter()
        .map(|(key, _, _, _)| key)
        .collect())
}

fn adaptive_limit(
    transaction: &Transaction<'_>,
    resource: &str,
    cap: usize,
    initial_limit: Option<usize>,
    now: i64,
) -> Result<usize, CoordinatorError> {
    if cap == 0 {
        return Err(CoordinatorError::Invalid(
            "adaptive coordination cap must be positive".into(),
        ));
    }
    checked_js_integer(cap)?;
    let cap_i64 = cap as i64;
    let row = transaction
        .query_row(
            "SELECT state,sampled_at FROM coordination_adaptation WHERE resource=?",
            [resource],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;

    let mut state = if let Some((serialized, _)) = &row {
        serde_json::from_str::<AdaptationState>(serialized)?
    } else {
        AdaptationState::new(initial_limit.unwrap_or(cap).min(cap).max(1), now)
    };
    state.current_limit = state.current_limit.min(cap).max(1);
    // The recovery ceiling follows the caller's initialLimit, but never exceeds the
    // current operator cap. On observe() the TypeScript path omits initialLimit and
    // therefore preserves/clamps the persisted ceiling.
    state.recovery_ceiling = initial_limit
        .unwrap_or(state.recovery_ceiling)
        .min(cap)
        .max(1);

    let active = transaction.query_row(
        "SELECT COUNT(*) FROM coordination_resources WHERE resource=?",
        [resource],
        |row| row.get::<_, i64>(0),
    )?;
    let elapsed = row
        .as_ref()
        .map(|(_, sampled_at)| now.saturating_sub(*sampled_at).max(0))
        .unwrap_or(0);
    sample_active_integral(&mut state, active.max(0) as f64, elapsed as f64);
    if now.saturating_sub(state.window_start_ms) >= ADAPTATION_WINDOW_MS {
        close_adaptation_window(&mut state, now, cap);
    }

    transaction.execute(
        "INSERT INTO coordination_adaptation(resource,state,sampled_at,configured_cap) \
         VALUES (?,?,?,?) ON CONFLICT(resource) DO UPDATE SET \
         state=excluded.state,sampled_at=excluded.sampled_at,configured_cap=excluded.configured_cap",
        params![resource, serde_json::to_string(&state)?, now, cap_i64],
    )?;
    Ok(state.current_limit)
}

fn sample_active_integral(state: &mut AdaptationState, active_cost: f64, dt_ms: f64) {
    if dt_ms <= 0.0 || active_cost <= 0.0 {
        return;
    }
    let bounded_active_cost = active_cost.min(state.current_limit as f64);
    let contribution = if dt_ms > (MAX_SAFE_NUMBER / bounded_active_cost).floor() {
        MAX_SAFE_NUMBER
    } else {
        bounded_active_cost * dt_ms
    };
    state.window_active_cost_integral =
        (state.window_active_cost_integral + contribution).min(MAX_SAFE_NUMBER);
}

fn set_critical_pressure(state: &mut AdaptationState) {
    if state.pressure != "critical" {
        state.pressure = "critical".into();
    }
}

fn note_latency(state: &mut AdaptationState, latency_ms: f64) {
    let sample = if latency_ms.is_finite() && latency_ms >= 0.0 {
        latency_ms
    } else {
        0.0
    };
    state.window_latency_samples = state.window_latency_samples.saturating_add(1);
    if state.short_latency_ewma <= 0.0 && state.long_latency_ewma <= 0.0 {
        state.short_latency_ewma = sample;
        state.long_latency_ewma = sample;
    } else {
        state.short_latency_ewma = 0.5 * sample + 0.5 * state.short_latency_ewma;
        state.long_latency_ewma = 0.1 * sample + 0.9 * state.long_latency_ewma;
    }
}

fn close_adaptation_window(state: &mut AdaptationState, now: i64, cap: usize) {
    let elapsed = now
        .saturating_sub(state.window_start_ms)
        .clamp(1, ADAPTATION_WINDOW_MS) as f64;
    let avg_active = state.window_active_cost_integral / elapsed;
    let utilization = if state.current_limit > 0 {
        avg_active / state.current_limit as f64
    } else {
        0.0
    };
    state.utilization = utilization.clamp(0.0, 1.0);
    let gradient = if state.long_latency_ewma > 0.0 {
        (state.short_latency_ewma - state.long_latency_ewma) / state.long_latency_ewma
    } else {
        0.0
    };

    let mut next = state.current_limit;
    if state.pressure == "critical" {
        if !state.critical_decrease_consumed {
            next = ((next as f64 * 0.5).floor() as usize).max(1);
        }
    } else if state.pressure == "high" || (state.window_latency_samples > 0 && gradient >= 0.25) {
        next = ((next as f64 * 0.8).floor() as usize).max(1);
    } else if !state.freeze_growth
        && state.pressure == "normal"
        && state.utilization >= 0.7
        && state.window_completed > 0
    {
        next = next.saturating_add(1);
    }

    if state.utilization <= 0.3 {
        state.short_latency_ewma = state.long_latency_ewma;
        if state.pressure != "critical"
            && !state.freeze_growth
            && state.window_completed == 0
            && state.current_limit < state.recovery_ceiling
        {
            next = next.saturating_add(1).min(state.recovery_ceiling);
        }
    }
    state.current_limit = next.clamp(1, cap);
    state.window_active_cost_integral = 0.0;
    state.window_completed = 0;
    state.window_latency_samples = 0;
    state.window_start_ms = now;
    state.freeze_growth = false;
    state.critical_decrease_consumed = false;
    state.pressure = "normal".into();
}

#[cfg(test)]
mod tests {
    use super::{AdaptationState, CoordinationOutcome, CoordinationRequirement, SqliteCoordinator};
    use rusqlite::OptionalExtension;
    use serde_json::Value;

    const TYPESCRIPT_ADAPTATION_FIXTURE: &str = r#"{
      "currentLimit": 2,
      "recoveryCeiling": 2,
      "shortLatencyEwma": 12,
      "longLatencyEwma": 10,
      "pressure": "normal",
      "windowActiveCostIntegral": 0,
      "windowCompleted": 1,
      "windowLatencySamples": 1,
      "windowStartMs": 1000,
      "freezeGrowth": false,
      "criticalDecreaseConsumed": false,
      "utilization": 0
    }"#;

    fn adaptive_gate(key: &str, cap: usize, initial_limit: usize) -> CoordinationRequirement {
        CoordinationRequirement {
            key: key.into(),
            limit: cap,
            adaptive: true,
            initial_limit: Some(initial_limit),
        }
    }

    fn reserve(
        coordinator: &SqliteCoordinator,
        key: &str,
        cap: usize,
        initial_limit: usize,
        now: i64,
    ) -> Option<super::FencedLease> {
        let id = coordinator
            .enqueue(
                &[adaptive_gate(key, cap, initial_limit)],
                now + 120_000,
                64,
                now,
            )
            .expect("enqueue adaptive reservation");
        let serialized = coordinator
            .db
            .lock()
            .expect("coordinator DB lock")
            .query_row(
                "SELECT resources FROM coordination_waiters WHERE id=?",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .expect("queued adaptive resources");
        assert!(
            super::parse_resources(&serialized).expect("parse queued adaptive resources")[0].3,
            "adaptive flag missing from queued resources: {serialized}"
        );
        let lease = coordinator
            .try_acquire(&id, 120_000, now)
            .expect("attempt adaptive reservation");
        lease
    }

    fn state(coordinator: &SqliteCoordinator, resource: &str) -> AdaptationState {
        let db = coordinator.db.lock().expect("coordinator DB lock");
        let raw = db
            .query_row(
                "SELECT state FROM coordination_adaptation WHERE resource=?",
                [resource],
                |row| row.get::<_, String>(0),
            )
            .expect("persisted adaptation row");
        serde_json::from_str(&raw).expect("valid persisted adaptation JSON")
    }

    #[test]
    fn adaptive_reservations_start_at_initial_limit_and_persist_shared_state() {
        let coordinator = SqliteCoordinator::open(":memory:", "adaptive-test")
            .expect("open in-memory coordinator");
        let first = reserve(&coordinator, "account", 5, 2, 1_000).expect("first permit");
        let second = reserve(&coordinator, "account", 5, 2, 1_000).expect("second permit");
        assert!(reserve(&coordinator, "account", 5, 2, 1_000).is_none());

        let persisted = state(&coordinator, "account");
        assert_eq!(persisted.current_limit, 2);
        assert_eq!(persisted.recovery_ceiling, 2);
        assert_eq!(persisted.pressure, "normal");

        coordinator.release(&first).expect("release first permit");
        coordinator.release(&second).expect("release second permit");
    }

    #[test]
    fn critical_feedback_decreases_once_per_window_and_ignored_feedback_is_noop() {
        let coordinator = SqliteCoordinator::open(":memory:", "feedback-test")
            .expect("open in-memory coordinator");
        let held = reserve(&coordinator, "account", 6, 4, 1_000).expect("first permit");
        coordinator
            .observe(
                "account",
                CoordinationOutcome::ConcurrencyOverload,
                0.0,
                1_000,
            )
            .expect("record overload");
        assert_eq!(state(&coordinator, "account").current_limit, 2);

        let before_ignored = state(&coordinator, "account");
        coordinator
            .observe("account", CoordinationOutcome::Ignored, 999.0, 2_000)
            .expect("ignored feedback");
        assert_eq!(state(&coordinator, "account"), before_ignored);

        coordinator
            .observe_protocol("account", "concurrency_overload", 0.0, 2_000)
            .expect("same-window overload");
        let same_window = state(&coordinator, "account");
        assert_eq!(same_window.current_limit, 2);
        assert!(same_window.critical_decrease_consumed);

        // An acquisition after a measured window closes resets the one-decrease fuse.
        let second = reserve(&coordinator, "account", 6, 4, 31_000).expect("next-window permit");
        coordinator
            .observe_protocol("account", "concurrency_overload", 0.0, 31_000)
            .expect("next-window overload");
        let next_window = state(&coordinator, "account");
        assert_eq!(next_window.current_limit, 1);
        assert!(next_window.critical_decrease_consumed);

        coordinator.release(&held).expect("release first permit");
        coordinator.release(&second).expect("release second permit");
    }

    #[test]
    fn healthy_measured_windows_grow_from_initial_limit_without_exceeding_cap() {
        let coordinator = SqliteCoordinator::open(":memory:", "recovery-test")
            .expect("open in-memory coordinator");
        let first = reserve(&coordinator, "account", 4, 2, 1_000).expect("first permit");
        let second = reserve(&coordinator, "account", 4, 2, 1_000).expect("second permit");

        coordinator
            .observe("account", CoordinationOutcome::Success, 10.0, 31_000)
            .expect("first successful observation");
        assert_eq!(state(&coordinator, "account").current_limit, 2);

        coordinator
            .observe("account", CoordinationOutcome::Success, 10.0, 61_000)
            .expect("second successful observation closes a measured window");
        assert_eq!(state(&coordinator, "account").current_limit, 3);
        let third = reserve(&coordinator, "account", 4, 2, 61_000).expect("third permit");

        coordinator
            .observe("account", CoordinationOutcome::Success, 10.0, 91_000)
            .expect("third successful observation closes a measured window");
        let recovered = state(&coordinator, "account");
        assert_eq!(recovered.current_limit, 4);
        assert_eq!(recovered.recovery_ceiling, 2);
        assert_eq!(recovered.short_latency_ewma, 10.0);
        assert_eq!(recovered.long_latency_ewma, 10.0);
        let fourth = reserve(&coordinator, "account", 4, 2, 91_000).expect("fourth permit");
        assert!(reserve(&coordinator, "account", 4, 2, 91_000).is_none());

        for lease in [first, second, third, fourth] {
            coordinator
                .release(&lease)
                .expect("release recovered permit");
        }
    }

    #[test]
    fn reads_typescript_camel_case_state_and_clamps_recovery_to_new_initial_limit() {
        let coordinator = SqliteCoordinator::open(":memory:", "interop-fixture")
            .expect("open in-memory coordinator");
        {
            let db = coordinator.db.lock().expect("coordinator DB lock");
            db.execute(
                "INSERT INTO coordination_adaptation(resource,state,sampled_at,configured_cap) VALUES (?,?,?,?)",
                ("fixture", TYPESCRIPT_ADAPTATION_FIXTURE, 1_000, 5),
            )
            .expect("insert TypeScript state fixture");
        }
        let permit = reserve(&coordinator, "fixture", 5, 3, 1_000).expect("fixture permit");
        let persisted = state(&coordinator, "fixture");
        assert_eq!(persisted.current_limit, 2);
        assert_eq!(persisted.recovery_ceiling, 3);
        assert_eq!(persisted.short_latency_ewma, 12.0);
        assert_eq!(persisted.window_completed, 1);

        let db = coordinator.db.lock().expect("coordinator DB lock");
        let serialized: String = db
            .query_row(
                "SELECT state FROM coordination_adaptation WHERE resource='fixture'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("query adapted fixture")
            .expect("fixture exists");
        let json: Value = serde_json::from_str(&serialized).expect("camelCase JSON");
        assert_eq!(json["currentLimit"], 2);
        assert_eq!(json["recoveryCeiling"], 3);
        assert!(json.get("current_limit").is_none());
        drop(db);
        coordinator
            .release(&permit)
            .expect("release fixture permit");
    }
}
