//! Synthetic account eligibility, configurable selection, and in-flight leases.
//!
//! This benchmark model uses only synthetic account metadata. It is not connected to
//! OmniRoute's database, provider credentials, quota cache, or routing settings.

use std::{
    cmp::Ordering,
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering as AtomicOrdering},
    },
    time::{Duration, Instant},
};

use tokio::sync::{Mutex, Notify};

#[derive(Clone)]
pub struct SyntheticAccount {
    pub id: String,
    pub enabled: bool,
    pub cooldown_until: Option<Instant>,
    pub quota_exhausted: bool,
    pub max_in_flight: usize,
    pub priority: u32,
}

/// Selection rules available in this benchmark model. `PriorityOrderedFillFirst` corresponds to
/// OmniRoute's default fallback branch only when the caller has already supplied the TypeScript-
/// filtered, priority-ordered candidate list. The normal constructor remains least-loaded so
/// capacity-scheduling experiments retain their previous behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyntheticRoutingStrategy {
    LeastLoaded,
    PriorityOrderedFillFirst,
}

struct Account {
    metadata: SyntheticAccount,
    in_flight: AtomicUsize,
}

#[derive(Clone)]
struct AffinityPin {
    account_id: String,
    expires_at: Instant,
}

struct SchedulerInner {
    accounts: Vec<Arc<Account>>,
    routing_strategy: SyntheticRoutingStrategy,
    affinity: Mutex<HashMap<String, AffinityPin>>,
    affinity_locks: Vec<Mutex<()>>,
    changed: Arc<Notify>,
    capacity_wait_requests: AtomicU64,
    affinity_ttl: Option<Duration>,
}

const AFFINITY_LOCK_STRIPES: usize = 64;

#[derive(Clone)]
pub struct AccountScheduler {
    inner: Arc<SchedulerInner>,
}

pub struct AccountLease {
    account: Arc<Account>,
    changed: Arc<Notify>,
    used_affinity: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerError {
    NoEligibleAccounts,
    WaitTimeout,
}

impl std::fmt::Display for SchedulerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoEligibleAccounts => formatter.write_str("no eligible accounts"),
            Self::WaitTimeout => formatter.write_str("account-capacity wait timed out"),
        }
    }
}

impl std::error::Error for SchedulerError {}

