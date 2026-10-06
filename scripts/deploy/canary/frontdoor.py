"""Observe actual forwarded app responses, not a proxy's config marker.

The fixed status request deliberately lacks lease:exclusive and cannot mutate a
lease. A public catalog remains supported, but is not treated as auth evidence.
"""
import json
import re
import socket
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit, urlunsplit
from .controller import Refused
from .readiness import NoRedirect, catalog_valid

DASHBOARD_PATH = "/api/canary-readiness"
API_PATH = "/v1/models"
STATUS_PATH = "/v1/session-leases"


def _target(url, surface):
    target = urlsplit(url)
    if (target.scheme != "http" or target.hostname != "127.0.0.1" or
            target.username or target.password or target.fragment or not target.port):
        raise Refused("frontdoor probe requires a fixed loopback target")
    if surface == "dashboard":
        valid = target.path == DASHBOARD_PATH and not target.query
    else:
        valid = target.path == API_PATH and parse_qs(target.query, keep_blank_values=True) == {
            "prefix": ["alias"], "configuredOnly": ["true"]}
    if not valid:
        raise Refused("frontdoor probe route contract differs")
    return target


def _request(url, key, *, method="GET", body=None, timeout=3, max_bytes=4 * 1024 * 1024):
    headers = {"Cache-Control": "no-cache", "Accept": "application/json"}
    if key is not None:
        headers["Authorization"] = "Bearer " + key
    encoded = None
    if body is not None:
        encoded = json.dumps(body, separators=(",", ":")).encode()
        headers["Content-Type"] = "application/json"
    started = time.monotonic()
    try:
        request = urllib.request.Request(url, data=encoded, headers=headers, method=method)
        try:
            response = urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = bytearray()
            while True:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise Refused("frontdoor response deadline")
                fp = response.fp
                if fp is not None:
                    if not hasattr(fp, "raw"):
                        fp = getattr(fp, "fp", None)
                    if fp is None or not hasattr(fp, "raw"):
                        raise Refused("frontdoor socket deadline unavailable")
                    fp.raw._sock.settimeout(remaining)
                chunk = response.read1(min(65536, max_bytes + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > max_bytes:
                    raise Refused("frontdoor response size bound")
            value = json.loads(raw)
            return {"status": response.status, "generation": response.headers.get("X-Omni-App-Generation"),
                    "body": value}
    except Refused:
        raise
    except (OSError, socket.timeout, ValueError, UnicodeError, AttributeError):
        # Do not expose URL/key/body/exception strings in root collector diagnostics.
        raise Refused("frontdoor transport or response contract failed") from None


def _generation(response, expected):
    if response["generation"] != expected:
        raise Refused("actual forwarded app generation differs")


def _lease_code(response, status, code, generation):
    _generation(response, generation)
    body = response["body"]
    if (response["status"] != status or not isinstance(body, dict) or
            not isinstance(body.get("error"), dict) or body["error"].get("code") != code):
        raise Refused("protected API authentication/scope observation failed")


def observe_frontdoors(targets, key, expected_generation, *, timeout=3, requester=None):
    """Return the existing installed-adapter ACK shape only after actual proof.

    requester exists for a reviewed namespace executor; it has the same fixed
    request signature and must return real observations, never receipt flags.
    """
    if not isinstance(targets, dict) or set(targets) != {"dashboard", "api"}:
        raise Refused("both exact frontdoor targets required")
    if not isinstance(expected_generation, str) or not re.fullmatch(r"[a-f0-9]{32}", expected_generation):
        raise Refused("frontdoor generation identity invalid")
    if not isinstance(key, str) or not key.strip() or len(key) > 4096 or "\n" in key or "\r" in key:
        raise Refused("private frontdoor read key invalid")
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 30:
        raise Refused("frontdoor timeout bound invalid")
    parsed = {name: _target(url, name) for name, url in targets.items()}
    if parsed["dashboard"].port == parsed["api"].port:
        raise Refused("distinct frontdoor listeners required")
    request = requester or _request
    dashboard = request(targets["dashboard"], key, timeout=timeout)
    _generation(dashboard, expected_generation)
    body = dashboard["body"]
    if (dashboard["status"] != 200 or not isinstance(body, dict) or
            body.get("schema") != "omni-canary-readiness/v1" or
            body.get("generation") != expected_generation or body.get("ready") is not True):
        raise Refused("forwarded dashboard readiness contract failed")
    unauthenticated = request(targets["dashboard"], None, timeout=timeout)
    _generation(unauthenticated, expected_generation)
    if unauthenticated["status"] not in (401, 403):
        raise Refused("dashboard readiness authentication not enforced")
    api = request(targets["api"], key, timeout=timeout)
    _generation(api, expected_generation)
    if api["status"] != 200 or not isinstance(api["body"], dict) or api["body"].get("object") != "list" or not catalog_valid(api["body"]):
        raise Refused("forwarded API catalog contract failed")
    status_url = urlunsplit(parsed["api"]._replace(path=STATUS_PATH, query=""))
    status_body = {"action": "status", "generation": 1}
    for credential, status, code in ((None, 401, "LEASE_AUTHENTICATION_REQUIRED"),
            ("invalid-canary-read-key", 401, "LEASE_API_KEY_INVALID"),
            (key, 403, "LEASE_SCOPE_REQUIRED")):
        result = request(status_url, credential, method="POST", body=status_body, timeout=timeout, max_bytes=16384)
        _lease_code(result, status, code, expected_generation)
    return {"protocol": 1, "ok": True, "generation": expected_generation,
            "apiGeneration": api["generation"], "dashboardGeneration": body["generation"]}
