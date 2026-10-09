#[path = "../account_scheduler.rs"]
mod account_scheduler;

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use account_scheduler::{AccountScheduler, SyntheticAccount};
use tokio::sync::Barrier;

const AGENT_COUNTS: [usize; 2] = [70, 100];
const TURNS_PER_AGENT: usize = 4;
const ACCOUNT_CAP: usize = 8;
const SERVICE_TIME: Duration = Duration::from_millis(8);
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
struct AccountMetrics {
    selected: usize,
    affinity_hits: usize,
    current: usize,
    peak: usize,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    for agent_count in AGENT_COUNTS {
        run_contention_case(agent_count).await?;
    }
    Ok(())
}

async fn run_contention_case(agent_count: usize) -> Result<(), Box<dyn std::error::Error>> {
    let mut accounts = (0..6)
        .map(|index| SyntheticAccount {
            id: format!("eligible-{index}"),
            enabled: true,
            cooldown_until: None,
            quota_exhausted: false,
            max_in_flight: ACCOUNT_CAP,
            priority: 1,
        })
        .collect::<Vec<_>>();
    accounts.extend([
        SyntheticAccount {
            id: "disabled".into(),
            enabled: false,
            cooldown_until: None,
            quota_exhausted: false,
            max_in_flight: ACCOUNT_CAP,
            priority: 1,
        },
        SyntheticAccount {
            id: "cooldown".into(),
            enabled: true,
            cooldown_until: Some(Instant::now() + Duration::from_secs(600)),
            quota_exhausted: false,
            max_in_flight: ACCOUNT_CAP,
            priority: 1,
        },
        SyntheticAccount {
            id: "quota-exhausted".into(),
            enabled: true,
            cooldown_until: None,
            quota_exhausted: true,
            max_in_flight: ACCOUNT_CAP,
            priority: 1,
        },
    ]);
    let eligible_ids = accounts
        .iter()
        .filter(|account| {
            account.enabled && account.cooldown_until.is_none() && !account.quota_exhausted
        })
        .map(|account| account.id.clone())
        .collect::<Vec<_>>();
    let scheduler = AccountScheduler::new(accounts, Some(Duration::from_secs(60)))?;
    let metrics = Arc::new(Mutex::new(BTreeMap::<String, AccountMetrics>::new()));
    let barrier = Arc::new(Barrier::new(agent_count + 1));
    let mut tasks = Vec::with_capacity(agent_count);

    for agent_index in 0..agent_count {
        let scheduler = scheduler.clone();
        let metrics = Arc::clone(&metrics);
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            let session_key = format!("agent-session-{agent_index}");
            barrier.wait().await;
            for _ in 0..TURNS_PER_AGENT {
                let lease = scheduler.acquire(Some(&session_key), WAIT_TIMEOUT).await?;
                let account_id = lease.account_id().to_owned();
                {
                    let mut metrics = metrics.lock().unwrap_or_else(|e| e.into_inner());
                    let entry = metrics.entry(account_id.clone()).or_default();
                    entry.selected += 1;
                    entry.affinity_hits += usize::from(lease.used_affinity());
                    entry.current += 1;
                    entry.peak = entry.peak.max(entry.current);
                }

                tokio::time::sleep(SERVICE_TIME).await;

                {
                    let mut metrics = metrics.lock().unwrap_or_else(|e| e.into_inner());
                    metrics
                        .get_mut(&account_id)
                        .expect("selected account is tracked")
                        .current -= 1;
                }
                drop(lease);
            }
            Ok::<(), account_scheduler::SchedulerError>(())
        }));
    }

    let started = Instant::now();
    barrier.wait().await;
    for task in tasks {
        task.await??;
    }
    let elapsed = started.elapsed();
    let metrics = metrics.lock().unwrap_or_else(|e| e.into_inner());
    let requested = agent_count * TURNS_PER_AGENT;
    let completed: usize = metrics.values().map(|entry| entry.selected).sum();
    let rejected = requested.saturating_sub(completed);
    let max_account_peak = metrics.values().map(|entry| entry.peak).max().unwrap_or(0);
    let affinity_hits: usize = metrics.values().map(|entry| entry.affinity_hits).sum();
    let max_account_id = metrics
        .iter()
        .max_by_key(|(_, entry)| entry.peak)
        .map(|(id, entry)| (id.as_str(), entry.peak));
    let max_account_id = max_account_id
        .map(|(id, peak)| format!("{id}:{peak}"))
        .unwrap_or_else(|| "none:0".into());

    assert_eq!(completed, requested);
    assert_eq!(rejected, 0);
    assert!(max_account_peak <= ACCOUNT_CAP);
    assert!(metrics.keys().all(|id| eligible_ids.contains(id)));
    assert!(eligible_ids.iter().all(|id| metrics.contains_key(id)));

    println!(
        "agents={agent_count} turns_per_agent={TURNS_PER_AGENT} requested={requested} completed={completed} rejected={rejected} eligible_accounts={} account_cap={ACCOUNT_CAP} peak_account={max_account_id} affinity_hits={affinity_hits} elapsed_ms={:.2} selections={:?}",
        eligible_ids.len(),
        elapsed.as_secs_f64() * 1000.0,
        metrics
            .iter()
            .map(|(id, entry)| (id, entry.selected))
            .collect::<Vec<_>>()
    );
    Ok(())
}
