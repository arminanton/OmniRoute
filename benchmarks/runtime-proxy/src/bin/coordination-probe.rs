#[path = "../coordination_sqlite.rs"]
mod coordination_sqlite;

use coordination_sqlite::{CoordinationRequirement, FencedLease, SqliteCoordinator};
use rusqlite::Connection;
use serde_json::json;
use std::{env, error::Error, process};

fn main() {
    if let Err(error) = run() {
        eprintln!("coordination probe failed: {error}");
        process::exit(2);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mode = args.next().ok_or("expected probe mode")?;
    match mode.as_str() {
        "attempt" => {
            let db_path = args.next().ok_or("expected DB path")?;
            let owner = args.next().ok_or("expected owner")?;
            let key = args.next().ok_or("expected resource key")?;
            let limit = parse::<usize>(args.next(), "limit")?;
            let now = parse::<i64>(args.next(), "now")?;
            let ttl = parse::<i64>(args.next(), "TTL")?;
            let deadline = parse::<i64>(args.next(), "deadline")?;
            let release = args.next().is_some_and(|value| value == "release");
            let coordinator = SqliteCoordinator::open(&db_path, owner)?;
            let id = coordinator.enqueue(
                &[CoordinationRequirement {
                    key,
                    limit,
                    adaptive: false,
                    initial_limit: None,
                }],
                deadline,
                20,
                now,
            )?;
            match coordinator.try_acquire(&id, ttl, now)? {
                Some(lease) => {
                    if release {
                        coordinator.release(&lease)?;
                    }
                    println!(
                        "{}",
                        json!({
                            "status": "acquired",
                            "lease": {
                                "id": lease.id,
                                "fence": lease.fence,
                                "expiresAt": lease.expires_at,
                            }
                        })
                    );
                }
                None => {
                    coordinator.cancel(&id)?;
                    println!("{{\"status\":\"blocked\"}}");
                }
            }
        }
        "adaptive-vector" => {
            let db_path = args.next().ok_or("expected DB path")?;
            let owner = args.next().ok_or("expected owner")?;
            let coordinator = SqliteCoordinator::open(&db_path, owner)?;
            let resource = "adaptive-parity";
            let mut admissions = vec![adaptive_capacity_at(&coordinator, resource, 1_000)?];
            coordinator.observe_protocol(resource, "concurrency_overload", 0.0, 1_100)?;
            coordinator.observe_protocol(resource, "concurrency_overload", 0.0, 1_200)?;
            admissions.push(adaptive_capacity_at(&coordinator, resource, 1_200)?);
            admissions.push(adaptive_capacity_at(&coordinator, resource, 31_001)?);
            coordinator.observe_protocol(resource, "concurrency_overload", 0.0, 31_100)?;
            coordinator.observe_protocol(resource, "concurrency_overload", 0.0, 31_200)?;
            admissions.push(adaptive_capacity_at(&coordinator, resource, 31_200)?);
            admissions.push(adaptive_capacity_at(&coordinator, resource, 61_001)?);
            admissions.push(adaptive_capacity_at(&coordinator, resource, 91_001)?);
            admissions.push(adaptive_capacity_at(&coordinator, resource, 121_001)?);

            let db = Connection::open(&db_path)?;
            let raw_state: String = db.query_row(
                "SELECT state FROM coordination_adaptation WHERE resource=?",
                [resource],
                |row| row.get(0),
            )?;
            let state: serde_json::Value = serde_json::from_str(&raw_state)?;
            println!("{}", json!({"admissions": admissions, "state": state}));
        }
        "cancel" => {
            let db_path = args.next().ok_or("expected DB path")?;
            let owner = args.next().ok_or("expected owner")?;
            let key = args.next().ok_or("expected resource key")?;
            let limit = parse::<usize>(args.next(), "limit")?;
            let now = parse::<i64>(args.next(), "now")?;
            let deadline = parse::<i64>(args.next(), "deadline")?;
            let coordinator = SqliteCoordinator::open(&db_path, owner)?;
            let id = coordinator.enqueue(
                &[CoordinationRequirement {
                    key,
                    limit,
                    adaptive: false,
                    initial_limit: None,
                }],
                deadline,
                20,
                now,
            )?;
            coordinator.cancel(&id)?;
            println!("{{\"status\":\"cancelled\"}}");
        }
        "block" | "unblock" => {
            let db_path = args.next().ok_or("expected DB path")?;
            let owner = args.next().ok_or("expected owner")?;
            let key = args.next().ok_or("expected resource key")?;
            let coordinator = SqliteCoordinator::open(&db_path, owner)?;
            if mode == "block" {
                let until = parse::<i64>(args.next(), "block expiry")?;
                coordinator.block(&key, until)?;
            } else {
                coordinator.unblock(&key)?;
            }
            println!("{{\"status\":\"ok\"}}");
        }
        "renew" | "valid" | "release" => {
            let db_path = args.next().ok_or("expected DB path")?;
            let owner = args.next().ok_or("expected owner")?;
            let lease = parse_lease(args.next().ok_or("expected lease JSON")?.as_str())?;
            let coordinator = SqliteCoordinator::open(&db_path, owner)?;
            let result = match mode.as_str() {
                "renew" => {
                    let now = parse::<i64>(args.next(), "now")?;
                    let ttl = parse::<i64>(args.next(), "TTL")?;
                    coordinator.renew(&lease, ttl, now)?
                }
                "valid" => {
                    let now = parse::<i64>(args.next(), "now")?;
                    coordinator.valid(&lease, now)?
                }
                "release" => {
                    coordinator.release(&lease)?;
                    true
                }
                _ => unreachable!(),
            };
            println!("{}", json!({ "result": result }));
        }
        _ => return Err(format!("unknown probe mode: {mode}").into()),
    }
    Ok(())
}

fn adaptive_capacity_at(
    coordinator: &SqliteCoordinator,
    resource: &str,
    now: i64,
) -> Result<usize, Box<dyn Error>> {
    let requirement = CoordinationRequirement {
        key: resource.to_owned(),
        limit: 6,
        adaptive: true,
        initial_limit: Some(4),
    };
    let mut leases = Vec::new();
    for _ in 0..6 {
        let id = coordinator.enqueue(&[requirement.clone()], now + 10_000, 20, now)?;
        if let Some(lease) = coordinator.try_acquire(&id, 60_000, now)? {
            leases.push(lease);
        } else {
            coordinator.cancel(&id)?;
        }
    }
    let admitted = leases.len();
    for lease in leases {
        coordinator.release(&lease)?;
    }
    Ok(admitted)
}

fn parse<T>(value: Option<String>, name: &str) -> Result<T, Box<dyn Error>>
where
    T: std::str::FromStr,
    T::Err: Error + 'static,
{
    Ok(value.ok_or_else(|| format!("expected {name}"))?.parse()?)
}

fn parse_lease(text: &str) -> Result<FencedLease, Box<dyn Error>> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    Ok(FencedLease {
        id: value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or("lease id missing")?
            .to_owned(),
        fence: value
            .get("fence")
            .and_then(serde_json::Value::as_i64)
            .ok_or("lease fence missing")?,
        expires_at: value
            .get("expiresAt")
            .and_then(serde_json::Value::as_i64)
            .ok_or("lease expiry missing")?,
    })
}
