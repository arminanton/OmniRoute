//! Benchmark-only Rust client for OmniRoute's `omni-coordination/v1` SQLite protocol.
//!
//! This is deliberately separate from the process-local `MultiGateAdmission` model and from
//! production source. The first parity slice supports static (non-adaptive) reservations. It
//! creates and validates the same schema as TypeScript, so both implementations can safely use a
//! dedicated local SQLite/WAL file. Adaptive requirements are rejected rather than silently
//! interpreted as static caps.

use std::{collections::BTreeMap, sync::Mutex, time::Duration};

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
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

#[derive(Debug)]
pub enum CoordinatorError {
    Invalid(String),
    QueueFull,
    AdaptiveNotSupported,
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
            Self::AdaptiveNotSupported => formatter.write_str(
                "adaptive coordination requirements are not supported by this prototype",
            ),
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

        let mut normalized = BTreeMap::<String, (usize, usize)>::new();
        for requirement in requirements {
            if requirement.adaptive {
                return Err(CoordinatorError::AdaptiveNotSupported);
            }
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
                })
                .or_insert((requirement.limit, initial));
        }

        let resources = Value::Array(
            normalized
                .iter()
                .map(|(key, (limit, initial))| {
                    json!({
                        "key": key,
                        "limit": limit,
                        "adaptive": false,
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

            for (key, limit, _initial_limit) in &requirements {
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
                if running >= active_cap.unwrap_or(*limit as i64).min(*limit as i64) {
                    return Ok(None);
                }
            }

            transaction.execute("INSERT INTO coordination_sequence DEFAULT VALUES", [])?;
            let fence = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO coordination_leases VALUES (?,?,?,?)",
                params![id, self.owner, fence, expires_at],
            )?;
            for (key, limit, _initial_limit) in &requirements {
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

fn parse_resources(text: &str) -> Result<Vec<(String, i64, i64)>, CoordinatorError> {
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
                .unwrap_or(limit)
                .min(limit);
            if entry
                .get("adaptive")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Err(CoordinatorError::AdaptiveNotSupported);
            }
            Ok((key.to_owned(), limit as i64, initial_limit as i64))
        })
        .collect()
}

fn resource_keys(text: &str) -> Result<Vec<String>, CoordinatorError> {
    Ok(parse_resources(text)?
        .into_iter()
        .map(|(key, _, _)| key)
        .collect())
}