impl AccountScheduler {
    pub fn new(
        accounts: Vec<SyntheticAccount>,
        affinity_ttl: Option<Duration>,
    ) -> Result<Self, &'static str> {
        Self::new_with_strategy(
            accounts,
            affinity_ttl,
            SyntheticRoutingStrategy::LeastLoaded,
        )
    }

    /// Build the synthetic scheduler with a named strategy. For `PriorityOrderedFillFirst`,
    /// provide accounts in the order the TypeScript routing layer has already selected after
    /// applying its active/model/quota/cooldown/connection gates.
    pub fn new_with_strategy(
        accounts: Vec<SyntheticAccount>,
        affinity_ttl: Option<Duration>,
        routing_strategy: SyntheticRoutingStrategy,
    ) -> Result<Self, &'static str> {
        let mut seen = HashMap::with_capacity(accounts.len());
        let mut stored = Vec::with_capacity(accounts.len());
        for metadata in accounts {
            if metadata.id.is_empty() || metadata.max_in_flight == 0 {
                return Err("account IDs must be nonempty and in-flight caps must be positive");
            }
            if seen.insert(metadata.id.clone(), ()).is_some() {
                return Err("account IDs must be unique");
            }
            stored.push(Arc::new(Account {
                metadata,
                in_flight: AtomicUsize::new(0),
            }));
        }
        Ok(Self {
            inner: Arc::new(SchedulerInner {
                accounts: stored,
                routing_strategy,
                affinity: Mutex::new(HashMap::new()),
                affinity_locks: (0..AFFINITY_LOCK_STRIPES).map(|_| Mutex::new(())).collect(),
                changed: Arc::new(Notify::new()),
                capacity_wait_requests: AtomicU64::new(0),
                affinity_ttl: affinity_ttl.filter(|ttl| !ttl.is_zero()),
            }),
        })
    }

    /// Select a healthy candidate with a free slot; queue by waiting for a lease release.
    /// Existing session affinity is reused while eligible and below its cap. If the pinned
    /// account is full but another eligible account has room, the configured selection strategy
    /// chooses an available account and moves the pin there.
    pub async fn acquire(
        &self,
        session_key: Option<&str>,
        wait_timeout: Duration,
    ) -> Result<AccountLease, SchedulerError> {
        tokio::time::timeout(wait_timeout, self.acquire_until_capacity(session_key))
            .await
            .map_err(|_| SchedulerError::WaitTimeout)?
    }

    async fn acquire_until_capacity(
        &self,
        session_key: Option<&str>,
    ) -> Result<AccountLease, SchedulerError> {
        let affinity_key = session_key.filter(|_| self.inner.affinity_ttl.is_some());
        let mut counted_capacity_wait = false;
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            // Requests without affinity never touch either lock. Requests for different
            // sessions only contend when they hash to the same stripe; the map lock itself is
            // held just long enough to read or update one pin, never during candidate scanning.
            let _session_guard = if let Some(key) = affinity_key {
                Some(
                    self.inner.affinity_locks[affinity_lock_stripe(key)]
                        .lock()
                        .await,
                )
            } else {
                None
            };
            let now = Instant::now();
            let eligible: Vec<Arc<Account>> = self
                .inner
                .accounts
                .iter()
                .filter(|account| is_eligible(&account.metadata, now))
                .cloned()
                .collect();
            if eligible.is_empty() {
                if let Some(key) = affinity_key {
                    self.inner.affinity.lock().await.remove(key);
                }
                return Err(SchedulerError::NoEligibleAccounts);
            }

            let mut pinned_account = None;
            if let Some(key) = affinity_key {
                let pin = {
                    let mut affinity = self.inner.affinity.lock().await;
                    let pin = affinity.get(key).cloned();
                    if pin.as_ref().is_some_and(|pin| pin.expires_at <= now) {
                        affinity.remove(key);
                        None
                    } else {
                        pin
                    }
                };
                if let Some(pin) = pin {
                    if let Some(account) = eligible
                        .iter()
                        .find(|account| account.metadata.id == pin.account_id)
                    {
                        pinned_account = Some(account.clone());
                    } else {
                        self.inner.affinity.lock().await.remove(key);
                    }
                }
            }

            let mut selected = None;
            let mut used_affinity = false;
            if let Some(account) = pinned_account.as_ref() {
                if try_reserve_slot(account.as_ref()) {
                    selected = Some(account.clone());
                    used_affinity = true;
                }
            }

            if selected.is_none() {
                let mut candidates = eligible.iter().collect::<Vec<_>>();
                if self.inner.routing_strategy == SyntheticRoutingStrategy::LeastLoaded {
                    candidates.sort_by(|left, right| compare_load(left, right));
                }
                selected = candidates
                    .into_iter()
                    .find(|account| try_reserve_slot(account.as_ref()))
                    .map(|account| account.clone());
            }

            if let Some(account) = selected {
                // Build the RAII guard before the map-lock await. If this task is cancelled while
                // waiting to update its pin, dropping the future still releases the reserved slot.
                let lease = AccountLease {
                    account,
                    changed: self.inner.changed.clone(),
                    used_affinity,
                };
                if let (Some(key), Some(ttl)) = (affinity_key, self.inner.affinity_ttl) {
                    self.inner.affinity.lock().await.insert(
                        key.to_owned(),
                        AffinityPin {
                            account_id: lease.account.metadata.id.clone(),
                            expires_at: now + ttl,
                        },
                    );
                }
                return Ok(lease);
            }

            drop(_session_guard);
            if !counted_capacity_wait {
                self.inner
                    .capacity_wait_requests
                    .fetch_add(1, AtomicOrdering::Relaxed);
                counted_capacity_wait = true;
            }
            notified.await;
        }
    }

    pub fn in_flight_by_account(&self) -> HashMap<String, usize> {
        self.inner
            .accounts
            .iter()
            .map(|account| {
                (
                    account.metadata.id.clone(),
                    account.in_flight.load(AtomicOrdering::Acquire),
                )
            })
            .collect()
    }

    /// Number of distinct acquisitions that had to wait at least once because every eligible
    /// account was at its in-flight cap. Each scheduler is benchmark-local and starts at zero.
    pub fn capacity_wait_requests(&self) -> u64 {
        self.inner
            .capacity_wait_requests
            .load(AtomicOrdering::Relaxed)
    }
}

