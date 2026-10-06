"""Read-only, fail-closed generation boundary/state collector for installed adapter.

It never provisions network namespaces or refreshes residential attestations. Those
remain the independently reviewed kernel network controller's responsibility.
"""
import json
import os
from pathlib import Path
import re
import sys
import time
from .adapter import Adapter, CONFIG, INSTALL, load
from .controller import Refused, digest, exact
from .host import trusted

READINESS_SCRIPT = r'''
let text=""; process.stdin.setEncoding("utf8");
process.stdin.on("data",s=>{text+=s;if(text.length>16384)process.exit(1)});
process.stdin.on("end",async()=>{try{
const input=JSON.parse(text);const key=input.key;
const fs=require("fs"),crypto=require("crypto"),dns=require("dns").promises;
const hosts=fs.readFileSync("/etc/hosts");
if(crypto.createHash("sha256").update(hosts).digest("hex")!=="b69b2c741be48691edabe3771c644c70473ccd6aa8effd9f17cc07fa129917f9")process.exit(1);
const addresses=await dns.lookup("localhost",{all:true});
if(!addresses.some(x=>x.address==="127.0.0.1")||addresses.some(x=>x.address!=="127.0.0.1"&&x.address!=="::1"))process.exit(1);
const response=await fetch("http://127.0.0.1:20128/api/canary-readiness",{
 headers:{Authorization:"Bearer "+key}, signal:AbortSignal.timeout(3000)});
if(response.status!==200||response.headers.get("x-omni-app-generation")!==input.generation)process.exit(1);
const body=await response.text();if(body.length>16384)process.exit(1);
const value=JSON.parse(body);console.log(JSON.stringify(value));
}catch{process.exit(1)}});
'''


def validate_attestation(claim, generation, *, boot, inode, boot_ms):
    exact(claim, {"v", "policyId", "bootId", "appNetnsInode", "topologyGeneration", "egressGeneration", "issuedBootMs", "expiresBootMs"})
    if claim["v"] != 1 or claim["policyId"] != "omni-app-residential-direct-v1" or claim["bootId"] != boot or claim["appNetnsInode"] != str(inode):
        raise Refused("wrong generation residential boundary")
    if not re.fullmatch(r"[a-f0-9]{32}", claim["topologyGeneration"]) or not re.fullmatch(r"[a-f0-9-]{36}", claim["egressGeneration"]):
        raise Refused("invalid topology/egress generation")
    if (type(claim["issuedBootMs"]) is not int or type(claim["expiresBootMs"]) is not int
            or not 0 <= claim["issuedBootMs"] <= boot_ms < claim["expiresBootMs"]
            or claim["expiresBootMs"] - claim["issuedBootMs"] > 15000):
        raise Refused("stale generation residential attestation")


