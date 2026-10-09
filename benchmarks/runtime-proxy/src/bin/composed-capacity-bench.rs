#[path = "../account_scheduler.rs"]
mod account_scheduler;
#[path = "../multi_gate_admission.rs"]
mod multi_gate_admission;

use std::{
    collections::BTreeMap,
    error::Error,
    fmt, io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use account_scheduler::{
    AccountLease, AccountScheduler, SchedulerError, SyntheticAccount, SyntheticRoutingStrategy,
};
use multi_gate_admission::{AcquireError, AdmissionLease, GateRequirement, MultiGateAdmission};
use tokio::sync::{Barrier, mpsc, oneshot};

const SESSION_COUNTS: [usize; 2] = [70, 100];
const TURNS_PER_SESSION: usize = 4;
const ACCOUNT_COUNT: usize = 6;
const SERVICE_TIME: Duration = Duration::from_millis(6);
const WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_QUEUE_SIZE: usize = 128;
const CANCEL_WAITERS: usize = 4;
const CANCELLED_WAITERS: usize = 2;
const CANCELLATION_WAIT: Duration = Duration::from_secs(2);
const GLOBAL_KEY: &str = "global";
const PROVIDER_KEY: &str = "provider:synthetic";

#[derive(Clone, Copy)]
enum BoundGate {
    Global,
    Provider,
    Account,
}

#[derive(Clone, Copy)]
struct GateCaps {
    name: &'static str,
    global: usize,
    provider: usize,
    account: usize,
    bound_gate: BoundGate,
}

const GATE_PROFILES: [GateCaps; 3] = [
    GateCaps {
        name: "global-bound",
        global: 20,
        provider: 40,
        account: 8,
        bound_gate: BoundGate::Global,
    },
    GateCaps {
        name: "provider-bound",
        global: 40,
        provider: 16,
        account: 8,
        bound_gate: BoundGate::Provider,
    },
    GateCaps {
        name: "account-bound",
        global: 40,
        provider: 40,
        account: 4,
        bound_gate: BoundGate::Account,
    },
];
const CANCELLATION_PROFILE: GateCaps = GATE_PROFILES[1];

#[derive(Debug)]
enum CompositeAcquireError {
    Account(SchedulerError),
    Gates(AcquireError),
    DeadlineExpired,
    ReceiverClosed,
}

impl fmt::Display for CompositeAcquireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Account(error) => write!(formatter, "account reservation failed: {error}"),
            Self::Gates(error) => write!(formatter, "multi-gate reservation failed: {error}"),
            Self::DeadlineExpired => formatter.write_str("composite admission deadline expired"),
            Self::ReceiverClosed => formatter.write_str("composite lease receiver closed"),
        }
    }
}

impl Error for CompositeAcquireError {}

/// Benchmark-only composition of account selection and atomic global/provider/account gates.
/// It intentionally reserves an AccountScheduler slot before awaiting MultiGateAdmission; the
/// tests measure cleanup across that sequential boundary but do not claim atomic TS parity.
#[derive(Clone)]
struct CompositeCapacity {
    accounts: AccountScheduler,
    gates: MultiGateAdmission,
    caps: GateCaps,
}

struct CompositeLease {
    gate_lease: Option<AdmissionLease>,
    account_lease: Option<AccountLease>,
    account_id: String,
    used_affinity: bool,
}

impl CompositeLease {
    fn account_id(&self) -> &str {
        &self.account_id
    }

    fn used_affinity(&self) -> bool {
        self.used_affinity
    }
}

impl Drop for CompositeLease {
    fn drop(&mut self) {
        // Release shared gates before waking another account-slot waiter.
        drop(self.gate_lease.take());
        drop(self.account_lease.take());
    }
}

