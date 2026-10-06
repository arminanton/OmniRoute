"""Root-installed shared APP profile adapter/collector; no new namespace receipts."""
from pathlib import Path
import hashlib
import json
import os
import re
import time
from .adapter import Adapter, CONFIG, BINARIES, load, atomic_bytes
from .boundary import Boundary, READINESS_SCRIPT, validate_attestation
from .controller import Refused, digest, exact
from .host import trusted
from . import sharedApp as shared


class SharedAdapter(Adapter):
    def __init__(self,layout,runner=None,observer=None,clock=time.time):
        exact(layout,{"schema","profile","activation","generations","maintenance","listeners","binaryHashes","approvalDigest","coordinationProtocol","observationUrls","implementationHashes","schemaProofSha256","staticAssets"})
        if layout["schema"]!=2 or layout["profile"]!=shared.PROFILE or layout["activation"]!="approved-shared-existing-app-v1" or layout["coordinationProtocol"]!="omni-coordination/v1":raise Refused("shared APP-only profile not explicitly activated")
        if len(layout["generations"])!=2 or set(layout["listeners"])!={"dashboard","api"} or layout["listeners"]!={"dashboard":21028,"api":21029}:raise Refused("fixed shared frontdoor/listeners required")
        if set(layout["binaryHashes"])!=set(BINARIES)|{"nft","python"}:raise Refused("all fixed executables must be pinned")
        for value in (layout["approvalDigest"],layout["schemaProofSha256"],*layout["binaryHashes"].values()):
            if not isinstance(value,str) or not re.fullmatch(r"[a-f0-9]{64}",value):raise Refused("invalid installed shared profile fingerprint")
        self.records={}
        for record in layout["generations"]:
            exact(record,{"generation","runtime","boundaryReceipt"});g=shared.validate(record["generation"])
            shared.command(record["runtime"],g,record["boundaryReceipt"])
            if g["generation"] in self.records:raise Refused("duplicate shared generation")
            self.records[g["generation"]]=record
        if {r["generation"]["slot"] for r in self.records.values()}!={"blue","green"}:raise Refused("blue and green required")
        m=layout["maintenance"];exact(m,{"generation","runtime","boundaryReceipt","entryReceipt"});shared.validate(m["generation"],maintenance=True)
        if m["generation"]["generation"] in self.records or len({r["generation"]["helperSet"] for r in (*self.records.values(),m)})!=1:raise Refused("maintenance collision or helper upgrade")
        shared.command(m["runtime"],m["generation"],m["boundaryReceipt"])
        assets=layout['staticAssets'];exact(assets,{'schema','digest','path','fileCount','totalBytes'})
        if assets['schema']!='omni-static-assets/v1' or not isinstance(assets['path'],str) or not assets['path'].startswith('/var/lib/omni-local-next/canary-static/'):
            raise Refused('static assets need exact retained immutable snapshot')
        self.layout,self.runner,self.observer,self.clock=layout,runner or self._run,observer or self._observe,clock

    def _run(self,binary,args,payload=None):
        nft_call=binary=="ip" and args[:4]==["netns","exec","omni-wan","/usr/sbin/nft"]
        reader_call=binary=='ip'and args[:5]==['netns','exec','omni-wan','/usr/bin/python3.12','-I']
        if reader_call:
            import subprocess
            for name,path in (('ip',Path('/usr/bin/ip')),('python',Path('/usr/bin/python3.12'))):
                trusted(path)
                if hashlib.sha256(path.read_bytes()).hexdigest()!=self.layout['binaryHashes'][name]:raise Refused('fixed namespace reader changed')
            done=subprocess.run(['/usr/bin/ip',*args],input=json.dumps(payload),capture_output=True,text=True,timeout=8,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
            if done.returncode or len(done.stdout)>1048576:raise Refused('namespace frontdoor read failed')
            return done.stdout
        if not nft_call:
            if binary!='ip':return super()._run(binary,args,payload)
            import subprocess
            path=Path('/usr/bin/ip');trusted(path)
            if hashlib.sha256(path.read_bytes()).hexdigest()!=self.layout['binaryHashes']['ip']:raise Refused('fixed ip executable changed')
            done=subprocess.run([str(path),*args],input=None if payload is None else json.dumps(payload),capture_output=True,text=True,timeout=25,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
            if done.returncode or len(done.stdout)>1048576:raise Refused('fixed ip operation failed')
            return done.stdout
        import subprocess
        for name,path in (("ip",Path("/usr/bin/ip")),("nft",Path("/usr/sbin/nft"))):
            trusted(path)
            if hashlib.sha256(path.read_bytes()).hexdigest()!=self.layout["binaryHashes"][name]:raise Refused("fixed shared executable changed")
        result=subprocess.run(["/usr/bin/ip",*args],input=payload,capture_output=True,text=True,timeout=10,env={"PATH":"/usr/sbin:/usr/bin:/sbin:/bin","LANG":"C.UTF-8"})
        if result.returncode or len(result.stdout)>1048576:raise Refused("fixed shared nft operation failed")
        return result.stdout

    def record(self,g):
        shared.validate(g);record=self.records.get(g["generation"])
        if not record or record["generation"]!=g:raise Refused("generation absent from exact shared root policy")
        return record

    def runtime_command(self,record):return shared.command(record["runtime"],record["generation"],record["boundaryReceipt"])
    def proxy_config(self,g):
        value=shared.nginx_config(g,self.layout["listeners"])
        from .static_assets import verify_asset_snapshot
        if verify_asset_snapshot(self.layout["staticAssets"]["path"])!=self.layout["staticAssets"]:raise Refused("immutable asset snapshot changed")
        # Immutable retained-asset location is supplied by the reviewed companion.
        from .static_assets import nginx_location
        return value.replace('  server {','  server {\n'+nginx_location(self.layout['staticAssets']['path']),2)

    def _observe(self):
        from .frontdoor import observe_frontdoors
        key=load(CONFIG/"readiness-key.json")["key"]
        selected=self._configured_selection()
        from .wanRequester import request
        return observe_frontdoors({"dashboard":"http://127.0.0.1:21028/api/canary-readiness","api":"http://127.0.0.1:21029/v1/models?prefix=alias&configuredOnly=true"},key,selected,requester=lambda url,key,**options:request(self,url,key,**options))

    def _configured_selection(self):
        from .wanRequester import request
        values=[]
        for url in self.layout["observationUrls"]:
            if url not in ('http://127.0.0.1:21028/_omni_generation','http://127.0.0.1:21029/_omni_generation'):raise Refused("unknown ingress observation target")
            response=request(self,url,None,marker=True,max_bytes=65)
            value=response['body']
            if response['status']!=200 or value not in self.records:raise Refused('unapproved config selection')
            values.append(value)
        if len(values)!=2 or values[0]!=values[1]:raise Refused('frontdoor config mismatch')
        return values[0]

    def operate(self,operation,request):
        if operation=="produce-schema-proof":
            exact(request,{})
            from .schemaProof import produce
            proof=produce(self);raw=json.dumps(proof,sort_keys=True,separators=(',',':')).encode()
            # Producer output is root-private review material, not automatic approval.
            atomic_bytes(CONFIG/'schema-proof.produced.json',raw)
            return {'protocol':1,'ok':True,'sha256':hashlib.sha256(raw).hexdigest(),'pair':proof['pair']}
        if operation=="provision-shared-profile":
            exact(request,{})
            approval=load(CONFIG/"shared-profile-approval.json")
            exact(approval,{"transactionDigest","expiresAt"})
            if approval["transactionDigest"]!=self.layout["approvalDigest"] or not self.clock()<approval["expiresAt"]<=self.clock()+3600:raise Refused("shared profile installation not approved")
            # Validate ORIGINAL actual namespace/lease before the one narrow WAN
            # extension; never add a NIC, route, namespace or forwarding bypass.
            g=next(iter(self.records.values()))["generation"]
            SharedBoundary(self).inspect_namespace(g)
            before=json.loads(self.runner("ip",["netns","exec","omni-wan","/usr/sbin/nft","-j","list","chain","inet","oe_guard","output"]))
            denied=[r['rule']for r in before['nftables']if r.get('rule',{}).get('comment')=='output-denied']
            if len(denied)!=1:raise Refused('ambiguous final WAN deny')
            tag='omni-shared-app:'+self.layout['approvalDigest'][:32]
            journal_path=Path('/var/lib/omni-local-next/deployments/canary/shared-profile.json')
            expected={'profile':shared.PROFILE,'transactionDigest':self.layout['approvalDigest'],'layoutDigest':digest(self.layout),'ownerTag':tag}
            prior=load(journal_path)if journal_path.exists()else None
            if prior and any(prior.get(k)!=v for k,v in expected.items()):raise Refused('profile journal belongs to different transaction')
            existing=[r['rule']for r in before['nftables']if r.get('rule',{}).get('comment')in(tag,tag+':maintenance')]
            if existing:
                if not prior or prior.get('phase')not in('intent','committed') or len(existing)!=2:raise Refused('unowned/partial shared rules require operator review')
                self.observe_port_rules()
                atomic_bytes(journal_path,json.dumps({**expected,'phase':'committed'}).encode())
                return {'protocol':1,'ok':True,'profile':shared.PROFILE,'adopted':True}
            atomic_bytes(journal_path,json.dumps({**expected,'phase':'intent'}).encode())
            h=denied[0]['handle']
            if type(h)is not int or h<=0:raise Refused('invalid final deny handle')
            batch=f'insert rule inet oe_guard output position {h} meta skuid {{ 0, 65534 }} oifname "app0" ip daddr 10.203.242.2 tcp dport {{ 30128, 30129, 30228, 30229 }} counter accept comment "{tag}"\ninsert rule inet oe_guard output position {h} meta skuid 0 oifname "app0" ip daddr 10.203.242.2 tcp dport {{ 30328, 30329 }} counter accept comment "{tag}:maintenance"\n'
            self.runner('ip',['netns','exec','omni-wan','/usr/sbin/nft','--check','-f','-'],batch)
            self.runner('ip',['netns','exec','omni-wan','/usr/sbin/nft','-f','-'],batch)
            self.observe_port_rules()
            atomic_bytes(journal_path,json.dumps({**expected,'phase':'committed'}).encode())
            return {'protocol':1,'ok':True,'profile':shared.PROFILE}
        if operation=="observe-shared-profile":
            exact(request,{})
            self.observe_port_rules()
            for record in self.records.values():SharedBoundary(self).inspect_namespace(record['generation'])
            return {'protocol':1,'ok':True,'profile':shared.PROFILE}
        if operation=="start-maintenance":
            exact(request,{})
            record=self.layout['maintenance'];g=record['generation']
            self.observe_port_rules()
            approval=load(CONFIG/"shared-profile-approval.json")
            if approval.get("transactionDigest")!=self.layout["approvalDigest"] or not self.clock()<approval.get("expiresAt",0)<=self.clock()+3600:raise Refused("maintenance launch not freshly approved")
            # Exact image-matched readonly host component, never arbitrary code.
            receipt=record['entryReceipt'];exact(receipt,{'schema','imageRevision','entrySha256','loaderSha256'})
            if receipt['schema']!='omni-maintenance-entry/v1' or receipt['imageRevision']!=g['revision']:raise Refused('maintenance image revision differs')
            for file,key in (('maintenance-entry.cjs','entrySha256'),('maintenance-loader.mjs','loaderSha256')):
                path=Path('/opt/omni-local-next/canary-host')/file;trusted(path)
                if hashlib.sha256(path.read_bytes()).hexdigest()!=receipt[key]:raise Refused('maintenance source component changed')
            cidpath=Path('/run/omni-local-next/maintenance',g['generation'],'maintenance.cid')
            if cidpath.exists():raise Refused('existing maintenance CID requires actual observation; never duplicate launch')
            journal_path=Path('/var/lib/omni-local-next/deployments/canary')/('maintenance-'+g['generation']+'.json')
            if journal_path.exists():raise Refused('incomplete maintenance launch requires operator reconciliation')
            atomic_bytes(journal_path,json.dumps({'generation':digest(g),'entryReceipt':digest(receipt),'transactionDigest':self.layout['approvalDigest'],'phase':'intent'}).encode())
            args=shared.command(record['runtime'],g,record['boundaryReceipt']);args.insert(args.index('run')+1,'--detach')
            result=self.runner('podman',args[1:]).strip()
            if not re.fullmatch(r'[a-f0-9]{64}',result):raise Refused('invalid actual maintenance CID')
            atomic_bytes(journal_path,json.dumps({'generation':digest(g),'entryReceipt':digest(receipt),'transactionDigest':self.layout['approvalDigest'],'phase':'started','cid':result}).encode())
            return {'protocol':1,'ok':True,'cid':result}
        return super().operate(operation,request)

    def observe_port_rules(self):
        data=json.loads(self.runner('ip',['netns','exec','omni-wan','/usr/sbin/nft','-j','list','chain','inet','oe_guard','output']))
        tag='omni-shared-app:'+self.layout['approvalDigest'][:32]
        rules=[r['rule']for r in data.get('nftables',[])if r.get('rule',{}).get('comment')in(tag,tag+':maintenance')]
        if len(rules)!=2:raise Refused('shared fixed port permissions missing')
        for rule in rules:
            expr=rule.get('expr',[])
            if {'accept':None}not in expr or any('jump'in e or 'goto'in e for e in expr):raise Refused('unexpected shared WAN permission')
            matches=[e['match']for e in expr if 'match'in e]
            expected_ports=[30328,30329]if rule['comment'].endswith(':maintenance')else[30128,30129,30228,30229]
            observed={}
            for m in matches:
                if m.get("op")!="==":raise Refused("non-equality permission predicate")
                left=m.get('left',{})
                if left.get('meta',{}).get('key')in('skuid','oifname'):observed[left['meta']['key']]=m.get('right')
                if left.get('payload',{}).get('field')in('daddr','dport'):observed[left['payload']['field']]=m.get('right')
            value=observed.get('dport');value=value.get('set')if isinstance(value,dict)else[value]
            uid=observed.get('skuid');uid=uid.get('set')if isinstance(uid,dict)else[uid]
            if observed.get('oifname')!='app0' or observed.get('daddr')!='10.203.242.2' or sorted(value or[])!=expected_ports or sorted(uid or[])!=([0]if expected_ports[0]==30328 else[0,65534]):raise Refused('shared WAN permission widened or changed')
        return True

    def proof(self,g):
        self.record(g)
        raw=self.runner("boundary",["--protocol=1","verify"],{"generation":g});proof=json.loads(raw)
        required={"protocol","generation","namespace","address","image","revision","expiresAt","residentialEgress","helperSet","stableHelpers","helperMode","sharedCapacity","oauthOwner","jobOwner","conversationState","schemaOverlap","appGeneration","appReady","drain"}
        exact(proof,required)
        if proof["helperMode"]!="existing-same-namespace" or proof["stableHelpers"] is not True:raise Refused("shared helper contract mismatch")
        if proof["generation"]!=digest(g) or proof["namespace"]!='omni-app' or proof["address"]!='10.203.242.2' or proof["image"]!=g["image"] or proof["revision"]!=g["revision"] or proof["appGeneration"]!=g["generation"] or not self.clock()<proof["expiresAt"]<=self.clock()+60:raise Refused("stale shared provenance")
        for key in ("residentialEgress","sharedCapacity","oauthOwner","jobOwner","conversationState","schemaOverlap"):
            if proof[key] is not True:raise Refused("shared overlap condition not verified")
        if proof["protocol"]!=1 or proof["helperSet"]!=g["helperSet"]:raise Refused("shared protocol/helper identity changed")
        if not (proof['appReady'] is True or proof['drain'].get('fenced') is True):raise Refused("shared app not ready")
        exact(proof['drain'],{"fenced","pendingBodies","pendingUploads","webSockets","conversationPins","upstreamLeases"})
        for key,value in proof['drain'].items():
            if key=='fenced':
                if type(value)is not bool:raise Refused("unknown drain")
            elif type(value)is not int or value<0:raise Refused("unknown lifetime counter")
        return proof


class SharedBoundary(Boundary):
    def inspect_namespace(self,g):
        shared.validate(g)
        ns=Path('/run/netns/omni-app');trusted(ns)
        boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        claim=load(Path('/run/omni-egress/public/residential-v1.json'),private=False)
        validate_attestation(claim,g,boot=boot,inode=ns.stat().st_ino,boot_ms=int(float(Path('/proc/uptime').read_text().split()[0])*1000))
        # Actual installed publisher remains responsible for its fixed topology,
        # node firewall and renewable gate; never copy/rebind its inode claim.
        trusted(Path('/etc/netns/omni-app/resolv.conf'))
        addresses=json.loads(self.adapter.runner('ip',['-j','-n','omni-app','address','show']))
        if not any(v.get('local')=='10.203.242.2'for nic in addresses for v in nic.get('addr_info',[])):raise Refused('actual APP address changed')
        self.verify_helpers(g)
        return True

    def readiness_script(self,g):return READINESS_SCRIPT.replace('127.0.0.1:20128','127.0.0.1:'+str(shared.ports(g)['dashboard']))

    def verify_helpers(self,g):
        record=self.adapter.record(g);policy=record['runtime']
        ns_inode=Path('/run/netns/omni-app').stat().st_ino
        observed=[]
        for role,enabled in (('browser',policy['helpers']['browser']),('codex',policy['helpers']['codex']),('browser-login',policy['helpers'].get('browserLogin',False))):
            if not enabled:continue
            cidfile=Path('/run/omni-local-next')/(role+'.cid');trusted(cidfile);cid=cidfile.read_text().strip()
            if not re.fullmatch(r'[a-f0-9]{64}',cid):raise Refused('invalid stable helper CID')
            rows=json.loads(self.adapter.runner('podman',['--remote=false','inspect',cid]))
            if len(rows)!=1:raise Refused('ambiguous helper')
            row=rows[0];pid=row.get('State',{}).get('Pid')
            if row.get('Id')!=cid or row.get('Image','').removeprefix('sha256:')!=policy['images'][role].removeprefix('sha256:') or row.get('State',{}).get('Running')is not True or type(pid)is not int or pid<=0 or Path('/proc',str(pid),'ns/net').stat().st_ino!=ns_inode:raise Refused('stable helper identity/namespace changed')
            if row.get('Name','').lstrip('/')!='omni-local-next-'+role:raise Refused('helper name changed')
            observed.append({'role':role,'cid':cid,'image':policy['images'][role]})
        if digest(observed)!=g['helperSet']:raise Refused('actual stable helper set differs')
        # Same-namespace browser CDP is inherently unauthenticated. It is NEVER
        # forwarded outside this boundary or misrepresented as authenticated.
        script='''const net=require("net");let pending=0;for(const port of JSON.parse(process.argv[1])){pending++;const s=net.connect(port,"127.0.0.1");s.setTimeout(1500);s.on("connect",()=>{s.destroy();if(--pending===0)process.exit(0)});s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))}if(!pending)process.exit(0);'''
        ports=[port for flag,port in ((policy['helpers']['browser'],9222),(policy['helpers']['codex'],1456))if flag]
        app_cid=Path('/run/omni-local-next/generations',g['generation'],'app.cid')
        probe_cid=app_cid.read_text().strip()if app_cid.exists()else observed[0]['cid']if observed else None
        if app_cid.exists():trusted(app_cid)
        if probe_cid:self.adapter.runner('podman',['--remote=false','exec','--user=10001:10001',probe_cid,'node','-e',script,json.dumps(ports)])

    def verify_compatibility(self,g):
        from .schemaProof import verify
        verify(self.adapter,CONFIG/'schema-proof.json')

    def verify_maintenance(self,g):
        m=self.adapter.layout['maintenance'];mg=m['generation'];shared.validate(mg,maintenance=True)
        cidfile=Path('/run/omni-local-next/maintenance',mg['generation'],'maintenance.cid');trusted(cidfile);cid=cidfile.read_text().strip()
        rows=json.loads(self.adapter.runner('podman',['--remote=false','inspect',cid]));row=rows[0]if len(rows)==1 else{}
        if row.get('State',{}).get('Running')is not True or row.get('Image','').removeprefix('sha256:')!=mg['image'].removeprefix('sha256:'):raise Refused('maintenance not actually running exact image')
        receipt=m['entryReceipt']
        for file,key,target in (('maintenance-entry.cjs','entrySha256','/app/maintenance-entry.cjs'),('maintenance-loader.mjs','loaderSha256','/app/dev/run-standalone.mjs')):
            source=Path('/opt/omni-local-next/canary-host')/file;trusted(source)
            if hashlib.sha256(source.read_bytes()).hexdigest()!=receipt[key]or not any(v.get('Source')==str(source)and v.get('Destination')==target and v.get('RW')is False for v in row.get('Mounts',[])):raise Refused('actual maintenance bundle mount changed')
        pid=row.get('State',{}).get('Pid')
        if type(pid)is not int or pid<=0 or Path('/proc',str(pid),'ns/net').stat().st_ino!=Path('/run/netns/omni-app').stat().st_ino:raise Refused('maintenance namespace changed')
        env=dict(v.split('=',1)for v in row.get('Config',{}).get('Env',[])if '='in v)
        if env.get('OMNI_COORDINATION_PROCESS_ROLE')!='maintenance' or env.get('OMNI_SHARED_ADMISSION')!='true' or env.get('OMNI_COORDINATION_DB')!='/app/data/coordination.sqlite':raise Refused('maintenance role differs')
        script=READINESS_SCRIPT.replace('127.0.0.1:20128','127.0.0.1:30328').replace('response.status!==200','![200,503].includes(response.status)')
        result=json.loads(self.adapter.runner('podman',['--remote=false','exec','--user=10001:10001','-i',cid,'node','-e',script],{'key':load(CONFIG/'readiness-key.json')['key'],'generation':mg['generation']}))
        if result.get('schema')!='omni-canary-readiness/v1' or result.get('generation')!=mg['generation'] or result.get('databaseReady')is not True or result.get('coordination',{}).get('protocol')!='omni-coordination/v1' or any(result['coordination'].get(k)is not True for k in ('accountAdmission','refreshOwnership','backgroundOwnership')):raise Refused('actual nontraffic maintenance witness failed')

    def verify(self,g,**options):
        result=super().verify(g,**options)
        if options.get('before_start') or options.get('conversation_phase')is not None:return result
        result.pop('helperForwarding');result.update(stableHelpers=True,helperMode='existing-same-namespace')
        return result