class Boundary:
    def __init__(self, adapter):
        self.adapter = adapter

    def inspect_namespace(self, g):
        namespace = Path("/run/netns") / g["namespace"]
        trusted(namespace)
        addresses = json.loads(self.adapter.runner("ip", ["-j", "-n", g["namespace"], "address", "show"]))
        if not any(info.get("local") == g["address"] for interface in addresses for info in interface.get("addr_info", [])):
            raise Refused("actual namespace listener address differs")
        claim = load(Path("/run/omni-egress/public/generations") / g["generation"] / "residential-v1.json", private=False)
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        boot_ms = int(float(Path("/proc/uptime").read_text().split()[0]) * 1000)
        validate_attestation(claim, g, boot=boot, inode=namespace.stat().st_ino, boot_ms=boot_ms)
        trusted(Path("/etc/netns") / g["namespace"] / "resolv.conf")
        # The independent root topology controller also attests the exact helper
        # forwarding rules. It must not claim readiness from a copied receipt.
        forward = load(CONFIG / ("helpers-" + g["generation"] + ".json"))
        exact(forward, {"generation", "helperSet", "namespaceInode", "bootId", "expiresAt", "verified"})
        if (forward["generation"] != digest(g) or forward["helperSet"] != g["helperSet"]
                or forward["namespaceInode"] != namespace.stat().st_ino or forward["bootId"] != boot
                or forward["verified"] is not True or not time.time() < forward["expiresAt"] <= time.time() + 60):
            raise Refused("helper forwarding not freshly independently verified")
        return True

    def verify(self, g, *, before_start=False, conversation_phase=None):
        record = self.adapter.record(g)
        static_hosts = Path("/opt/omni-local-next/runtime/static-loopback-hosts")
        trusted(static_hosts)
        import hashlib, stat
        info = static_hosts.stat()
        if info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o444 or hashlib.sha256(static_hosts.read_bytes()).hexdigest() != "b69b2c741be48691edabe3771c644c70473ccd6aa8effd9f17cc07fa129917f9":
            raise Refused("static loopback mount provenance differs")
        self.inspect_namespace(g)
        raw = self.adapter.runner("podman", ["--remote=false", "image", "inspect", g["image"]])
        images = json.loads(raw)
        if len(images) != 1 or images[0].get("Id", "").removeprefix("sha256:") != g["image"].removeprefix("sha256:") or images[0].get("Labels", {}).get("org.opencontainers.image.revision") != g["revision"]:
            raise Refused("immutable image/revision mismatch")
        if before_start:
            return record["boundaryReceipt"]
        cidfile = Path("/run/omni-local-next/generations") / g["generation"] / "app.cid"
        trusted(cidfile)
        cid = cidfile.read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", cid):
            raise Refused("invalid fixed generation CID")
        containers = json.loads(self.adapter.runner("podman", ["--remote=false", "inspect", cid]))
        if len(containers) != 1:
            raise Refused("ambiguous generation container")
        container = containers[0]
        if (container.get("Id") != cid or container.get("Image", "").removeprefix("sha256:") != g["image"].removeprefix("sha256:")
                or container.get("Name", "").lstrip("/") != "omni-app-" + g["generation"] or container.get("State", {}).get("Running") is not True):
            raise Refused("generation container provenance differs")
        pid = container.get("State", {}).get("Pid")
        if type(pid) is not int or pid <= 0 or Path("/proc").joinpath(str(pid), "ns/net").stat().st_ino != (Path("/run/netns") / g["namespace"]).stat().st_ino:
            raise Refused("actual container namespace differs")
        status = dict(line.split(":", 1) for line in (Path("/proc") / str(pid) / "status").read_text().splitlines() if ":" in line)
        if (status.get("Uid", "").split() != ["10001"] * 4 or status.get("Gid", "").split() != ["10001"] * 4
                or status.get("NoNewPrivs", "").strip() != "1" or status.get("Seccomp", "").strip() != "2"
                or any(not re.fullmatch(r"0+", status.get(key, "").strip()) for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"))
                or container.get("HostConfig", {}).get("ReadonlyRootfs") is not True):
            raise Refused("actual container privilege/rootfs facts differ")
        key_record = load(CONFIG / "readiness-key.json")
        exact(key_record, {"key"})
        script = READINESS_SCRIPT
        payload = {"key": key_record["key"], "generation": g["generation"]}
        if conversation_phase is not None:
            script = script.replace('response.status!==200', '![200,503].includes(response.status)')
            if conversation_phase != "challenge":
                payload["peerChallengeId"] = conversation_phase
                script = script.replace('headers:{Authorization:"Bearer "+key}', 'method:"POST",body:JSON.stringify({generation:input.generation,peerChallengeId:input.peerChallengeId}),headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"}')
        state = json.loads(self.adapter.runner("podman", ["--remote=false", "exec", "--user=10001:10001", "-i", cid, "node", "-e", script], payload))
        if conversation_phase is not None:
            if conversation_phase != "challenge":
                exact(state, {"protocol", "generation", "peerGeneration", "peerChallengeId", "completed"})
                if state["generation"] != g["generation"] or state["protocol"] != "omni-conversation-state/v1":
                    raise Refused("conversation acknowledgment generation differs")
                return state
            conversation = state.get("conversationState")
            if state.get("generation") != g["generation"] or state.get("schema") != "omni-canary-readiness/v1" or not isinstance(conversation, dict):
                raise Refused("generation lacks conversation handoff protocol; approved bootstrap required")
            exact(conversation, {"protocol", "ready", "challengeId", "expiresAt", "peerGeneration", "handoffFresh", "reason"})
            return {"protocol": conversation["protocol"], "generation": g["generation"], "namespace": g["namespace"],
                    "challengeId": conversation["challengeId"], "expiresAt": conversation["expiresAt"]}
        fields = {"schema", "generation", "ready", "databaseReady", "coordination", "lifecycle", "conversationState"}
        exact(state, fields)
        conversation = state["conversationState"]
        exact(conversation, {"protocol", "ready", "challengeId", "expiresAt", "peerGeneration", "handoffFresh", "reason"})
        if conversation["protocol"] != "omni-conversation-state/v1" or type(conversation["ready"]) is not bool or conversation["ready"] != state["coordination"].get("conversationState"):
            raise Refused("conversation capability lacks actual protocol witness")
        exact(state["coordination"], {"protocol", "accountAdmission", "refreshOwnership", "backgroundOwnership", "conversationState"})
        if (state["schema"] != "omni-canary-readiness/v1" or state["generation"] != g["generation"]
                or state["coordination"]["protocol"] != "omni-coordination/v1" or state["databaseReady"] is not True):
            raise Refused("actual app generation/coordination protocol differs")
        lifecycle = state["lifecycle"]
        exact(lifecycle, {"activeResponses", "activeWebSockets", "queuedRequests", "draining", "pendingUploads", "conversationPins", "upstreamLeases"})
        if any(type(lifecycle[k]) is not int or lifecycle[k] < 0 for k in lifecycle if k != "draining") or type(lifecycle["draining"]) is not bool:
            raise Refused("invalid app lifecycle counters")
        compatibility = load(CONFIG / ("compatibility-" + g["generation"] + ".json"))
        exact(compatibility, {"generation", "pair", "schemaProof", "reviewedOverlap", "expiresAt"})
        if (compatibility["generation"] != digest(g) or compatibility["pair"] != sorted(digest(r["generation"]) for r in self.adapter.records.values()) or compatibility["reviewedOverlap"] is not True
                or not isinstance(compatibility["schemaProof"], str) or not re.fullmatch(r"[a-f0-9]{64}", compatibility["schemaProof"])
                or not time.time() < compatibility["expiresAt"] <= time.time() + 3600):
            raise Refused("schema overlap lacks fresh independently reviewed proof")
        maintenance = load(CONFIG / "maintenance-owner.json")
        exact(maintenance, {"pair", "helperSet", "owner", "bootId", "healthy", "fencedOwnership", "expiresAt"})
        if (maintenance["pair"] != sorted(digest(r["generation"]) for r in self.adapter.records.values())
                or maintenance["helperSet"] != g["helperSet"] or not isinstance(maintenance["owner"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", maintenance["owner"])
                or maintenance["bootId"] != Path("/proc/sys/kernel/random/boot_id").read_text().strip()
                or maintenance["healthy"] is not True or maintenance["fencedOwnership"] is not True
                or not time.time() < maintenance["expiresAt"] <= time.time() + 60):
            raise Refused("stable maintenance owner lacks fresh independently verified evidence")
        return {"protocol": 1, "generation": digest(g), "namespace": g["namespace"], "address": g["address"], "image": g["image"],
                "revision": g["revision"], "expiresAt": time.time() + 10, "residentialEgress": True, "helperSet": g["helperSet"],
                "helperForwarding": True, "appGeneration": state["generation"], "appReady": state["ready"], "sharedCapacity": state["coordination"]["accountAdmission"],
                "oauthOwner": state["coordination"]["refreshOwnership"], "jobOwner": state["coordination"]["backgroundOwnership"],
                "conversationState": state["coordination"]["conversationState"], "schemaOverlap": True,
                "drain": {"fenced": lifecycle["draining"] and lifecycle["queuedRequests"] == 0,
                          "pendingBodies": lifecycle["activeResponses"], "pendingUploads": lifecycle["pendingUploads"],
                          "webSockets": lifecycle["activeWebSockets"], "conversationPins": lifecycle["conversationPins"],
                          "upstreamLeases": lifecycle["upstreamLeases"]}}



def main():
    if Path(__file__).resolve() != INSTALL / "boundary.py" or os.geteuid() != 0:
        raise Refused("only root-installed collector can execute")
    if len(sys.argv) != 3 or sys.argv[1] != "--protocol=1" or sys.argv[2] not in ("verify", "verify-before-start", "set-drain", "conversation-exchange"):
        raise Refused("invalid boundary operation")
    request = json.loads(sys.stdin.buffer.read(65537))
    exact(request, {"old", "candidate"} if sys.argv[2] == "conversation-exchange" else ({"generation", "draining"} if sys.argv[2] == "set-drain" else {"generation"}))
    adapter = Adapter(load(CONFIG / "layout.json"))
    boundary = Boundary(adapter)
    if sys.argv[2] == "conversation-exchange":
        from .conversation import exchange
        old, candidate = request["old"], request["candidate"]
        adapter.record(old); adapter.record(candidate)
        exchange(old, candidate, lambda g, challenge: boundary.verify(g, conversation_phase=challenge or "challenge"))
        print(json.dumps({"protocol": 1, "ok": True, "pair": sorted([old["generation"], candidate["generation"]])}))
        return
    if sys.argv[2] == "set-drain":
        if type(request["draining"]) is not bool:
            raise Refused("invalid admission fence")
        g = request["generation"]
        authorization = load(CONFIG / "selection-approval.json")
        exact(authorization, {"generation", "configDigest", "transactionDigest", "expiresAt"})
        if (authorization["transactionDigest"] != adapter.layout["approvalDigest"]
                or not time.time() < authorization["expiresAt"] <= time.time() + 3600
                or (request["draining"] is False and authorization["generation"] != digest(g))
                or (request["draining"] is True and authorization["generation"] == digest(g))):
            raise Refused("admission fence lacks exact fresh cutover authorization")
        boundary.verify(g)
        cid = (Path("/run/omni-local-next/generations") / g["generation"] / "app.cid").read_text().strip()
        key = load(CONFIG / "readiness-key.json")["key"]
        script = READINESS_SCRIPT.replace('/api/canary-readiness', '/api/canary-drain').replace('headers:{Authorization:"Bearer "+key}', 'method:"POST",body:JSON.stringify({generation:input.generation,draining:input.draining}),headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"}')
        adapter.runner("podman", ["--remote=false", "exec", "--user=10001:10001", "-i", cid, "node", "-e", script], {"key": key, "generation": g["generation"], "draining": request["draining"]})
    print(json.dumps(boundary.verify(request["generation"], before_start=sys.argv[2] == "verify-before-start")))
