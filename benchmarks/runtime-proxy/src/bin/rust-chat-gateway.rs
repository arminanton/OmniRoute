//! Loopback-only OpenAI chat data-plane trial.
//!
//! This deliberately small prototype exercises client authentication with static configured key
//! identities, independent per-key request windows/revocation flags, global stream admission,
//! bounded request-body memory, optional model aliasing, provider-key replacement, and
//! cancellation-aware SSE forwarding. It is not the production OmniRoute router: keys and policy
//! are static process configuration with one upstream.

use std::{
    collections::{HashMap, HashSet},
    env, io,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use bytes::{Bytes, BytesMut};
use futures_util::{Stream, StreamExt};
use reqwest::Client;
use tokio::{
    net::TcpListener,
    sync::{OwnedSemaphorePermit, Semaphore},
};

#[cfg(test)]
#[path = "../account_scheduler.rs"]
mod account_scheduler;

#[cfg(test)]
#[path = "../multi_gate_admission.rs"]
mod multi_gate_admission;

const BODY_UNIT_BYTES: usize = 64 * 1024;
const RATE_WINDOW: Duration = Duration::from_secs(60);
const MAX_CONFIG_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_CONFIG_BODY_BUDGET_BYTES: usize = 2 * 1024 * 1024 * 1024;
const MAX_CONFIG_INFLIGHT: usize = 4096;
const MAX_CONFIG_CLIENT_KEYS: usize = 256;
const MAX_CONFIG_CLIENT_KEYS_JSON_BYTES: usize = 512 * 1024;
const MAX_CLIENT_ID_BYTES: usize = 128;
const MAX_CLIENT_KEY_BYTES: usize = 512;
const MAX_CLIENT_REQUESTS_PER_MINUTE: u64 = 10_000_000;
const MAX_MODEL_ALIASES: usize = 1000;
const MAX_MODEL_NAME_BYTES: usize = 512;
const MAX_JSON_STRUCTURAL_TOKENS: usize = 100_000;
const BODY_MEMORY_CHARGE_FACTOR: usize = 4;
const JSON_TOKEN_MEMORY_CHARGE_BYTES: usize = 128;

#[derive(Clone)]
struct GatewayConfig {
    upstream: String,
    api_path: String,
    client_keys: Vec<ClientKeyConfig>,
    upstream_api_key: Option<String>,
    max_body_bytes: usize,
    body_budget_bytes: usize,
    max_inflight: usize,
    model_aliases: HashMap<String, String>,
}

#[derive(Clone)]
struct AppState {
    client: Client,
    upstream: String,
    api_path: String,
    upstream_authorization: Option<HeaderValue>,
    max_body_bytes: usize,
    max_body_budget_units: usize,
    max_inflight: usize,
    client_keys: Arc<Vec<ClientKey>>,
    model_aliases: Arc<HashMap<String, String>>,
    inflight: Arc<Semaphore>,
    body_budget: Arc<Semaphore>,
    active: Arc<AtomicUsize>,
    accepted: Arc<AtomicU64>,
    completed: Arc<AtomicU64>,
    rejected: Arc<AtomicU64>,
    input_bytes: Arc<AtomicU64>,
    output_bytes: Arc<AtomicU64>,
    rate_windows: Arc<Mutex<HashMap<String, RateWindow>>>,
}

#[derive(Clone)]
struct ClientKeyConfig {
    id: String,
    api_key: String,
    max_requests_per_minute: u64,
    revoked: bool,
}

struct ClientKey {
    id: String,
    secret: Arc<[u8]>,
    max_requests_per_minute: u64,
    revoked: bool,
}

struct AuthenticatedClient {
    id: String,
    max_requests_per_minute: u64,
}

struct RateWindow {
    started: Instant,
    requests: u64,
}

struct ActiveGuard(Arc<AtomicUsize>);

impl ActiveGuard {
    fn new(active: Arc<AtomicUsize>) -> Self {
        active.fetch_add(1, Ordering::Relaxed);
        Self(active)
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

enum BodyReadFailure {
    TooLarge,
    TooComplex,
    Capacity,
    Transport,
}

#[derive(Default)]
struct JsonComplexityScanner {
    in_string: bool,
    escaped: bool,
    structural_tokens: usize,
}

impl JsonComplexityScanner {
    fn scan(&mut self, chunk: &[u8]) -> Result<(), BodyReadFailure> {
        for byte in chunk {
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if *byte == b'\\' {
                    self.escaped = true;
                } else if *byte == b'"' {
                    self.in_string = false;
                }
                continue;
            }
            match *byte {
                b'"' => {
                    self.in_string = true;
                    self.structural_tokens = self.structural_tokens.saturating_add(1);
                }
                b'{' | b'[' | b',' | b':' => {
                    self.structural_tokens = self.structural_tokens.saturating_add(1);
                }
                _ => {}
            }
            if self.structural_tokens > MAX_JSON_STRUCTURAL_TOKENS {
                return Err(BodyReadFailure::TooComplex);
            }
        }
        Ok(())
    }
}

fn estimated_body_reservation_bytes(input_bytes: usize, structural_tokens: usize) -> usize {
    input_bytes
        .saturating_mul(BODY_MEMORY_CHARGE_FACTOR)
        .saturating_add(structural_tokens.saturating_mul(JSON_TOKEN_MEMORY_CHARGE_BYTES))
}

impl AppState {
    fn new(config: GatewayConfig) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        if !config.api_path.starts_with('/') {
            return Err("API_PATH must start with '/'".into());
        }
        if config.max_body_bytes > MAX_CONFIG_BODY_BYTES
            || config.body_budget_bytes > MAX_CONFIG_BODY_BUDGET_BYTES
            || config.max_inflight > MAX_CONFIG_INFLIGHT
            || config.client_keys.is_empty()
            || config.client_keys.len() > MAX_CONFIG_CLIENT_KEYS
            || config.model_aliases.len() > MAX_MODEL_ALIASES
            || config.model_aliases.iter().any(|(source, target)| {
                source.is_empty()
                    || target.is_empty()
                    || source.len() > MAX_MODEL_NAME_BYTES
                    || target.len() > MAX_MODEL_NAME_BYTES
            })
        {
            return Err("gateway configuration exceeds a fixed resource bound".into());
        }
        let mut client_ids = HashSet::with_capacity(config.client_keys.len());
        for (index, client_key) in config.client_keys.iter().enumerate() {
            let valid_id = !client_key.id.is_empty()
                && client_key.id.len() <= MAX_CLIENT_ID_BYTES
                && client_key
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
            if !valid_id || !client_ids.insert(client_key.id.as_str()) {
                return Err("client key ids must be unique non-secret identifiers".into());
            }
            if client_key.api_key.is_empty()
                || client_key.api_key.len() > MAX_CLIENT_KEY_BYTES
                || !client_key.api_key.is_ascii()
                || client_key
                    .api_key
                    .bytes()
                    .any(|byte| byte.is_ascii_control())
                || client_key.max_requests_per_minute == 0
                || client_key.max_requests_per_minute > MAX_CLIENT_REQUESTS_PER_MINUTE
            {
                return Err("client key credentials or per-key request limits are invalid".into());
            }
            if config.client_keys[..index]
                .iter()
                .any(|previous| previous.api_key == client_key.api_key)
            {
                return Err("client key credentials must be unique".into());
            }
        }
        if config.max_body_bytes == 0
            || config.body_budget_bytes < estimated_body_reservation_bytes(config.max_body_bytes, 0)
        {
            return Err("body budget must cover one maximum-sized encoded body reservation".into());
        }
        if config.max_inflight == 0 {
            return Err("in-flight limits must be positive".into());
        }

        let body_budget_units = config.body_budget_bytes.div_ceil(BODY_UNIT_BYTES);
        if body_budget_units > u32::MAX as usize {
            return Err("body budget exceeds the semaphore's supported permit range".into());
        }
        let upstream_authorization = config
            .upstream_api_key
            .filter(|key| !key.is_empty())
            .map(|key| HeaderValue::from_str(&format!("Bearer {key}")))
            .transpose()?;
        let client_keys = config
            .client_keys
            .into_iter()
            .map(|client_key| ClientKey {
                id: client_key.id,
                secret: Arc::from(client_key.api_key.into_bytes()),
                max_requests_per_minute: client_key.max_requests_per_minute,
                revoked: client_key.revoked,
            })
            .collect::<Vec<_>>();

        Ok(Self {
            client: Client::builder()
                .pool_max_idle_per_host(config.max_inflight)
                .build()?,
            upstream: config.upstream.trim_end_matches('/').to_owned(),
            api_path: config.api_path,
            upstream_authorization,
            max_body_bytes: config.max_body_bytes,
            max_body_budget_units: body_budget_units,
            max_inflight: config.max_inflight,
            client_keys: Arc::new(client_keys),
            model_aliases: Arc::new(config.model_aliases),
            inflight: Arc::new(Semaphore::new(config.max_inflight)),
            body_budget: Arc::new(Semaphore::new(body_budget_units)),
            active: Arc::new(AtomicUsize::new(0)),
            accepted: Arc::new(AtomicU64::new(0)),
            completed: Arc::new(AtomicU64::new(0)),
            rejected: Arc::new(AtomicU64::new(0)),
            input_bytes: Arc::new(AtomicU64::new(0)),
            output_bytes: Arc::new(AtomicU64::new(0)),
            rate_windows: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn authenticate_client(&self, token: &[u8]) -> Option<AuthenticatedClient> {
        let mut selected_index = 0usize;
        let mut match_count = 0usize;
        for (index, client_key) in self.client_keys.iter().enumerate() {
            let matched = usize::from(constant_time_eq(client_key.secret.as_ref(), token));
            selected_index = selected_index * (1 - matched) + index * matched;
            match_count += matched;
        }
        if match_count != 1 {
            return None;
        }

        let client_key = &self.client_keys[selected_index];
        if client_key.revoked {
            return None;
        }
        Some(AuthenticatedClient {
            id: client_key.id.clone(),
            max_requests_per_minute: client_key.max_requests_per_minute,
        })
    }

    fn rate_limit_retry_after(&self, client_id: &str, max_requests_per_minute: u64) -> Option<u64> {
        let now = Instant::now();
        let mut windows = self
            .rate_windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let window = windows
            .entry(client_id.to_owned())
            .or_insert_with(|| RateWindow {
                started: now,
                requests: 0,
            });
        if now.duration_since(window.started) >= RATE_WINDOW {
            window.started = now;
            window.requests = 0;
        }
        if window.requests >= max_requests_per_minute {
            let elapsed = now.duration_since(window.started).as_secs();
            Some(60u64.saturating_sub(elapsed).max(1))
        } else {
            window.requests += 1;
            None
        }
    }
}

fn client_token(headers: &HeaderMap) -> Option<&[u8]> {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some((scheme, token)) = value.split_once(' ')
            && scheme.eq_ignore_ascii_case("bearer")
            && !token.is_empty()
        {
            return Some(token.as_bytes());
        }
    }
    headers.get("x-api-key").map(HeaderValue::as_bytes)
}

/// Constant-time over the longer input. Header length is bounded by HTTP parsing limits.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut difference = left.len() ^ right.len();
    for index in 0..max_len {
        difference |= usize::from(*left.get(index).unwrap_or(&0) ^ *right.get(index).unwrap_or(&0));
    }
    difference == 0
}

fn error_response(status: StatusCode, message: &str, retry_after: Option<u64>) -> Response {
    let mut response = (
        status,
        axum::Json(serde_json::json!({
            "error": { "message": message, "type": "gateway_error" }
        })),
    )
        .into_response();
    if let Some(seconds) = retry_after
        && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
    {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
}

fn content_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
}

async fn read_bounded_body(
    body: Body,
    state: &AppState,
    declared_length: Option<usize>,
) -> Result<(Bytes, Vec<OwnedSemaphorePermit>), BodyReadFailure> {
    let initial_reservation = declared_length.unwrap_or(1).max(1);
    let initial_charge = estimated_body_reservation_bytes(initial_reservation, 0);
    let initial_units = initial_charge.div_ceil(BODY_UNIT_BYTES);
    if initial_units > state.max_body_budget_units {
        return Err(BodyReadFailure::Capacity);
    }
    let initial_permit = state
        .body_budget
        .clone()
        .try_acquire_many_owned(initial_units as u32)
        .map_err(|_| BodyReadFailure::Capacity)?;
    let mut reservations = vec![initial_permit];
    let mut reserved_units = initial_units;
    let mut buffered = BytesMut::with_capacity(initial_reservation.min(state.max_body_bytes));
    let mut stream = body.into_data_stream();
    let mut complexity = JsonComplexityScanner::default();

    while let Some(next) = stream.next().await {
        let chunk = next.map_err(|_| BodyReadFailure::Transport)?;
        let total = buffered.len().saturating_add(chunk.len());
        if total > state.max_body_bytes {
            return Err(BodyReadFailure::TooLarge);
        }
        complexity.scan(&chunk)?;
        let needed_charge =
            estimated_body_reservation_bytes(total.max(1), complexity.structural_tokens);
        let needed_units = needed_charge.div_ceil(BODY_UNIT_BYTES);
        if needed_units > reserved_units {
            let extra_units = needed_units - reserved_units;
            let permit = state
                .body_budget
                .clone()
                .try_acquire_many_owned(extra_units as u32)
                .map_err(|_| BodyReadFailure::Capacity)?;
            reservations.push(permit);
            reserved_units = needed_units;
        }
        buffered.extend_from_slice(&chunk);
    }

    Ok((buffered.freeze(), reservations))
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let available_body = state.body_budget.available_permits() * BODY_UNIT_BYTES;
    axum::Json(serde_json::json!({
        "ok": true,
        "active": state.active.load(Ordering::Relaxed),
        "limit": state.max_inflight,
        "maxInflight": state.max_inflight,
        "bodyBudgetBytesAvailable": available_body,
        "requestsAccepted": state.accepted.load(Ordering::Relaxed),
        "requestsCompleted": state.completed.load(Ordering::Relaxed),
        "requestsRejected": state.rejected.load(Ordering::Relaxed),
        "requestBytes": state.input_bytes.load(Ordering::Relaxed),
        "responseBytes": state.output_bytes.load(Ordering::Relaxed),
    }))
}

async fn chat(State(state): State<AppState>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let Some(client_token) = client_token(&parts.headers) else {
        state.rejected.fetch_add(1, Ordering::Relaxed);
        return error_response(StatusCode::UNAUTHORIZED, "valid API key required", None);
    };
    let Some(client) = state.authenticate_client(client_token) else {
        state.rejected.fetch_add(1, Ordering::Relaxed);
        return error_response(StatusCode::UNAUTHORIZED, "valid API key required", None);
    };

    if let Some(retry_after) =
        state.rate_limit_retry_after(&client.id, client.max_requests_per_minute)
    {
        state.rejected.fetch_add(1, Ordering::Relaxed);
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "per-key request rate limit reached",
            Some(retry_after),
        );
    }

    if !is_json_content_type(&parts.headers) {
        state.rejected.fetch_add(1, Ordering::Relaxed);
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "application/json required",
            None,
        );
    }

    let length = content_length(&parts.headers);
    if length.is_some_and(|value| value > state.max_body_bytes) {
        state.rejected.fetch_add(1, Ordering::Relaxed);
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body exceeds configured limit",
            None,
        );
    }

    let inflight = match state.inflight.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            state.rejected.fetch_add(1, Ordering::Relaxed);
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway capacity reached",
                Some(1),
            );
        }
    };

    let (body, body_reservations) = match read_bounded_body(body, &state, length).await {
        Ok(body) => body,
        Err(BodyReadFailure::TooLarge) => {
            state.rejected.fetch_add(1, Ordering::Relaxed);
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body exceeds configured limit",
                None,
            );
        }
        Err(BodyReadFailure::Capacity) => {
            state.rejected.fetch_add(1, Ordering::Relaxed);
            return error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "gateway request-body budget reached",
                Some(1),
            );
        }
        Err(BodyReadFailure::TooComplex) => {
            state.rejected.fetch_add(1, Ordering::Relaxed);
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request JSON structure exceeds configured complexity limit",
                None,
            );
        }
        Err(BodyReadFailure::Transport) => {
            state.rejected.fetch_add(1, Ordering::Relaxed);
            return error_response(
                StatusCode::BAD_REQUEST,
                "request body could not be read",
                None,
            );
        }
    };

    let mut payload: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            state.rejected.fetch_add(1, Ordering::Relaxed);
            return error_response(StatusCode::BAD_REQUEST, "invalid JSON request body", None);
        }
    };
    let Some(requested_model) = payload.get("model").and_then(serde_json::Value::as_str) else {
        state.rejected.fetch_add(1, Ordering::Relaxed);
        return error_response(StatusCode::BAD_REQUEST, "model must be a string", None);
    };
    if !payload
        .get("messages")
        .is_some_and(serde_json::Value::is_array)
    {
        state.rejected.fetch_add(1, Ordering::Relaxed);
        return error_response(StatusCode::BAD_REQUEST, "messages must be an array", None);
    }
    if let Some(target_model) = state.model_aliases.get(requested_model) {
        payload["model"] = serde_json::Value::String(target_model.clone());
    }
    let outbound_body = match serde_json::to_vec(&payload) {
        Ok(value) if value.len() <= state.max_body_bytes => Bytes::from(value),
        Ok(_) => {
            state.rejected.fetch_add(1, Ordering::Relaxed);
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "normalized request body exceeds configured limit",
                None,
            );
        }
        Err(_) => {
            state.rejected.fetch_add(1, Ordering::Relaxed);
            return error_response(
                StatusCode::BAD_REQUEST,
                "request body could not be normalized",
                None,
            );
        }
    };
    let request_body_bytes = body.len();
    // The decoded/encoded request copies are all that the body-budget lease protects. Keep the
    // lease through upstream request transmission, then release it before holding a potentially
    // long-lived SSE response open. The independent inflight permit remains owned by the response
    // stream until EOF or client cancellation.
    drop(payload);
    drop(body);

    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or(&state.api_path);
    let upstream_url = format!("{}{}", state.upstream, path_and_query);
    let mut upstream_headers = reqwest::header::HeaderMap::new();
    copy_request_header(
        &parts.headers,
        &mut upstream_headers,
        header::CONTENT_TYPE.as_str(),
    );
    copy_request_header(
        &parts.headers,
        &mut upstream_headers,
        header::ACCEPT.as_str(),
    );
    copy_request_header(&parts.headers, &mut upstream_headers, "x-request-id");
    if let Some(value) = &state.upstream_authorization {
        upstream_headers.insert(reqwest::header::AUTHORIZATION, value.clone());
    }

    let active = ActiveGuard::new(state.active.clone());
    state.accepted.fetch_add(1, Ordering::Relaxed);
    state
        .input_bytes
        .fetch_add(request_body_bytes as u64, Ordering::Relaxed);
    let upstream_result = state
        .client
        .post(upstream_url)
        .headers(upstream_headers)
        .body(outbound_body)
        .send()
        .await;
    drop(body_reservations);
    let upstream = match upstream_result {
        Ok(response) => response,
        Err(_) => {
            return error_response(StatusCode::BAD_GATEWAY, "upstream connection failed", None);
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response_headers = HeaderMap::new();
    for name in [
        "content-type",
        "cache-control",
        "x-request-id",
        "retry-after",
    ] {
        if let Some(value) = upstream.headers().get(name) {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) {
                response_headers.insert(name, value);
            }
        }
    }

    let output_bytes = state.output_bytes.clone();
    let completed = state.completed.clone();
    let response_stream: Pin<Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send>> =
        Box::pin(async_stream::try_stream! {
            let _inflight = inflight;
            let _active = active;
            let mut stream = upstream.bytes_stream();
            while let Some(next) = stream.next().await {
                let chunk = next.map_err(|error| io::Error::other(error.to_string()))?;
                output_bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                yield chunk;
            }
            completed.fetch_add(1, Ordering::Relaxed);
        });
    let mut builder = Response::builder().status(status);
    if let Some(headers) = builder.headers_mut() {
        *headers = response_headers;
    }
    builder
        .body(Body::from_stream(response_stream))
        .unwrap_or_else(|_| {
            error_response(StatusCode::BAD_GATEWAY, "invalid upstream response", None)
        })
}

