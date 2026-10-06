"""Staged root host adapter. Installation and activation require operator review.

ONLY the exact installed path can execute this CLI as root. No source checkout,
caller-provided executable/namespace/argv/config path or shell can be executed.
Generation records, runtime, boundary proof and approvals come from root policy.
"""
from __future__ import annotations
import hashlib
import fcntl
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from .controller import Refused, digest, exact, validate_generation
from .host import trusted
from .proxy import nginx_config
from .runtime import command

INSTALL = Path("/opt/omni-local-next/canary-host")
CONFIG = Path("/etc/omni-local-next/canary")
RUN = Path("/run/omni-local-next/canary")
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8",
       "HOME": "/var/lib/omni-local-next/podman-home",
       "CONTAINERS_CONF": "/etc/omni-local-next/containers.conf"}
BINARIES = {"podman": "/usr/bin/podman", "nginx": "/usr/sbin/nginx", "boundary": str(INSTALL / "boundary-check"), "ip": "/usr/bin/ip"}
OPERATIONS = frozenset({"verify-overlap", "verify-approval", "observe-admission", "validate-proxy", "select-proxy", "observe-drain", "start-candidate", "fence-old", "retire-generation", "observe-retirement", "provision-shared-profile", "observe-shared-profile", "start-maintenance", "produce-schema-proof"})


