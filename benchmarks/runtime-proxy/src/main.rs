use std::{
    env,
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest::Client;
use tokio::{net::TcpListener, sync::Semaphore};

#[derive(Clone)]
struct AppState {
    client: Client,
    upstream: String,
    max_body_bytes: usize,
    semaphore: Arc<Semaphore>,
    active: Arc<AtomicUsize>,
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

fn error_response(status: StatusCode, message: &'static str) -> Response {
    let body = serde_json::json!({
        "error": { "message": message, "type": "proxy_error" }
    });
    (status, axum::Json(body)).into_response()
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "ok": true,
        "active": state.active.load(Ordering::Relaxed),
        "limit": state.semaphore.available_permits() + state.active.load(Ordering::Relaxed),
    }))
}

fn copy_header(source: &HeaderMap, target: &mut reqwest::header::HeaderMap, name: &str) {
    if let Some(value) = source.get(name) {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            target.insert(name, value);
        }
    }
}

async fn proxy(State(state): State<AppState>, request: Request) -> Response {
    let permit = match state.semaphore.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return error_response(StatusCode::SERVICE_UNAVAILABLE, "proxy capacity reached"),
    };

    if request
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > state.max_body_bytes)
    {
        return error_response(StatusCode::PAYLOAD_TOO_LARGE, "request body exceeds benchmark limit");
    }

    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let url = format!("{}{}", state.upstream, path_and_query);
    let mut headers = reqwest::header::HeaderMap::new();
    copy_header(request.headers(), &mut headers, "content-type");
    copy_header(request.headers(), &mut headers, "x-request-id");

    let body_stream = request.into_body().into_data_stream();
    let max_body_bytes = state.max_body_bytes;
    let bounded_body: Pin<Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send>> =
        Box::pin(async_stream::try_stream! {
        let mut total = 0usize;
        let mut stream = body_stream;
        while let Some(next) = stream.next().await {
            let chunk = next.map_err(|error| io::Error::other(error.to_string()))?;
            total = total.saturating_add(chunk.len());
            if total > max_body_bytes {
                Err(io::Error::new(io::ErrorKind::InvalidData, "request body exceeds benchmark limit"))?;
            }
            yield chunk;
        }
    });

    let active = ActiveGuard::new(state.active.clone());
    let upstream = match state
        .client
        .post(url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(bounded_body))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return error_response(StatusCode::BAD_GATEWAY, "mock upstream unavailable"),
    };

    let status = StatusCode::from_u16(upstream.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response_headers = HeaderMap::new();
    for name in ["content-type", "cache-control", "x-request-id"] {
        if let Some(value) = upstream.headers().get(name) {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) {
                response_headers.insert(name, value);
            }
        }
    }

    let response_stream = upstream.bytes_stream();
    let body = Body::from_stream(async_stream::try_stream! {
        let _permit = permit;
        let _active = active;
        let mut stream = response_stream;
        while let Some(next) = stream.next().await {
            let chunk = next.map_err(|error| io::Error::other(error.to_string()))?;
            yield chunk;
        }
    });
    let mut builder = Response::builder().status(status);
    if let Some(headers) = builder.headers_mut() {
        *headers = response_headers;
    }
    builder
        .body(body)
        .unwrap_or_else(|_| error_response(StatusCode::BAD_GATEWAY, "invalid upstream response"))
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let port = env::var("PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(3901);
    let max_inflight = env::var("MAX_INFLIGHT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(128);
    let max_body_bytes = env::var("MAX_BODY_BYTES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4 * 1024 * 1024);
    let upstream = env::var("UPSTREAM_URL").unwrap_or_else(|_| "http://127.0.0.1:3900".into());
    let client = Client::builder()
        .pool_max_idle_per_host(max_inflight)
        .build()
        .map_err(io::Error::other)?;
    let state = AppState {
        client,
        upstream,
        max_body_bytes,
        semaphore: Arc::new(Semaphore::new(max_inflight)),
        active: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/responses", post(proxy))
        .with_state(state);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(io::Error::other)
}