fn copy_request_header(source: &HeaderMap, target: &mut reqwest::header::HeaderMap, name: &str) {
    if let Some(value) = source.get(name) {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            target.insert(name, value);
        }
    }
}

fn build_app(state: AppState) -> Router {
    let api_path = state.api_path.clone();
    Router::new()
        .route("/health", get(health))
        .route(&api_path, post(chat))
        .with_state(state)
}

fn read_usize(
    name: &str,
    default: usize,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    match env::var(name) {
        Ok(value) => Ok(value.parse::<usize>()?),
        Err(_) => Ok(default),
    }
}

fn parse_client_keys_json(raw: &str) -> Result<Vec<ClientKeyConfig>, io::Error> {
    if raw.len() > MAX_CONFIG_CLIENT_KEYS_JSON_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "CLIENT_KEYS_JSON exceeds the configuration byte limit",
        ));
    }

    let value = serde_json::from_str::<serde_json::Value>(raw).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "CLIENT_KEYS_JSON must be a JSON array of client-key entries",
        )
    })?;
    let entries = value.as_array().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "CLIENT_KEYS_JSON must be a JSON array of client-key entries",
        )
    })?;
    if entries.is_empty() || entries.len() > MAX_CONFIG_CLIENT_KEYS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "CLIENT_KEYS_JSON must contain between 1 and 256 entries",
        ));
    }

    let mut client_keys = Vec::with_capacity(entries.len());
    for entry in entries {
        let object = entry.as_object().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "each CLIENT_KEYS_JSON entry must be an object",
            )
        })?;
        if object
            .keys()
            .any(|key| !["id", "apiKey", "maxRequestsPerMinute", "revoked"].contains(&key.as_str()))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "CLIENT_KEYS_JSON entries contain an unsupported field",
            ));
        }

        let required_string = |field: &str| {
            object
                .get(field)
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "each client key requires string id and apiKey fields",
                    )
                })
        };
        let id = required_string("id")?;
        let api_key = required_string("apiKey")?;
        let max_requests_per_minute = object
            .get("maxRequestsPerMinute")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "each client key requires an unsigned maxRequestsPerMinute value",
                )
            })?;
        let revoked = match object.get("revoked") {
            None => false,
            Some(serde_json::Value::Bool(value)) => *value,
            Some(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "client key revoked must be a boolean",
                ));
            }
        };

        client_keys.push(ClientKeyConfig {
            id,
            api_key,
            max_requests_per_minute,
            revoked,
        });
    }

    Ok(client_keys)
}

