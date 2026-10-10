//! Test-only pure mirror of OmniRoute's `available-capacity` account selector.
//!
//! This is deliberately separate from `AccountScheduler`: selection chooses a hint from the
//! TypeScript-approved candidate snapshot, while the production account semaphore is the hard
//! concurrency gate. No other OmniRoute routing strategy is implemented here.

use serde::Deserialize;

const CAPACITY_TIE_EPSILON: f64 = 1e-9;
const MISSING_PRIORITY: i64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidateVector {
    id: String,
    priority: Option<i64>,
    max_concurrent: Option<f64>,
    in_flight: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionStep {
    strategy: String,
    provider: String,
    candidates: Vec<CandidateVector>,
    expected: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionVector {
    name: String,
    steps: Vec<SelectionStep>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u64,
    supported_strategy: String,
    unsupported_strategies: Vec<String>,
    vectors: Vec<SelectionVector>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct UnsupportedStrategy;

/// Pure selection step. The caller owns and scopes the cursor by provider, matching the
/// TypeScript `lastSelectedByProvider` map without making this helper stateful.
fn select_available_capacity(
    strategy: &str,
    candidates: &[CandidateVector],
    last_selected: Option<&str>,
) -> Result<Option<String>, UnsupportedStrategy> {
    if strategy != "available-capacity" {
        return Err(UnsupportedStrategy);
    }
    if candidates.is_empty() {
        return Ok(None);
    }

    let mut lowest_load = f64::INFINITY;
    let mut eligible = Vec::<usize>::with_capacity(candidates.len());
    for (index, candidate) in candidates.iter().enumerate() {
        let configured_capacity = candidate.max_concurrent.unwrap_or(f64::NAN);
        let capacity = if configured_capacity.is_finite() && configured_capacity > 0.0 {
            configured_capacity.trunc().max(1.0)
        } else {
            1.0
        };
        let load = candidate.in_flight as f64 / capacity;
        if load < lowest_load - CAPACITY_TIE_EPSILON {
            lowest_load = load;
            eligible.clear();
            eligible.push(index);
        } else if (load - lowest_load).abs() <= CAPACITY_TIE_EPSILON {
            eligible.push(index);
        }
    }

    let preferred_priority = eligible
        .iter()
        .map(|index| candidates[*index].priority.unwrap_or(MISSING_PRIORITY))
        .min()
        .expect("nonempty candidate input has at least one minimum-load candidate");
    eligible.retain(|index| {
        candidates[*index].priority.unwrap_or(MISSING_PRIORITY) == preferred_priority
    });

    let previous_index = last_selected.and_then(|last| {
        eligible
            .iter()
            .position(|index| candidates[*index].id == last)
    });
    let next_index = previous_index.map_or(0, |index| (index + 1) % eligible.len());
    let selected_index = eligible[next_index];
    Ok(Some(candidates[selected_index].id.clone()))
}

#[cfg(test)]
mod tests {
    use super::{CandidateVector, Fixture, UnsupportedStrategy, select_available_capacity};
    use std::collections::HashMap;

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(
            "../fixtures/available-capacity-selection-v1.json"
        ))
        .expect("shared available-capacity vectors must be valid JSON")
    }

    #[test]
    fn rust_available_capacity_selection_matches_shared_typescript_vectors() {
        let fixture = fixture();
        assert_eq!(fixture.schema_version, 1);
        assert_eq!(fixture.supported_strategy, "available-capacity");
        assert!(fixture.vectors.len() >= 10);

        for vector in fixture.vectors {
            let mut last_selected_by_provider = HashMap::<String, String>::new();
            for step in vector.steps {
                let last_selected = last_selected_by_provider
                    .get(&step.provider)
                    .map(String::as_str);
                let selected =
                    select_available_capacity(&step.strategy, &step.candidates, last_selected)
                        .expect("shared fixture uses the one implemented strategy");
                assert_eq!(selected, step.expected, "{}", vector.name);
                if let Some(selected) = selected {
                    last_selected_by_provider.insert(step.provider, selected);
                }
            }
        }
    }

    #[test]
    fn unsupported_routing_strategies_are_rejected() {
        let fixture = fixture();
        let candidate = CandidateVector {
            id: "opaque-candidate".into(),
            priority: Some(1),
            max_concurrent: Some(1.0),
            in_flight: 0,
        };
        for strategy in fixture.unsupported_strategies {
            assert_eq!(
                select_available_capacity(&strategy, &[candidate_for_test(&candidate)], None),
                Err(UnsupportedStrategy),
                "{strategy} must not be silently interpreted as available-capacity"
            );
        }
    }

    fn candidate_for_test(candidate: &CandidateVector) -> CandidateVector {
        CandidateVector {
            id: candidate.id.clone(),
            priority: candidate.priority,
            max_concurrent: candidate.max_concurrent,
            in_flight: candidate.in_flight,
        }
    }
}
