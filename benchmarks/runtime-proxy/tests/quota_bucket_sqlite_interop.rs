#[path = "../src/quota_bucket_store.rs"]
mod quota_bucket_store;

use quota_bucket_store::SqliteQuotaBucketStore;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");
const API_KEY_ID: &str = "fixture-api-key-a";
const DIMENSION: &str = "fixture-pool:tokens:hourly";
const CURRENT_BUCKET: i64 = 100;

struct TemporaryDataDirectory(PathBuf);

impl TemporaryDataDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("omni-quota-rust-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create local DATA_DIR");
        Self(path)
    }

    fn database_path(&self) -> PathBuf {
        self.0.join("storage.sqlite")
    }
}

impl Drop for TemporaryDataDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rust_and_typescript_share_migration_defined_quota_bucket_rows() {
    let data_dir = TemporaryDataDirectory::new();
    let db_path = data_dir.database_path();

    // TypeScript owns migration/bootstrap and writes the first two bucket rows through the actual
    // `src/lib/db/quotaConsumption.ts` helper, using a disposable DATA_DIR only.
    let first = run_typescript(
        &data_dir.0,
        r#"
          const before = quota.getPair(process.env.TEST_API_KEY_ID, process.env.TEST_DIMENSION, 100);
          quota.incrementBucket(process.env.TEST_API_KEY_ID, process.env.TEST_DIMENSION, 100, 12, 1000);
          quota.incrementBucket(process.env.TEST_API_KEY_ID, process.env.TEST_DIMENSION, 99, 4, 1000);
          const after = quota.getPair(process.env.TEST_API_KEY_ID, process.env.TEST_DIMENSION, 100);
          core.resetDbInstance();
          console.log("RESULT:" + JSON.stringify({ before, after }));
        "#,
    );
    assert_pair(&first["before"], 0.0, 0.0);
    assert_pair(&first["after"], 12.0, 4.0);

    // Rust opens an existing SQLite file, checks the migration's column/key contract, then uses
    // the same atomic UPSERT and current/previous bucket convention.
    let rust = SqliteQuotaBucketStore::open_existing(&db_path).expect("open TS-migrated DB");
    assert_eq!(
        rust.get_pair(API_KEY_ID, DIMENSION, CURRENT_BUCKET)
            .unwrap(),
        pair(12.0, 4.0)
    );
    rust.increment_bucket(API_KEY_ID, DIMENSION, CURRENT_BUCKET, 3.0, 2_000)
        .unwrap();
    rust.increment_bucket(API_KEY_ID, DIMENSION, CURRENT_BUCKET - 1, 7.0, 2_100)
        .unwrap();
    rust.increment_bucket("fixture-api-key-b", DIMENSION, CURRENT_BUCKET, 100.0, 2_100)
        .unwrap();
    rust.increment_bucket(
        API_KEY_ID,
        "fixture-pool:usd:hourly",
        CURRENT_BUCKET,
        50.0,
        2_100,
    )
    .unwrap();
    assert_eq!(
        rust.get_pair(API_KEY_ID, DIMENSION, CURRENT_BUCKET)
            .unwrap(),
        pair(15.0, 11.0)
    );

    // The TypeScript helper observes Rust's rows, verifies key/dimension isolation, then writes
    // one more delta. This deliberately tests storage only; no pool allocation or policy is run.
    drop(rust);
    let second = run_typescript(
        &data_dir.0,
        r#"
          const observed = quota.getPair(process.env.TEST_API_KEY_ID, process.env.TEST_DIMENSION, 100);
          const otherKey = quota.getBucket("fixture-api-key-b", process.env.TEST_DIMENSION, 100);
          const otherDimension = quota.getBucket(process.env.TEST_API_KEY_ID, "fixture-pool:usd:hourly", 100);
          quota.incrementBucket(process.env.TEST_API_KEY_ID, process.env.TEST_DIMENSION, 100, 2, 3000);
          const after = quota.getPair(process.env.TEST_API_KEY_ID, process.env.TEST_DIMENSION, 100);
          core.resetDbInstance();
          console.log("RESULT:" + JSON.stringify({ observed, otherKey, otherDimension, after }));
        "#,
    );
    assert_pair(&second["observed"], 15.0, 11.0);
    assert_eq!(second["otherKey"].as_f64(), Some(100.0));
    assert_eq!(second["otherDimension"].as_f64(), Some(50.0));
    assert_pair(&second["after"], 17.0, 11.0);

    // Rust reads the final TypeScript write from the same DB; the TypeScript main DB and all
    // migrations remain inside the disposable temp directory.
    let rust = SqliteQuotaBucketStore::open_existing(&db_path).expect("reopen shared DB");
    assert_eq!(
        rust.get_pair(API_KEY_ID, DIMENSION, CURRENT_BUCKET)
            .unwrap(),
        pair(17.0, 11.0)
    );
    assert_eq!(
        rust.get_bucket("missing-api-key", DIMENSION, CURRENT_BUCKET)
            .unwrap(),
        0.0
    );
}

