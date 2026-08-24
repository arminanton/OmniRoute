import net from 'node:net'; import crypto from 'node:crypto';
const host='127.0.0.1', port=1456, tok=process.env.WSTOKEN;
const key=crypto.randomBytes(16).toString('base64');
const CRLF=String.fromCharCode(13,10);
const reqLines=['GET / HTTP/1.1','Host: '+host+':'+port,'Upgrade: websocket','Connection: Upgrade','Sec-WebSocket-Key: '+key,'Sec-WebSocket-Version: 13','Authorization: Bearer '+tok,'',''];
const sock=net.connect(port,host,()=>{sock.write(reqLines.join(CRLF));});
let hs=false,buf=Buffer.alloc(0),sawText='',methods=new Set();
function send(o){const p=Buffer.from(JSON.stringify(o));const l=p.length;let h;if(l<126)h=Buffer.from([0x81,0x80|l]);else if(l<65536){h=Buffer.from([0x81,0x80|126,(l>>8)&0xff,l&0xff]);}else{h=Buffer.alloc(10);h[0]=0x81;h[1]=0x80|127;h.writeUInt32BE(l,6);}const m=crypto.randomBytes(4);const mk=Buffer.alloc(l);for(let i=0;i<l;i++)mk[i]=p[i]^m[i%4];sock.write(Buffer.concat([h,m,mk]));}
function frames(){while(buf.length>=2){let len=buf[1]&0x7f,off=2;if(len===126){len=buf.readUInt16BE(2);off=4;}else if(len===127){len=Number(buf.readBigUInt64BE(2));off=10;}if(buf.length<off+len)break;const pl=buf.slice(off,off+len);buf=buf.slice(off+len);if(pl.length)msg(pl.toString());}}
let threadId='';
function msg(t){let m;try{m=JSON.parse(t);}catch{return;}
  if(m.method){methods.add(m.method);
    if(m.method==='item/agentMessage/delta'&&m.params&&m.params.delta){sawText+=m.params.delta;process.stdout.write(m.params.delta);}
    if(m.id!==undefined&&m.id!==null){send({jsonrpc:'2.0',id:m.id,result:{decision:'approved'}});}
    if(m.method.indexOf('turn/completed')>=0||m.method.indexOf('turn.completed')>=0){console.log(CRLF+'[TURN COMPLETED] methods: '+[...methods].join(', '));finish();}
    return;}
  if(m.id===1){console.log('[initialize OK]');send({jsonrpc:'2.0',id:2,method:'thread/start',params:{cwd:'/tmp',approvalPolicy:'never',sandbox:'danger-full-access'}});}
  if(m.id===2){threadId=(m.result&&m.result.thread&&m.result.thread.id)||'';console.log('[thread/start OK] threadId='+threadId+' model='+(m.result&&m.result.model));send({jsonrpc:'2.0',id:3,method:'turn/start',params:{threadId,input:[{type:'text',text:'Reply with exactly the token: RESIDENTIAL-CODEX-OK',text_elements:[]}]}});console.log('[turn/start sent]');}
  if(m.id===3&&m.error){console.log('[turn/start ERROR] '+JSON.stringify(m.error));finish();}
  if(m.id===3&&m.result!==undefined){console.log('[turn/start accepted]');}}
sock.on('data',c=>{if(!hs){buf=Buffer.concat([buf,c]);const i=buf.indexOf(CRLF+CRLF);if(i<0)return;hs=true;buf=buf.slice(i+4);send({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'smoke',version:'1'},capabilities:null}});frames();return;}buf=Buffer.concat([buf,c]);frames();});
let done=false;function finish(){if(done)return;done=true;console.log(CRLF+'[RESULT] textlen='+sawText.length+' '+(sawText.indexOf('RESIDENTIAL-CODEX-OK')>=0?'GOT-EXPECTED-TOKEN':(sawText.length>0?'GOT-SOME-TEXT':'NO-TEXT')));try{sock.end();}catch{}process.exit(0);}
setTimeout(()=>{console.log(CRLF+'[TIMEOUT] methods: '+[...methods].join(', '));finish();},80000);
sock.on('error',e=>{console.log('SOCKERR '+e.message);process.exit(1);});