impl CompositeCapacity {
    fn new(caps: GateCaps) -> Result<Self, &'static str> {
        Ok(Self {
            accounts: AccountScheduler::new_with_strategy(
                synthetic_accounts(caps.account),
                Some(Duration::from_secs(60)),
                SyntheticRoutingStrategy::LeastLoaded,
            )?,
            gates: MultiGateAdmission::new(),
            caps,
        })
    }

    /// Reserve a candidate's local account slot first, then atomically claim the corresponding
    /// global, provider, and account gates. Dropping this future during the gate wait must release
    /// the account reservation while MultiGateAdmission removes its registered wait from all gates.
    async fn acquire(
        &self,
        session_key: Option<&str>,
        timeout: Duration,
    ) -> Result<CompositeLease, CompositeAcquireError> {
        let deadline = tokio::time::Instant::now() + timeout;
        let account_lease = self
            .accounts
            .acquire(session_key, timeout)
            .await
            .map_err(CompositeAcquireError::Account)?;
        let account_id = account_lease.account_id().to_owned();
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(CompositeAcquireError::DeadlineExpired);
        }

        let account_gate = format!("account:synthetic:{account_id}");
        let requirements = [
            GateRequirement {
                key: GLOBAL_KEY.into(),
                max_concurrency: Some(self.caps.global),
            },
            GateRequirement {
                key: PROVIDER_KEY.into(),
                max_concurrency: Some(self.caps.provider),
            },
            GateRequirement {
                key: account_gate,
                max_concurrency: Some(self.caps.account),
            },
        ];
        let gate_lease = self
            .gates
            .acquire_many(&requirements, remaining, MAX_QUEUE_SIZE)
            .await
            .map_err(CompositeAcquireError::Gates)?;

        Ok(CompositeLease {
            gate_lease: Some(gate_lease),
            used_affinity: account_lease.used_affinity(),
            account_lease: Some(account_lease),
            account_id,
        })
    }

    fn account_reservations(&self) -> BTreeMap<String, usize> {
        self.accounts.in_flight_by_account().into_iter().collect()
    }

    fn account_wait_requests(&self) -> u64 {
        self.accounts.capacity_wait_requests()
    }
}

#[derive(Default)]
struct Metrics {
    completed_sessions: usize,
    completed_turns: usize,
    account_timeouts: usize,
    gate_timeouts: usize,
    queue_full: usize,
    no_eligible: usize,
    deadline_expired: usize,
    affinity_hits: usize,
    acquire_ms: Vec<f64>,
    by_account: BTreeMap<String, usize>,
    max_global: usize,
    max_provider: usize,
    max_account_gate: usize,
    max_account_reservations: usize,
    max_gate_queue: usize,
}

fn synthetic_accounts(account_cap: usize) -> Vec<SyntheticAccount> {
    let mut accounts = (0..ACCOUNT_COUNT)
        .map(|index| SyntheticAccount {
            id: format!("eligible-{index}"),
            enabled: true,
            cooldown_until: None,
            quota_exhausted: false,
            max_in_flight: account_cap,
            priority: index as u32 + 1,
        })
        .collect::<Vec<_>>();
    accounts.extend([
        SyntheticAccount {
            id: "disabled".into(),
            enabled: false,
            cooldown_until: None,
            quota_exhausted: false,
            max_in_flight: account_cap,
            priority: 99,
        },
        SyntheticAccount {
            id: "cooldown".into(),
            enabled: true,
            cooldown_until: Some(Instant::now() + Duration::from_secs(600)),
            quota_exhausted: false,
            max_in_flight: account_cap,
            priority: 99,
        },
        SyntheticAccount {
            id: "quota-exhausted".into(),
            enabled: true,
            cooldown_until: None,
            quota_exhausted: true,
            max_in_flight: account_cap,
            priority: 99,
        },
    ]);
    accounts
}

