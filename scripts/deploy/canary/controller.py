"""Canary admission and durable cutover kernel; no privileged execution or installation.

Host adapters must enforce installed policy, boundary and coordination contracts.
The controller never builds, pulls, executes checkout code, restores DBs or replays requests.
"""
from __future__ import annotations
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import time


class Refused(RuntimeError):
    pass


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Refused("unknown or incomplete fields")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def validate_generation(g):
    exact(g, {"generation", "slot", "revision", "image", "address", "namespace", "stateOwner", "helperSet"})
    if not isinstance(g["generation"], str) or not re.fullmatch(r"[a-f0-9]{32}", g["generation"]):
        raise Refused("invalid generation")
    if g["slot"] not in ("blue", "green"):
        raise Refused("invalid slot")
    for key, pattern in (("revision", r"[a-f0-9]{40}"), ("image", r"sha256:[a-f0-9]{64}"), ("helperSet", r"[a-f0-9]{64}")):
        if not isinstance(g[key], str) or not re.fullmatch(pattern, g[key]):
            raise Refused("invalid immutable provenance")
    try:
        addr = ipaddress.ip_address(g["address"])
        if addr.version != 4 or not addr.is_private or addr.is_loopback or addr.is_unspecified or addr.is_multicast:
            raise ValueError()
    except (ValueError, TypeError):
        raise Refused("generation requires policy-approved private IPv4") from None
    if g["namespace"] != "omni-app-" + g["generation"]:
        raise Refused("namespace must be generation-specific")
    if g["stateOwner"] != "coordinated-live-v1":
        raise Refused("independent stale state cannot be promoted")
    return g


REQUIRED_CHECKS = frozenset({"boundary", "image-provenance", "shared-capacity", "oauth-owner", "job-owner", "conversation-state", "schema-overlap", "helpers", "cold-catalog", "warm-catalog", "tool-turn", "dashboard-assets", "stream-drain", "frontdoor"})


def validate_evidence(evidence, old, candidate, now):
    exact(evidence, {"old", "candidate", "expiresAt", "checks"})
    if evidence["old"] != digest(old) or evidence["candidate"] != digest(candidate):
        raise Refused("evidence does not bind exact generations")
    if type(evidence["expiresAt"]) not in (int, float) or not now < evidence["expiresAt"] <= now + 3600:
        raise Refused("missing, stale or unbounded evidence")
    if set(evidence["checks"]) != REQUIRED_CHECKS:
        raise Refused("all overlap and readiness checks required")
    for result in evidence["checks"].values():
        exact(result, {"ok", "proof"})
        if result["ok"] is not True or not isinstance(result["proof"], str) or not re.fullmatch(r"[a-f0-9]{64}", result["proof"]):
            raise Refused("check lacks successful immutable proof")


