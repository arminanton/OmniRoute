#[path = "../account_scheduler.rs"]
mod account_scheduler;

use std::{
    collections::BTreeMap,
    env,
    error::Error,
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use account_scheduler::{
    AccountScheduler, SchedulerError, SyntheticAccount, SyntheticRoutingStrategy,
};
use tokio::sync::{Barrier, mpsc};

const AGENT_COUNTS: [usize; 2] = [70, 100];
const TURNS_PER_AGENT: usize = 4;
const ACCOUNT_COUNT: usize = 6;
const ACCOUNT_CAP: usize = 8;
const SERVICE_TIME: Duration = Duration::from_millis(8);
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const CANCEL_PROBE_TASKS: usize = 4;
const STRATEGIES: [SyntheticRoutingStrategy; 2] = [
    SyntheticRoutingStrategy::LeastLoaded,
    SyntheticRoutingStrategy::PriorityOrderedFillFirst,
];

#[derive(Default)]
struct AccountMetrics {
    selected: usize,
    current: usize,
    peak: usize,
}

#[derive(Default)]
struct WorkloadMetrics {
    accounts: BTreeMap<String, AccountMetrics>,
    acquire_latencies_ms: Vec<f64>,
    sessions_completed: usize,
    wait_timeouts: usize,
    no_eligible: usize,
}

fn strategy_name(strategy: SyntheticRoutingStrategy) -> &'static str {
    match strategy {
        SyntheticRoutingStrategy::LeastLoaded => "least-loaded",
        SyntheticRoutingStrategy::PriorityOrderedFillFirst => "priority-fill-first",
    }
}

fn synthetic_accounts() -> Vec<SyntheticAccount> {
    let mut accounts = (0..ACCOUNT_COUNT)
        .map(|index| SyntheticAccount {
            id: format!("eligible-{index}"),
            enabled: true,
            cooldown_until: None,
            quota_exhausted: false,
            max_in_flight: ACCOUNT_CAP,
            priority: index as u32 + 1,
        })
        .collect::<Vec<_>>();
    accounts.extend([
        SyntheticAccount {
            id: "disabled".into(),
            enabled: false,
            cooldown_until: None,
            quota_exhausted: false,
            max_in_flight: ACCOUNT_CAP,
            priority: 99,
        },
        SyntheticAccount {
            id: "cooldown".into(),
            enabled: true,
            cooldown_until: Some(Instant::now() + Duration::from_secs(600)),
            quota_exhausted: false,
            max_in_flight: ACCOUNT_CAP,
            priority: 99,
        },
        SyntheticAccount {
            id: "quota-exhausted".into(),
            enabled: true,
            cooldown_until: None,
            quota_exhausted: true,
            max_in_flight: ACCOUNT_CAP,
            priority: 99,
        },
    ]);
    accounts
}

fn eligible_ids(accounts: &[SyntheticAccount]) -> Vec<String> {
    accounts
        .iter()
        .filter(|account| {
            account.enabled
                && !account.quota_exhausted
                && account
                    .cooldown_until
                    .is_none_or(|until| until <= Instant::now())
        })
        .map(|account| account.id.clone())
        .collect()
}

