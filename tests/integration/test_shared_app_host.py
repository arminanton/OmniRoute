import json
import unittest
import tempfile
import hashlib
from pathlib import Path
from unittest.mock import patch
from scripts.deploy.canary.sharedAppHost import SharedAdapter
from scripts.deploy.canary.controller import Refused,digest
from scripts.deploy.canary import schemaProof


class SharedHostTests(unittest.TestCase):
 def adapter(self,rules):
  a=object.__new__(SharedAdapter);a.layout={'approvalDigest':'a'*64};a.runner=lambda *_:json.dumps({'nftables':[{'rule':r}for r in rules]});return a
 def rule(self,maintenance=False,uid=None,ports=None):
  return {'comment':'omni-shared-app:'+'a'*32+(':maintenance'if maintenance else''),'expr':[
   {'match':{'op':'==','left':{'meta':{'key':'skuid'}},'right':0 if maintenance else{'set':uid or[0,65534]}}},
   {'match':{'op':'==','left':{'meta':{'key':'oifname'}},'right':'app0'}},
   {'match':{'op':'==','left':{'payload':{'protocol':'ip','field':'daddr'}},'right':'10.203.242.2'}},
   {'match':{'op':'==','left':{'payload':{'protocol':'tcp','field':'dport'}},'right':{'set':ports or([30328,30329]if maintenance else[30128,30129,30228,30229])}}},
   {'counter':{'packets':1,'bytes':1}},{'accept':None}]}
 def test_exact_two_narrow_rules_observed(self):self.assertTrue(self.adapter([self.rule(),self.rule(True)]).observe_port_rules())
 def test_partial_duplicate_wronguid_wrongport_or_nonequality_rejected(self):
  cases=[[self.rule()], [self.rule(),self.rule(True),self.rule()], [self.rule(uid=[0,10001,65534]),self.rule(True)],[self.rule(ports=[22,30128,30129,30228,30229]),self.rule(True)]]
  wrong=self.rule();wrong['expr'][0]['match']['op']='!=';cases.append([wrong,self.rule(True)])
  for rules in cases:
   with self.assertRaises(Refused):self.adapter(rules).observe_port_rules()
 def test_schema_proof_missing_wrongbytes_or_othercohort_rejected(self):
  a=object.__new__(SharedAdapter);a.records={'a'*32:{'generation':{'image':'sha256:'+'c'*64,'revision':'b'*40}}};a.layout={'schemaProofSha256':'a'*64}
  with tempfile.TemporaryDirectory() as root:
   p=Path(root)/'proof.json'
   with patch.object(schemaProof,'trusted',lambda *_:None):
    with self.assertRaises(FileNotFoundError):schemaProof.verify(a,p)
    p.write_text('{}')
    with self.assertRaises(Refused):schemaProof.verify(a,p)
 def test_schema_proof_otherimage_pair_or_observed_schema_refused(self):
  a=object.__new__(SharedAdapter);g={'generation':'a'*32,'image':'sha256:'+'c'*64,'revision':'b'*40};a.records={'a'*32:{'generation':g}};a.layout={}
  record={'schema':'omni-shared-schema-proof/v1','pair':['a'*32],'images':[{'descriptor':digest(g),'image':g['image'],'revision':g['revision']}],'migrationChainSha256':'d'*64,'migrationCount':167,'databaseSchemaSha256':'e'*64,'coordinationProtocol':'omni-coordination/v1','stateProtocol':'coordinated-live-v1','disposition':'identical-migration-chains'}
  with tempfile.TemporaryDirectory()as root:
   p=Path(root)/'proof.json'
   for key,value in [('pair',['f'*32]),('images',[]),('databaseSchemaSha256','f'*64)]:
    changed=dict(record);changed[key]=value;raw=json.dumps(changed).encode();p.write_bytes(raw);a.layout['schemaProofSha256']=hashlib.sha256(raw).hexdigest()
    with patch.object(schemaProof,'trusted',lambda *_:None),patch.object(schemaProof,'database_schema',lambda _:'e'*64):
     with self.assertRaises(Refused):schemaProof.verify(a,p)

 def test_schema_producer_refuses_changed_migration_chain(self):
  a=object.__new__(SharedAdapter);a.records={'a':{'generation':{'generation':'a'*32,'image':'sha256:'+'a'*64,'revision':'b'*40}},'b':{'generation':{'generation':'b'*32,'image':'sha256:'+'b'*64,'revision':'c'*40}}};calls=0
  def run(_kind,args):
   nonlocal calls
   if 'inspect'in args:return json.dumps([{'Labels':{'org.opencontainers.image.revision':'b'*40 if args[-1].endswith('a'*64)else'c'*40}}])
   calls+=1;return json.dumps([{'name':'001.sql','sha256':('a'if calls==1 else'b')*64}])
  a.runner=run
  with self.assertRaises(Refused):schemaProof.produce(a)


if __name__=='__main__':unittest.main()
