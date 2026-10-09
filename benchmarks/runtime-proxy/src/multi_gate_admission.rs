//! Synthetic atomic multi-gate admission model for the Rust gateway prototype.
//!
//! This models process-local global/provider/account caps only. It does not read OmniRoute
//! settings, share counters across workers, or own provider credentials.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::sync::Notify;

#[derive(Clone, Debug)]
pub struct GateRequirement {
    pub key: String,
    /// `None` or zero bypasses the gate, matching the TypeScript no-cap behavior.
    pub max_concurrency: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquireError {
    QueueFull,
    Timeout,
}

impl std::fmt::Display for AcquireError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::QueueFull => formatter.write_str("multi-gate admission queue is full"),
            Self::Timeout => formatter.write_str("multi-gate admission wait timed out"),
        }
    }
}

impl std::error::Error for AcquireError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateSnapshot {
    pub running: usize,
    pub queued: usize,
    pub max_concurrency: usize,
}

#[derive(Default)]
struct Gate {
    running: usize,
    max_concurrency: usize,
    queue: VecDeque<u64>,
}

#[derive(Default)]
struct AdmissionState {
    gates: HashMap<String, Gate>,
    queue_order: VecDeque<u64>,
    waiting: HashMap<u64, Vec<String>>,
    granted: HashMap<u64, Vec<String>>,
    next_request_id: u64,
}

struct AdmissionInner {
    state: Mutex<AdmissionState>,
    changed: Arc<Notify>,
}

#[derive(Clone)]
pub struct MultiGateAdmission {
    inner: Arc<AdmissionInner>,
}

pub struct AdmissionLease {
    inner: Arc<AdmissionInner>,
    keys: Vec<String>,
    released: bool,
}

struct WaiterRegistration {
    inner: Arc<AdmissionInner>,
    request_id: u64,
    armed: bool,
}

impl MultiGateAdmission {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AdmissionInner {
                state: Mutex::new(AdmissionState::default()),
                changed: Arc::new(Notify::new()),
            }),
        }
    }

    /// Atomically reserves every enabled gate or none of them.
    ///
    /// Duplicate keys collapse to the strictest supplied limit, and the normalized keys are
    /// sorted before reservation/queue insertion so every caller observes a deterministic order.
    /// A dropped acquisition future removes its waiter from every gate. A returned lease releases
    /// the complete set exactly once when explicitly released or dropped.
    pub async fn acquire_many(
        &self,
        requirements: &[GateRequirement],
        timeout: Duration,
        max_queue_size: usize,
    ) -> Result<AdmissionLease, AcquireError> {
        let normalized = normalize_requirements(requirements);
        if normalized.is_empty() {
            return Ok(AdmissionLease {
                inner: Arc::clone(&self.inner),
                keys: Vec::new(),
                released: false,
            });
        }
        let keys = normalized
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();

        let (request_id, granted_waiters) = {
            let mut state = lock_state(&self.inner.state);
            for (key, max_concurrency) in &normalized {
                let gate = state.gates.entry(key.clone()).or_default();
                gate.max_concurrency = *max_concurrency;
            }

            if max_queue_size > 0
                && keys.iter().any(|key| {
                    state
                        .gates
                        .get(key)
                        .is_some_and(|gate| gate.queue.len() >= max_queue_size)
                })
            {
                cleanup_idle_gates(&mut state, &keys);
                return Err(AcquireError::QueueFull);
            }

            if can_acquire_immediately(&state, &keys) {
                increment_gates(&mut state, &keys);
                return Ok(AdmissionLease {
                    inner: Arc::clone(&self.inner),
                    keys,
                    released: false,
                });
            }

            state.next_request_id = state.next_request_id.wrapping_add(1);
            let request_id = state.next_request_id;
            state.queue_order.push_back(request_id);
            state.waiting.insert(request_id, keys.clone());
            for key in &keys {
                state
                    .gates
                    .get_mut(key)
                    .expect("gate inserted")
                    .queue
                    .push_back(request_id);
            }
            let granted_waiters = drain_waiters(&mut state);
            (request_id, granted_waiters)
        };

        if granted_waiters {
            self.inner.changed.notify_waiters();
        }
        let mut registration = WaiterRegistration {
            inner: Arc::clone(&self.inner),
            request_id,
            armed: true,
        };
        let result = tokio::time::timeout(timeout, wait_for_grant(&self.inner, request_id)).await;
        match result {
            Ok(keys) => {
                registration.armed = false;
                Ok(AdmissionLease {
                    inner: Arc::clone(&self.inner),
                    keys,
                    released: false,
                })
            }
            Err(_) => Err(AcquireError::Timeout),
        }
    }

    pub fn snapshot(&self) -> HashMap<String, GateSnapshot> {
        let state = lock_state(&self.inner.state);
        state
            .gates
            .iter()
            .map(|(key, gate)| {
                (
                    key.clone(),
                    GateSnapshot {
                        running: gate.running,
                        queued: gate.queue.len(),
                        max_concurrency: gate.max_concurrency,
                    },
                )
            })
            .collect()
    }
}

