"""Fixed maintenance-role compiler; host component overlays, unchanged app image.

The installed host must verify actual files, image provenance, namespace/egress,
helper gateway and unique state ownership BEFORE using this argv. This module
cannot execute containers, provision namespaces or create approval.
"""
from pathlib import Path
import hashlib
import re
from . import runtime
from .controller import Refused, exact, validate_generation
from .host import trusted

ENTRY = Path("/opt/omni-local-next/canary-host/maintenance-entry.cjs")
LOADER = Path("/opt/omni-local-next/canary-host/maintenance-loader.mjs")
ENTRY_TARGET = "/app/maintenance-entry.cjs"
LOADER_TARGET = "/app/dev/run-standalone.mjs"


def validate_bundle(receipt, maintenance):
    validate_generation(maintenance)
    exact(receipt, {"schema", "imageRevision", "entrySha256", "loaderSha256"})
    if receipt["schema"] != "omni-maintenance-entry/v1" or receipt["imageRevision"] != maintenance["revision"]:
        raise Refused("maintenance bundle belongs to another immutable app revision")
    for name in ("entrySha256", "loaderSha256"):
        if not isinstance(receipt[name], str) or not re.fullmatch(r"[a-f0-9]{64}", receipt[name]):
            raise Refused("invalid fixed maintenance component digest")
    return receipt


def verify_installed_bundle(receipt, maintenance):
    """Root-only no-follow file proof. Compiler receipts are NOT execution approval."""
    validate_bundle(receipt, maintenance)
    for path, key in ((ENTRY, "entrySha256"), (LOADER, "loaderSha256")):
        trusted(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != receipt[key]:
            raise Refused("installed maintenance component differs from reviewed bytes")


def command(policy, maintenance, boundary_receipt, entry_receipt):
    validate_bundle(entry_receipt, maintenance)
    args = runtime.command(policy, maintenance, boundary_receipt)
    identity = maintenance["generation"]
    replacements = {
        "--name=omni-app-" + identity: "--name=omni-maintenance-" + identity,
        "--cidfile=/run/omni-local-next/generations/" + identity + "/app.cid":
            "--cidfile=/run/omni-local-next/maintenance/" + identity + "/maintenance.cid",
        "--env=OMNI_COORDINATION_PROCESS_ROLE=generation": "--env=OMNI_COORDINATION_PROCESS_ROLE=maintenance",
    }
    for source, target in replacements.items():
        if args.count(source) != 1:
            raise Refused("fixed maintenance runtime contract drift")
        args[args.index(source)] = target
    index = args.index(maintenance["image"])
    # Keep the image's boundary entrypoint unchanged. Its app child reads the
    # fixed ESM loader, which imports the reviewed CJS coordinator/server runner.
    for value in (
        "--label=io.omni.maintenance=true",
        "--mount=type=bind,src=" + str(ENTRY) + ",dst=" + ENTRY_TARGET + ",readonly,bind-propagation=rprivate",
        "--mount=type=bind,src=" + str(LOADER) + ",dst=" + LOADER_TARGET + ",readonly,bind-propagation=rprivate",
    ):
        args.insert(index, value)
        index += 1
    return args
