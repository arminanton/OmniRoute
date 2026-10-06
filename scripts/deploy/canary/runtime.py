"""Generation-aware command compiler preserving the residential launch restrictions.

Source-only: this module cannot install, create namespaces, start containers or alter
iptables/Tailscale. Host adoption must separately provision/attest each namespace and
stable helper forwarding before this command is admitted by the root supervisor.
"""
import importlib.util
from pathlib import Path
from .controller import Refused, digest, validate_generation

_BASE = (Path("/opt/omni-local-next/runtime/runtime_launcher.py")
         if Path(__file__).resolve().parent == Path("/opt/omni-local-next/canary-host")
         else Path(__file__).resolve().parents[1] / "residential" / "runtime_launcher.py")
spec = importlib.util.spec_from_file_location("residential_canary_base", _BASE)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def command(policy, generation, boundary_receipt):
    """Compile fixed app-only argv, never shared browser/Codex replacement.

    receipt is a sanitized host attestation, not caller permission to execute.
    Installed executor must verify freshness, ownership and actual host observations.
    """
    validate_generation(generation)
    base.validate_policy(policy)
    if policy.get("profile") != "kernel-residential-v1" or policy.get("activation") != "approved-deployment":
        raise Refused("requires existing reviewed residential profile")
    if policy["images"]["app"] != generation["image"]:
        raise Refused("generation image differs from runtime policy")
    expected = {"generation": digest(generation), "namespace": generation["namespace"],
                "address": generation["address"], "egressPolicy": "kernel-residential-v1",
                "stateProtocol": "coordinated-live-v1", "stableHelperSet": generation["helperSet"]}
    if boundary_receipt != expected:
        raise Refused("generation boundary/helper/state evidence differs")
    args = base.command(policy, "app")
    overrides = {"--name=omni-local-next-app": "--name=omni-app-" + generation["generation"],
                 "--cidfile=/run/omni-local-next/app.cid": "--cidfile=/run/omni-local-next/generations/" + generation["generation"] + "/app.cid",
                 "--network=ns:/run/netns/omni-app": "--network=ns:/run/netns/" + generation["namespace"],
                 "--mount=" + base.mount(base.PUBLIC, "/run/omni-egress-attestation"):
                     "--mount=" + base.mount(Path("/run/omni-egress/public/generations") / generation["generation"], "/run/omni-egress-attestation"),
                 "--mount=" + base.mount(base.RESOLVER, "/etc/resolv.conf"):
                     "--mount=" + base.mount(Path("/etc/netns") / generation["namespace"] / "resolv.conf", "/etc/resolv.conf")}
    for key in overrides:
        if args.count(key) != 1:
            raise Refused("reviewed base runtime contract drift")
    args = [overrides.get(arg, arg) for arg in args]
    # Add generation identity; never arbitrary caller env/mount/network/device options.
    args.insert(args.index(generation["image"]), "--label=io.omni.generation=" + generation["generation"])
    args.insert(args.index(generation["image"]), "--env=OMNIROUTE_APP_GENERATION=" + generation["generation"])
    # Exact coordinated traffic-generation contract; no caller env override.
    # Old/candidate readiness still verifies both actual modules and maintenance owner.
    for value in ("OMNI_SHARED_ADMISSION=true", "OMNI_COORDINATION_DB=/app/data/coordination.sqlite",
                  "OMNI_COORDINATION_PROCESS_ROLE=generation"):
        args.insert(args.index(generation["image"]), "--env=" + value)
    return args
