"""Render constrained ingress config; installation/reload belongs to reviewed host adapter."""
from .controller import Refused, validate_generation


def nginx_config(generation, listeners, *, trusted_proto="https"):
    validate_generation(generation)
    if trusted_proto not in ("http", "https"):
        raise Refused("invalid trusted ingress protocol")
    if not isinstance(listeners, dict) or set(listeners) != {"dashboard", "api"}:
        raise Refused("exact dashboard/API listeners required")
    if any(type(port) is not int or not 1024 <= port <= 65535 for port in listeners.values()):
        raise Refused("invalid listener")
    if len(set(listeners.values())) != 2:
        raise Refused("listeners must be distinct")
    config = """# Generated candidate; validate with reviewed nginx -t before reload.
# No worker_shutdown_timeout: old healthy SSE/WS must not be killed on a deadline.
pid /run/omni-local-next/canary/nginx.pid;
worker_processes auto;
events { worker_connections 4096; }
http {
  # Never log URL/query, Authorization, bodies or caller-provided request identifiers.
  log_format admission '$status $request_time $upstream_status';
  access_log /dev/stdout admission;
  # Avoid raw NGINX diagnostics containing credential-bearing request URIs.
  # Controller records redacted status/category and nginx -t exit instead.
  error_log /dev/null crit;
  map $http_upgrade $upgrade_connection { default upgrade; '' ''; }
  client_max_body_size 64m;
  client_body_timeout 3600s;
  send_timeout 3600s;
"""
    for name, upstream_port in (("dashboard", 20128), ("api", 20129)):
        config += f"""  server {{
    listen {listeners[name]};
    # Admission proof is read privately by host adapter, never a public backend selector.
    location = /_omni_generation {{
      allow 127.0.0.1;
      deny all;
      default_type text/plain;
      return 200 '{generation['generation']}';
    }}
    location / {{
      proxy_pass http://{generation['address']}:{upstream_port};
      proxy_http_version 1.1;
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_cache off;
      proxy_next_upstream off;
      proxy_connect_timeout 10s;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $upgrade_connection;
      proxy_set_header Host $http_host;
      # Upstream host/proto trust must be verified in frontdoor proof.
      # These config listeners are only reachable through reviewed ingress policy.
      proxy_set_header X-Forwarded-Proto {trusted_proto};
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Omni-Generation '';
      proxy_set_header X-Omni-Canary '';
      proxy_set_header X-Omni-Internal-Authorization '';
      proxy_set_header X-Omniroute-Route-Class '';
      proxy_set_header X-Omniroute-Auth-Kind '';
      proxy_set_header X-Omniroute-Auth-Id '';
      proxy_set_header X-Omniroute-Auth-Label '';
      proxy_set_header X-Omniroute-Auth-Scopes '';
      proxy_set_header X-Omniroute-Cli-Token '';
      proxy_set_header X-Omniroute-Peer-Ip '';
      proxy_set_header X-Omniroute-Via-Proxy '';
      proxy_set_header X-Omniroute-Peer-Locality '';
      proxy_set_header X-Omniroute-Trusted-Peer-Ip '';
    }}
  }}
"""
    return config + "}\n"