#[test]
fn rust_sliding_window_math_matches_typescript_store_on_migrated_sqlite_rows() {
    let data_dir = TemporaryDataDirectory::new();
    let db_path = data_dir.database_path();
    let fixture_path = Path::new(MANIFEST_DIR).join("fixtures/quota-sliding-window-v1.json");
    let fixture_bytes = fs::read(&fixture_path).expect("read shared sliding-window vectors");
    let vectors: Vec<Value> = serde_json::from_slice(&fixture_bytes).expect("parse vectors");

    // TypeScript owns database initialization, writes each pair through the real quota helper,
    // then evaluates SqliteQuotaStore.peek/consume with a deterministic Date.now().
    let seeded = run_typescript(
        &data_dir.0,
        r#"
          const fs = await import("node:fs");
          const { SqliteQuotaStore } = await import("./src/lib/quota/sqliteQuotaStore.ts");
          const { WINDOW_MS } = await import("./src/lib/quota/dimensions.ts");
          const vectors = JSON.parse(fs.readFileSync(process.env.TEST_EFFECTIVE_FIXTURE, "utf8"));
          const originalNow = Date.now;
          const store = new SqliteQuotaStore();
          const results = [];
          try {
            for (const vector of vectors) {
              if (WINDOW_MS[vector.window] !== vector.windowMs) {
                throw new Error(`window size drift for ${vector.window}`);
              }
              const dimension = { poolId: "fixture-pool", unit: "tokens", window: vector.window };
              const dimensionKey = `${dimension.poolId}:${dimension.unit}:${dimension.window}`;
              const apiKeyId = `fixture-effective-${vector.id}`;
              const currentBucket = Math.floor(vector.nowMs / vector.windowMs);
              if (vector.curr !== null) {
                quota.incrementBucket(apiKeyId, dimensionKey, currentBucket, vector.curr, vector.nowMs);
              }
              if (vector.prev !== null) {
                quota.incrementBucket(apiKeyId, dimensionKey, currentBucket - 1, vector.prev, vector.nowMs);
              }
              Date.now = () => vector.nowMs;
              const beforePair = quota.getPair(apiKeyId, dimensionKey, currentBucket);
              const before = await store.peek(apiKeyId, dimension);
              const consumed = vector.consumeDelta === null
                ? null
                : await store.consume(apiKeyId, dimension, vector.consumeDelta);
              const afterPair = quota.getPair(apiKeyId, dimensionKey, currentBucket);
              const after = await store.peek(apiKeyId, dimension);
              results.push({ id: vector.id, apiKeyId, dimensionKey, currentBucket, beforePair, before, consumed, afterPair, after });
            }
          } finally {
            Date.now = originalNow;
            core.resetDbInstance();
          }
          console.log("RESULT:" + JSON.stringify(results));
        "#,
    );
    let seeded_rows = seeded.as_array().expect("TypeScript result array");
    assert_eq!(seeded_rows.len(), vectors.len());

    // Rust reads the exact TypeScript-created rows and evaluates the same timestamp/window.
    // It then applies another fractional delta and TypeScript observes those Rust-written rows.
    let rust = SqliteQuotaBucketStore::open_existing(&db_path).expect("open TS-migrated DB");
    for (vector, result) in vectors.iter().zip(seeded_rows.iter()) {
        let id = vector["id"].as_str().expect("vector id");
        let window_ms = vector["windowMs"].as_i64().expect("window size");
        let now_ms = vector["nowMs"].as_i64().expect("timestamp");
        let current_bucket = now_ms.div_euclid(window_ms);
        let api_key_id = result["apiKeyId"].as_str().expect("seeded API key ID");
        let dimension_key = result["dimensionKey"].as_str().expect("dimension key");
        assert_eq!(
            result["currentBucket"].as_i64(),
            Some(current_bucket),
            "{id}"
        );

        let before_pair = pair_from_json(&result["beforePair"]);
        let expected_peek = vector["expectedPeek"].as_f64().expect("expected peek");
        assert_close(
            &format!("{id}: TypeScript peek"),
            result["before"].as_f64().unwrap(),
            expected_peek,
        );
        assert_close(
            &format!("{id}: Rust formula on TypeScript pair"),
            before_pair.effective(now_ms, window_ms).unwrap(),
            expected_peek,
        );

        let after_pair = rust
            .get_pair(api_key_id, dimension_key, current_bucket)
            .expect("read TypeScript bucket rows");
        assert_pair_close(
            &format!("{id}: Rust reads TypeScript pair"),
            after_pair,
            pair_from_json(&result["afterPair"]),
        );
        let expected_after_consume = vector["expectedAfterConsume"]
            .as_f64()
            .expect("expected consume result");
        if vector["consumeDelta"].is_null() {
            assert!(
                result["consumed"].is_null(),
                "{id}: unexpected TypeScript consume result"
            );
        } else {
            assert_close(
                &format!("{id}: TypeScript consume return"),
                result["consumed"].as_f64().expect("consume return value"),
                expected_after_consume,
            );
        }
        assert_close(
            &format!("{id}: TypeScript result after consume"),
            result["after"].as_f64().unwrap(),
            expected_after_consume,
        );
        assert_close(
            &format!("{id}: Rust formula after TypeScript consume"),
            after_pair.effective(now_ms, window_ms).unwrap(),
            expected_after_consume,
        );

        let rust_delta = vector["rustDelta"].as_f64().expect("Rust delta");
        rust.increment_bucket(
            api_key_id,
            dimension_key,
            current_bucket,
            rust_delta,
            now_ms,
        )
        .expect("write Rust fractional delta");
        let rust_pair = rust
            .get_pair(api_key_id, dimension_key, current_bucket)
            .expect("read Rust-updated pair");
        assert_close(
            &format!("{id}: Rust formula after Rust increment"),
            rust_pair.effective(now_ms, window_ms).unwrap(),
            vector["expectedAfterRust"]
                .as_f64()
                .expect("expected Rust result"),
        );
    }
    drop(rust);

    let observed_by_typescript = run_typescript(
        &data_dir.0,
        r#"
          const fs = await import("node:fs");
          const { SqliteQuotaStore } = await import("./src/lib/quota/sqliteQuotaStore.ts");
          const vectors = JSON.parse(fs.readFileSync(process.env.TEST_EFFECTIVE_FIXTURE, "utf8"));
          const originalNow = Date.now;
          const store = new SqliteQuotaStore();
          const results = [];
          try {
            for (const vector of vectors) {
              Date.now = () => vector.nowMs;
              const dimension = { poolId: "fixture-pool", unit: "tokens", window: vector.window };
              const apiKeyId = `fixture-effective-${vector.id}`;
              results.push({ id: vector.id, actual: await store.peek(apiKeyId, dimension) });
            }
          } finally {
            Date.now = originalNow;
            core.resetDbInstance();
          }
          console.log("RESULT:" + JSON.stringify(results));
        "#,
    );
    let observed = observed_by_typescript
        .as_array()
        .expect("TypeScript reread array");
    for vector in vectors.iter() {
        let id = vector["id"].as_str().expect("vector id");
        let actual = observed
            .iter()
            .find(|result| result["id"].as_str() == Some(id))
            .expect("TypeScript observed each vector")["actual"]
            .as_f64()
            .expect("TypeScript effective value");
        assert_close(
            &format!("{id}: TypeScript formula after Rust increment"),
            actual,
            vector["expectedAfterRust"]
                .as_f64()
                .expect("expected Rust result"),
        );
    }
}