fn configuration_from_env() -> Result<(u16, GatewayConfig), Box<dyn std::error::Error + Send + Sync>>
{
    let port = env::var("PORT")
        .unwrap_or_else(|_| "3901".into())
        .parse::<u16>()?;
    let client_keys = match env::var("CLIENT_KEYS_JSON") {
        Ok(raw) => parse_client_keys_json(&raw)?,
        Err(_) => {
            let api_key = env::var("CLIENT_API_KEY").map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "CLIENT_KEYS_JSON or CLIENT_API_KEY must be set",
                )
            })?;
            let max_requests_per_minute = env::var("MAX_REQUESTS_PER_MINUTE")
                .unwrap_or_else(|_| "10000".into())
                .parse::<u64>()?;
            vec![ClientKeyConfig {
                id: env::var("CLIENT_KEY_ID").unwrap_or_else(|_| "default".into()),
                api_key,
                max_requests_per_minute,
                revoked: false,
            }]
        }
    };
    let model_aliases = match env::var("MODEL_ALIASES_JSON") {
        Ok(raw) => serde_json::from_str::<HashMap<String, String>>(&raw)?,
        Err(_) => HashMap::new(),
    };
    Ok((
        port,
        GatewayConfig {
            upstream: env::var("UPSTREAM_URL").unwrap_or_else(|_| "http://127.0.0.1:3900".into()),
            api_path: env::var("API_PATH").unwrap_or_else(|_| "/v1/chat/completions".into()),
            client_keys,
            upstream_api_key: env::var("UPSTREAM_API_KEY").ok(),
            max_body_bytes: read_usize("MAX_BODY_BYTES", 4 * 1024 * 1024)?,
            body_budget_bytes: read_usize("BODY_BUDGET_BYTES", 512 * 1024 * 1024)?,
            max_inflight: read_usize("MAX_INFLIGHT", 128)?,
            model_aliases,
        },
    ))
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let (port, config) = configuration_from_env().map_err(io::Error::other)?;
    let state = AppState::new(config).map_err(io::Error::other)?;
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    axum::serve(listener, build_app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use tokio::sync::mpsc;

    struct ForwardedRequest {
        authorization: Option<String>,
        payload: serde_json::Value,
    }

    async fn spawn_upstream(
        status: StatusCode,
    ) -> (
        String,
        mpsc::Receiver<ForwardedRequest>,
        tokio::task::JoinHandle<()>,
    ) {
        let (sender, receiver) = mpsc::channel(8);
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |request: Request| {
                let sender = sender.clone();
                async move {
                    let (parts, body) = request.into_parts();
                    let bytes = to_bytes(body, 8 * 1024 * 1024).await.unwrap();
                    let payload = serde_json::from_slice(&bytes).unwrap();
                    let authorization = parts
                        .headers
                        .get(header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned);
                    sender
                        .send(ForwardedRequest {
                            authorization,
                            payload,
                        })
                        .await
                        .unwrap();
                    let mut response = Response::new(Body::from("data: [DONE]\n\n"));
                    *response.status_mut() = status;
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/event-stream"),
                    );
                    response
                }
            }),
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), receiver, task)
    }

    async fn spawn_streaming_upstream() -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/v1/chat/completions",
            post(|| async {
                let stream = async_stream::stream! {
                    yield Ok::<Bytes, io::Error>(Bytes::from_static(b"data: {\"choices\":[]}\n\n"));
                    loop {
                        tokio::time::sleep(Duration::from_millis(25)).await;
                        yield Ok::<Bytes, io::Error>(Bytes::from_static(b"data: {\"choices\":[]}\n\n"));
                    }
                };
                let mut response = Response::new(Body::from_stream(stream));
                *response.status_mut() = StatusCode::OK;
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/event-stream"),
                );
                response
            }),
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), task)
    }

    fn state(upstream: String, rpm: u64, max_body_bytes: usize) -> AppState {
        AppState::new(GatewayConfig {
            upstream,
            api_path: "/v1/chat/completions".into(),
            client_keys: vec![ClientKeyConfig {
                id: "default".into(),
                api_key: "client-secret".into(),
                max_requests_per_minute: rpm,
                revoked: false,
            }],
            upstream_api_key: Some("provider-secret".into()),
            max_body_bytes,
            body_budget_bytes: (max_body_bytes * BODY_MEMORY_CHARGE_FACTOR
                + MAX_JSON_STRUCTURAL_TOKENS * JSON_TOKEN_MEMORY_CHARGE_BYTES)
                .max(64 * 1024),
            max_inflight: 8,
            model_aliases: HashMap::from([("cx/gpt-5.6".into(), "gpt-5.6".into())]),
        })
        .unwrap()
    }

    fn chat_body() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "model": "cx/gpt-5.6",
            "stream": true,
            "messages": [
                {"role": "assistant", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "inspect", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": "call-1", "content": "result"},
                {"role": "user", "content": "continue"}
            ]
        }))
        .unwrap()
    }

    async fn send_chat(port: u16, token: Option<&str>, body: Vec<u8>) -> reqwest::Response {
        let client = Client::new();
        let mut request = client
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(body);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        request.send().await.unwrap()
    }

    async fn spawn_gateway(state: AppState) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = build_app(state);
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (port, task)
    }

    #[tokio::test]
    async fn requires_client_key_and_never_forwards_client_credentials() {
        let (upstream, mut forwarded, upstream_task) = spawn_upstream(StatusCode::OK).await;
        let (port, gateway_task) = spawn_gateway(state(upstream, 100, 1024 * 1024)).await;

        let unauthorized = send_chat(port, None, chat_body()).await;
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert!(matches!(
            forwarded.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        let accepted = send_chat(port, Some("client-secret"), chat_body()).await;
        assert_eq!(accepted.status(), StatusCode::OK);
        assert!(accepted.text().await.unwrap().contains("[DONE]"));
        let upstream_request = forwarded.recv().await.unwrap();
        assert_eq!(
            upstream_request.authorization.as_deref(),
            Some("Bearer provider-secret")
        );
        assert_eq!(upstream_request.payload["model"], "gpt-5.6");
        assert_eq!(
            upstream_request.payload["messages"][0]["tool_calls"][0]["id"],
            "call-1"
        );

        gateway_task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn enforces_body_cap_before_forwarding() {
        let (upstream, mut forwarded, upstream_task) = spawn_upstream(StatusCode::OK).await;
        let (port, gateway_task) = spawn_gateway(state(upstream, 100, 128)).await;
        let response = send_chat(port, Some("client-secret"), chat_body()).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(matches!(
            forwarded.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        gateway_task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn rejects_high_node_count_json_before_deserialization() {
        let (upstream, mut forwarded, upstream_task) = spawn_upstream(StatusCode::OK).await;
        let (port, gateway_task) = spawn_gateway(state(upstream, 100, 1024 * 1024)).await;
        let mut body = String::from(r#"{"model":"m","messages":["#);
        for index in 0..=MAX_JSON_STRUCTURAL_TOKENS {
            if index > 0 {
                body.push(',');
            }
            body.push_str("null");
        }
        body.push_str("]}");

        let response = send_chat(port, Some("client-secret"), body.into_bytes()).await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(matches!(
            forwarded.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        gateway_task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn rate_limit_returns_retry_after_without_calling_upstream_twice() {
        let (upstream, mut forwarded, upstream_task) = spawn_upstream(StatusCode::OK).await;
        let (port, gateway_task) = spawn_gateway(state(upstream, 1, 1024 * 1024)).await;

        let first = send_chat(port, Some("client-secret"), chat_body()).await;
        assert_eq!(first.status(), StatusCode::OK);
        let _ = first.text().await.unwrap();
        let _ = forwarded.recv().await.unwrap();

        let second = send_chat(port, Some("client-secret"), chat_body()).await;
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(second.headers().get(header::RETRY_AFTER).is_some());
        assert!(matches!(
            forwarded.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        gateway_task.abort();
        upstream_task.abort();
    }

    #[tokio::test]
    async fn rate_budgets_and_revocation_are_isolated_by_client_id() {
        let (upstream, mut forwarded, upstream_task) = spawn_upstream(StatusCode::OK).await;
        let max_body_bytes = 1024 * 1024;
        let state = AppState::new(GatewayConfig {
            upstream,
            api_path: "/v1/chat/completions".into(),
            client_keys: vec![
                ClientKeyConfig {
                    id: "agent-a".into(),
                    api_key: "secret-a".into(),
                    max_requests_per_minute: 1,
                    revoked: false,
                },
                ClientKeyConfig {
                    id: "agent-b".into(),
                    api_key: "secret-b".into(),
                    max_requests_per_minute: 2,
                    revoked: false,
                },
                ClientKeyConfig {
                    id: "revoked-agent".into(),
                    api_key: "secret-revoked".into(),
                    max_requests_per_minute: 100,
                    revoked: true,
                },
            ],
            upstream_api_key: Some("provider-secret".into()),
            max_body_bytes,
            body_budget_bytes: max_body_bytes * BODY_MEMORY_CHARGE_FACTOR
                + MAX_JSON_STRUCTURAL_TOKENS * JSON_TOKEN_MEMORY_CHARGE_BYTES,
            max_inflight: 8,
            model_aliases: HashMap::new(),
        })
        .unwrap();
        let (port, gateway_task) = spawn_gateway(state).await;

        let revoked = send_chat(port, Some("secret-revoked"), chat_body()).await;
        assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
        assert!(matches!(
            forwarded.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        let first_a = send_chat(port, Some("secret-a"), chat_body()).await;
        assert_eq!(first_a.status(), StatusCode::OK);
        assert!(first_a.text().await.unwrap().contains("[DONE]"));
        assert_eq!(
            forwarded.recv().await.unwrap().authorization.as_deref(),
            Some("Bearer provider-secret")
        );

        let exhausted_a = send_chat(port, Some("secret-a"), chat_body()).await;
        assert_eq!(exhausted_a.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(exhausted_a.headers().get(header::RETRY_AFTER).is_some());

        // Agent A's exhausted window and the separately revoked identity do not consume B's quota.
        for _ in 0..2 {
            let accepted_b = send_chat(port, Some("secret-b"), chat_body()).await;
            assert_eq!(accepted_b.status(), StatusCode::OK);
            assert!(accepted_b.text().await.unwrap().contains("[DONE]"));
            assert_eq!(
                forwarded.recv().await.unwrap().authorization.as_deref(),
                Some("Bearer provider-secret")
            );
        }

        let exhausted_b = send_chat(port, Some("secret-b"), chat_body()).await;
        assert_eq!(exhausted_b.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(exhausted_b.headers().get(header::RETRY_AFTER).is_some());
        assert!(matches!(
            forwarded.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        gateway_task.abort();
        upstream_task.abort();
    }

    #[test]
    fn parses_client_key_id_limit_and_revocation_configuration() {
        let keys = parse_client_keys_json(
            r#"[
                {"id":"agent-a","apiKey":"synthetic-secret-a","maxRequestsPerMinute":3},
                {"id":"agent-b","apiKey":"synthetic-secret-b","maxRequestsPerMinute":7,"revoked":true}
            ]"#,
        )
        .unwrap();

        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].id, "agent-a");
        assert_eq!(keys[0].max_requests_per_minute, 3);
        assert!(!keys[0].revoked);
        assert_eq!(keys[1].id, "agent-b");
        assert_eq!(keys[1].max_requests_per_minute, 7);
        assert!(keys[1].revoked);
    }

    #[test]
    fn rejects_duplicate_client_identity_ids() {
        let config = GatewayConfig {
            upstream: "http://127.0.0.1:3900".into(),
            api_path: "/v1/chat/completions".into(),
            client_keys: vec![
                ClientKeyConfig {
                    id: "agent-a".into(),
                    api_key: "secret-a".into(),
                    max_requests_per_minute: 5,
                    revoked: false,
                },
                ClientKeyConfig {
                    id: "agent-a".into(),
                    api_key: "secret-b".into(),
                    max_requests_per_minute: 5,
                    revoked: false,
                },
            ],
            upstream_api_key: None,
            max_body_bytes: 1024 * 1024,
            body_budget_bytes: 8 * 1024 * 1024,
            max_inflight: 8,
            model_aliases: HashMap::new(),
        };

        assert!(AppState::new(config).is_err());
    }

    #[tokio::test]
    async fn body_admission_releases_after_upstream_send_while_stream_admission_stays_held() {
        let (upstream, upstream_task) = spawn_streaming_upstream().await;
        let state = state(upstream, 100, 1024 * 1024);
        let active = state.active.clone();
        let budget = state.body_budget.clone();
        let body_budget_permits = budget.available_permits();
        let (port, gateway_task) = spawn_gateway(state).await;
        let client = Client::new();
        let mut response = client
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, "Bearer client-secret")
            .body(chat_body())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let _ = response.chunk().await.unwrap();
        assert_eq!(active.load(Ordering::Relaxed), 1);
        assert_eq!(budget.available_permits(), body_budget_permits);

        drop(response);
        for _ in 0..50 {
            if active.load(Ordering::Relaxed) == 0
                && budget.available_permits() == body_budget_permits
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(active.load(Ordering::Relaxed), 0);
        assert_eq!(budget.available_permits(), body_budget_permits);

        gateway_task.abort();
        upstream_task.abort();
    }
}