impl Default for MultiGateAdmission {
    fn default() -> Self {
        Self::new()
    }
}

impl AdmissionLease {
    #[cfg(test)]
    pub fn keys(&self) -> &[String] {
        &self.keys
    }

    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut state = lock_state(&self.inner.state);
        decrement_gates(&mut state, &self.keys);
        drain_waiters(&mut state);
        cleanup_idle_gates(&mut state, &self.keys);
        drop(state);
        self.inner.changed.notify_waiters();
    }
}

impl Drop for AdmissionLease {
    fn drop(&mut self) {
        self.release();
    }
}

impl Drop for WaiterRegistration {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = lock_state(&self.inner.state);
        if let Some(keys) = state.granted.remove(&self.request_id) {
            decrement_gates(&mut state, &keys);
            drain_waiters(&mut state);
            cleanup_idle_gates(&mut state, &keys);
        } else if let Some(keys) = remove_waiter(&mut state, self.request_id) {
            drain_waiters(&mut state);
            cleanup_idle_gates(&mut state, &keys);
        }
        drop(state);
        self.inner.changed.notify_waiters();
    }
}

async fn wait_for_grant(inner: &Arc<AdmissionInner>, request_id: u64) -> Vec<String> {
    loop {
        let notified = inner.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        let granted = {
            let mut state = lock_state(&inner.state);
            state.granted.remove(&request_id)
        };
        if let Some(keys) = granted {
            return keys;
        }
        notified.await;
    }
}

fn normalize_requirements(requirements: &[GateRequirement]) -> Vec<(String, usize)> {
    let mut enabled = BTreeMap::<String, usize>::new();
    for requirement in requirements {
        let Some(limit) = requirement.max_concurrency.filter(|limit| *limit > 0) else {
            continue;
        };
        enabled
            .entry(requirement.key.clone())
            .and_modify(|current| *current = (*current).min(limit))
            .or_insert(limit);
    }
    enabled.into_iter().collect()
}

fn can_acquire_immediately(state: &AdmissionState, keys: &[String]) -> bool {
    keys.iter().all(|key| {
        state
            .gates
            .get(key)
            .is_some_and(|gate| gate.queue.is_empty() && gate.running < gate.max_concurrency)
    })
}

fn increment_gates(state: &mut AdmissionState, keys: &[String]) {
    for key in keys {
        state.gates.get_mut(key).expect("gate inserted").running += 1;
    }
}

fn decrement_gates(state: &mut AdmissionState, keys: &[String]) {
    for key in keys {
        if let Some(gate) = state.gates.get_mut(key) {
            gate.running = gate.running.saturating_sub(1);
        }
    }
}

fn request_can_acquire(state: &AdmissionState, request_id: u64, keys: &[String]) -> bool {
    keys.iter().all(|key| {
        state.gates.get(key).is_some_and(|gate| {
            gate.running < gate.max_concurrency && gate.queue.front() == Some(&request_id)
        })
    })
}

fn remove_waiter(state: &mut AdmissionState, request_id: u64) -> Option<Vec<String>> {
    let keys = state.waiting.remove(&request_id)?;
    state
        .queue_order
        .retain(|queued_id| *queued_id != request_id);
    for key in &keys {
        if let Some(gate) = state.gates.get_mut(key) {
            gate.queue.retain(|queued_id| *queued_id != request_id);
        }
    }
    Some(keys)
}

fn drain_waiters(state: &mut AdmissionState) -> bool {
    let mut granted_any = false;
    loop {
        let eligible = state.queue_order.iter().find_map(|request_id| {
            let keys = state.waiting.get(request_id)?;
            request_can_acquire(state, *request_id, keys).then_some(*request_id)
        });
        let Some(request_id) = eligible else {
            return granted_any;
        };
        let keys = remove_waiter(state, request_id).expect("eligible waiter exists");
        increment_gates(state, &keys);
        state.granted.insert(request_id, keys);
        granted_any = true;
    }
}

fn cleanup_idle_gates(state: &mut AdmissionState, keys: &[String]) {
    for key in keys {
        let idle = state
            .gates
            .get(key)
            .is_some_and(|gate| gate.running == 0 && gate.queue.is_empty());
        if idle {
            state.gates.remove(key);
        }
    }
}

