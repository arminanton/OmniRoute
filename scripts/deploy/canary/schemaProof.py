"""Conservative read-only image/DB observer producing an exact shared-profile proof."""
from pathlib import Path
import hashlib
import json
import sqlite3
import os
import stat
from .controller import Refused,digest,exact
from .host import trusted
from .runtime import base

MIGRATIONS = r'''const fs=require('fs'),c=require('crypto');const directory='/app/migrations';const files=fs.readdirSync(directory).filter(n=>/^[a-zA-Z0-9_.-]+\.(?:sql|js|mjs|ts)$/.test(n)).sort();const result=[];for(const name of files){const p=directory+'/'+name;const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>1048576)process.exit(1);result.push({name,sha256:c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')})}console.log(JSON.stringify(result));'''


def protected_database(path):
    path=Path(path)
    if path.parent!=base.APP_DATA or path.name not in ('storage.sqlite','coordination.sqlite'):raise Refused('fixed app DB only')
    base.check_app_data()
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode)or info.st_nlink!=1 or info.st_uid!=base.UID or info.st_gid!=base.GID or info.st_mode&0o022:raise Refused('invalid app DB provenance')
    return path


def database_schema(path):
    path=protected_database(path)
    db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True,timeout=2)
    try:
        rows=db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchall()
        return digest(rows)
    finally:db.close()


def produce(adapter):
    images=[];chains=[]
    for record in sorted(adapter.records.values(),key=lambda r:r['generation']['generation']):
        g=record['generation']
        inspected=json.loads(adapter.runner('podman',['--remote=false','image','inspect',g['image']]))
        if len(inspected)!=1 or inspected[0].get('Labels',{}).get('org.opencontainers.image.revision')!=g['revision']:raise Refused('schema image revision mismatch')
        # No app import/credentials/network/persistent mounts; one bounded readonly observer.
        rows=json.loads(adapter.runner('podman',['--remote=false','run','--rm','--network=none','--user=10001:10001','--read-only','--cap-drop=all','--security-opt=no-new-privileges','--entrypoint=/usr/bin/env',g['image'],'node','-e',MIGRATIONS]))
        if not rows or len(rows)>4096:raise Refused('image has no bounded migration chain')
        chains.append(rows);images.append({'descriptor':digest(g),'image':g['image'],'revision':g['revision']})
    # Different SQL chains require a separate actual expand/contract review;
    # this conservative producer never equates prefix append with safe overlap.
    if chains[0]!=chains[1]:raise Refused('different migrations require explicit reviewed compatibility')
    coordinator=protected_database(Path(base.APP_DATA)/'coordination.sqlite')
    db=sqlite3.connect('file:'+str(coordinator)+'?mode=ro',uri=True,timeout=2)
    try:versions=[r[0]for r in db.execute('SELECT version FROM coordination_protocol').fetchall()]
    finally:db.close()
    if versions!=['omni-coordination/v1']:raise Refused('actual shared DB protocol differs')
    return {'schema':'omni-shared-schema-proof/v1','pair':sorted(adapter.records), 'images':images,
            'migrationChainSha256':digest(chains[0]),'migrationCount':len(chains[0]),
            'databaseSchemaSha256':database_schema(Path(base.APP_DATA)/'storage.sqlite'),
            'coordinationProtocol':'omni-coordination/v1','stateProtocol':'coordinated-live-v1',
            'disposition':'identical-migration-chains'}


def verify(adapter,path):
    path=Path(path);trusted(path)
    raw=path.read_bytes()
    if len(raw)>65536 or hashlib.sha256(raw).hexdigest()!=adapter.layout['schemaProofSha256']:raise Refused('schema proof bytes missing or changed')
    proof=json.loads(raw)
    exact(proof,{'schema','pair','images','migrationChainSha256','migrationCount','databaseSchemaSha256','coordinationProtocol','stateProtocol','disposition'})
    images=[{'descriptor':digest(r['generation']),'image':r['generation']['image'],'revision':r['generation']['revision']}for r in sorted(adapter.records.values(),key=lambda r:r['generation']['generation'])]
    if proof['schema']!='omni-shared-schema-proof/v1' or proof['pair']!=sorted(adapter.records) or proof['images']!=images or proof['coordinationProtocol']!='omni-coordination/v1' or proof['stateProtocol']!='coordinated-live-v1' or proof['disposition']!='identical-migration-chains':raise Refused('schema proof binds different cohort')
    if proof['databaseSchemaSha256']!=database_schema(Path(base.APP_DATA)/'storage.sqlite'):raise Refused('observed database schema changed')
    return proof