fn percentile(values: &[f64], percent: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((percent / 100.0 * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    sorted[index]
}

fn assert_eligible_only(metrics: &WorkloadMetrics, eligible: &[String]) {
    assert!(metrics.accounts.keys().all(|id| eligible.contains(id)));
    assert!(eligible.iter().all(|id| metrics.accounts.contains_key(id)));
    assert!(metrics.accounts.values().all(|entry| entry.current == 0));
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let agent_counts = match env::args().nth(1) {
        None => AGENT_COUNTS.to_vec(),
        Some(value) => {
            let count = value.parse::<usize>()?;
            if !AGENT_COUNTS.contains(&count) {
                return Err(io::Error::other("pass 70 or 100 sessions").into());
            }
            vec![count]
        }
    };

    for agent_count in agent_counts {
        for strategy in STRATEGIES {
            run_contention_case(agent_count, strategy).await?;
            run_cancellation_probe(agent_count, strategy).await?;
        }
    }
    Ok(())
}

async fn run_contention_case(
    agent_count: usize,
    strategy: SyntheticRoutingStrategy,
) -> Result<(), Box<dyn Error>> {
    let accounts = synthetic_accounts();
    let eligible = eligible_ids(&accounts);
    let scheduler = AccountScheduler::new_with_strategy(accounts, None, strategy)?;
    let metrics = Arc::new(Mutex::new(WorkloadMetrics {
        accounts: eligible
            .iter()
            .map(|id| (id.clone(), AccountMetrics::default()))
            .collect(),
        ..WorkloadMetrics::default()
    }));
    let barrier = Arc::new(Barrier::new(agent_count + 1));
    let mut tasks = Vec::with_capacity(agent_count);

    for _agent_index in 0..agent_count {
        let scheduler = scheduler.clone();
        let metrics = Arc::clone(&metrics);
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            let mut completed_turns = 0;
            for _ in 0..TURNS_PER_AGENT {
                let acquire_started = Instant::now();
                let lease_result = scheduler.acquire(None, WAIT_TIMEOUT).await;
                let acquire_ms = acquire_started.elapsed().as_secs_f64() * 1000.0;
                {
                    let mut metrics = metrics.lock().unwrap_or_else(|error| error.into_inner());
                    metrics.acquire_latencies_ms.push(acquire_ms);
                }

                let lease = match lease_result {
                    Ok(lease) => lease,
                    Err(SchedulerError::WaitTimeout) => {
                        metrics
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .wait_timeouts += 1;
                        break;
                    }
                    Err(SchedulerError::NoEligibleAccounts) => {
                        metrics
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .no_eligible += 1;
                        break;
                    }
                };

                let account_id = lease.account_id().to_owned();
                {
                    let mut metrics = metrics.lock().unwrap_or_else(|error| error.into_inner());
                    let entry = metrics
                        .accounts
                        .get_mut(&account_id)
                        .expect("selected account is in the eligible set");
                    entry.selected += 1;
                    entry.current += 1;
                    entry.peak = entry.peak.max(entry.current);
                }

                tokio::time::sleep(SERVICE_TIME).await;

                {
                    metrics
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .accounts
                        .get_mut(&account_id)
                        .expect("selected account is tracked")
                        .current -= 1;
                }
                drop(lease);
                completed_turns += 1;
            }
            if completed_turns == TURNS_PER_AGENT {
                metrics
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .sessions_completed += 1;
            }
        }));
    }

    let started = Instant::now();
    barrier.wait().await;
    for task in tasks {
        task.await?;
    }
    let elapsed = started.elapsed();
    let capacity_wait_requests = scheduler.capacity_wait_requests();
    let metrics = metrics.lock().unwrap_or_else(|error| error.into_inner());
    assert_eligible_only(&metrics, &eligible);

    let requested = agent_count * TURNS_PER_AGENT;
    let completed: usize = metrics.accounts.values().map(|entry| entry.selected).sum();
    let failed = metrics.wait_timeouts + metrics.no_eligible;
    let max_account_peak = metrics
        .accounts
        .values()
        .map(|entry| entry.peak)
        .max()
        .unwrap_or(0);
    let selection_counts = metrics
        .accounts
        .iter()
        .map(|(id, entry)| (id.clone(), entry.selected))
        .collect::<Vec<_>>();
    let min_selected = metrics
        .accounts
        .values()
        .map(|entry| entry.selected)
        .min()
        .unwrap_or(0);
    let max_selected = metrics
        .accounts
        .values()
        .map(|entry| entry.selected)
        .max()
        .unwrap_or(0);
    let average = completed as f64 / eligible.len() as f64;
    let variance = metrics
        .accounts
        .values()
        .map(|entry| (entry.selected as f64 - average).powi(2))
        .sum::<f64>()
        / eligible.len() as f64;
    let skew_max_min = if min_selected == 0 {
        f64::INFINITY
    } else {
        max_selected as f64 / min_selected as f64
    };
    let throughput = completed as f64 / elapsed.as_secs_f64();

    println!(
        "workload strategy={} sessions={} turns_per_session={} requested={} completed={} failed={} capacity_wait_requests={} wait_timeouts={} no_eligible={} throughput_req_s={:.2} elapsed_ms={:.2} acquire_p50_ms={:.3} acquire_p95_ms={:.3} account_cap={} max_account_peak={} selection_skew_max_min={:.2} selection_cv={:.3} distribution={:?}",
        strategy_name(strategy),
        agent_count,
        TURNS_PER_AGENT,
        requested,
        completed,
        failed,
        capacity_wait_requests,
        metrics.wait_timeouts,
        metrics.no_eligible,
        throughput,
        elapsed.as_secs_f64() * 1000.0,
        percentile(&metrics.acquire_latencies_ms, 50.0),
        percentile(&metrics.acquire_latencies_ms, 95.0),
        ACCOUNT_CAP,
        max_account_peak,
        skew_max_min,
        variance.sqrt() / average,
        selection_counts,
    );

    assert_eq!(completed, requested);
    assert_eq!(metrics.sessions_completed, agent_count);
    assert_eq!(failed, 0);
    assert!(max_account_peak <= ACCOUNT_CAP);
    Ok(())
}