fn lock_state(state: &Mutex<AdmissionState>) -> MutexGuard<'_, AdmissionState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{sync::oneshot, time::sleep};

    fn requirements(account: &str, account_cap: usize) -> Vec<GateRequirement> {
        vec![
            GateRequirement {
                key: format!("account:codex:{account}"),
                max_concurrency: Some(account_cap),
            },
            GateRequirement {
                key: "provider:codex".into(),
                max_concurrency: Some(2),
            },
            GateRequirement {
                key: "global".into(),
                max_concurrency: Some(3),
            },
        ]
    }

    fn contended_requirements(account: &str) -> Vec<GateRequirement> {
        vec![
            GateRequirement {
                key: format!("account:codex:{account}"),
                max_concurrency: Some(1),
            },
            GateRequirement {
                key: "provider:codex".into(),
                max_concurrency: Some(1),
            },
            GateRequirement {
                key: "global".into(),
                max_concurrency: Some(1),
            },
        ]
    }

    #[tokio::test]
    async fn reserves_global_provider_and_account_gates_atomically_in_sorted_order() {
        let admission = MultiGateAdmission::new();
        let mut lease = admission
            .acquire_many(&requirements("acct-a", 1), Duration::from_millis(50), 4)
            .await
            .unwrap();

        assert_eq!(
            lease.keys(),
            &["account:codex:acct-a", "global", "provider:codex"]
        );
        let stats = admission.snapshot();
        assert_eq!(stats["global"].running, 1);
        assert_eq!(stats["provider:codex"].running, 1);
        assert_eq!(stats["account:codex:acct-a"].running, 1);

        lease.release();
        lease.release();
        assert!(admission.snapshot().is_empty());
    }

    #[tokio::test]
    async fn waits_without_partially_reserving_free_gates_and_drains_after_release() {
        let admission = MultiGateAdmission::new();
        let held = admission
            .acquire_many(
                &contended_requirements("acct-a"),
                Duration::from_millis(100),
                4,
            )
            .await
            .unwrap();
        let waiting_admission = admission.clone();
        let waiter = tokio::spawn(async move {
            waiting_admission
                .acquire_many(
                    &contended_requirements("acct-b"),
                    Duration::from_millis(200),
                    4,
                )
                .await
        });
        sleep(Duration::from_millis(10)).await;

        let stats = admission.snapshot();
        assert_eq!(stats["global"].running, 1);
        assert_eq!(stats["global"].queued, 1);
        assert_eq!(stats["provider:codex"].running, 1);
        assert_eq!(stats["provider:codex"].queued, 1);
        assert_eq!(stats["account:codex:acct-b"].running, 0);
        assert_eq!(stats["account:codex:acct-b"].queued, 1);

        drop(held);
        let next = waiter.await.unwrap().unwrap();
        assert_eq!(admission.snapshot()["account:codex:acct-b"].running, 1);
        drop(next);
        assert!(admission.snapshot().is_empty());
    }

    #[tokio::test]
    async fn cancellation_clears_waiter_queues_and_drops_acquired_multi_gate_lease() {
        let admission = MultiGateAdmission::new();
        let held = admission
            .acquire_many(
                &contended_requirements("acct-a"),
                Duration::from_millis(100),
                4,
            )
            .await
            .unwrap();
        let waiting_admission = admission.clone();
        let waiter = tokio::spawn(async move {
            let _queued = waiting_admission
                .acquire_many(&contended_requirements("acct-b"), Duration::from_secs(1), 4)
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });
        sleep(Duration::from_millis(10)).await;
        assert_eq!(admission.snapshot()["global"].queued, 1);
        waiter.abort();
        let _ = waiter.await;

        let stats = admission.snapshot();
        assert_eq!(stats["global"].queued, 0);
        assert_eq!(stats["provider:codex"].queued, 0);
        assert_eq!(stats.get("account:codex:acct-b"), None);
        drop(held);
        assert!(admission.snapshot().is_empty());

        let task_admission = admission.clone();
        let (acquired_tx, acquired_rx) = oneshot::channel();
        let holder = tokio::spawn(async move {
            let _lease = task_admission
                .acquire_many(&contended_requirements("acct-a"), Duration::from_secs(1), 4)
                .await
                .unwrap();
            let _ = acquired_tx.send(());
            std::future::pending::<()>().await;
        });
        acquired_rx.await.unwrap();
        assert_eq!(admission.snapshot()["global"].running, 1);
        holder.abort();
        let _ = holder.await;
        assert!(admission.snapshot().is_empty());

        let after_cancel = admission
            .acquire_many(
                &contended_requirements("acct-b"),
                Duration::from_millis(50),
                4,
            )
            .await
            .unwrap();
        drop(after_cancel);
        assert!(admission.snapshot().is_empty());
    }

    #[tokio::test]
    async fn duplicate_gate_requirements_use_the_strictest_cap_and_bypass_zero() {
        let admission = MultiGateAdmission::new();
        let lease = admission
            .acquire_many(
                &[
                    GateRequirement {
                        key: "global".into(),
                        max_concurrency: Some(4),
                    },
                    GateRequirement {
                        key: "global".into(),
                        max_concurrency: Some(2),
                    },
                    GateRequirement {
                        key: "bypassed".into(),
                        max_concurrency: Some(0),
                    },
                    GateRequirement {
                        key: "unbounded".into(),
                        max_concurrency: None,
                    },
                ],
                Duration::from_millis(20),
                2,
            )
            .await
            .unwrap();
        assert_eq!(lease.keys(), &["global"]);
        assert_eq!(admission.snapshot()["global"].max_concurrency, 2);
        drop(lease);
        assert!(admission.snapshot().is_empty());
    }
}
