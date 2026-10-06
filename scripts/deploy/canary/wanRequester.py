"""Bounded actual frontdoor requester in the verified existing WAN namespace."""
from pathlib import Path
import json
from urllib.parse import urlsplit
from .controller import Refused
from .host import trusted

SCRIPT = r'''
import json,sys,urllib.request,urllib.error,time
x=json.loads(sys.stdin.read(16385));headers={'Accept':'application/json','Cache-Control':'no-cache'}
if x['key'] is not None:headers['Authorization']='Bearer '+x['key']
data=None
if x['body'] is not None:data=json.dumps(x['body']).encode();headers['Content-Type']='application/json'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):return None
r=urllib.request.Request(x['url'],data=data,headers=headers,method=x['method'])
try:
 try:response=urllib.request.build_opener(NoRedirect()).open(r,timeout=x['timeout'])
 except urllib.error.HTTPError as error:response=error
 with response:
  raw=response.read(x['max_bytes']+1)
  if len(raw)>x['max_bytes']:raise ValueError()
  if x['marker']:body=raw.decode('ascii')
  else:
   body=json.loads(raw)
   if '/v1/models?'in x['url'] and isinstance(body,dict)and isinstance(body.get('data'),list):
    # Retain the actual semantic model-list contract, never user descriptions.
    body={'object':body.get('object'),'data':[{'id':row.get('id'),'object':row.get('object')}for row in body['data']if isinstance(row,dict)]}
  print(json.dumps({'status':response.status,'generation':response.headers.get('X-Omni-App-Generation'),'body':body}))
except Exception:sys.exit(1)
'''


def request(adapter,url,key,*,method='GET',body=None,timeout=3,max_bytes=4*1024*1024,marker=False):
    target=urlsplit(url)
    if target.scheme!='http' or target.hostname!='127.0.0.1' or target.port not in(21028,21029) or target.username or target.password or target.fragment:raise Refused('fixed WAN frontdoor only')
    valid=(method=='GET'and target.path in('/_omni_generation','/api/canary-readiness','/v1/models'))or(method=='POST'and target.path=='/v1/session-leases'and body=={'action':'status','generation':1})
    if not valid or not 0<timeout<=5 or not 0<max_bytes<=4*1024*1024:raise Refused('unknown namespace request operation')
    ns=Path('/run/netns/omni-wan');trusted(ns);inode=ns.stat().st_ino
    boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    payload={'url':url,'key':key,'method':method,'body':body,'timeout':timeout,'max_bytes':max_bytes,'marker':marker}
    raw=adapter.runner('ip',['netns','exec','omni-wan','/usr/bin/python3.12','-I','-c',SCRIPT],payload)
    if ns.stat().st_ino!=inode or Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=boot:raise Refused('WAN namespace changed during probe')
    result=json.loads(raw)
    if set(result)!={'status','generation','body'}:raise Refused('invalid namespace response')
    return result
