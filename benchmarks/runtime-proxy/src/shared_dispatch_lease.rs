//! Benchmark-only asynchronous dispatch lease facade over `omni-coordination/v1`.
//!
//! This mirrors the TypeScript static-gate wrapper's enqueue/poll/cancel/release lifecycle and
//! renewable fenced lease. It is not connected to `rust-chat-gateway` or production policy. The
//! caller must supply TypeScript-approved gate names/caps; adaptive gates are rejected by the
//! underlying coordinator.

use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::{
    sync::watch,
    task::JoinError,
    time::{Instant, sleep},
};

use crate::coordination_sqlite::{
    CoordinationRequirement, CoordinatorError, FencedLease, SqliteCoordinator,
};

const ACTIVE: u8 = 0;
const RELEASED: u8 = 1;
const LOST: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DispatchLeaseTiming {
    pub lease_ttl_ms: i64,
    pub renew_every: Duration,
    pub poll_every: Duration,
}

impl Default for DispatchLeaseTiming {
    fn default() -> Self {
        Self {
            lease_ttl_ms: 30_000,
            renew_every: Duration::from_secs(10),
            poll_every: Duration::from_millis(50),
        }
    }
}

#[derive(Debug)]
pub enum DispatchAcquireError {
    QueueFull,
    Timeout,
    Cancelled,
    Coordinator(CoordinatorError),
    BlockingTask(JoinError),
}

impl std::fmt::Display for DispatchAcquireError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::QueueFull => formatter.write_str("shared dispatch queue is full"),
            Self::Timeout => formatter.write_str("shared dispatch admission timed out"),
            Self::Cancelled => formatter.write_str("shared dispatch admission was cancelled"),
            Self::Coordinator(error) => write!(formatter, "shared dispatch coordinator: {error}"),
            Self::BlockingTask(error) => write!(formatter, "SQLite worker task failed: {error}"),
        }
    }
}

impl std::error::Error for DispatchAcquireError {}

impl From<CoordinatorError> for DispatchAcquireError {
    fn from(error: CoordinatorError) -> Self {
        match error {
            CoordinatorError::QueueFull => Self::QueueFull,
            other => Self::Coordinator(other),
        }
    }
}

#[derive(Clone)]
pub struct SharedDispatchAdmission {
    coordinator: Arc<SqliteCoordinator>,
    timing: DispatchLeaseTiming,
}

struct LeaseState {
    coordinator: Arc<SqliteCoordinator>,
    lease: FencedLease,
    status: AtomicU8,
    stop_tx: watch::Sender<bool>,
    lost_tx: watch::Sender<bool>,
}

/// A granted set of global/provider/account gates. Explicitly call `release()` at normal request
/// completion. Drop makes a best-effort nonblocking release; TTL pruning is the process-crash path.
pub struct DispatchLease {
    state: Option<Arc<LeaseState>>,
    lost_rx: Option<watch::Receiver<bool>>,
}

/// Cancellation registration for an enqueued waiter. Drop queues cleanup on Tokio's blocking pool;
/// persisted waiter expiry remains the bounded fallback if the runtime is shutting down.
struct WaiterRegistration {
    coordinator: Arc<SqliteCoordinator>,
    id: Option<String>,
}

impl SharedDispatchAdmission {
    pub fn new(coordinator: Arc<SqliteCoordinator>) -> Self {
        Self {
            coordinator,
            timing: DispatchLeaseTiming::default(),
        }
    }

    /// Timing overrides make lease renewal tests fast. The default settings match TypeScript's
    /// 30-second lease, 10-second heartbeat, and 50-millisecond waiter polling interval.
    pub fn with_timing(
        coordinator: Arc<SqliteCoordinator>,
        timing: DispatchLeaseTiming,
    ) -> Result<Self, DispatchAcquireError> {
        if timing.lease_ttl_ms < 1_000
            || timing.renew_every.is_zero()
            || timing.poll_every.is_zero()
            || timing.renew_every.as_millis() >= timing.lease_ttl_ms as u128
        {
            return Err(DispatchAcquireError::Coordinator(CoordinatorError::Invalid(
                "dispatch lease timing requires TTL >= 1000ms and positive intervals shorter than TTL".into(),
            )));
        }
        Ok(Self {
            coordinator,
            timing,
        })
    }

