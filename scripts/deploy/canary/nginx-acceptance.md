# Real NGINX reload acceptance — private fixture

Tested NGINX 1.24.0 Ubuntu arm64 package `1.24.0-2ubuntu7.18`, package SHA256
`55af9202a0e3b12239f579d589f9dea9d899240efc6d9808cbbd500f53980a3d`.
The package was downloaded/extracted only under the task's private audit path.
No operating-system installation, host service, Tailscale mapping, firewall,
production namespace or live container changed.

Run the opt-in fixture with a reviewed private binary:

```sh
OMNI_TEST_NGINX_BINARY=/absolute/private/path/nginx node --test tests/integration/nginx-canary-acceptance.test.mjs
```

The fixture renders the actual `proxy.py` configuration. Its explicit fixture-only
adaptations use private PID/temp/log paths, loopback backend addresses and listeners,
two workers and an additional TLS/H2 listener with a task-local self-signed CA.
Production addresses, root policy, state, auth and network attestations are not
simulated as successful production proof. Four mock app listeners use only
127.0.0.2/127.0.0.3 on internal fixture ports; no provider credentials are used.

## Verified behavior

- `nginx -t` accepts the rendered configuration. Invalid config prevalidation
  fails while the old selected backend continues serving.
- The same master PID survives HUP. Existing old-worker connections retain 100
  active SSE responses, a WebSocket and an in-progress streamed POST upload.
- All old SSEs finish with their original first/last frames. Authorized management
  WebSocket echo continues on old; unauthenticated upgrade remains HTTP 401.
  This proves proxy transport/auth-header preservation with the mock upstream,
  not the actual application's full management authorization policy.
- Fresh API/dashboard requests and reused HTTP/1 keepalive clients reach candidate
  after its admission ACK. The upload executes once against old and finishes.
- A backend that accepts a POST and then disconnects yields HTTP 502. NGINX does
  not dispatch that tool-bearing POST again; `proxy_next_upstream off` is effective.
- An active TLS/H2 stream completes on old. Old connection emits GOAWAY with
  code 0 and lastStreamID 1. Node's attempt to create a new POST stream on that
  session fails `ERR_HTTP2_GOAWAY_SESSION` before any backend dispatch. A fresh
  H2 connection reaches candidate. Established HTTP/2 connections are not moved
  across generations; clients must respect GOAWAY/open a new connection and must
  not blindly replay a possibly dispatched tool request.
- Failed un-fence of retained old keeps candidate selected. Once old's explicit
  un-fence ACK succeeds, a validated reload sends new admission back to old.

The acceptance diagnostic records counts, protocol outcome and master-PID stability;
it contains no credentials, raw headers, provider bodies or user prompts. Audit
logs/exit markers reside under `/home/ubuntu/_/omni/audit/ledger-nginx/`.

## Concrete defects fixed by this test

`access_log /dev/stdout` failed `nginx -t` with ENXIO when the installed adapter
captures stdout through a pipe. The renderer now disables
request access logging; probe/controller diagnostics supply bounded redacted
observations without creating an unbounded file. The defined format includes only
status/timing, never request URI/query, credentials or bodies. Fixed temp
paths also remove reliance on distribution-specific `/var/lib/nginx` defaults.
Reload checks the root master PID's UID, executable inode and fixed configuration
ownership, refusing PID 1, unrelated or stale/reused PIDs before signaling.

## Remaining production gate

This demonstrates actual NGINX worker/HTTP/SSE/WS/H2 behavior through local mock
backends. It does not prove application state handoff, account coordination,
maintenance ownership, long-lived conversation pin migration, actual built-app
management authorization, helper forwarding, namespace isolation or the one-time
Tailscale/systemd-socket front-door migration. Those gates and explicit deployment
approval remain necessary. NGINX reload is eventually acknowledged admission,
not a global instantaneous switch of every pre-existing socket.