fn percentile(values: &[f64], percentile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((percentile / 100.0 * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    sorted[index]
}

fn account_total(admission: &CompositeCapacity) -> usize {
    admission.account_reservations().values().copied().sum()
}

async fn run_all() -> Result<(), Box<dyn Error>> {
    for sessions in SESSION_COUNTS {
        for caps in GATE_PROFILES {
            run_workload(sessions, caps).await?;
        }
        run_cancellation_probe(sessions, CANCELLATION_PROFILE).await?;
    }
    Ok(())
}

async fn run_workload(session_count: usize, caps: GateCaps) -> Result<(), Box<dyn Error>> {
    let admission = CompositeCapacity::new(caps)?;
    let metrics = Arc::new(Mutex::new(Metrics {
        by_account: (0..ACCOUNT_COUNT)
            .map(|index| (format!("eligible-{index}"), 0))
            .collect(),
        ..Metrics::default()
    }));
    let barrier = Arc::new(Barrier::new(session_count + 1));
    let mut tasks = Vec::with_capacity(session_count);

    for session_index in 0..session_count {
        let admission = admission.clone();
        let metrics = Arc::clone(&metrics);
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            let session_key = format!("synthetic-session-{session_index}");
            barrier.wait().await;
            let mut completed_turns = 0;
            for _ in 0..TURNS_PER_SESSION {
                let started = Instant::now();
                let result = admission.acquire(Some(&session_key), WAIT_TIMEOUT).await;
                let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
                metrics
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .acquire_ms
                    .push(elapsed_ms);
                let lease = match result {
                    Ok(lease) => lease,
                    Err(CompositeAcquireError::Account(SchedulerError::WaitTimeout)) => {
                        metrics
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .account_timeouts += 1;
                        break;
                    }
                    Err(CompositeAcquireError::Account(SchedulerError::NoEligibleAccounts)) => {
                        metrics
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .no_eligible += 1;
                        break;
                    }
                    Err(CompositeAcquireError::Gates(AcquireError::Timeout))
                    | Err(CompositeAcquireError::DeadlineExpired) => {
                        metrics
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .gate_timeouts += 1;
                        break;
                    }
                    Err(CompositeAcquireError::Gates(AcquireError::QueueFull)) => {
                        metrics
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .queue_full += 1;
                        break;
                    }
                    Err(CompositeAcquireError::ReceiverClosed) => {
                        metrics
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .deadline_expired += 1;
                        break;
                    }
                };

                completed_turns += 1;
                {
                    let mut metrics = metrics.lock().unwrap_or_else(|error| error.into_inner());
                    metrics.completed_turns += 1;
                    metrics.affinity_hits += usize::from(lease.used_affinity());
                    *metrics
                        .by_account
                        .entry(lease.account_id().to_owned())
                        .or_default() += 1;

                    let gates = admission.gates.snapshot();
                    let reservations = admission.account_reservations();
                    metrics.max_global = metrics
                        .max_global
                        .max(gates.get(GLOBAL_KEY).map_or(0, |gate| gate.running));
                    metrics.max_provider = metrics
                        .max_provider
                        .max(gates.get(PROVIDER_KEY).map_or(0, |gate| gate.running));
                    metrics.max_gate_queue = metrics
                        .max_gate_queue
                        .max(gates.values().map(|gate| gate.queued).max().unwrap_or(0));
                    metrics.max_account_gate = metrics.max_account_gate.max(
                        gates
                            .iter()
                            .filter(|(key, _)| key.starts_with("account:synthetic:"))
                            .map(|(_, gate)| gate.running)
                            .max()
                            .unwrap_or(0),
                    );
                    metrics.max_account_reservations = metrics
                        .max_account_reservations
                        .max(reservations.values().copied().max().unwrap_or(0));
                }

                tokio::time::sleep(SERVICE_TIME).await;
                drop(lease);
            }
            if completed_turns == TURNS_PER_SESSION {
                metrics
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .completed_sessions += 1;
            }
        }));
    }

    let started = Instant::now();
    barrier.wait().await;
    for task in tasks {
        task.await?;
    }
    let elapsed = started.elapsed();
    let account_wait_requests = admission.account_wait_requests();
    let metrics = metrics.lock().unwrap_or_else(|error| error.into_inner());
    let requested_turns = session_count * TURNS_PER_SESSION;
    let failed = metrics.account_timeouts
        + metrics.gate_timeouts
        + metrics.queue_full
        + metrics.no_eligible
        + metrics.deadline_expired;
    let gates_idle = admission.gates.snapshot().is_empty();
    let account_slots_idle = account_total(&admission) == 0;

    println!(
        "composed_workload profile={} sessions={} requested_turns={} completed_turns={} completed_sessions={} failed={} account_wait_requests={} account_timeouts={} gate_timeouts={} queue_full={} no_eligible={} global_peak={}/{} provider_peak={}/{} account_gate_peak={}/{} account_slot_peak={}/{} gate_queue_peak={} throughput_req_s={:.2} elapsed_ms={:.2} acquire_p95_ms={:.3} affinity_hits={} account_distribution={:?} gates_idle={} account_slots_idle={}",
        caps.name,
        session_count,
        requested_turns,
        metrics.completed_turns,
        metrics.completed_sessions,
        failed,
        account_wait_requests,
        metrics.account_timeouts,
        metrics.gate_timeouts,
        metrics.queue_full,
        metrics.no_eligible,
        metrics.max_global,
        caps.global,
        metrics.max_provider,
        caps.provider,
        metrics.max_account_gate,
        caps.account,
        metrics.max_account_reservations,
        caps.account,
        metrics.max_gate_queue,
        metrics.completed_turns as f64 / elapsed.as_secs_f64(),
        elapsed.as_secs_f64() * 1000.0,
        percentile(&metrics.acquire_ms, 95.0),
        metrics.affinity_hits,
        metrics.by_account,
        gates_idle,
        account_slots_idle,
    );

    assert_eq!(metrics.completed_turns, requested_turns);
    assert_eq!(metrics.completed_sessions, session_count);
    assert_eq!(failed, 0);
    assert!(metrics.max_global <= caps.global);
    assert!(metrics.max_provider <= caps.provider);
    assert!(metrics.max_account_gate <= caps.account);
    assert!(metrics.max_account_reservations <= caps.account);
    let observed_bound = match caps.bound_gate {
        BoundGate::Global => metrics.max_global,
        BoundGate::Provider => metrics.max_provider,
        BoundGate::Account => metrics.max_account_gate,
    };
    let expected_bound = match caps.bound_gate {
        BoundGate::Global => caps.global,
        BoundGate::Provider => caps.provider,
        BoundGate::Account => caps.account,
    };
    assert_eq!(
        observed_bound, expected_bound,
        "{} gate was not exercised",
        caps.name
    );
    assert!(gates_idle);
    assert!(account_slots_idle);
    Ok(())
}

