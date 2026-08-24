const net=require("net"),crypto=require("crypto"),fs=require("fs");
const host="127.0.0.1",port=1456;
const tok=fs.readFileSync("/run/ws-token","utf8").trim();
const key=crypto.randomBytes(16).toString("base64"),CRLF=String.fromCharCode(13,10);
const lines=["GET / HTTP/1.1","Host: "+host+":"+port,"Upgrade: websocket","Connection: Upgrade","Sec-WebSocket-Key: "+key,"Sec-WebSocket-Version: 13","Authorization: Bearer "+tok,"",""];
const s=net.connect(port,host,()=>s.write(lines.join(CRLF)));
let hs=false,buf=Buffer.alloc(0),tid="";
function send(o){const p=Buffer.from(JSON.stringify(o)),l=p.length;let h=l<126?Buffer.from([0x81,0x80|l]):Buffer.from([0x81,0x80|126,(l>>8)&255,l&255]);const m=crypto.randomBytes(4),k=Buffer.alloc(l);for(let i=0;i<l;i++)k[i]=p[i]^m[i%4];s.write(Buffer.concat([h,m,k]));}
function fr(){while(buf.length>=2){let len=buf[1]&127,off=2;if(len===126){len=buf.readUInt16BE(2);off=4;}else if(len===127){len=Number(buf.readBigUInt64BE(2));off=10;}if(buf.length<off+len)break;const pl=buf.slice(off,off+len);buf=buf.slice(off+len);if(pl.length)mg(pl.toString());}}
function mg(t){let m;try{m=JSON.parse(t);}catch{return;}
  if(m.method==="error"||m.method==="warning"){console.log("*** "+m.method.toUpperCase()+": "+JSON.stringify(m.params));}
  if(m.method==="item/completed"){const it=m.params&&m.params.item;console.log("ITEM type="+(it&&it.type)+" : "+JSON.stringify(it).slice(0,400));}
  if(m.method&&m.id!=null)send({jsonrpc:"2.0",id:m.id,result:{decision:"approved"}});
  if(m.id===1)send({jsonrpc:"2.0",id:2,method:"thread/start",params:{cwd:"/tmp",approvalPolicy:"never",sandbox:"danger-full-access"}});
  if(m.id===2){tid=m.result.thread.id;console.log("threadId="+tid+" model="+m.result.model);send({jsonrpc:"2.0",id:3,method:"turn/start",params:{threadId:tid,input:[{type:"text",text:"Say hello in 3 words",text_elements:[]}]}});}
  if(m.id===3&&m.error)console.log("turn/start ERR "+JSON.stringify(m.error));
}
s.on("data",c=>{if(!hs){buf=Buffer.concat([buf,c]);const i=buf.indexOf(CRLF+CRLF);if(i<0)return;hs=true;buf=buf.slice(i+4);send({jsonrpc:"2.0",id:1,method:"initialize",params:{clientInfo:{name:"d",version:"1"},capabilities:null}});fr();return;}buf=Buffer.concat([buf,c]);fr();});
s.on("error",e=>console.log("SOCKERR "+e.message));
setTimeout(()=>process.exit(0),30000);
