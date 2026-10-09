//! Benchmark-only port of the pure quota-pool fair-share decision.
//!
//! This module consumes already-resolved policy inputs. It does not read quota storage, resolve
//! plans or pools, select a quota-store driver, or implement TypeScript's fail-open wrapper.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FairShareInput {
    pub dimensions: Vec<FairShareDimension>,
    pub allocation: FairShareAllocation,
    pub consumed_by_this_key: HashMap<String, f64>,
    pub saturation_threshold: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FairShareDimension {
    pub key: FairShareDimensionKey,
    pub limit: f64,
    pub consumed_total: f64,
    pub global_used_percent: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FairShareDimensionKey {
    pub pool_id: String,
    pub unit: String,
    pub window: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FairShareAllocation {
    pub weight: f64,
    pub policy: String,
    pub cap_value: Option<f64>,
    pub cap_unit: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DecisionKind {
    Allow,
    Block,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Serialize)]
pub enum DecisionReason {
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "fair-share")]
    FairShare,
    #[serde(rename = "cap-absolute")]
    CapAbsolute,
    #[serde(rename = "global-saturated")]
    GlobalSaturated,
}

/// Normalized TypeScript-compatible output. `penalized` is always a boolean here; TypeScript's
/// omitted/undefined value is normalized to false by the cross-runtime vector tests.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Serialize)]
pub struct FairShareDecision {
    pub kind: DecisionKind,
    pub reason: DecisionReason,
    pub penalized: bool,
}

pub fn decide_fair_share(input: &FairShareInput) -> FairShareDecision {
    if input.dimensions.is_empty() {
        return allow(false);
    }

    // The TypeScript source normalizes any unknown/corrupt policy to `hard`.
    let policy = match input.allocation.policy.as_str() {
        "soft" => Policy::Soft,
        "burst" => Policy::Burst,
        _ => Policy::Hard,
    };
    let mut any_penalized = false;

    for dimension in &input.dimensions {
        let dimension_key = format!(
            "{}:{}:{}",
            dimension.key.pool_id, dimension.key.unit, dimension.key.window
        );
        let consumed = input
            .consumed_by_this_key
            .get(&dimension_key)
            .copied()
            .unwrap_or(0.0);
        let fair_share = (input.allocation.weight / 100.0) * dimension.limit;

        if input.allocation.cap_value.is_some_and(|cap| {
            input.allocation.cap_unit.as_deref() == Some(&dimension.key.unit) && consumed >= cap
        }) {
            return block(DecisionReason::CapAbsolute);
        }

        if dimension.consumed_total >= dimension.limit {
            return block(DecisionReason::GlobalSaturated);
        }

        let strict = dimension.global_used_percent >= input.saturation_threshold;
        if strict {
            match policy {
                Policy::Hard if consumed >= fair_share => {
                    return block(DecisionReason::FairShare);
                }
                Policy::Soft if consumed >= fair_share => any_penalized = true,
                Policy::Hard | Policy::Soft | Policy::Burst => {}
            }
        } else {
            match policy {
                Policy::Hard if consumed >= dimension.limit => {
                    return block(DecisionReason::GlobalSaturated);
                }
                Policy::Soft if consumed >= fair_share => any_penalized = true,
                Policy::Hard | Policy::Soft | Policy::Burst => {}
            }
        }
    }

    allow(any_penalized)
}

#[derive(Debug, Clone, Copy)]
enum Policy {
    Hard,
    Soft,
    Burst,
}

fn allow(penalized: bool) -> FairShareDecision {
    FairShareDecision {
        kind: DecisionKind::Allow,
        reason: DecisionReason::Ok,
        penalized,
    }
}

fn block(reason: DecisionReason) -> FairShareDecision {
    FairShareDecision {
        kind: DecisionKind::Block,
        reason,
        penalized: false,
    }
}

#[cfg(test)]
mod tests {
    use super::{FairShareDecision, FairShareInput, decide_fair_share};
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VectorFixture {
        schema_version: u16,
        vectors: Vec<VectorCase>,
    }

    #[derive(Debug, Deserialize)]
    struct VectorCase {
        name: String,
        input: FairShareInput,
        expected: FairShareDecision,
    }

    #[test]
    fn rust_decisions_match_shared_typescript_fair_share_vectors() {
        let fixture: VectorFixture =
            serde_json::from_str(include_str!("../fixtures/quota-fair-share-v1.json"))
                .expect("parse shared fair-share vectors");

        assert_eq!(fixture.schema_version, 1);
        assert!(
            fixture.vectors.len() >= 18,
            "fixture should cover policy boundaries"
        );

        for vector in fixture.vectors {
            let actual = decide_fair_share(&vector.input);
            let normalized = FairShareDecision {
                kind: actual.kind,
                reason: actual.reason,
                penalized: actual.penalized,
            };
            assert_eq!(normalized, vector.expected, "vector: {}", vector.name);
        }
    }
}
