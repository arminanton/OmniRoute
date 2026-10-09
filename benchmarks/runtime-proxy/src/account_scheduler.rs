//! Synthetic account eligibility, configurable selection, and in-flight leases.
//!
//! This benchmark model uses only synthetic account metadata. It is not connected to
//! OmniRoute's database, provider credentials, quota cache, or routing settings.

use std::{
    cmp::Ordering,
    collections::HashMap,
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
    changed: Arc<Notify>,
    capacity_wait_requests: AtomicU64,
    affinity_ttl: Option<Duration>,
}

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
        let mut counted_capacity_wait = false;
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let mut affinity = self.inner.affinity.lock().await;
            let now = Instant::now();
            let eligible: Vec<Arc<Account>> = self
                .inner
                .accounts
                .iter()
                .filter(|account| is_eligible(&account.metadata, now))
                .cloned()
                .collect();
            if eligible.is_empty() {
                if let Some(key) = session_key {
                    affinity.remove(key);
                }
                return Err(SchedulerError::NoEligibleAccounts);
            }

            let mut used_affinity = false;
            let mut pinned_index = None;
            if let (Some(key), Some(ttl)) = (session_key, self.inner.affinity_ttl) {
                if let Some(pin) = affinity.get(key).cloned() {
                    if pin.expires_at <= now {
                        affinity.remove(key);
                    } else if let Some(index) = eligible.iter().position(|account| {
                        account.metadata.id == pin.account_id && has_capacity(account.as_ref())
                    }) {
                        pinned_index = Some(index);
                        used_affinity = true;
                        affinity.insert(
                            key.to_owned(),
                            AffinityPin {
                                account_id: pin.account_id,
                                expires_at: now + ttl,
                            },
                        );
                    } else if !eligible
                        .iter()
                        .any(|account| account.metadata.id == pin.account_id)
                    {
                        affinity.remove(key);
                    }
                }
            }

            let selected = pinned_index
                .map(|index| eligible[index].clone())
                .or_else(|| {
                    let mut available = eligible.iter().filter(|account| has_capacity(account));
                    match self.inner.routing_strategy {
                        SyntheticRoutingStrategy::LeastLoaded => available
                            .min_by(|left, right| compare_load(left, right))
                            .cloned(),
                        SyntheticRoutingStrategy::PriorityOrderedFillFirst => {
                            available.next().cloned()
                        }
                    }
                });

            if let Some(account) = selected {
                account.in_flight.fetch_add(1, AtomicOrdering::AcqRel);
                if !used_affinity {
                    if let (Some(key), Some(ttl)) = (session_key, self.inner.affinity_ttl) {
                        affinity.insert(
                            key.to_owned(),
                            AffinityPin {
                                account_id: account.metadata.id.clone(),
                                expires_at: now + ttl,
                            },
                        );
                    }
                }
                return Ok(AccountLease {
                    account,
                    changed: self.inner.changed.clone(),
                    used_affinity,
                });
            }

            drop(affinity);
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

fn has_capacity(account: &Account) -> bool {
    account.in_flight.load(AtomicOrdering::Acquire) < account.metadata.max_in_flight
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
    use tokio::sync::oneshot;

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
}