fn affinity_lock_stripe(key: &str) -> usize {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hasher);
    hasher.finish() as usize % AFFINITY_LOCK_STRIPES
}

fn try_reserve_slot(account: &Account) -> bool {
    let max_in_flight = account.metadata.max_in_flight;
    account
        .in_flight
        .try_update(AtomicOrdering::AcqRel, AtomicOrdering::Acquire, |current| {
            (current < max_in_flight).then_some(current + 1)
        })
        .is_ok()
}

impl AccountLease {
    pub fn account_id(&self) -> &str {
        &self.account.metadata.id
    }

    pub fn used_affinity(&self) -> bool {
        self.used_affinity
    }
}

impl Drop for AccountLease {
    fn drop(&mut self) {
        let previous = self.account.in_flight.fetch_sub(1, AtomicOrdering::AcqRel);
        debug_assert!(previous > 0, "account lease released more than once");
        self.changed.notify_one();
    }
}

fn is_eligible(account: &SyntheticAccount, now: Instant) -> bool {
    account.enabled
        && !account.quota_exhausted
        && account.cooldown_until.is_none_or(|until| until <= now)
}

fn compare_load(left: &Arc<Account>, right: &Arc<Account>) -> Ordering {
    let left_running = left.in_flight.load(AtomicOrdering::Acquire) as u128;
    let right_running = right.in_flight.load(AtomicOrdering::Acquire) as u128;
    let left_capacity = left.metadata.max_in_flight as u128;
    let right_capacity = right.metadata.max_in_flight as u128;

    // Compare utilization ratios without floating-point rounding.
    (left_running * right_capacity)
        .cmp(&(right_running * left_capacity))
        .then_with(|| left.metadata.priority.cmp(&right.metadata.priority))
        .then_with(|| left.metadata.id.cmp(&right.metadata.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::{Barrier, mpsc, oneshot, watch};

    fn account(
        id: &str,
        enabled: bool,
        cooldown_until: Option<Instant>,
        quota_exhausted: bool,
        max_in_flight: usize,
    ) -> SyntheticAccount {
        SyntheticAccount {
            id: id.into(),
            enabled,
            cooldown_until,
            quota_exhausted,
            max_in_flight,
            priority: 1,
        }
    }

    #[tokio::test]
    async fn excludes_disabled_cooldown_and_quota_exhausted_accounts() {
        let scheduler = AccountScheduler::new(
            vec![
                account("disabled", false, None, false, 1),
                account(
                    "cooldown",
                    true,
                    Some(Instant::now() + Duration::from_secs(30)),
                    false,
                    1,
                ),
                account("exhausted", true, None, true, 1),
                account("eligible", true, None, false, 1),
            ],
            None,
        )
        .unwrap();

        let lease = scheduler
            .acquire(None, Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(lease.account_id(), "eligible");
        drop(lease);
    }

    #[tokio::test]
    async fn least_loaded_selection_respects_each_account_cap() {
        let scheduler = AccountScheduler::new(
            vec![
                account("account-a", true, None, false, 1),
                account("account-b", true, None, false, 1),
            ],
            None,
        )
        .unwrap();
        let first = scheduler
            .acquire(None, Duration::from_millis(20))
            .await
            .unwrap();
        let second = scheduler
            .acquire(None, Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(first.account_id(), "account-a");
        assert_eq!(second.account_id(), "account-b");
        assert_eq!(scheduler.in_flight_by_account()["account-a"], 1);
        assert_eq!(scheduler.in_flight_by_account()["account-b"], 1);
        assert_eq!(
            scheduler
                .acquire(None, Duration::from_millis(5))
                .await
                .err(),
            Some(SchedulerError::WaitTimeout)
        );
        assert_eq!(scheduler.capacity_wait_requests(), 1);
        drop(first);
        drop(second);
    }

    #[tokio::test]
    async fn type_script_fill_first_and_rust_least_loaded_choose_differently_under_headroom() {
        // This captures one source-grounded strategy mismatch after candidate gates: TypeScript's
        // default `fill-first` branch returns orderedConnections[0], while AccountScheduler::new
        // minimizes in-flight/capacity utilization. Both accounts have ample capacity here, so
        // the difference is strategy choice, not a full-account fallback.
        let mut preferred = account("preferred", true, None, false, 100);
        preferred.priority = 1;
        let mut secondary = account("secondary", true, None, false, 100);
        secondary.priority = 2;
        let fill_first = AccountScheduler::new_with_strategy(
            vec![preferred, secondary],
            None,
            SyntheticRoutingStrategy::PriorityOrderedFillFirst,
        )
        .unwrap();

        let fill_first_a = fill_first
            .acquire(None, Duration::from_millis(20))
            .await
            .unwrap();
        let fill_first_b = fill_first
            .acquire(None, Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(fill_first_a.account_id(), "preferred");
        assert_eq!(fill_first_b.account_id(), "preferred");

        let least_loaded = AccountScheduler::new(
            vec![
                account("preferred", true, None, false, 100),
                account("secondary", true, None, false, 100),
            ],
            None,
        )
        .unwrap();
        let least_loaded_a = least_loaded
            .acquire(None, Duration::from_millis(20))
            .await
            .unwrap();
        let least_loaded_b = least_loaded
            .acquire(None, Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(least_loaded_a.account_id(), "preferred");
        assert_eq!(least_loaded_b.account_id(), "secondary");

        drop((fill_first_a, fill_first_b, least_loaded_a, least_loaded_b));
    }

    #[tokio::test]
    async fn affinity_reuses_eligible_pin_then_falls_back_when_it_is_full() {
        let scheduler = AccountScheduler::new(
            vec![
                account("account-a", true, None, false, 1),
                account("account-b", true, None, false, 1),
            ],
            Some(Duration::from_secs(60)),
        )
        .unwrap();
        let first_session = scheduler
            .acquire(Some("conversation-a"), Duration::from_millis(20))
            .await
            .unwrap();
        let second_session = scheduler
            .acquire(Some("conversation-b"), Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(first_session.account_id(), "account-a");
        assert_eq!(second_session.account_id(), "account-b");

        drop(second_session);
        let fallback = scheduler
            .acquire(Some("conversation-a"), Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(fallback.account_id(), "account-b");
        assert!(!fallback.used_affinity());
        drop(first_session);
        drop(fallback);

        let pinned = scheduler
            .acquire(Some("conversation-a"), Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(pinned.account_id(), "account-b");
        assert!(pinned.used_affinity());
    }

    #[tokio::test]
    async fn cancelling_task_releases_held_account_lease() {
        let scheduler =
            AccountScheduler::new(vec![account("account-a", true, None, false, 1)], None).unwrap();
        let task_scheduler = scheduler.clone();
        let (acquired, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let lease = task_scheduler
                .acquire(None, Duration::from_secs(1))
                .await
                .unwrap();
            let _ = acquired.send(lease.account_id().to_owned());
            std::future::pending::<()>().await;
            drop(lease);
        });

        assert_eq!(ready.await.unwrap(), "account-a");
        assert_eq!(scheduler.in_flight_by_account()["account-a"], 1);
        task.abort();
        let _ = task.await;

        let after_cancel = scheduler
            .acquire(None, Duration::from_millis(50))
            .await
            .unwrap();
        assert_eq!(after_cancel.account_id(), "account-a");
        assert_eq!(scheduler.in_flight_by_account()["account-a"], 1);
        drop(after_cancel);
        assert_eq!(scheduler.in_flight_by_account()["account-a"], 0);
    }

    #[tokio::test]
    async fn one_hundred_concurrent_sessions_respect_caps_and_release_after_cancellation() {
        const TASKS: usize = 100;
        const ACCOUNT_COUNT: usize = 4;
        const PER_ACCOUNT_CAP: usize = 8;
        const TOTAL_CAPACITY: usize = ACCOUNT_COUNT * PER_ACCOUNT_CAP;
        const CANCEL_COUNT: usize = 5;

        let scheduler = AccountScheduler::new(
            (0..ACCOUNT_COUNT)
                .map(|index| {
                    account(
                        &format!("account-{index}"),
                        true,
                        None,
                        false,
                        PER_ACCOUNT_CAP,
                    )
                })
                .collect(),
            Some(Duration::from_secs(60)),
        )
        .unwrap();
        let start = Arc::new(Barrier::new(TASKS + 1));
        let (acquired_tx, mut acquired_rx) = mpsc::unbounded_channel();
        let (release_tx, release_rx) = watch::channel(false);
        let mut tasks = (0..TASKS)
            .map(|task_id| {
                let scheduler = scheduler.clone();
                let start = Arc::clone(&start);
                let acquired_tx = acquired_tx.clone();
                let mut release_rx = release_rx.clone();
                tokio::spawn(async move {
                    start.wait().await;
                    let session_key = format!("session-{task_id}");
                    let lease = scheduler
                        .acquire(Some(&session_key), Duration::from_secs(5))
                        .await
                        .expect("capacity should become available before the timeout");
                    acquired_tx
                        .send((task_id, lease.account_id().to_owned()))
                        .expect("test receiver remains open");
                    while !*release_rx.borrow() {
                        if release_rx.changed().await.is_err() {
                            break;
                        }
                    }
                    drop(lease);
                })
            })
            .map(Some)
            .collect::<Vec<_>>();
        drop(acquired_tx);

        start.wait().await;
        let mut first_wave = Vec::with_capacity(TOTAL_CAPACITY);
        for _ in 0..TOTAL_CAPACITY {
            first_wave.push(
                tokio::time::timeout(Duration::from_secs(2), acquired_rx.recv())
                    .await
                    .expect("all account slots should be filled")
                    .expect("an acquisition task should report its lease"),
            );
        }

        let counts = scheduler.in_flight_by_account();
        assert!(counts.values().all(|count| *count <= PER_ACCOUNT_CAP));
        assert_eq!(counts.values().sum::<usize>(), TOTAL_CAPACITY);

        // Aborting lease holders must drop their guards and wake queued acquisitions.
        for (task_id, _) in first_wave.iter().take(CANCEL_COUNT) {
            let task = tasks[*task_id]
                .take()
                .expect("task handle is still present");
            task.abort();
            assert!(
                task.await
                    .expect_err("task should be cancelled")
                    .is_cancelled()
            );
        }
        for _ in 0..CANCEL_COUNT {
            tokio::time::timeout(Duration::from_secs(2), acquired_rx.recv())
                .await
                .expect("cancelled slots should wake queued tasks")
                .expect("a queued acquisition should report its lease");
        }

        let counts_after_cancel = scheduler.in_flight_by_account();
        assert!(
            counts_after_cancel
                .values()
                .all(|count| *count <= PER_ACCOUNT_CAP)
        );
        assert_eq!(counts_after_cancel.values().sum::<usize>(), TOTAL_CAPACITY);

        release_tx
            .send(true)
            .expect("lease holders remain subscribed");
        for task in tasks.into_iter().flatten() {
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .expect("all remaining tasks should finish")
                .expect("task should complete without panic");
        }
        assert!(
            scheduler
                .in_flight_by_account()
                .values()
                .all(|count| *count == 0)
        );
    }
}
