"""Fixed installed-adapter interface; root host integration is deliberately gated.

Commands are exact fixed paths/argv, never checkout executables or caller shell.
An installation must implement and review the corresponding adapter binaries.
This source has no fallback to the old stop-all deployer.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
from .controller import Refused, digest

_ROOT = Path("/opt/omni-local-next/canary-host")
_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}


def trusted(path):
    # Open walk with no-follow handles: never trust a symlink or writable ancestor.
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(path.parts[1:]):
            final = index == len(path.parts[1:]) - 1
            nxt = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | (0 if final else os.O_DIRECTORY), dir_fd=fd)
            os.close(fd)
            fd = nxt
            s = os.fstat(fd)
            if s.st_uid != 0 or s.st_mode & 0o022 or (final and (not stat.S_ISREG(s.st_mode) or s.st_nlink != 1)):
                raise Refused("untrusted installed adapter")
    finally:
        os.close(fd)


class InstalledHost:
    """Protocol v1 adapter. It refuses missing/unreviewed host integration.

    Resource verification must inspect CIDs/images/namespaces, coordinator protocols,
    helper forwarding/profile ownership and state/migration compatibility. ACK must
    reflect fresh actual app observations on both front doors (not config strings).
    Drain evidence includes in-flight bodies, uploads, WS and conversation pins.
    """
    def __init__(self, adapter_sha256):
        self.expected = adapter_sha256

    def call(self, operation, value):
        import hashlib
        path = _ROOT / "adapter"
        trusted(path)
        with path.open("rb") as f:
            if hashlib.sha256(f.read()).hexdigest() != self.expected:
                raise Refused("installed adapter differs from reviewed bytes")
        result = subprocess.run([str(path), "--protocol=1", operation], input=json.dumps(value),
                                capture_output=True, text=True, env=_ENV, timeout=30, check=False)
        # Never print adapter stdout/stderr; adapters must emit bounded structured data.
        if result.returncode != 0 or len(result.stdout) > 65536:
            raise Refused("installed host operation failed: " + operation)
        try:
            output = json.loads(result.stdout)
        except ValueError:
            raise Refused("invalid adapter acknowledgment") from None
        if not isinstance(output, dict) or output.get("protocol") != 1 or output.get("ok") is not True:
            raise Refused("host operation refused: " + operation)
        return output

    def verify_resources(self, old, candidate):
        self.call("verify-overlap", {"old": old, "candidate": candidate})

    def verify_approval(self, transaction_digest):
        self.call("verify-approval", {"transactionDigest": transaction_digest})

    def selected(self):
        value = self.call("observe-admission", {})
        if set(value) != {"protocol", "ok", "generation", "apiGeneration", "dashboardGeneration"}:
            raise Refused("invalid admission acknowledgment")
        if value["generation"] != value["apiGeneration"] or value["generation"] != value["dashboardGeneration"]:
            raise Refused("frontdoors disagree")
        return value["generation"]

    def validate_config(self, generation):
        value = self.call("validate-proxy", {"generation": generation})
        import re
        if not isinstance(value.get("configDigest"), str) or not re.fullmatch(r"[a-f0-9]{64}", value["configDigest"]):
            raise Refused("invalid validated config digest")
        return value["configDigest"]

    def select(self, generation, config):
        self.call("select-proxy", {"generation": generation, "configDigest": config})

    def retired(self, generation):
        return self.call("observe-retirement", {"generation": generation}).get("retired") is True

    def retire(self, generation):
        self.call("retire-generation", {"generation": generation})

    def fence(self, generation):
        self.call("fence-old", {"generation": generation})

    def drained(self, generation):
        value = self.call("observe-drain", {"generation": generation})
        fields = ("pendingBodies", "pendingUploads", "webSockets", "conversationPins", "upstreamLeases")
        return value.get("fenced") is True and all(type(value.get(key)) is int and value[key] == 0 for key in fields)