def load(path, *, private=True):
    trusted(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if s.st_size > 65536 or (private and s.st_mode & 0o077):
            raise Refused("unsafe or oversized installed record")
        raw = os.read(fd, 65537)
    finally:
        os.close(fd)
    def unique(pairs):
        output = {}
        for key, value in pairs:
            if key in output:
                raise Refused("duplicate record field")
            output[key] = value
        return output
    try:
        return json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise Refused("invalid installed record") from None


def atomic_bytes(path, raw):
    """Private root parent is checked; atomic replacement cannot follow target symlink."""
    parent = path.parent
    # trusted() treats final as regular; independently inspect directory descriptor.
    for ancestor in (parent, *parent.parents):
        s = ancestor.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise Refused("unsafe installed output directory")
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = "pending-" + os.urandom(16).hex()
    try:
        out = os.open(name, os.O_WRONLY | os.O_EXCL | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(out, "wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.rename(name, path.name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


@contextmanager
def mutation_lock():
    parent = RUN
    for ancestor in (parent, *parent.parents):
        s = ancestor.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise Refused("unsafe mutation-lock ancestry")
    fd = os.open(parent / "mutation.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != 0 or s.st_mode & 0o077:
            raise Refused("unsafe mutation lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def retirement_observed(rows, cid):
    if not isinstance(rows, list):
        raise Refused("invalid retirement observation")
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("Id"), str) or not re.fullmatch(r"[a-f0-9]{64}", row["Id"]):
            raise Refused("incomplete container observation")
        if row["Id"] == cid:
            if row.get("State") in ("exited", "stopped"):
                return True
            if row.get("State") in ("created", "initialized", "configured", "running", "paused", "stopping"):
                return False
            raise Refused("unknown retired container state")
    return True


def validate_proxy_master_snapshot(pid, snapshot, expected_inode, config_path):
    if type(pid) is not int or pid <= 1 or snapshot.get("uid") != 0 or snapshot.get("exeIdentity") != expected_inode:
        raise Refused("proxy master identity differs")
    if not isinstance(snapshot.get("cmdline"), str) or "nginx: master process" not in snapshot["cmdline"] or str(config_path) not in snapshot["cmdline"]:
        raise Refused("proxy master does not own fixed configuration")


class Adapter:
    def __init__(self, layout, runner=None, observer=None, clock=time.time):
        exact(layout, {"schema", "activation", "generations", "listeners", "binaryHashes", "approvalDigest", "coordinationProtocol", "observationUrls", "implementationHashes"})
        if layout["schema"] != 1 or layout["activation"] != "approved-canary-host-v1":
            raise Refused("canary host not explicitly activated")
        if layout["coordinationProtocol"] != "omni-coordination/v1":
            raise Refused("unknown coordination protocol")
        if not isinstance(layout["generations"], list) or len(layout["generations"]) != 2:
            raise Refused("exact old and candidate generations required")
        if set(layout["binaryHashes"]) != set(BINARIES):
            raise Refused("all fixed executables must be fingerprinted")
        for field in (layout["approvalDigest"], *layout["binaryHashes"].values()):
            if not isinstance(field, str) or not re.fullmatch(r"[a-f0-9]{64}", field):
                raise Refused("invalid policy fingerprint")
        self.records = {}
        for value in layout["generations"]:
            exact(value, {"generation", "runtime", "boundaryReceipt"})
            g = validate_generation(value["generation"])
            if g["generation"] in self.records:
                raise Refused("duplicate generation")
            # Compiler enforces no extra options and binds immutable image/namespace.
            command(value["runtime"], g, value["boundaryReceipt"])
            self.records[g["generation"]] = value
        for key in ("slot", "address", "namespace"):
            if len({v["generation"][key] for v in self.records.values()}) != 2:
                raise Refused("generation resources must be distinct")
        if len({v["generation"]["helperSet"] for v in self.records.values()}) != 1:
            raise Refused("overlapping helper upgrade unsupported")
        self.layout = layout
        self.runner = runner or self._run
        self.observer = observer or self._observe
        self.clock = clock

    def _run(self, binary, args, payload=None):
        path = Path(BINARIES[binary])
        trusted(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != self.layout["binaryHashes"][binary]:
            raise Refused("installed executable drift")
        completed = subprocess.run([str(path), *args], input=None if payload is None else json.dumps(payload),
                                   text=True, capture_output=True, env=ENV, timeout=25, check=False)
        if completed.returncode or len(completed.stdout) > 65536:
            raise Refused("fixed operation failed: " + binary)
        return completed.stdout

    def record(self, generation):
        validate_generation(generation)
        record = self.records.get(generation["generation"])
        if not record or record["generation"] != generation:
            raise Refused("generation not in installed root policy")
        return record

    def proof(self, g):
        self.record(g)
        raw = self.runner("boundary", ["--protocol=1", "verify"], {"generation": g})
        try:
            proof = json.loads(raw)
        except ValueError:
            raise Refused("invalid boundary proof") from None
        required = {"protocol", "generation", "namespace", "address", "image", "revision", "expiresAt", "residentialEgress", "helperSet", "helperForwarding", "sharedCapacity", "oauthOwner", "jobOwner", "conversationState", "schemaOverlap", "appGeneration", "appReady", "drain"}
        exact(proof, required)
        if (proof["protocol"] != 1 or proof["generation"] != digest(g) or proof["namespace"] != g["namespace"]
                or proof["address"] != g["address"] or proof["image"] != g["image"] or proof["revision"] != g["revision"]
                or proof["helperSet"] != g["helperSet"] or proof["appGeneration"] != g["generation"]
                or type(proof["expiresAt"]) not in (int, float) or not self.clock() < proof["expiresAt"] <= self.clock() + 60):
            raise Refused("boundary proof is stale or differs from running generation")
        if type(proof["appReady"]) is not bool or not (proof["appReady"] or proof["drain"].get("fenced") is True):
            raise Refused("app unhealthy and not merely admission-fenced")
        for flag in ("residentialEgress", "helperForwarding", "sharedCapacity", "oauthOwner", "jobOwner", "conversationState", "schemaOverlap"):
            if proof[flag] is not True:
                raise Refused("overlap proof failed: " + flag)
        exact(proof["drain"], {"fenced", "pendingBodies", "pendingUploads", "webSockets", "conversationPins", "upstreamLeases", "diagnosticCaptureWork"})
        for key, value in proof["drain"].items():
            if key == "fenced":
                if type(value) is not bool:
                    raise Refused("invalid admission fence observation")
            elif type(value) is not int or value < 0:
                raise Refused("invalid lifecycle observation")
        return proof

    def proxy_config(self, g):
        return nginx_config(g, self.layout["listeners"])

    def runtime_command(self, record):
        return command(record["runtime"], record["generation"], record["boundaryReceipt"])

    def verify_proxy_master(self):
        pidfile = RUN / "nginx.pid"
        trusted(pidfile)
        raw = pidfile.read_text().strip()
        if not re.fullmatch(r"[1-9][0-9]{0,9}", raw):
            raise Refused("invalid fixed proxy PID")
        pid = int(raw)
        proc = Path("/proc") / raw
        status = dict(line.split(":", 1) for line in (proc / "status").read_text().splitlines() if ":" in line)
        uid = status.get("Uid", "").split()
        exe = (proc / "exe").stat()
        approved = Path(BINARIES["nginx"]).stat()
        validate_proxy_master_snapshot(pid, {"uid": int(uid[0]) if len(uid) == 4 and len(set(uid)) == 1 else None,
            "exeIdentity": (exe.st_dev, exe.st_ino), "cmdline": (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf8", "strict")},
            (approved.st_dev, approved.st_ino), RUN / "nginx.conf")

    def _observe(self):
        # URLs are root-configured, local policy-defined ingress targets, not caller URLs.
        import urllib.request
        from urllib.parse import urlsplit
        from .readiness import NoRedirect
        results = []
        for url in self.layout["observationUrls"]:
            target = urlsplit(url)
            if target.scheme != "http" or target.hostname != "127.0.0.1" or target.path != "/_omni_generation" or target.query or target.fragment or target.username or target.password:
                raise Refused("invalid fixed ingress observation URL")
            with urllib.request.build_opener(NoRedirect()).open(url, timeout=3) as response:
                value = response.read(65).decode("ascii")
                if response.status != 200 or not re.fullmatch(r"[a-f0-9]{32}", value):
                    raise Refused("invalid fresh ingress observation")
                results.append(value)
        if len(results) != 2 or results[0] != results[1]:
            raise Refused("frontdoors disagree")
        # Re-query actual authenticated app/runtime via boundary collector; static
        # NGINX generation alone is not a successful readiness/cutover ACK.
        self.proof(self.records[results[0]]["generation"])
        return {"protocol": 1, "ok": True, "generation": results[0], "apiGeneration": results[0], "dashboardGeneration": results[1]}

    def operate(self, operation, request):
        if operation not in OPERATIONS:
            raise Refused("unknown fixed operation")
        if operation == "verify-approval":
            exact(request, {"transactionDigest"})
            if request["transactionDigest"] != self.layout["approvalDigest"]:
                raise Refused("operator approval does not bind transaction")
        elif operation == "verify-overlap":
            exact(request, {"old", "candidate"})
            old, candidate = request["old"], request["candidate"]
            if old["helperSet"] != candidate["helperSet"]:
                raise Refused("overlapping helper upgrade unsupported")
            self.record(old); self.record(candidate)
            exchanged = json.loads(self.runner("boundary", ["--protocol=1", "conversation-exchange"], {"old": old, "candidate": candidate}))
            exact(exchanged, {"protocol", "ok", "pair"})
            if exchanged["protocol"] != 1 or exchanged["ok"] is not True or exchanged["pair"] != sorted([old["generation"], candidate["generation"]]):
                raise Refused("conversation exchange did not bind the approved pair")
            self.proof(old)
            self.proof(candidate)
        elif operation == "observe-admission":
            exact(request, set())
            return self.observer()
        elif operation == "fence-old":
            exact(request, {"generation"})
            g = request["generation"]
            proof = self.proof(g)
            if self.observer()["generation"] == g["generation"] or proof["drain"]["conversationPins"] != 0:
                raise Refused("cannot fence active generation or pinned conversations")
            authorization = load(CONFIG / "selection-approval.json")
            if authorization.get("transactionDigest") != self.layout["approvalDigest"] or not self.clock() < authorization.get("expiresAt", 0) <= self.clock() + 3600:
                raise Refused("old admission fence lacks fresh cutover approval")
            self.runner("boundary", ["--protocol=1", "set-drain"], {"generation": g, "draining": True})
            if self.proof(g)["drain"]["fenced"] is not True:
                raise Refused("old admission fence lacked app acknowledgment")
        elif operation == "observe-retirement":
            exact(request, {"generation"})
            g = request["generation"]
            self.record(g)
            receipt = load(Path("/var/lib/omni-local-next/deployments/canary") / ("retirement-" + g["generation"] + ".json"))
            exact(receipt, {"generation", "cid", "approvalDigest"})
            if receipt["generation"] != digest(g) or not re.fullmatch(r"[a-f0-9]{64}", receipt["cid"]):
                raise Refused("retirement receipt differs")
            remaining = json.loads(self.runner("podman", ["--remote=false", "ps", "--all", "--no-trunc", "--format=json"]))
            retired = retirement_observed(remaining, receipt["cid"])
            return {"protocol": 1, "ok": True, "retired": retired}
        elif operation == "retire-generation":
            exact(request, {"generation"})
            g = request["generation"]
            proof = self.proof(g)
            if self.observer()["generation"] == g["generation"] or proof["drain"]["fenced"] is not True or any(proof["drain"][k] != 0 for k in proof["drain"] if k != "fenced"):
                raise Refused("active or undrained generation cannot retire")
            authorization = load(CONFIG / "retirement-approval.json")
            exact(authorization, {"generation", "transactionDigest", "expiresAt"})
            if authorization["generation"] != digest(g) or authorization["transactionDigest"] != self.layout["approvalDigest"] or not self.clock() < authorization["expiresAt"] <= self.clock() + 3600:
                raise Refused("retirement lacks exact fresh operator approval")
            # Stop only this proven, drained app CID. Helpers/state/network stay intact.
            cidfile = Path("/run/omni-local-next/generations") / g["generation"] / "app.cid"
            trusted(cidfile)
            cid = cidfile.read_text().strip()
            if not re.fullmatch(r"[a-f0-9]{64}", cid):
                raise Refused("invalid retirement CID")
            atomic_bytes(Path("/var/lib/omni-local-next/deployments/canary") / ("retirement-" + g["generation"] + ".json"),
                         json.dumps({"generation": digest(g), "cid": cid, "approvalDigest": self.layout["approvalDigest"]}).encode())
            self.runner("podman", ["--remote=false", "stop", "--time=20", cid])
            remaining = json.loads(self.runner("podman", ["--remote=false", "ps", "--all", "--no-trunc", "--format=json"]))
            if not retirement_observed(remaining, cid):
                raise Refused("retired generation still running")
        elif operation == "observe-drain":
            exact(request, {"generation"})
            proof = self.proof(request["generation"])
            return {"protocol": 1, "ok": True, **proof["drain"]}
        elif operation in ("validate-proxy", "select-proxy"):
            exact(request, {"generation"} if operation == "validate-proxy" else {"generation", "configDigest"})
            g = request["generation"]
            self.proof(g)
            raw = self.proxy_config(g).encode()
            sha = hashlib.sha256(raw).hexdigest()
            staged = RUN / ("proxy-" + sha + ".conf")
            atomic_bytes(staged, raw)
            self.runner("nginx", ["-t", "-c", str(staged), "-p", str(RUN)])
            if operation == "validate-proxy":
                return {"protocol": 1, "ok": True, "configDigest": sha}
            if request["configDigest"] != sha:
                raise Refused("validated config changed")
            # Approval check is performed again at mutation time; adapter may not be
            # directly used to bypass Controller.verify_approval.
            approval = load(CONFIG / "selection-approval.json")
            exact(approval, {"generation", "configDigest", "transactionDigest", "expiresAt"})
            if approval["generation"] != digest(g) or approval["configDigest"] != sha or approval["transactionDigest"] != self.layout["approvalDigest"] or not self.clock() < approval["expiresAt"] <= self.clock() + 3600:
                raise Refused("selection lacks exact fresh operator approval")
            if self.proof(g)["drain"]["fenced"]:
                self.runner("boundary", ["--protocol=1", "set-drain"], {"generation": g, "draining": False})
                if self.proof(g)["appReady"] is not True:
                    raise Refused("retained generation did not become admission-ready")
            self.verify_proxy_master()
            atomic_bytes(RUN / "nginx.conf", raw)
            self.runner("nginx", ["-s", "reload", "-c", str(RUN / "nginx.conf"), "-p", str(RUN)])
            observed = self.observer()
            if observed["generation"] != g["generation"]:
                raise Refused("proxy did not acknowledge candidate generation")
        else:
            exact(request, {"generation"})
            g = request["generation"]
            record = self.record(g)
            # Namespace creation is external reviewed infrastructure, never implicit.
            # Pre-start proof binds namespace/egress/helper forwarding independently;
            # running-image checks happen after start in full proof().
            authorization = load(CONFIG / "launch-approval.json")
            exact(authorization, {"generation", "transactionDigest", "expiresAt"})
            if authorization["generation"] != digest(g) or authorization["transactionDigest"] != self.layout["approvalDigest"] or not self.clock() < authorization["expiresAt"] <= self.clock() + 3600:
                raise Refused("candidate launch lacks fresh exact operator approval")
            receipt = json.loads(self.runner("boundary", ["--protocol=1", "verify-before-start"], {"generation": g}))
            if receipt != record["boundaryReceipt"]:
                raise Refused("pre-start boundary receipt differs")
            argv = self.runtime_command(record)
            # Fixed compiler is only source of executable arguments, caller cannot add flags.
            argv.insert(argv.index("run") + 1, "--detach")
            result = self.runner("podman", argv[1:]).strip()
            if not re.fullmatch(r"[a-f0-9]{64}", result):
                raise Refused("candidate start lacked immutable CID")
        return {"protocol": 1, "ok": True}


def main():
    if Path(__file__).resolve() != INSTALL / "adapter.py" or os.geteuid() != 0:
        raise Refused("only reviewed root-installed adapter can execute")
    trusted(INSTALL / "adapter.py")
    if len(sys.argv) != 3 or sys.argv[1] != "--protocol=1" or sys.argv[2] not in OPERATIONS:
        raise Refused("invalid fixed adapter command")
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise Refused("oversized adapter input")
    layout = load(CONFIG / "layout.json")
    if layout.get("schema") == 2:
        from .sharedAppHost import SharedAdapter
        adapter = SharedAdapter(layout)
        if sys.argv[2] in ("select-proxy","start-candidate","fence-old","retire-generation","provision-shared-profile","start-maintenance","produce-schema-proof"):
            from .sharedPaths import provision
            provision(layout)
    else:
        adapter = Adapter(layout)
    request = json.loads(raw)
    if sys.argv[2] in ("select-proxy", "start-candidate", "fence-old", "retire-generation", "provision-shared-profile", "start-maintenance", "produce-schema-proof"):
        with mutation_lock():
            result = adapter.operate(sys.argv[2], request)
    else:
        result = adapter.operate(sys.argv[2], request)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (Refused, ValueError, OSError, subprocess.TimeoutExpired, KeyError):
        # No paths, subprocess stderr, raw JSON or credentials appear in failure output.
        print('{"protocol":1,"ok":false,"category":"canary-host-refused"}')
        sys.exit(1)
