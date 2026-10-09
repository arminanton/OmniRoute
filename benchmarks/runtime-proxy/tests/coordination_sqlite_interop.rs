#[path = "../src/coordination_sqlite.rs"]
mod coordination_sqlite;

use coordination_sqlite::{CoordinationRequirement, FencedLease, SqliteCoordinator};
#[path = "../src/shared_dispatch_lease.rs"]
mod shared_dispatch_lease;

use rusqlite::Connection;
use serde_json::Value;
use shared_dispatch_lease::{DispatchAcquireError, DispatchLeaseTiming, SharedDispatchAdmission};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::Arc,
    time::Duration,
};
use tokio::sync::watch;
use uuid::Uuid;

const PROBE: &str = env!("CARGO_BIN_EXE_omniroute-coordination-probe");
const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("omni-coord-rust-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create local temporary directory");
        Self(path)
    }

    fn db_path(&self) -> PathBuf {
        self.0.join("coordination.sqlite")
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rust_and_typescript_processes_share_v1_cap_fences_and_lease_lifecycle() {
    let temporary = TempDirectory::new();
    let db_path = temporary.db_path();
    let db = db_path.to_str().expect("UTF-8 temp DB path");
    let now = 1_000_i64;
    let rust = SqliteCoordinator::open(db, "rust-parent").expect("open Rust coordinator");
    let waiter = rust
        .enqueue(&[gate("provider:codex", 1)], now + 20_000, 20, now)
        .expect("enqueue first lease");
    let first = rust
        .try_acquire(&waiter, 1_000, now)
        .expect("acquire first lease")
        .expect("first lease admitted");

    // An independent process cannot exceed the cap-1 resource, but it can make progress on a
    // distinct resource. The worker itself closes its connection after the attempt.
    let blocked = run_probe(&[
        "attempt",
        db,
        "rust-child",
        "provider:codex",
        "1",
        "1200",
        "1000",
        "20000",
    ]);
    assert_eq!(blocked["status"], "blocked");
    let independent = run_probe(&[
        "attempt",
        db,
        "rust-child",
        "provider:other",
        "1",
        "1200",
        "1000",
        "20000",
        "release",
    ]);
    assert_eq!(independent["status"], "acquired");

    // Renewal extends the shared expiry. The other process remains blocked until the renewed
    // deadline, then prunes the expired lease and gets a strictly newer fence.
    assert!(rust.renew(&first, 1_000, 1_500).expect("renew first lease"));
    let still_blocked = run_probe(&[
        "attempt",
        db,
        "rust-child",
        "provider:codex",
        "1",
        "2499",
        "1000",
        "20000",
    ]);
    assert_eq!(still_blocked["status"], "blocked");
    let replacement = run_probe(&[
        "attempt",
        db,
        "rust-child",
        "provider:codex",
        "1",
        "2500",
        "1000",
        "20000",
    ]);
    assert_eq!(replacement["status"], "acquired");
    let second = parse_lease(&replacement["lease"]);
    assert!(second.fence > first.fence);
    assert!(
        !rust
            .valid(&first, 2_500)
            .expect("old lease invalid after expiry")
    );
    assert!(
        !rust
            .renew(&first, 1_000, 2_500)
            .expect("old fence cannot renew")
    );

    // A stale owner/fence release cannot remove the replacement process's permit.
    rust.release(&first).expect("stale release is harmless");
    let valid_from_child = run_probe(&["valid", db, "rust-child", &lease_json(&second), "2500"]);
    assert_eq!(valid_from_child["result"], true);
    let wrong_owner = run_probe(&["valid", db, "other-owner", &lease_json(&second), "2500"]);
    assert_eq!(wrong_owner["result"], false);
    run_probe(&["release", db, "other-owner", &lease_json(&second)]);
    let still_valid = run_probe(&["valid", db, "rust-child", &lease_json(&second), "2500"]);
    assert_eq!(still_valid["result"], true);
    run_probe(&["release", db, "rust-child", &lease_json(&second)]);
    let invalid_after_release =
        run_probe(&["valid", db, "rust-child", &lease_json(&second), "2500"]);
    assert_eq!(invalid_after_release["result"], false);

    // A canceled waiter must not remain ahead of a newer waiter on the same resource.
    let hold_id = rust
        .enqueue(&[gate("cancel-check", 1)], 10_000, 20, 3_000)
        .expect("enqueue cancellation test holder");
    let held = rust
        .try_acquire(&hold_id, 1_000, 3_000)
        .expect("acquire cancellation test holder")
        .expect("holder admitted");
    let canceled = run_probe(&[
        "cancel",
        db,
        "cancel-owner",
        "cancel-check",
        "1",
        "3100",
        "10000",
    ]);
    assert_eq!(canceled["status"], "cancelled");
    let locally_cancelled = rust
        .enqueue(&[gate("cancel-check", 1)], 10_000, 20, 3_100)
        .expect("enqueue local cancellation waiter");
    rust.cancel(&locally_cancelled)
        .expect("cancel local waiter");
    let later_id = rust
        .enqueue(&[gate("cancel-check", 1)], 10_000, 20, 3_100)
        .expect("enqueue later waiter");
    assert!(
        rust.try_acquire(&later_id, 1_000, 3_100)
            .expect("later waiter is capacity-blocked")
            .is_none()
    );
    rust.release(&held)
        .expect("release cancellation test holder");
    let later = rust
        .try_acquire(&later_id, 1_000, 3_200)
        .expect("later waiter proceeds")
        .expect("later waiter acquired");
    rust.release(&later).expect("release later waiter");

    // Shared blocks are part of the same v1 file protocol and must be visible cross-process.
    let blocked_resource = "blocked-resource";
    rust.block(blocked_resource, 6_000)
        .expect("create shared block");
    let child_blocked = run_probe(&[
        "attempt",
        db,
        "block-observer",
        blocked_resource,
        "1",
        "4000",
        "1000",
        "10000",
    ]);
    assert_eq!(child_blocked["status"], "blocked");
    let block_waiter = rust
        .enqueue(&[gate(blocked_resource, 1)], 10_000, 20, 4_000)
        .expect("enqueue blocked resource");
    assert!(
        rust.try_acquire(&block_waiter, 1_000, 4_000)
            .expect("shared block applies")
            .is_none()
    );
    rust.unblock(blocked_resource).expect("remove shared block");
    let unblocked_lease = rust
        .try_acquire(&block_waiter, 1_000, 4_000)
        .expect("shared block removed")
        .expect("resource admitted after unblock");
    rust.release(&unblocked_lease)
        .expect("release unblocked resource");

    // TypeScript creates a v1 lease first. Rust sees it as occupied, then can acquire after the
    // TypeScript owner releases it. This exercises the TypeScript-to-Rust direction.
    let typescript_db_path = temporary.0.join("typescript-first.sqlite");
    let ts_lease_value = run_typescript_probe(
        typescript_db_path.as_path(),
        "ts-lease-owner",
        r#"
          const c = new SqliteCoordinator(process.env.TEST_COORDINATION_DB,
            process.env.TEST_COORDINATION_OWNER);
          const now = 4000;
          const id = c.enqueue([{ key: "ts-to-rust", limit: 1 }], now + 5000, 20, now);
          const lease = c.tryAcquire(id, 1000, now);
          c.close();
          console.log(JSON.stringify(lease));
        "#,
    );
    let ts_lease = parse_lease(&ts_lease_value);
    let typescript_db = typescript_db_path
        .to_str()
        .expect("UTF-8 TypeScript-first DB path");
    let rust_on_ts_file = SqliteCoordinator::open(typescript_db, "rust-observer")
        .expect("Rust opens TypeScript-created schema");
    let rust_waiter = rust_on_ts_file
        .enqueue(&[gate("ts-to-rust", 1)], 10_000, 20, 4_100)
        .expect("Rust queues behind TypeScript lease");
    assert!(
        rust_on_ts_file
            .try_acquire(&rust_waiter, 1_000, 4_100)
            .expect("Rust observes TypeScript lease")
            .is_none()
    );
    let release_script = format!(
        r#"
          const c = new SqliteCoordinator(process.env.TEST_COORDINATION_DB,
            process.env.TEST_COORDINATION_OWNER);
          const lease = {};
          c.release(lease);
          c.close();
          console.log(JSON.stringify({{ released: true }}));
        "#,
        lease_json(&ts_lease)
    );
    let released_by_ts = run_typescript_probe(
        typescript_db_path.as_path(),
        "ts-lease-owner",
        release_script.as_str(),
    );
    assert_eq!(released_by_ts["released"], true);
    let rust_after_ts = rust_on_ts_file
        .try_acquire(&rust_waiter, 1_000, 4_200)
        .expect("Rust admission after TypeScript release")
        .expect("Rust acquired after TypeScript release");
    rust_on_ts_file
        .release(&rust_after_ts)
        .expect("release cross-runtime Rust lease");

    // The reverse direction: TypeScript observes a Rust lease, then acquires after Rust releases.
    let rust_cross_language_id = rust
        .enqueue(&[gate("cross-language", 1)], 10_000, 20, 4_000)
        .expect("enqueue Rust cross-language waiter");
    let rust_cross_language = rust
        .try_acquire(&rust_cross_language_id, 1_000, 4_000)
        .expect("acquire Rust cross-language lease")
        .expect("Rust cross-language lease admitted");
    let ts_denied_rust_lease = run_typescript_probe(
        db_path.as_path(),
        "ts-observer",
        r#"
          const c = new SqliteCoordinator(process.env.TEST_COORDINATION_DB,
            process.env.TEST_COORDINATION_OWNER);
          const id = c.enqueue([{ key: "cross-language", limit: 1 }], 10000, 20, 4100);
          const denied = c.tryAcquire(id, 1000, 4100) === null;
          c.cancel(id);
          c.close();
          console.log(JSON.stringify({ denied }));
        "#,
    );
    assert_eq!(ts_denied_rust_lease["denied"], true);
    rust.release(&rust_cross_language)
        .expect("release Rust cross-language lease");
    let ts_acquired = run_typescript_probe(
        db_path.as_path(),
        "ts-acquire",
        r#"
          const c = new SqliteCoordinator(process.env.TEST_COORDINATION_DB,
            process.env.TEST_COORDINATION_OWNER);
          const id = c.enqueue([{ key: "cross-language", limit: 1 }], 10000, 20, 4200);
          const lease = c.tryAcquire(id, 1000, 4200);
          if (lease) c.release(lease);
          c.close();
          console.log(JSON.stringify({ acquired: lease !== null, fence: lease?.fence ?? null }));
        "#,
    );
    assert_eq!(ts_acquired["acquired"], true);
}

fn gate(key: &str, limit: usize) -> CoordinationRequirement {
    CoordinationRequirement {
        key: key.to_owned(),
        limit,
        adaptive: false,
        initial_limit: None,
    }
}

fn run_probe(args: &[&str]) -> Value {
    let output = Command::new(PROBE)
        .args(args)
        .output()
        .expect("launch independent Rust coordination process");
    assert_success(&output, "Rust coordination worker");
    serde_json::from_slice(&output.stdout).expect("parse Rust worker JSON")
}

fn run_typescript_probe(db_path: &Path, owner: &str, source: &str) -> Value {
    let script = format!(
        "import {{ SqliteCoordinator }} from './open-sse/services/coordination/sqliteCoordinator.ts';\n{source}"
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
        .env("TEST_COORDINATION_DB", db_path)
        .env("TEST_COORDINATION_OWNER", owner)
        .output()
        .expect("launch TypeScript coordinator process");
    assert_success(&output, "TypeScript coordinator");
    serde_json::from_slice(&output.stdout).expect("parse TypeScript coordinator JSON")
}

fn assert_success(output: &Output, label: &str) {
    assert!(
        output.status.success(),
        "{label} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn parse_lease(value: &Value) -> FencedLease {
    FencedLease {
        id: value["id"].as_str().expect("lease id").to_owned(),
        fence: value["fence"].as_i64().expect("lease fence"),
        expires_at: value["expiresAt"].as_i64().expect("lease expiry"),
    }
}

fn lease_json(lease: &FencedLease) -> String {
    serde_json::json!({
        "id": lease.id,
        "fence": lease.fence,
        "expiresAt": lease.expires_at,
    })
    .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rust_dispatch_facade_cancels_renews_and_reclaims_ts_leases() {
    let temporary = TempDirectory::new();
    let db_path = temporary.db_path();

    // TypeScript holds the same global/provider/account gates that production supplies after
    // selection. Rust's waiter must remain queued without consuming a partial reservation.
    let held_by_ts = run_typescript_probe(
        db_path.as_path(),
        "ts-dispatch-holder",
        r#"
          const c = new SqliteCoordinator(process.env.TEST_COORDINATION_DB,
            process.env.TEST_COORDINATION_OWNER);
          const now = Date.now();
          const resources = [
            { key: "global", limit: 1 },
            { key: "provider:codex", limit: 1 },
            { key: "account:opaque-candidate", limit: 1 },
          ];
          const id = c.enqueue(resources, now + 30000, 20, now);
          const lease = c.tryAcquire(id, 30000, now);
          c.close();
          console.log(JSON.stringify(lease));
        "#,
    );
    let ts_lease = parse_lease(&held_by_ts);
    let db = db_path.to_str().expect("UTF-8 temp DB path");
    let coordinator = Arc::new(
        SqliteCoordinator::open(db, "rust-dispatch-facade")
            .expect("open the TypeScript-created coordination DB"),
    );
    let timing = DispatchLeaseTiming {
        lease_ttl_ms: 1_200,
        renew_every: Duration::from_millis(200),
        poll_every: Duration::from_millis(20),
    };
    let service = SharedDispatchAdmission::with_timing(Arc::clone(&coordinator), timing)
        .expect("valid test lease timing");
    let requirements = vec![
        gate("global", 1),
        gate("provider:codex", 1),
        gate("account:opaque-candidate", 1),
    ];

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let waiting_service = service.clone();
    let waiting_requirements = requirements.clone();
    let waiter_task = tokio::spawn(async move {
        waiting_service
            .acquire_many(
                &waiting_requirements,
                Duration::from_secs(5),
                20,
                Some(cancel_rx),
            )
            .await
    });
    wait_for_waiter_count(db_path.as_path(), 1).await;
    cancel_tx.send(true).expect("signal waiter abort");
    assert!(matches!(
        waiter_task.await.unwrap(),
        Err(DispatchAcquireError::Cancelled)
    ));
    assert_eq!(shared_waiter_count(db_path.as_path()), 0);

    // Cancellation removes the wait record; releasing the TypeScript lease lets the Rust facade
    // claim every gate in one transaction. A TypeScript contender observes the Rust lease.
    let released_ts = run_typescript_probe(
        db_path.as_path(),
        "ts-dispatch-holder",
        &format!(
            "const c=new SqliteCoordinator(process.env.TEST_COORDINATION_DB, process.env.TEST_COORDINATION_OWNER); c.release({}); c.close(); console.log(JSON.stringify({{released:true}}));",
            lease_json(&ts_lease)
        ),
    );
    assert_eq!(released_ts["released"], true);

    let rust_lease = service
        .acquire_many(&requirements, Duration::from_secs(2), 20, None)
        .await
        .expect("Rust acquires all shared gates after TypeScript releases");
    tokio::time::sleep(Duration::from_millis(1_450)).await;
    assert!(!rust_lease.is_lost(), "renewal should keep the lease alive");
    let denied_ts = run_typescript_probe(
        db_path.as_path(),
        "ts-dispatch-contender",
        r#"
          const c = new SqliteCoordinator(process.env.TEST_COORDINATION_DB,
            process.env.TEST_COORDINATION_OWNER);
          const now = Date.now();
          const resources = [
            { key: "global", limit: 1 },
            { key: "provider:codex", limit: 1 },
            { key: "account:opaque-candidate", limit: 1 },
          ];
          const id = c.enqueue(resources, now + 5000, 20, now);
          const denied = c.tryAcquire(id, 1000, now) === null;
          c.cancel(id);
          c.close();
          console.log(JSON.stringify({ denied }));
        "#,
    );
    assert_eq!(denied_ts["denied"], true);
    rust_lease
        .release()
        .await
        .expect("release Rust dispatch lease");
    let accepted_ts = run_typescript_probe(
        db_path.as_path(),
        "ts-dispatch-after-release",
        r#"
          const c = new SqliteCoordinator(process.env.TEST_COORDINATION_DB,
            process.env.TEST_COORDINATION_OWNER);
          const now = Date.now();
          const id = c.enqueue([{key:"global", limit:1}], now + 5000, 20, now);
          const lease = c.tryAcquire(id, 1000, now);
          if (lease) c.release(lease);
          c.close();
          console.log(JSON.stringify({ acquired: lease !== null }));
        "#,
    );
    assert_eq!(accepted_ts["acquired"], true);

    // Lease loss is surfaced to the request owner. As in TypeScript, capacity is not proactively
    // released by the lost lease; the SQLite TTL is the recovery bound.
    let loss_lease = service
        .acquire_many(&[gate("loss-probe", 1)], Duration::from_secs(2), 20, None)
        .await
        .expect("acquire lease-loss probe");
    let mut lost = loss_lease.lost_receiver().expect("lease loss receiver");
    let stolen = loss_lease.fenced_lease().expect("fenced lease").clone();
    coordinator
        .release(&stolen)
        .expect("simulate fenced lease loss");
    tokio::time::timeout(Duration::from_secs(2), lost.changed())
        .await
        .expect("heartbeat detects lost lease")
        .expect("lease-loss signal remains connected");
    assert!(loss_lease.is_lost());
    loss_lease
        .release()
        .await
        .expect("lost lease leaves capacity to TTL recovery");

    // A TypeScript lease with an already-expired wall-clock TTL is pruned by the Rust facade on
    // acquisition. This exercises the same lease expiry semantics through the dispatch wrapper.
    let stale_ts = run_typescript_probe(
        db_path.as_path(),
        "ts-expired-holder",
        r#"
          const c = new SqliteCoordinator(process.env.TEST_COORDINATION_DB,
            process.env.TEST_COORDINATION_OWNER);
          const now = Date.now() - 5000;
          const id = c.enqueue([{key:"expired-resource", limit:1}], now + 4000, 20, now);
          const lease = c.tryAcquire(id, 1000, now);
          c.close();
          console.log(JSON.stringify(lease));
        "#,
    );
    let stale_lease = parse_lease(&stale_ts);
    let expired_recovered = service
        .acquire_many(
            &[gate("expired-resource", 1)],
            Duration::from_secs(2),
            20,
            None,
        )
        .await
        .expect("expired TypeScript lease is reclaimed");
    assert!(expired_recovered.fenced_lease().unwrap().fence > stale_lease.fence);
    expired_recovered
        .release()
        .await
        .expect("release recovered lease");
}

fn shared_waiter_count(path: &Path) -> usize {
    let db = Connection::open(path).expect("open waiter-count probe");
    db.query_row("SELECT COUNT(*) FROM coordination_waiters", [], |row| {
        row.get::<_, usize>(0)
    })
    .expect("read shared waiter count")
}

async fn wait_for_waiter_count(path: &Path, expected: usize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if shared_waiter_count(path) == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("wait for durable waiter registration");
}
