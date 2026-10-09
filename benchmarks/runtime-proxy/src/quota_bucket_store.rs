//! Benchmark-only reader/writer for the documented `quota_consumption` SQLite bucket schema.
//!
//! This is a storage primitive, not quota policy. It deliberately accepts an explicit database
//! path and refuses to create the table, so tests can verify interoperability against a database
//! initialized by OmniRoute's TypeScript migrations. Do not point this prototype at a live DB or
//! use it when `quotaStore.driver=redis`.

use std::{collections::BTreeMap, path::Path, sync::Mutex, time::Duration};

use rusqlite::{Connection, OptionalExtension, params};

#[derive(Debug)]
pub enum QuotaBucketError {
    Invalid(String),
    IncompatibleSchema(String),
    Database(rusqlite::Error),
    Poisoned,
}

impl std::fmt::Display for QuotaBucketError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::IncompatibleSchema(message) => formatter.write_str(message),
            Self::Database(error) => write!(formatter, "quota SQLite error: {error}"),
            Self::Poisoned => formatter.write_str("quota SQLite lock was poisoned"),
        }
    }
}

impl std::error::Error for QuotaBucketError {}

impl From<rusqlite::Error> for QuotaBucketError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BucketPair {
    pub curr: f64,
    pub prev: f64,
}

pub struct SqliteQuotaBucketStore {
    db: Mutex<Connection>,
}

impl SqliteQuotaBucketStore {
    /// Open an existing SQLite file and verify the migration-defined table shape.
    pub fn open_existing(path: &Path) -> Result<Self, QuotaBucketError> {
        if !path.is_file() {
            return Err(QuotaBucketError::Invalid(
                "quota bucket DB must already exist".into(),
            ));
        }

        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_millis(1_000))?;
        validate_schema(&db)?;
        Ok(Self { db: Mutex::new(db) })
    }

    /// Atomically add a delta to one `(api_key_id, dimension_key, bucket_index)` row.
    ///
    /// This matches TypeScript `incrementBucket`: a single SQLite UPSERT performs the increment,
    /// and `updated_at` is replaced by the supplied epoch-millisecond timestamp.
    pub fn increment_bucket(
        &self,
        api_key_id: &str,
        dimension_key: &str,
        bucket_index: i64,
        delta: f64,
        updated_at_ms: i64,
    ) -> Result<(), QuotaBucketError> {
        if !delta.is_finite() {
            return Err(QuotaBucketError::Invalid(
                "quota bucket delta must be finite".into(),
            ));
        }
        let db = self.db.lock().map_err(|_| QuotaBucketError::Poisoned)?;
        db.execute(
            "INSERT INTO quota_consumption (api_key_id, dimension_key, bucket_index, consumed, updated_at) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(api_key_id, dimension_key, bucket_index) \
             DO UPDATE SET consumed = consumed + excluded.consumed, updated_at = excluded.updated_at",
            params![api_key_id, dimension_key, bucket_index, delta, updated_at_ms],
        )?;
        Ok(())
    }

    pub fn get_bucket(
        &self,
        api_key_id: &str,
        dimension_key: &str,
        bucket_index: i64,
    ) -> Result<f64, QuotaBucketError> {
        let db = self.db.lock().map_err(|_| QuotaBucketError::Poisoned)?;
        Ok(db
            .query_row(
                "SELECT consumed FROM quota_consumption \
                 WHERE api_key_id=? AND dimension_key=? AND bucket_index=?",
                params![api_key_id, dimension_key, bucket_index],
                |row| row.get::<_, f64>(0),
            )
            .optional()?
            .unwrap_or(0.0))
    }

    /// Read current and preceding buckets, matching TypeScript `getPair` semantics.
    pub fn get_pair(
        &self,
        api_key_id: &str,
        dimension_key: &str,
        current_bucket: i64,
    ) -> Result<BucketPair, QuotaBucketError> {
        let db = self.db.lock().map_err(|_| QuotaBucketError::Poisoned)?;
        let curr = read_bucket(&db, api_key_id, dimension_key, current_bucket)?;
        let prev = read_bucket(
            &db,
            api_key_id,
            dimension_key,
            current_bucket.saturating_sub(1),
        )?;
        Ok(BucketPair { curr, prev })
    }
}

fn read_bucket(
    db: &Connection,
    api_key_id: &str,
    dimension_key: &str,
    bucket_index: i64,
) -> Result<f64, QuotaBucketError> {
    Ok(db
        .query_row(
            "SELECT consumed FROM quota_consumption \
             WHERE api_key_id=? AND dimension_key=? AND bucket_index=?",
            params![api_key_id, dimension_key, bucket_index],
            |row| row.get::<_, f64>(0),
        )
        .optional()?
        .unwrap_or(0.0))
}

fn validate_schema(db: &Connection) -> Result<(), QuotaBucketError> {
    let mut statement = db.prepare("PRAGMA table_info(quota_consumption)")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?.to_ascii_uppercase(),
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let actual = rows
        .into_iter()
        .map(|(name, data_type, not_null, primary_key_order)| {
            (name, (data_type, not_null, primary_key_order))
        })
        .collect::<BTreeMap<_, _>>();
    let expected = [
        ("api_key_id", "TEXT", 1, 1),
        ("dimension_key", "TEXT", 1, 2),
        ("bucket_index", "INTEGER", 1, 3),
        ("consumed", "REAL", 1, 0),
        ("updated_at", "INTEGER", 1, 0),
    ];

    for (name, data_type, not_null, primary_key_order) in expected {
        match actual.get(name) {
            Some((actual_type, actual_not_null, actual_pk))
                if actual_type == data_type
                    && *actual_not_null == not_null
                    && *actual_pk == primary_key_order => {}
            _ => {
                return Err(QuotaBucketError::IncompatibleSchema(format!(
                    "quota_consumption.{name} does not match the expected migrated schema"
                )));
            }
        }
    }
    Ok(())
}