async fn wait_for_provider_queue(
    admission: &CompositeCapacity,
    target: usize,
) -> Result<usize, Box<dyn Error>> {
    let deadline = tokio::time::Instant::now() + CANCELLATION_WAIT;
    loop {
        let queued = admission
            .gates
            .snapshot()
            .get(PROVIDER_KEY)
            .map_or(0, |gate| gate.queued);
        if queued >= target {
            return Ok(queued);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(io::Error::other("timed out waiting for provider gate queue").into());
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

async fn run_cancellation_probe(
    session_count: usize,
    caps: GateCaps,
) -> Result<(), Box<dyn Error>> {
    let admission = CompositeCapacity::new(caps)?;
    let mut holders = Vec::with_capacity(caps.provider);
    for _ in 0..caps.provider {
        holders.push(admission.acquire(None, WAIT_TIMEOUT).await?);
    }

    let active_before = admission.gates.snapshot();
    assert_eq!(active_before[GLOBAL_KEY].running, caps.provider);
    assert_eq!(active_before[PROVIDER_KEY].running, caps.provider);
    assert!(
        active_before
            .iter()
            .filter(|(key, _)| key.starts_with("account:synthetic:"))
            .all(|(_, gate)| gate.running <= caps.account)
    );

    let barrier = Arc::new(Barrier::new(CANCEL_WAITERS + 1));
    let (lease_sender, mut lease_receiver) = mpsc::channel::<CompositeLease>(CANCEL_WAITERS);
    let mut waiters = Vec::with_capacity(CANCEL_WAITERS);
    for _ in 0..CANCEL_WAITERS {
        let admission = admission.clone();
        let barrier = Arc::clone(&barrier);
        let lease_sender = lease_sender.clone();
        waiters.push(Some(tokio::spawn(async move {
            barrier.wait().await;
            let lease = admission.acquire(None, WAIT_TIMEOUT).await?;
            lease_sender
                .send(lease)
                .await
                .map_err(|_| CompositeAcquireError::ReceiverClosed)?;
            Ok::<(), CompositeAcquireError>(())
        })));
    }
    drop(lease_sender);
    barrier.wait().await;

    let queued_before_cancel = wait_for_provider_queue(&admission, CANCEL_WAITERS).await?;
    let reservations_before_cancel = account_total(&admission);
    assert_eq!(queued_before_cancel, CANCEL_WAITERS);
    assert_eq!(reservations_before_cancel, caps.provider + CANCEL_WAITERS);
    let mut queued_waiters_cancelled = 0;
    for waiter in waiters.iter_mut().take(CANCELLED_WAITERS) {
        let waiter = waiter.take().expect("waiter handle exists");
        waiter.abort();
        match waiter.await {
            Err(error) if error.is_cancelled() => queued_waiters_cancelled += 1,
            Err(error) => return Err(error.into()),
            Ok(Err(error)) => return Err(error.into()),
            Ok(Ok(())) => {
                return Err(io::Error::other("queued waiter unexpectedly completed").into());
            }
        }
    }
    let queued_after_cancel =
        wait_for_provider_queue(&admission, CANCEL_WAITERS - CANCELLED_WAITERS).await?;
    let reservations_after_cancel = account_total(&admission);
    let gate_running_after_cancel = admission.gates.snapshot()[PROVIDER_KEY].running;
    assert_eq!(
        reservations_after_cancel,
        caps.provider + CANCEL_WAITERS - CANCELLED_WAITERS
    );
    assert_eq!(gate_running_after_cancel, caps.provider);

    drop(holders);
    let mut resumed_leases = Vec::with_capacity(CANCEL_WAITERS - CANCELLED_WAITERS);
    for _ in 0..CANCEL_WAITERS - CANCELLED_WAITERS {
        let lease = tokio::time::timeout(CANCELLATION_WAIT, lease_receiver.recv()).await?;
        resumed_leases
            .push(lease.ok_or_else(|| io::Error::other("remaining waiter did not resume"))?);
    }
    for waiter in waiters.into_iter().flatten() {
        waiter.await??;
    }
    let resumed_running = admission.gates.snapshot()[PROVIDER_KEY].running;
    drop(resumed_leases);

    // Now cancel a request after it owns the complete composed lease. Both the gate set and the
    // account-selection slot must disappear on future cancellation.
    let holder_admission = admission.clone();
    let (acquired_sender, acquired_receiver) = oneshot::channel::<String>();
    let holder = tokio::spawn(async move {
        let lease = holder_admission.acquire(None, WAIT_TIMEOUT).await?;
        let _ = acquired_sender.send(lease.account_id().to_owned());
        std::future::pending::<()>().await;
        drop(lease);
        Ok::<(), CompositeAcquireError>(())
    });
    let in_flight_account = tokio::time::timeout(CANCELLATION_WAIT, acquired_receiver).await??;
    let admitted_before_cancel = admission.gates.snapshot();
    let admitted_count_before_cancel = admission.gates.snapshot()[GLOBAL_KEY].running;
    assert_eq!(admitted_count_before_cancel, 1);
    assert_eq!(admitted_before_cancel[PROVIDER_KEY].running, 1);
    assert_eq!(
        admitted_before_cancel[&format!("account:synthetic:{in_flight_account}")].running,
        1
    );
    holder.abort();
    let admitted_waiter_cancelled = match holder.await {
        Err(error) if error.is_cancelled() => true,
        Err(error) => return Err(error.into()),
        Ok(Err(error)) => return Err(error.into()),
        Ok(Ok(())) => false,
    };

    let gates_idle_after_cancel = admission.gates.snapshot().is_empty();
    let account_slots_idle_after_cancel = account_total(&admission) == 0;
    let verification_lease = admission.acquire(None, Duration::from_secs(1)).await?;
    drop(verification_lease);
    let capacity_reacquired =
        admission.gates.snapshot().is_empty() && account_total(&admission) == 0;

    println!(
        "composed_cancel_probe profile={} sessions={} admitted_held={} queued_before_cancel={} queued_cancelled={} queued_after_cancel={} account_slots_before_cancel={} account_slots_after_cancel={} gate_running_after_queue_cancel={} resumed_waiters={} gate_running_after_resume={} admitted_request_cancelled={} gates_idle_after_cancel={} account_slots_idle_after_cancel={} capacity_reacquired={}",
        caps.name,
        session_count,
        caps.provider,
        queued_before_cancel,
        queued_waiters_cancelled,
        queued_after_cancel,
        reservations_before_cancel,
        reservations_after_cancel,
        gate_running_after_cancel,
        CANCEL_WAITERS - CANCELLED_WAITERS,
        resumed_running,
        admitted_waiter_cancelled,
        gates_idle_after_cancel,
        account_slots_idle_after_cancel,
        capacity_reacquired,
    );

    assert_eq!(queued_waiters_cancelled, CANCELLED_WAITERS);
    assert_eq!(queued_after_cancel, CANCEL_WAITERS - CANCELLED_WAITERS);
    assert_eq!(reservations_before_cancel, caps.provider + CANCEL_WAITERS);
    assert_eq!(
        reservations_after_cancel,
        caps.provider + CANCEL_WAITERS - CANCELLED_WAITERS
    );
    assert_eq!(gate_running_after_cancel, caps.provider);
    assert_eq!(resumed_running, CANCEL_WAITERS - CANCELLED_WAITERS);
    assert!(admitted_waiter_cancelled);
    assert!(gates_idle_after_cancel);
    assert!(account_slots_idle_after_cancel);
    assert!(capacity_reacquired);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    run_all().await
}

#[cfg(test)]
#[tokio::test]
async fn composed_global_provider_account_caps_and_cancellation_cleanup_hold_for_70_and_100() {
    run_all()
        .await
        .expect("composed synthetic capacity probe should finish without leaking slots");
}