    /// Acquire every enabled gate atomically. `cancellation` mirrors an AbortSignal; a dropped
    /// acquire future also schedules waiter cancellation, with SQLite waiter expiry as fallback.
    pub async fn acquire_many(
        &self,
        requirements: &[CoordinationRequirement],
        timeout: Duration,
        max_queue_size: usize,
        cancellation: Option<watch::Receiver<bool>>,
    ) -> Result<DispatchLease, DispatchAcquireError> {
        let enabled = requirements
            .iter()
            .filter(|requirement| requirement.limit > 0)
            .cloned()
            .collect::<Vec<_>>();
        if enabled.is_empty() {
            return Ok(DispatchLease::noop());
        }

        let timeout_ms = i64::try_from(timeout.as_millis()).unwrap_or(i64::MAX);
        let deadline = Instant::now() + timeout;
        let waiter_expiry = unix_now_ms().saturating_add(timeout_ms);
        let coordinator = Arc::clone(&self.coordinator);
        let enqueue_requirements = enabled;
        let waiter_id: String = run_db(move || {
            coordinator.enqueue(
                &enqueue_requirements,
                waiter_expiry,
                max_queue_size,
                unix_now_ms(),
            )
        })
        .await?;
        let mut registration = WaiterRegistration {
            coordinator: Arc::clone(&self.coordinator),
            id: Some(waiter_id.clone()),
        };
        let mut cancellation = cancellation;

        loop {
            if is_cancelled(&mut cancellation) {
                registration.cancel().await?;
                return Err(DispatchAcquireError::Cancelled);
            }
            if Instant::now() >= deadline {
                registration.cancel().await?;
                return Err(DispatchAcquireError::Timeout);
            }

            let coordinator = Arc::clone(&self.coordinator);
            let waiter_for_attempt = waiter_id.clone();
            let ttl_ms = self.timing.lease_ttl_ms;
            match run_db(move || {
                coordinator.try_acquire(&waiter_for_attempt, ttl_ms, unix_now_ms())
            })
            .await?
            {
                Some(lease) => {
                    registration.disarm();
                    return Ok(DispatchLease::start(
                        Arc::clone(&self.coordinator),
                        lease,
                        self.timing,
                    ));
                }
                None => {}
            }

            if wait_for_poll_or_cancel(&mut cancellation, self.timing.poll_every).await {
                registration.cancel().await?;
                return Err(DispatchAcquireError::Cancelled);
            }
        }
    }
}

impl DispatchLease {
    fn noop() -> Self {
        Self {
            state: None,
            lost_rx: None,
        }
    }