async fn run_cancellation_probe(
    agent_count: usize,
    strategy: SyntheticRoutingStrategy,
) -> Result<(), Box<dyn Error>> {
    let scheduler = AccountScheduler::new_with_strategy(synthetic_accounts(), None, strategy)?;
    let barrier = Arc::new(Barrier::new(CANCEL_PROBE_TASKS + 1));
    let (sender, mut receiver) = mpsc::channel::<String>(CANCEL_PROBE_TASKS);
    let mut tasks = Vec::with_capacity(CANCEL_PROBE_TASKS);

    for _ in 0..CANCEL_PROBE_TASKS {
        let scheduler = scheduler.clone();
        let barrier = Arc::clone(&barrier);
        let sender = sender.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            let lease = scheduler.acquire(None, WAIT_TIMEOUT).await?;
            sender
                .send(lease.account_id().to_owned())
                .await
                .map_err(|_| SchedulerError::WaitTimeout)?;
            std::future::pending::<()>().await;
            drop(lease);
            Ok::<(), SchedulerError>(())
        }));
    }
    drop(sender);
    barrier.wait().await;

    let mut cancellation_distribution = BTreeMap::<String, usize>::new();
    for _ in 0..CANCEL_PROBE_TASKS {
        let account_id = tokio::time::timeout(Duration::from_secs(2), receiver.recv()).await?;
        let account_id = account_id.ok_or_else(|| io::Error::other("cancel probe ended early"))?;
        *cancellation_distribution.entry(account_id).or_default() += 1;
    }

    let in_flight_before = scheduler
        .in_flight_by_account()
        .values()
        .copied()
        .sum::<usize>();
    let mut cancelled_tasks = 0;
    for task in tasks {
        task.abort();
        match task.await {
            Err(error) if error.is_cancelled() => cancelled_tasks += 1,
            Err(error) => return Err(error.into()),
            Ok(Err(error)) => return Err(error.into()),
            Ok(Ok(())) => {
                return Err(io::Error::other("cancel probe task unexpectedly completed").into());
            }
        }
    }
    let in_flight_after = scheduler
        .in_flight_by_account()
        .values()
        .copied()
        .sum::<usize>();
    let released_after_cancel = in_flight_before.saturating_sub(in_flight_after);
    let capacity_wait_requests = scheduler.capacity_wait_requests();
    let verification_lease = scheduler.acquire(None, Duration::from_secs(1)).await?;
    let capacity_reacquired = true;
    drop(verification_lease);

    println!(
        "cancellation_probe strategy={} sessions={} requested={} acquired={} cancelled_tasks={} in_flight_before={} released_after_cancel={} in_flight_after={} capacity_wait_requests={} verification_reacquired={} account_distribution={:?}",
        strategy_name(strategy),
        agent_count,
        CANCEL_PROBE_TASKS,
        cancellation_distribution.values().sum::<usize>(),
        cancelled_tasks,
        in_flight_before,
        released_after_cancel,
        in_flight_after,
        capacity_wait_requests,
        capacity_reacquired,
        cancellation_distribution,
    );

    assert_eq!(cancelled_tasks, CANCEL_PROBE_TASKS);
    assert_eq!(in_flight_before, CANCEL_PROBE_TASKS);
    assert_eq!(released_after_cancel, CANCEL_PROBE_TASKS);
    assert_eq!(in_flight_after, 0);
    assert_eq!(capacity_wait_requests, 0);
    Ok(())
}
