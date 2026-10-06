"""Explicit app-only existing-namespace canary profile; distinct-NS v1 stays unchanged."""
from pathlib import Path
import re
from .controller import Controller, Refused, digest, exact, validate_evidence
from .runtime import base
from .proxy import render_nginx

PROFILE = "shared-existing-app-v1"
PORTS = {"blue": {"dashboard":30128,"api":30129,"embed":30131,"live":30132},
         "green":{"dashboard":30228,"api":30229,"embed":30231,"live":30232},
         "maintenance":{"dashboard":30328,"api":30329,"embed":30331,"live":30332}}


def validate(g, *, maintenance=False):
    exact(g, {"schema","profile","generation","slot","revision","image","namespace","address","stateOwner","helperSet"})
    if g["schema"] != 2 or g["profile"] != PROFILE or g["namespace"] != "omni-app" or g["address"] != "10.203.242.2":
        raise Refused("requires explicit existing APP-only namespace profile")
    if g["slot"] not in (("maintenance",) if maintenance else ("blue","green")):
        raise Refused("maintenance is not a traffic generation")
    for key,pattern in (("generation",r"[a-f0-9]{32}"),("revision",r"[a-f0-9]{40}"),("image",r"sha256:[a-f0-9]{64}"),("helperSet",r"[a-f0-9]{64}")):
        if not isinstance(g[key],str) or not re.fullmatch(pattern,g[key]):raise Refused("invalid shared profile identity")
    if g["stateOwner"] != "coordinated-live-v1":raise Refused("independent stale state forbidden")
    return g


def ports(g):
    validate(g,maintenance=g.get("slot")=="maintenance")
    return dict(PORTS[g["slot"]])


def command(policy,g,boundary_receipt):
    validate(g,maintenance=g.get("slot")=="maintenance")
    base.validate_policy(policy)
    if policy.get("profile")!="kernel-residential-v1" or policy.get("activation")!="approved-deployment" or policy["images"]["app"]!=g["image"]:
        raise Refused("shared profile requires exact reviewed kernel app image")
    expected={"profile":PROFILE,"generation":digest(g),"namespace":"omni-app","address":"10.203.242.2","stateProtocol":"coordinated-live-v1","stableHelperSet":g["helperSet"]}
    if boundary_receipt!=expected:raise Refused("shared boundary receipt differs")
    args=base.command(policy,"app")
    substitutions={"--name=omni-local-next-app":"--name=omni-app-"+g["generation"],
                   "--cidfile=/run/omni-local-next/app.cid":"--cidfile=/run/omni-local-next/generations/"+g["generation"]+"/app.cid"}
    env=ports(g)
    for source,target in (("PORT","dashboard"),("API_PORT","api"),("LIVE_WS_PORT","live")):
        old="--env="+source+"="+{"PORT":"20128","API_PORT":"20129","LIVE_WS_PORT":"20132"}[source]
        substitutions[old]="--env="+source+"="+str(env[target])
    for old,new in substitutions.items():
        if args.count(old)!=1:raise Refused("fixed shared runtime contract drift")
        args[args.index(old)]=new
    if g["slot"] == "maintenance":
        args[args.index("--name=omni-app-"+g["generation"]) ]="--name=omni-maintenance-"+g["generation"]
        cid="--cidfile=/run/omni-local-next/generations/"+g["generation"]+"/app.cid"
        args[args.index(cid)]="--cidfile=/run/omni-local-next/maintenance/"+g["generation"]+"/maintenance.cid"
        for value in ("--label=io.omni.maintenance=true",
                      "--mount="+base.mount(Path("/opt/omni-local-next/canary-host/maintenance-entry.cjs"),"/app/maintenance-entry.cjs"),
                      "--mount="+base.mount(Path("/opt/omni-local-next/canary-host/maintenance-loader.mjs"),"/app/dev/run-standalone.mjs")):
            args.insert(args.index(g["image"]),value)
    # Existing live attestation and resolver mounts stay EXACTLY unchanged.
    for value in ("--label=io.omni.generation="+g["generation"],"--label=io.omni.canary-profile="+PROFILE,
                  "--env=OMNIROUTE_APP_GENERATION="+g["generation"],"--env=EMBED_WS_PROXY_PORT="+str(env["embed"]),
                  "--env=OMNI_SHARED_ADMISSION=true","--env=OMNI_COORDINATION_DB=/app/data/coordination.sqlite",
                  "--env=OMNI_COORDINATION_PROCESS_ROLE="+("maintenance" if g["slot"]=="maintenance" else "generation")):
        args.insert(args.index(g["image"]),value)
    return args


def nginx_config(g,listeners,*,trusted_proto="https"):
    validate(g)
    return render_nginx(g,listeners,trusted_proto=trusted_proto,
                        backend_ports={"dashboard":ports(g)["dashboard"],"api":ports(g)["api"]})


class SharedController(Controller):
    def prepare(self,old,candidate,evidence):
        validate(old);validate(candidate)
        if old["generation"]==candidate["generation"] or old["slot"]==candidate["slot"] or old["helperSet"]!=candidate["helperSet"]:
            raise Refused("duplicate resources or helper upgrade forbidden")
        if self.journal.read() is not None:raise Refused("transaction journal cannot be reused")
        validate_evidence(evidence,old,candidate,self.clock())
        self.host.verify_resources(old,candidate)
        if self.host.selected()!=old["generation"]:raise Refused("observed frontdoor differs")
        self.save({"schema":2,"profile":PROFILE,"old":old,"candidate":candidate,"evidence":evidence},"ready")
