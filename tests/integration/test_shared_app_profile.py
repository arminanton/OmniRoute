import copy
import unittest
from scripts.deploy.canary import sharedApp as s
from scripts.deploy.canary.controller import Refused,digest,validate_generation


def fixture(slot='blue'):
 g={'schema':2,'profile':s.PROFILE,'generation':('a'if slot=='blue'else'b'if slot=='green'else'c')*32,'slot':slot,'revision':'d'*40,'image':'sha256:'+'e'*64,'namespace':'omni-app','address':'10.203.242.2','stateOwner':'coordinated-live-v1','helperSet':'f'*64}
 p={'schema':1,'activation':'approved-deployment','profile':'kernel-residential-v1','images':{r:g['image']for r in ('app','browser','codex')},'helpers':{'browser':True,'codex':True}}
 r={'profile':s.PROFILE,'generation':digest(g),'namespace':'omni-app','address':'10.203.242.2','stateProtocol':'coordinated-live-v1','stableHelperSet':g['helperSet']}
 return p,g,r


class SharedProfileTests(unittest.TestCase):
 def test_separate_schema_never_relaxes_original_isolated_contract(self):
  p,g,r=fixture()
  with self.assertRaises(Refused):validate_generation(g)
  s.validate(g)
  for key,value in [('namespace','omni-app-any'),('address','10.203.250.2'),('profile','legacy'),('ports',{'api':1})]:
   wrong=copy.deepcopy(g);wrong[key]=value
   with self.assertRaises(Refused):s.validate(wrong)

 def test_three_roles_unique_fixed_ports_cids_same_actual_boundary_no_derived_receipt(self):
  seen=set()
  for slot in ('blue','green','maintenance'):
   p,g,r=fixture(slot);args=s.command(p,g,r)
   self.assertIn('--network=ns:/run/netns/omni-app',args)
   self.assertIn('--cap-drop=all',args);self.assertIn('--read-only',args);self.assertIn('--no-hosts',args)
   self.assertTrue(any('src=/run/omni-egress/public,'in arg for arg in args))
   self.assertFalse(any('/public/generations/'in arg for arg in args))
   for port in s.ports(g).values():self.assertNotIn(port,seen);seen.add(port)
   self.assertIn('--env=API_PORT='+str(s.ports(g)['api']),args)
   self.assertIn('--env=EMBED_WS_PROXY_PORT='+str(s.ports(g)['embed']),args)
   self.assertIn('--env=LIVE_WS_PORT='+str(s.ports(g)['live']),args)
   self.assertTrue(any(g['generation']in arg and'--cidfile='in arg for arg in args))
   if slot=='maintenance':self.assertIn('--env=OMNI_COORDINATION_PROCESS_ROLE=maintenance',args)

 def test_proxy_uses_exact_new_traffic_ports_and_fixed_nonroot_uid(self):
  _,g,_=fixture('green');config=s.nginx_config(g,{'dashboard':21028,'api':21029})
  self.assertIn('http://10.203.242.2:30228',config);self.assertIn('http://10.203.242.2:30229',config)
  self.assertIn('user nobody nogroup',config);self.assertIn('proxy_next_upstream off',config)
  _,m,_=fixture('maintenance')
  with self.assertRaises(Refused):s.nginx_config(m,{'dashboard':21028,'api':21029})

 def test_helper_or_image_receipt_mismatch_fails_closed(self):
  p,g,r=fixture();r['stableHelperSet']='a'*64
  with self.assertRaises(Refused):s.command(p,g,r)


if __name__=='__main__':unittest.main()