    fn start(
        coordinator: Arc<SqliteCoordinator>,
        lease: FencedLease,
        timing: DispatchLeaseTiming,
    ) -> Self {
        let (stop_tx, mut stop_rx) = watch::channel(false);
        let (lost_tx, lost_rx) = watch::channel(false);
        let state = Arc::new(LeaseState {
            coordinator,
            lease,
            status: AtomicU8::new(ACTIVE),
            stop_tx,
            lost_tx,
        });

        let heartbeat_state = Arc::clone(&state);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = stop_rx.changed() => {
                        if changed.is_err() || *stop_rx.borrow() {
                            return;
                        }
                    }
                    _ = sleep(timing.renew_every) => {
                        if heartbeat_state.status.load(Ordering::Acquire) != ACTIVE {
                            return;
                        }
                        let coordinator = Arc::clone(&heartbeat_state.coordinator);
                        let lease = heartbeat_state.lease.clone();
                        let ttl_ms = timing.lease_ttl_ms;
                        let renewed = run_db(move || coordinator.renew(&lease, ttl_ms, unix_now_ms())).await;
                        if !matches!(renewed, Ok(true)) {
                            if heartbeat_state
                                .status
                                .compare_exchange(ACTIVE, LOST, Ordering::AcqRel, Ordering::Acquire)
                                .is_ok()
                            {
                                let _ = heartbeat_state.lost_tx.send(true);
                            }
                            // Do not issue an explicit release after heartbeat loss: the lease may
                            // already be gone or owned by another dispatcher. If a transient
                            // coordination error left the row valid, TTL expiry bounds recovery.
                            // Upstream work must observe `lost_receiver()` and abort immediately.
                            return;
                        }
                    }
                }
            }
        });

        Self {
            state: Some(state),
            lost_rx: Some(lost_rx),
        }
    }

    pub fn fenced_lease(&self) -> Option<&FencedLease> {
        self.state.as_ref().map(|state| &state.lease)
    }

    pub fn lost_receiver(&self) -> Option<watch::Receiver<bool>> {
        self.lost_rx.clone()
    }

    pub fn is_lost(&self) -> bool {
        self.lost_rx
            .as_ref()
            .is_some_and(|receiver| *receiver.borrow())
    }

    /// Release normally completed work. After heartbeat loss, this does not issue an explicit
    /// release because the old lease may be gone or replaced. If a transient coordination error
    /// left it valid, TTL expiry bounds recovery; the caller must abort upstream work on loss.
    pub async fn release(&self) -> Result<(), DispatchAcquireError> {
        let Some(state) = &self.state else {
            return Ok(());
        };
        let previous =
            state
                .status
                .compare_exchange(ACTIVE, RELEASED, Ordering::AcqRel, Ordering::Acquire);
        let _ = state.stop_tx.send(true);
        match previous {
            Ok(_) => {
                let coordinator = Arc::clone(&state.coordinator);
                let lease = state.lease.clone();
                run_db(move || coordinator.release(&lease)).await
            }
            Err(LOST | RELEASED) => Ok(()),
            Err(_) => Ok(()),
        }
    }
}

impl Drop for DispatchLease {
    fn drop(&mut self) {
        let Some(state) = &self.state else {
            return;
        };
        if state
            .status
            .compare_exchange(ACTIVE, RELEASED, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            let _ = state.stop_tx.send(true);
            return;
        }
        let _ = state.stop_tx.send(true);
        let coordinator = Arc::clone(&state.coordinator);
        let lease = state.lease.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn_blocking(move || {
                let _ = coordinator.release(&lease);
            });
        }
        // Without a runtime to schedule cleanup, the durable lease TTL is the recovery bound.
    }
}

impl WaiterRegistration {
    fn disarm(&mut self) {
        self.id = None;
    }

    async fn cancel(&mut self) -> Result<(), DispatchAcquireError> {
        let Some(id) = self.id.as_ref().cloned() else {
            return Ok(());
        };
        let coordinator = Arc::clone(&self.coordinator);
        run_db(move || coordinator.cancel(&id)).await?;
        self.id = None;
        Ok(())
    }
}

impl Drop for WaiterRegistration {
    fn drop(&mut self) {
        let Some(id) = self.id.take() else {
            return;
        };
        let coordinator = Arc::clone(&self.coordinator);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn_blocking(move || {
                let _ = coordinator.cancel(&id);
            });
        }
        // If the runtime is gone, waiter expiry is the bounded cleanup fallback.
    }
}

async fn run_db<T, F>(operation: F) -> Result<T, DispatchAcquireError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CoordinatorError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(DispatchAcquireError::BlockingTask)?
        .map_err(DispatchAcquireError::Coordinator)
}

fn is_cancelled(cancellation: &mut Option<watch::Receiver<bool>>) -> bool {
    cancellation
        .as_mut()
        .is_some_and(|receiver| *receiver.borrow_and_update())
}

async fn wait_for_poll_or_cancel(
    cancellation: &mut Option<watch::Receiver<bool>>,
    poll_every: Duration,
) -> bool {
    if is_cancelled(cancellation) {
        return true;
    }
    match cancellation {
        Some(receiver) => tokio::select! {
            _ = sleep(poll_every) => false,
            changed = receiver.changed() => changed.is_err() || *receiver.borrow_and_update(),
        },
        None => {
            sleep(poll_every).await;
            false
        }
    }
}

fn unix_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(i64::MAX)
}
