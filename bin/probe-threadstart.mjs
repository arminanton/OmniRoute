import net from 'node:net'; import crypto from 'node:crypto';
const host='127.0.0.1', port=1456, token=process.env.WSTOKEN;
const key=crypto.randomBytes(16).toString('base64');
const sock=net.connect(port,host,()=>{sock.write(`GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`);});
let hs=false,buf=Buffer.alloc(0);
function send(o){const p=Buffer.from(JSON.stringify(o));const l=p.length;let h;if(l<126)h=Buffer.from([0x81,0x80|l]);else{h=Buffer.from([0x81,0x80|126,(l>>8)&0xff,l&0xff]);}const m=crypto.randomBytes(4);const mk=Buffer.alloc(l);for(let i=0;i<l;i++)mk[i]=p[i]^m[i%4];sock.write(Buffer.concat([h,m,mk]));}
function frames(){while(buf.length>=2){let len=buf[1]&0x7f,off=2;if(len===126){len=buf.readUInt16BE(2);off=4;}else if(len===127){len=Number(buf.readBigUInt64BE(2));off=10;}if(buf.length<off+len)break;const pl=buf.slice(off,off+len);buf=buf.slice(off+len);if(pl.length)msg(pl.toString());}}
function msg(t){let m;try{m=JSON.parse(t);}catch{return;}
  if(m.method){console.log('NOTIF/REQ method='+m.method+(m.id!==undefined?' id='+m.id:''));if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{decision:'approved'}});return;}
  if(m.id!==undefined&&(m.result!==undefined||m.error)){console.log('RESP id='+m.id+' result='+JSON.stringify(m.result||m.error));if(m.id===2){console.log('>>> thread/start result keys: '+(m.result?JSON.stringify(Object.keys(m.result)):'none'));process.exit(0);}}}
sock.on('data',c=>{if(!hs){buf=Buffer.concat([buf,c]);const i=buf.indexOf('\r\n\r\n');if(i<0)return;hs=true;buf=buf.slice(i+4);send({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'p',version:'1'},capabilities:null}});setTimeout(()=>send({jsonrpc:'2.0',id:2,method:'thread/start',params:{cwd:'/tmp',approvalPolicy:'never',sandbox:'danger-full-access'}}),600);frames();return;}buf=Buffer.concat([buf,c]);frames();});
setTimeout(()=>{console.log('timeout');process.exit(0);},15000);