class Journal:
    """Owner-private journal, fixed lock inode, atomic/fsynced records, no symlinks.

    Production adapter must additionally require root ownership of this directory.
    This unprivileged kernel intentionally has no root-install/activation escape hatch.
    """
    def __init__(self, directory):
        directory = Path(directory).absolute()
        # Refuse symlink components before opening the final no-follow descriptor.
        for p in (directory, *directory.parents):
            if p.is_symlink():
                raise Refused("symlink journal path")
        self.fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        s = os.fstat(self.fd)
        if s.st_uid != os.geteuid() or s.st_mode & 0o077:
            os.close(self.fd)
            raise Refused("journal must be owner-private")
        self.lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        s = os.fstat(self.lock)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.geteuid() or s.st_mode & 0o077:
            self.close()
            raise Refused("unsafe lock")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.close()
            raise

    def close(self):
        os.close(self.lock)
        os.close(self.fd)

    def read(self):
        try:
            fd = os.open("transaction.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
        except FileNotFoundError:
            return None
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.geteuid() or s.st_mode & 0o077 or s.st_size > 65536:
                raise Refused("unsafe journal record")
            return json.loads(os.read(fd, 65537))
        finally:
            os.close(fd)

    def write(self, value):
        name = "record-" + os.urandom(16).hex()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            raw = json.dumps(value, sort_keys=True).encode()
            with os.fdopen(fd, "wb") as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
            os.rename(name, "transaction.json", src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        finally:
            try:
                os.unlink(name, dir_fd=self.fd)
            except FileNotFoundError:
                pass


class Controller:
    def __init__(self, journal, host, clock=time.time):
        self.journal, self.host, self.clock = journal, host, clock

    def save(self, record, phase):
        record["phase"] = phase
        self.journal.write(record)

    def prepare(self, old, candidate, evidence):
        validate_generation(old)
        validate_generation(candidate)
        if any(old[k] == candidate[k] for k in ("generation", "slot", "address", "namespace")):
            raise Refused("candidate resources must be distinct")
        if old["helperSet"] != candidate["helperSet"]:
            raise Refused("overlapping helper upgrade unsupported")
        if self.journal.read() is not None:
            raise Refused("transaction ID journal cannot be reused")
        validate_evidence(evidence, old, candidate, self.clock())
        self.host.verify_resources(old, candidate)
        if self.host.selected() != old["generation"]:
            raise Refused("observed frontdoor differs from old generation")
        record = {"schema": 1, "old": old, "candidate": candidate, "evidence": evidence}
        self.save(record, "ready")

    def promote(self):
        r = self.journal.read()
        if not r or r["phase"] != "ready":
            raise Refused("candidate not ready")
        validate_evidence(r["evidence"], r["old"], r["candidate"], self.clock())
        self.host.verify_resources(r["old"], r["candidate"])
        if self.host.selected() != r["old"]["generation"]:
            raise Refused("frontdoor changed since preparation")
        # Explicit installed/operator approval is enforced by the host adapter.
        self.host.verify_approval(digest(r))
        config = self.host.validate_config(r["candidate"])
        self.save(r, "promotion-intent")
        self.host.select(r["candidate"], config)
        if self.host.selected() != r["candidate"]["generation"]:
            raise Refused("switch lacked routed-generation acknowledgment")
        self.save(r, "draining-old")
        self.host.fence(r["old"])

    def switch_back(self):
        r = self.journal.read()
        if not r or r["phase"] not in ("draining-old", "old-retained", "promotion-intent"):
            raise Refused("no retained generation")
        self.host.verify_resources(r["old"], r["candidate"])
        self.host.verify_approval(digest(r))
        config = self.host.validate_config(r["old"])
        self.save(r, "switchback-intent")
        self.host.select(r["old"], config)
        if self.host.selected() != r["old"]["generation"]:
            raise Refused("switch-back lacked acknowledgment")
        self.save(r, "draining-candidate")
        self.host.fence(r["candidate"])

    def recover(self):
        r = self.journal.read()
        if not r:
            return "absent"
        observed = self.host.selected()
        if observed not in (r["old"]["generation"], r["candidate"]["generation"]):
            raise Refused("unknown frontdoor authority; manual reconciliation required")
        if r["phase"] in ("promotion-intent", "switchback-intent"):
            expected = r["candidate"] if r["phase"] == "promotion-intent" else r["old"]
            previous = r["old"] if r["phase"] == "promotion-intent" else r["candidate"]
            if observed == expected["generation"]:
                self.save(r, "draining-old" if expected == r["candidate"] else "draining-candidate")
            elif observed == previous["generation"]:
                self.save(r, "ready" if previous == r["old"] else "draining-old")
            else:
                raise Refused("unknown frontdoor authority; manual reconciliation required")
        phase = self.journal.read()["phase"]
        if phase in ("draining-old", "draining-candidate"):
            self.host.fence(r["old"] if phase == "draining-old" else r["candidate"])
        return phase

    def retain(self):
        r = self.journal.read()
        if not r or r["phase"] not in ("draining-old", "draining-candidate"):
            raise Refused("not draining")
        drained = r["old"] if r["phase"] == "draining-old" else r["candidate"]
        # No deadline can force termination of healthy long streams or pinned turns.
        if not self.host.drained(drained):
            return False
        self.save(r, "old-retained" if drained == r["old"] else "candidate-retained")
        return True
