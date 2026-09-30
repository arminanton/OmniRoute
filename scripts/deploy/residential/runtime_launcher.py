"""STAGED deployment launcher. Default print-command is offline and side-effect free.

Only exact fixed mounts/commands are supported. No engine socket, arbitrary env,
network, volume, device, host namespace, privilege or executable option exists.
Execute/stop require root-installed files AND an explicit activation receipt.
The explicit kernel-residential-v1 profile starts real workloads; the legacy
experimental locked profile retains its deployment stop.
This file is not installed by generating the staging artifacts.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

INSTALL = Path("/opt/omni-local-next/runtime")
CONFIG = Path("/etc/omni-local-next")
RUNTIME_AUTHORITY = CONFIG / "runtime-policy"
RUNTIME_AUTHORITY_TARGET = "/run/omni-runtime-policy"
CANONICAL_CORE_SHA256 = "65ef803f048b16df2be39b0057ecd2e757590d23e2ef1cf87bf24b4bb849bd20"
STATE = Path("/var/lib/omni-local-next")
APP_DATA = Path("/home/ubuntu/.omniroute")
OPERATOR_UID = 1001
RUN = Path("/run/omni-local-next")
PUBLIC = Path("/run/omni-egress/public")
NETNS = Path("/run/netns/omni-app")
RESOLVER = Path("/etc/netns/omni-app/resolv.conf")
ROLES = ("app", "browser", "codex")
UID = GID = 10001
IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
HEX = re.compile(r"[0-9a-f]{64}")
CLEAN_HOST_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                  "HOME": str(STATE / "podman-home"), "LANG": "C.UTF-8",
                  "CONTAINERS_CONF": str(CONFIG / "containers.conf")}
AUTH_KEYS = {"JWT_SECRET", "API_KEY_SECRET", "INITIAL_PASSWORD"}


class PolicyError(RuntimeError):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PolicyError("duplicate JSON key")
        result[key] = value
    return result


def load_json(raw: bytes) -> dict:
    if len(raw) > 16384:
        raise PolicyError("oversized policy")
    value = json.loads(raw, object_pairs_hook=unique_object,
                       parse_constant=lambda _: (_ for _ in ()).throw(PolicyError("nonfinite JSON")))
    if not isinstance(value, dict):
        raise PolicyError("expected object")
    return value


def validate_policy(policy: dict) -> None:
    if (set(policy) not in ({"schema", "activation", "images", "helpers"},
                            {"schema", "activation", "images", "helpers", "profile"})
            or type(policy["schema"]) is not int or policy["schema"] != 1):
        raise PolicyError("unknown or incomplete runtime policy")
    if "profile" in policy and policy["profile"] != "kernel-residential-v1":
        raise PolicyError("unknown deployment profile")
    if policy["activation"] not in {"disabled-staged", "approved-disposable", "approved-deployment"}:
        raise PolicyError("invalid activation")
    if not isinstance(policy["images"], dict) or set(policy["images"]) != set(ROLES):
        raise PolicyError("exact images for three known roles required")
    for image in policy["images"].values():
        if not isinstance(image, str) or not IMAGE.fullmatch(image):
            raise PolicyError("images must be immutable local sha256 IDs; no tags or pulls")
    if (not isinstance(policy["helpers"], dict) or set(policy["helpers"]) != {"browser", "codex"}
            or any(type(v) is not bool for v in policy["helpers"].values())):
        raise PolicyError("only explicit boolean browser/codex helper choices are supported")


def role_enabled(policy: dict, role: str) -> bool:
    return role == "app" or policy["helpers"][role]


def mount(source: Path, target: str, *, writable: bool = False) -> str:
    # rprivate + no recursively included host submounts. Never use rbind.
    return f"type=bind,src={source},dst={target},{'rw' if writable else 'ro'},bind-propagation=rprivate,bind-nonrecursive"


def workload_environment(policy: dict, role: str) -> dict[str, str]:
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
           "NODE_ENV": "production", "NEXT_TELEMETRY_DISABLED": "1"}
    if role == "app":
        env.update({"DATA_DIR": "/app/data", "HOME": "/app/data/home", "PORT": "20128",
                    "HOSTNAME": "0.0.0.0", "API_PORT": "20129", "API_HOST": "0.0.0.0",
                    "LIVE_WS_PORT": "20132", "LIVE_WS_HOST": "0.0.0.0",
                    "REQUIRE_API_KEY": "true", "OMNIROUTE_MIGRATIONS_DIR": "/app/migrations",
                    "NODE_OPTIONS": "--max-old-space-size=2048",
                    "OMNIROUTE_BROWSER_POOL": "false", "CLI_ALLOW_CONFIG_WRITES": "false",
                    "ENABLE_TLS_FINGERPRINT": "true", "TLS_FINGERPRINT_PROVIDERS": "maxai"})
        if policy["helpers"]["browser"]:
            env["CHATGPT_WEB_CODEX_CDP_URL"] = "http://127.0.0.1:9222"
        if policy["helpers"]["codex"]:
            env.update({"OMNIROUTE_CODEX_APPSERVER_WS": "ws://127.0.0.1:1456",
                        "OMNIROUTE_CODEX_APPSERVER_WS_TOKEN_FILE": "/run/codex-appserver/token",
                        "CODEX_HOME": "/home/node/.codex"})
    elif role == "browser":
        env["HOME"] = "/browser-profile/home"
    else:
        env.update({"HOME": "/home/node", "CODEX_HOME": "/home/node/.codex", "RUST_LOG": "warn"})
    return env


def command(policy: dict, role: str, *, boundary_only: bool = False) -> list[str]:
    validate_policy(policy)
    if role not in ROLES or not role_enabled(policy, role):
        raise PolicyError("role disabled or unknown")
    args = ["/usr/bin/podman", "--remote=false", f"--hooks-dir={CONFIG}/no-hooks", "run",
            "--name=omni-local-next-" + role, "--pull=never", "--rm", "--init",
            "--cidfile=" + str(RUN / (role + ".cid")),
            "--label=io.omni.local-next.role=" + role,
            "--network=ns:" + str(NETNS), "--userns=host", "--user=10001:10001",
            "--cap-drop=all", "--security-opt=no-new-privileges",
            "--security-opt=seccomp=" + str(CONFIG / "seccomp.json"),
            "--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private",
            "--read-only", "--read-only-tmpfs=false", "--image-volume=ignore",
            "--systemd=false", "--sdnotify=ignore", "--http-proxy=false", "--unsetenv-all",
            "--dns=none", "--no-hosts", "--pids-limit=512", "--memory=4g", "--cpus=2",
            "--ulimit=core=0:0", "--health-cmd=none",
            "--tmpfs=/dev/shm:rw,nosuid,nodev,noexec,mode=1777,size=256m",
            "--tmpfs=/tmp:rw,nosuid,nodev,noexec,mode=1777,size=256m",
            "--tmpfs=/var/tmp:rw,nosuid,nodev,noexec,mode=1777,size=64m",
            "--mount=" + mount(INSTALL, "/opt/omni-runtime"),
            "--mount=" + mount(PUBLIC, "/run/omni-egress-attestation"),
            "--mount=" + mount(RESOLVER, "/etc/resolv.conf")]
    if policy.get("profile") != "kernel-residential-v1":
        args += ["--mount=" + mount(RUNTIME_AUTHORITY, RUNTIME_AUTHORITY_TARGET)]
    if role == "app":
        if policy.get("profile") == "kernel-residential-v1":
            # Normal bootstrap creates/persists secrets in DATA_DIR. No initial
            # password is injected: keep the first-run onboarding flow.
            args += ["--mount=" + mount(APP_DATA, "/app/data", writable=True)]
        else:
            args += ["--mount=" + mount(STATE / "app-data", "/app/data", writable=True),
                     "--env-file=" + str(CONFIG / "app-auth.env")]
    elif role == "browser":
        args += ["--mount=" + mount(STATE / "browser-profile", "/browser-profile", writable=True)]
    if role == "codex" or (role == "app" and policy["helpers"]["codex"]):
        args += ["--mount=" + mount(STATE / "codex-home", "/home/node/.codex", writable=True),
                 "--mount=" + mount(STATE / "codex-token", "/run/codex-appserver")]
    for key, value in sorted(workload_environment(policy, role).items()):
        args.append("--env=" + key + "=" + value)
    args += ["--entrypoint=/usr/bin/env", policy["images"][role], "node",
             "/opt/omni-runtime/workload-entrypoint.mjs", "boundary-only" if boundary_only else role,
             policy.get("profile", "locked-experimental-v1")]
    return args


def protected(path: Path, *, directory=False, private=False, writable_uid=None):
    """Reject symlinks, writable ancestors and non-regular special files."""
    for parent in list(reversed(path.parents)):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PolicyError("unprotected path ancestry")
    info = path.lstat()
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            raise PolicyError("expected directory")
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise PolicyError("expected single-link regular file")
    if writable_uid is None:
        if info.st_uid != 0 or info.st_mode & (0o077 if private else 0o022):
            raise PolicyError("unprotected root-owned path")
    elif info.st_uid != writable_uid or info.st_gid != GID or stat.S_IMODE(info.st_mode) != 0o700:
        raise PolicyError("workload state must be isolated UID/GID 10001 mode0700")
    return info


def read_protected(path: Path, *, private=False, limit=16384) -> bytes:
    before = protected(path, private=private)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        current = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino) or current.st_size > limit:
            raise PolicyError("file changed or too large")
        return os.read(fd, limit + 1)
    finally:
        os.close(fd)


def check_executable_provenance(path: Path, expected_sha256: str) -> None:
    info = protected(path)
    if not info.st_mode & 0o111 or info.st_mode & 0o6000 or info.st_size > 16 * 1024 * 1024:
        raise PolicyError("probe must be a bounded root-owned ordinary executable")
    if not isinstance(expected_sha256, str) or not HEX.fullmatch(expected_sha256):
        raise PolicyError("probe build digest is missing from the runtime review")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        actual = os.fstat(fd)
        if (actual.st_dev, actual.st_ino, actual.st_size) != (info.st_dev, info.st_ino, info.st_size):
            raise PolicyError("probe executable changed")
        digest = hashlib.sha256()
        total = 0
        while chunk := os.read(fd, 65536):
            total += len(chunk)
            if total > 16 * 1024 * 1024:
                raise PolicyError("oversized probe executable")
            digest.update(chunk)
        after = os.fstat(fd)
        if (after.st_mtime_ns, after.st_ctime_ns, after.st_size) != (actual.st_mtime_ns, actual.st_ctime_ns, actual.st_size):
            raise PolicyError("probe executable changed during verification")
        if digest.hexdigest() != expected_sha256:
            raise PolicyError("probe build differs from the reviewed digest")
    finally:
        os.close(fd)


def check_authority_ancestor(info) -> None:
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
            or info.st_mode & 0o7022):
        raise PolicyError("runtime authority ancestry invalid")


def check_authority_metadata(info, *, directory: bool, limit: int = 0) -> None:
    expected = 0o555 if directory else 0o444
    correct_kind = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if (not correct_kind or info.st_uid != 0 or info.st_gid != 0
            or stat.S_IMODE(info.st_mode) != expected
            or (not directory and (info.st_nlink != 1 or not 0 < info.st_size <= limit))):
        raise PolicyError("runtime authority provenance invalid")


def check_runtime_authority() -> None:
    # Host metadata and immutable code only. The ONE canonical reader validates
    # marker/policy schema and exact-byte SHA inside each workload before spawn.
    for parent in reversed(RUNTIME_AUTHORITY.parents):
        check_authority_ancestor(parent.lstat())
    check_authority_metadata(protected(RUNTIME_AUTHORITY, directory=True), directory=True)
    if {entry.name for entry in RUNTIME_AUTHORITY.iterdir()} != {"required-v1.json", "policy.json"}:
        raise PolicyError("runtime authority bind must contain only marker and policy")
    for name, limit in (("required-v1.json", 1024), ("policy.json", 256 * 1024)):
        check_authority_metadata(protected(RUNTIME_AUTHORITY / name), directory=False, limit=limit)
    core = read_protected(INSTALL / "runtime-policy.mjs")
    if hashlib.sha256(core).hexdigest() != CANONICAL_CORE_SHA256:
        raise PolicyError("canonical runtime authority module differs from frozen review")


def check_auth(raw: bytes) -> None:
    # Do not print secret values, even on error. No proxy/loader/arbitrary envs.
    keys = set()
    for line in raw.decode("utf8").splitlines():
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if sep != "=" or key not in AUTH_KEYS or key in keys or not value or "\x00" in value:
            raise PolicyError("auth env has an invalid/duplicate/unsupported key")
        keys.add(key)
    if keys != AUTH_KEYS:
        raise PolicyError("explicit disposable or deployment authentication required")


def preflight(role: str) -> tuple[dict, bool]:
    if os.geteuid() != 0:
        raise PolicyError("execution requires the trusted root launcher")
    raw = read_protected(CONFIG / "policy.json", private=True)
    policy = load_json(raw)
    validate_policy(policy)
    if policy["activation"] == "disabled-staged":
        raise PolicyError("staging is not activation")
    if policy.get("profile") == "kernel-residential-v1":
        return kernel_preflight(policy, raw, role)
    if policy["activation"] == "approved-deployment":
        # Hard stop, not an env/receipt escape: canonical role admission is staged,
        # but full source/native/config policy coverage needs separate acceptance.
        raise PolicyError("deployment activation deferred; only disposable boundary checks are implemented")
    receipt = load_json(read_protected(CONFIG / "activation.json", private=True))
    expected = {"schema", "policySha256", "runtimeReviewSha256", "configurationReviewSha256", "authenticationReviewSha256"}
    if (set(receipt) != expected or type(receipt["schema"]) is not int or receipt["schema"] != 1
            or any(not isinstance(receipt[k], str) or not HEX.fullmatch(receipt[k]) for k in expected - {"schema"})
            or receipt["policySha256"] != hashlib.sha256(raw).hexdigest()):
        raise PolicyError("missing or mismatched operator review receipt")
    # Receipts reference root-approved audit reports, not guessed green results.
    reports = {}
    for key in expected - {"schema", "policySha256"}:
        report = read_protected(CONFIG / (key.removesuffix("Sha256") + ".json"), private=True)
        if hashlib.sha256(report).hexdigest() != receipt[key]:
            raise PolicyError("review report changed")
        reports[key] = load_json(report)
    protected(INSTALL, directory=True)
    check_runtime_authority()
    check_executable_provenance(INSTALL / "capability-probe",
                               reports["runtimeReviewSha256"].get("capabilityProbeSha256"))
    for name in ("runtime_launcher.py", "workload-entrypoint.mjs", "boundary-check.mjs"):
        protected(INSTALL / name)
    protected(CONFIG / "seccomp.json")
    protected(CONFIG / "containers.conf")
    protected(STATE / "podman-home", directory=True, private=True)
    for mounts_path in (Path("/usr/share/containers/mounts.conf"),
                        Path("/etc/containers/mounts.conf"),
                        STATE / "podman-home/.config/containers/mounts.conf"):
        if mounts_path.exists():
            # An implicit host-secret/socket bind is not part of this policy.
            # Require an operator-reviewed empty configuration, never change it.
            if any(line.strip() and not line.lstrip().startswith("#")
                   for line in read_protected(mounts_path).decode().splitlines()):
                raise PolicyError("implicit mounts.conf mounts are not allowed")
    protected(CONFIG / "no-hooks", directory=True)
    if list((CONFIG / "no-hooks").iterdir()):
        raise PolicyError("OCI hook directory must be empty")
    protected(PUBLIC, directory=True)
    if any(entry.name != "residential-v1.json" and not re.fullmatch(r"\.lease-[0-9a-f]{32}", entry.name)
           for entry in PUBLIC.iterdir()):
        raise PolicyError("public attestation directory contains unexpected files")
    protected(PUBLIC / "residential-v1.json")
    protected(RESOLVER)
    protected(RUN, directory=True, private=True)
    # Do not hand the namespace handle to the workload. Only root Podman gets it.
    info = protected(NETNS)
    claim = load_json(read_protected(PUBLIC / "residential-v1.json"))
    if str(info.st_ino) != claim.get("appNetnsInode"):
        raise PolicyError("namespace does not match current public claim")
    if role == "app":
        protected(STATE / "app-data", directory=True, writable_uid=UID)
        check_auth(read_protected(CONFIG / "app-auth.env", private=True))
    elif role == "browser":
        protected(STATE / "browser-profile", directory=True, writable_uid=UID)
    if role == "codex" or (role == "app" and policy["helpers"]["codex"]):
        protected(STATE / "codex-home", directory=True, writable_uid=UID)
        protected(STATE / "codex-token", directory=True)
        token = protected(STATE / "codex-token/token")
        if token.st_gid != GID or stat.S_IMODE(token.st_mode) != 0o440:
            raise PolicyError("root-owned shared capability token must be group10001 mode0440")
    return policy, policy["activation"] == "approved-disposable"


def validate_kernel_claim(claim: dict, *, inode: int, boot_id: str, now_ms: int) -> None:
    fields = {"v", "policyId", "bootId", "appNetnsInode", "topologyGeneration",
              "egressGeneration", "issuedBootMs", "expiresBootMs"}
    import uuid
    if (set(claim) != fields or type(claim["v"]) is not int or claim["v"] != 1
            or claim["policyId"] != "omni-app-residential-direct-v1"
            or claim["bootId"] != boot_id or claim["appNetnsInode"] != str(inode)
            or not re.fullmatch(r"[0-9a-f]{32}", claim["topologyGeneration"])
            or str(uuid.UUID(claim["egressGeneration"])) != claim["egressGeneration"]
            or type(claim["issuedBootMs"]) is not int
            or type(claim["expiresBootMs"]) is not int
            or not 0 <= claim["issuedBootMs"] <= now_ms < claim["expiresBootMs"]
            or not 0 < claim["expiresBootMs"] - claim["issuedBootMs"] <= 15000):
        raise PolicyError("missing, stale or mismatched residential namespace claim")


def check_app_data() -> None:
    # The operator explicitly selected this persistent home directory. Trust
    # only that operator's non-shared home, never arbitrary writable ancestry.
    for parent in reversed(APP_DATA.parents):
        info = parent.lstat()
        expected_uid = OPERATOR_UID if parent == APP_DATA.parent else 0
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != expected_uid
                or info.st_mode & 0o022):
            raise PolicyError("unprotected application data ancestry")
    info = APP_DATA.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != UID or info.st_gid != GID
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise PolicyError("application data must be UID/GID 10001 mode0700")


def kernel_preflight(policy: dict, raw: bytes, role: str) -> tuple[dict, bool]:
    """Explicit OS-enforced profile; does not grant experimental app adapters.

    Root-installed immutable images/config are trusted. Kernel nft lease remains
    authoritative after launch; the payload independently checks its actual netns.
    """
    if policy["activation"] != "approved-deployment" or not role_enabled(policy, role):
        raise PolicyError("kernel profile requires explicit deployment approval")
    receipt = load_json(read_protected(CONFIG / "activation.json", private=True))
    if receipt != {"schema": 1, "profile": "kernel-residential-v1",
                   "policySha256": hashlib.sha256(raw).hexdigest()}:
        raise PolicyError("deployment approval does not bind exact launch policy")
    protected(INSTALL, directory=True)
    for name in ("runtime_launcher.py", "workload-entrypoint.mjs", "boundary-check.mjs",
                 "runtime-policy.mjs"):
        protected(INSTALL / name)
    for name in ("seccomp.json", "containers.conf"):
        protected(CONFIG / name)
    # This profile still requires the reviewed namespace-denying filter, not just
    # an arbitrary file named seccomp.json. Never regenerate implicitly at launch.
    expected_filter = read_protected(INSTALL / "seccomp.arm64.json", limit=256 * 1024)
    if read_protected(CONFIG / "seccomp.json", limit=256 * 1024) != expected_filter:
        raise PolicyError("seccomp differs from installed namespace-denying filter")
    protected(STATE / "podman-home", directory=True, private=True)
    for path in (Path("/usr/share/containers/mounts.conf"), Path("/etc/containers/mounts.conf"),
                 STATE / "podman-home/.config/containers/mounts.conf"):
        if path.exists() and any(line.strip() and not line.lstrip().startswith("#")
                                 for line in read_protected(path).decode().splitlines()):
            raise PolicyError("implicit host mounts forbidden")
    protected(CONFIG / "no-hooks", directory=True)
    if list((CONFIG / "no-hooks").iterdir()):
        raise PolicyError("OCI hooks forbidden")
    protected(RUN, directory=True, private=True)
    protected(PUBLIC, directory=True)
    protected(RESOLVER)
    info = protected(NETNS)
    claim = load_json(read_protected(PUBLIC / "residential-v1.json"))
    validate_kernel_claim(claim, inode=info.st_ino,
                          boot_id=Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                          now_ms=time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000)
    if role == "app":
        check_app_data()
    elif role == "browser":
        protected(STATE / "browser-profile", directory=True, writable_uid=UID)
    if role == "codex" or (role == "app" and policy["helpers"]["codex"]):
        protected(STATE / "codex-home", directory=True, writable_uid=UID)
        protected(STATE / "codex-token", directory=True)
        token = protected(STATE / "codex-token/token")
        if token.st_gid != GID or stat.S_IMODE(token.st_mode) != 0o440:
            raise PolicyError("invalid shared capability token provenance")
    return policy, False


def close_extra_fds() -> None:
    # Include inherited descriptors above 1023. The workload may retain only
    # standard input/output/error; no host namespace/directory/control handle.
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd > 2:
            try:
                os.close(fd)
            except OSError:
                pass  # The short-lived enumeration descriptor may be closed.


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    show = sub.add_parser("print-command")
    show.add_argument("policy", type=Path)
    show.add_argument("role", choices=ROLES)
    for action in ("execute", "stop"):
        child = sub.add_parser(action)
        child.add_argument("role", choices=ROLES)
    args = parser.parse_args()
    if args.action == "print-command":
        # Intentionally accepts only public placeholder policy, never auth data.
        print(json.dumps(command(load_json(args.policy.read_bytes()), args.role), indent=2))
        return 0
    if args.action == "execute":
        os.umask(0o077)
        policy, boundary_only = preflight(args.role)
        if (RUN / (args.role + ".cid")).exists():
            raise PolicyError("existing CID file requires operator inspection; no adoption/removal")
        # Closed FD inheritance: no trusted-root descriptor is intentionally passed.
        close_extra_fds()
        os.execve("/usr/bin/podman", command(policy, args.role, boundary_only=boundary_only), CLEAN_HOST_ENV)
    # Stop only our exact CID, never a name collision or foreign container.
    if os.geteuid() != 0:
        raise PolicyError("root required")
    cidpath = RUN / (args.role + ".cid")
    if not cidpath.exists():
        return 0
    cid = read_protected(cidpath, private=True).decode().strip()
    if not HEX.fullmatch(cid):
        raise PolicyError("invalid owned CID")
    result = subprocess.run(["/usr/bin/podman", "--remote=false", "inspect", cid],
                            env=CLEAN_HOST_ENV, capture_output=True, text=True, timeout=10, check=True)
    inspection = json.loads(result.stdout)
    if (len(inspection) != 1 or inspection[0].get("Id") != cid
            or inspection[0].get("Name") != "omni-local-next-" + args.role
            or inspection[0].get("Config", {}).get("Labels", {}).get("io.omni.local-next.role") != args.role
            or inspection[0].get("HostConfig", {}).get("NetworkMode") != "ns:" + str(NETNS)):
        raise PolicyError("CID does not match owned namespace workload")
    close_extra_fds()
    os.execve("/usr/bin/podman", ["/usr/bin/podman", "--remote=false", "stop", "--time=10", cid], CLEAN_HOST_ENV)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PolicyError, ValueError, OSError, subprocess.SubprocessError):
        # No config/env/report/subprocess stdout in public diagnostics.
        print("runtime refused: protected policy, evidence or ownership check failed", file=sys.stderr)
        raise SystemExit(1)
