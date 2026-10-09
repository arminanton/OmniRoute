#[path = "../multi_gate_admission.rs"]
mod multi_gate_admission;

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use multi_gate_admission::{GateRequirement, MultiGateAdmission};
use tokio::sync::Barrier;

const SESSION_COUNTS: [usize; 2] = [70, 100];
const TURNS_PER_SESSION: usize = 4;
const GLOBAL_CAP: usize = 20;
const PROVIDER_CAP: usize = 16;
const ACCOUNT_CAP: usize = 4;
const SERVICE_TIME: Duration = Duration::from_millis(6);
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_QUEUE_SIZE: usize = 256;

#[derive(Default)]
struct Metrics {
    completed: usize,
    max_global: usize,
    max_provider: usize,
    max_account: usize,
    max_queued_on_gate: usize,
    by_account: BTreeMap<String, usize>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    for session_count in SESSION_COUNTS {
        run_contention_case(session_count).await?;
    }
    Ok(())
}

async fn run_contention_case(session_count: usize) -> Result<(), Box<dyn std::error::Error>> {
    let admission = MultiGateAdmission::new();
    let metrics = Arc::new(Mutex::new(Metrics::default()));
    let barrier = Arc::new(Barrier::new(session_count + 1));
    let mut tasks = Vec::with_capacity(session_count);

    for session_index in 0..session_count {
        let admission = admission.clone();
        let metrics = Arc::clone(&metrics);
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            let account_id = format!("account-{}", session_index % 5);
            barrier.wait().await;
            for _ in 0..TURNS_PER_SESSION {
                let requirements = vec![
                    GateRequirement {
                        key: format!("account:codex:{account_id}"),
                        max_concurrency: Some(ACCOUNT_CAP),
                    },
                    GateRequirement {
                        key: "provider:codex".into(),
                        max_concurrency: Some(PROVIDER_CAP),
                    },
                    GateRequirement {
                        key: "global".into(),
                        max_concurrency: Some(GLOBAL_CAP),
                    },
                ];
                let lease = admission
                    .acquire_many(&requirements, WAIT_TIMEOUT, MAX_QUEUE_SIZE)
                    .await?;
                {
                    let snapshot = admission.snapshot();
                    let mut metrics = metrics.lock().unwrap_or_else(|e| e.into_inner());
                    metrics.completed += 1;
                    *metrics.by_account.entry(account_id.clone()).or_default() += 1;
                    metrics.max_global = metrics.max_global.max(snapshot["global"].running);
                    metrics.max_provider =
                        metrics.max_provider.max(snapshot["provider:codex"].running);
                    metrics.max_account = metrics
                        .max_account
                        .max(snapshot[&format!("account:codex:{account_id}")].running);
                    metrics.max_queued_on_gate = metrics
                        .max_queued_on_gate
                        .max(snapshot.values().map(|gate| gate.queued).max().unwrap_or(0));
                }
                tokio::time::sleep(SERVICE_TIME).await;
                drop(lease);
            }
            Ok::<(), multi_gate_admission::AcquireError>(())
        }));
    }

    let started = Instant::now();
    barrier.wait().await;
    for task in tasks {
        task.await??;
    }
    let elapsed = started.elapsed();
    let metrics = metrics.lock().unwrap_or_else(|e| e.into_inner());
    let requested = session_count * TURNS_PER_SESSION;
    let rejected = requested.saturating_sub(metrics.completed);

    assert_eq!(metrics.completed, requested);
    assert_eq!(rejected, 0);
    assert!(metrics.max_global <= GLOBAL_CAP);
    assert!(metrics.max_provider <= PROVIDER_CAP);
    assert!(metrics.max_account <= ACCOUNT_CAP);
    assert_eq!(metrics.by_account.len(), 5);

    println!(
        "sessions={session_count} turns_per_session={TURNS_PER_SESSION} requested={requested} completed={} rejected={rejected} max_global={}/{} max_provider={}/{} max_account={}/{} max_queued_on_gate={} elapsed_ms={:.2} accounts={:?}",
        metrics.completed,
        metrics.max_global,
        GLOBAL_CAP,
        metrics.max_provider,
        PROVIDER_CAP,
        metrics.max_account,
        ACCOUNT_CAP,
        metrics.max_queued_on_gate,
        elapsed.as_secs_f64() * 1000.0,
        metrics.by_account
    );
    Ok(())
}
