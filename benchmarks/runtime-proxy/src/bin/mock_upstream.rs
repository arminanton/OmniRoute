use std::{
    env, io,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use bytes::Bytes;
use futures_util::StreamExt;
use tokio::{net::TcpListener, time::sleep};

#[derive(Clone)]
struct MockState {
    chunks: usize,
    chunk_delay: Duration,
    chunk_data: String,
    chat_completions: bool,
    active: Arc<AtomicUsize>,
}

struct ActiveStream(Arc<AtomicUsize>);

impl ActiveStream {
    fn new(active: Arc<AtomicUsize>) -> Self {
        active.fetch_add(1, Ordering::Relaxed);
        Self(active)
    }
}

impl Drop for ActiveStream {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn health(State(state): State<MockState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "activeStreams": state.active.load(Ordering::Relaxed),
    }))
}

async fn models() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "object": "list",
        "data": [{
            "id": "gpt-4o-mini",
            "object": "model",
            "created": 0,
            "owned_by": "benchmark"
        }]
    }))
}

async fn stream_response(State(state): State<MockState>, request: Request) -> Response {
    // Mirror the Node mock: consume uploads asynchronously while sending response headers
    // immediately, so large request bodies don't make the mock itself dominate first-byte time.
    let mut request_body = request.into_body().into_data_stream();
    tokio::spawn(async move {
        while let Some(chunk) = request_body.next().await {
            if chunk.is_err() {
                break;
            }
        }
    });

    let active = state.active.clone();
    let chunk_data = state.chunk_data;
    let chunk_delay = state.chunk_delay;
    let chat_completions = state.chat_completions;
    let stream = async_stream::stream! {
        let _active = ActiveStream::new(active);
        for index in 0..state.chunks {
            let event = if chat_completions {
                let payload = serde_json::json!({
                    "id": "chatcmpl-bench",
                    "object": "chat.completion.chunk",
                    "created": 0,
                    "model": "gpt-4o-mini",
                    "choices": [{
                        "index": 0,
                        "delta": { "content": chunk_data },
                        "finish_reason": null
                    }]
                });
                format!("data: {payload}\n\n")
            } else {
                format!(
                    "data: {{\"type\":\"response.output_text.delta\",\"index\":{index},\"delta\":\"{chunk_data}\"}}\n\n"
                )
            };
            yield Ok::<Bytes, io::Error>(Bytes::from(event));
            if !chunk_delay.is_zero() {
                sleep(chunk_delay).await;
            }
        }
        if chat_completions {
            let payload = serde_json::json!({
                "id": "chatcmpl-bench",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "gpt-4o-mini",
                "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
            });
            yield Ok::<Bytes, io::Error>(Bytes::from(format!("data: {payload}\n\n")));
        }
        yield Ok::<Bytes, io::Error>(Bytes::from_static(b"data: [DONE]\n\n"));
    };

    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    response
}

fn env_usize(name: &str, default: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3900);
    let chunks = env_usize("CHUNKS", 50);
    let chunk_delay_ms = env_usize("CHUNK_DELAY_MS", 10);
    let chunk_bytes = env_usize("CHUNK_BYTES", 128);
    let api_path = env::var("API_PATH").unwrap_or_else(|_| "/v1/responses".into());
    let state = MockState {
        chunks,
        chunk_delay: Duration::from_millis(chunk_delay_ms as u64),
        chunk_data: "x".repeat(chunk_bytes),
        chat_completions: api_path == "/v1/chat/completions",
        active: Arc::new(AtomicUsize::new(0)),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route(&api_path, post(stream_response))
        .with_state(state);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(io::Error::other)
}
