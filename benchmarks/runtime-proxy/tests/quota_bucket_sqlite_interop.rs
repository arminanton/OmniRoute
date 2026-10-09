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
