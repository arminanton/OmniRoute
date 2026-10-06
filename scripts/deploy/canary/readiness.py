"""Authenticated readiness sampling with phase-specific secret-free diagnostics."""
import hashlib
import json
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ProbeFailure(RuntimeError):
    def __init__(self, category, status=None):
        self.category, self.status = category, status
        super().__init__(category)


def probe_json(url, key, generation, validator, *, timeout=10, max_bytes=4 * 1024 * 1024):
    target = urlsplit(url)
    if target.scheme not in ("http", "https") or not target.hostname or target.username or target.password or target.fragment:
        raise ProbeFailure("invalid-probe-target")
    if timeout <= 0 or max_bytes <= 0:
        raise ProbeFailure("invalid-probe-bounds")
    started = time.monotonic()
    stage, status = "connect-headers", None
    try:
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + key})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            status = response.status
            if status != 200:
                raise ProbeFailure("http-status", status)
            # This is actual generation returned by app readiness, NOT proxy-selected config.
            if response.headers.get("X-Omni-App-Generation") != generation:
                raise ProbeFailure("generation-mismatch", status)
            stage = "body"
            chunks = []
            size = 0
            # Enforce a total wall deadline, not a per-read timeout reset by trickles.
            while True:
                if response.fp is None:
                    break
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise TimeoutError()
                response.fp.raw._sock.settimeout(remaining)
                chunk = response.read1(min(65536, max_bytes + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > max_bytes:
                    raise ProbeFailure("body-limit", status)
            body = b"".join(chunks)
            stage = "json"
            value = json.loads(body)
            stage = "validation"
            if not validator(value):
                raise ProbeFailure("semantic-validation", status)
        result = {"ok": True, "stage": "complete", "status": status}
    except urllib.error.HTTPError as error:
        result = {"ok": False, "stage": stage, "status": error.code, "category": "http-status"}
    except ProbeFailure as error:
        result = {"ok": False, "stage": stage, "status": error.status, "category": error.category}
    except (TimeoutError, OSError):
        result = {"ok": False, "stage": stage, "status": status, "category": "transport-timeout-or-io"}
    except (ValueError, UnicodeError):
        result = {"ok": False, "stage": stage, "status": status, "category": "invalid-json"}
    result["elapsedMs"] = round((time.monotonic() - started) * 1000)
    # Hash only redacted metadata, not potentially private model/request contents.
    result["proof"] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return result


def catalog_valid(body):
    if not isinstance(body, dict) or not isinstance(body.get("data"), list) or not body["data"]:
        return False
    ids = [row.get("id") for row in body["data"] if isinstance(row, dict)]
    return len(ids) == len(body["data"]) and all(isinstance(i, str) and i for i in ids) and len(set(ids)) == len(ids)