fn run_typescript(data_dir: &Path, source: &str) -> Value {
    let script = format!(
        "import * as core from './src/lib/db/core.ts';\n\
         import * as quota from './src/lib/db/quotaConsumption.ts';\n\
         core.getDbInstance();\n{source}"
    );
    let repo_root = Path::new(MANIFEST_DIR)
        .join("../..")
        .canonicalize()
        .expect("resolve repository root");
    let output = Command::new("node")
        .current_dir(repo_root)
        .args([
            "--import",
            "tsx/esm",
            "--input-type=module",
            "-e",
            script.as_str(),
        ])
        .env("DATA_DIR", data_dir)
        .env("TEST_API_KEY_ID", API_KEY_ID)
        .env("TEST_DIMENSION", DIMENSION)
        .env(
            "TEST_EFFECTIVE_FIXTURE",
            Path::new(MANIFEST_DIR).join("fixtures/quota-sliding-window-v1.json"),
        )
        .env("OMNIROUTE_SKIP_DB_HEALTHCHECK", "1")
        .output()
        .expect("launch TypeScript quota-storage process");
    assert!(
        output.status.success(),
        "TypeScript quota helper failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let result = stdout
        .lines()
        .find_map(|line| line.strip_prefix("RESULT:"))
        .expect("TypeScript quota result marker");
    serde_json::from_str(result).expect("parse TypeScript quota result")
}

fn pair(curr: f64, prev: f64) -> quota_bucket_store::BucketPair {
    quota_bucket_store::BucketPair { curr, prev }
}

fn assert_pair(value: &Value, curr: f64, prev: f64) {
    assert_eq!(value["curr"].as_f64(), Some(curr));
    assert_eq!(value["prev"].as_f64(), Some(prev));
}

fn pair_from_json(value: &Value) -> quota_bucket_store::BucketPair {
    pair(
        value["curr"].as_f64().expect("current bucket value"),
        value["prev"].as_f64().expect("previous bucket value"),
    )
}

fn assert_pair_close(
    label: &str,
    actual: quota_bucket_store::BucketPair,
    expected: quota_bucket_store::BucketPair,
) {
    assert_close(&format!("{label}: curr"), actual.curr, expected.curr);
    assert_close(&format!("{label}: prev"), actual.prev, expected.prev);
}

fn assert_close(label: &str, actual: f64, expected: f64) {
    let tolerance = 1e-9_f64.max(expected.abs() * 1e-12);
    assert!(
        actual.is_finite() && (actual - expected).abs() <= tolerance,
        "{label}: expected {expected:.15}, got {actual:.15} (tolerance {tolerance})"
    );
}
