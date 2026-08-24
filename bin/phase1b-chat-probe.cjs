// PHASE 1b-2 — live CHAT probe: does a BARE /gpt/cwc/chat (no upsert bookkeeping,
// fresh conversation_id, just model_name) produce a real answer? Determines
// whether the meta.AIProvider bookkeeping is required. Natural prompt, paced.
const crypto = require("node:crypto");
const fs = require("node:fs");
const wreq = require("/app/node_modules/wreq-js");

const PROXY = "http://ts-egress:3128";
const APP_VERSION = "webpage_8.18.0";
const HMAC_SECRET = process.env.MX_HMAC, AES_PASS = process.env.MX_AES;
const CTX_KEY = "3c86e26ccbb7274f752e7d868a1541ebfb7f37e7";
const BLANK = new Set(["/oauth/signin_with_email","/oauth/signin_with_google","/oauth/verify_secret_code"]);

const hmacSha1Hex=(m,k)=>crypto.createHmac("sha1",Buffer.from(k,"utf8")).update(Buffer.from(m,"utf8")).digest("hex");
const sm3Hex=(m)=>crypto.createHash("sm3").update(Buffer.from(m,"utf8")).digest("hex");
function evp(p,s,kl=32,il=16){let d=Buffer.alloc(0),b=Buffer.alloc(0);while(d.length<kl+il){b=crypto.createHash("md5").update(Buffer.concat([b,Buffer.from(p,"utf8"),s])).digest();d=Buffer.concat([d,b]);}return{key:d.subarray(0,kl),iv:d.subarray(kl,kl+il)};}
function aesEnc(pt,p){const s=crypto.randomBytes(8);const{key,iv}=evp(p,s);const c=crypto.createCipheriv("aes-256-cbc",key,iv);const body=Buffer.concat([c.update(Buffer.from(pt,"utf8")),c.final()]);return Buffer.concat([Buffer.from("Salted__","ascii"),s,body]).toString("base64");}
function computeP(path,t,uid){path=path.endsWith("?")?path.slice(0,-1):path;const u=BLANK.has(path)?"":uid;const s=`${APP_VERSION}:${t}:${path}:${u}`;return sm3Hex(`${t}:${hmacSha1Hex(s,`${t}:${HMAC_SECRET}`)}:${HMAC_SECRET}`);}
function signHeaders(path,userId,deviceId){const t=Date.now();const rnd=String((crypto.randomBytes(4).readUInt32BE(0)%900000)+100000);const payload={"X-Client-Domain":"maxai.co","X-Client-Path":"https://www.maxai.co/app/","X-Random":rnd,"t":t,"p":computeP(path,t,userId),"d":deviceId,[CTX_KEY]:{"a":""}};return {"X-Browser-Name":"Firefox","X-Browser-Version":"150.0","X-Browser-Major":"150","X-App-Version":APP_VERSION,"X-App-Env":"MaxAI-Browser-Extension","X-Authorization":aesEnc(JSON.stringify(payload),AES_PASS)};}

const CHAT_ORDER=["chat_mode","conversation_id","chat_history","message_content","chrome_extension_version","model_name","prompt_id","prompt_name","prompt_inputs","doc_list","event_source","streaming","prompt_type","feature_name","source_type","platform_feature"];
function buildChatBody(convId, text, model){const v={chat_mode:"pro_chat",conversation_id:convId,chat_history:[],message_content:[{type:"text",text}],chrome_extension_version:"webpage_8.18.0",model_name:model,prompt_id:"chat",prompt_name:"chat",prompt_inputs:{RELATED_QUESTION_CNT:"5",AI_RESPONSE_LANGUAGE:"English"},doc_list:[],event_source:"web",streaming:true,prompt_type:"freestyle",feature_name:"immersive_chat",source_type:"NA",platform_feature:"web_app"};const o={};for(const k of CHAT_ORDER)o[k]=v[k];return o;}

const staticHeaders={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0","Accept":"*/*","Accept-Language":"en-CA,en;q=0.9","Origin":"https://www.maxai.co","Referer":"https://www.maxai.co/","Sec-Fetch-Dest":"empty","Sec-Fetch-Mode":"cors","Sec-Fetch-Site":"cross-site","Content-Type":"application/json"};

// UUIDv4
function uuid(){return crypto.randomUUID();}

async function chat(browser, model, prompt) {
  const cred = JSON.parse(fs.readFileSync("/tmp/maxai_probe_cred.json","utf8"));
  const deviceId = cred.device_id.replace(/^"|"$/g,"");
  const path = "/gpt/cwc/chat";
  const signed = signHeaders(path, cred.user_id, deviceId);
  const headers = { ...staticHeaders, ...signed, "Authorization": "Bearer " + cred.access_token };
  const body = buildChatBody(uuid(), prompt, model);
  try {
    const res = await wreq.fetch("https://api.maxai.me" + path, { browser, os:"windows", proxy: PROXY, method:"POST", headers, body: JSON.stringify(body) });
    if (res.status !== 200) { const t = await res.text(); return { status: res.status, body: t.slice(0,200) }; }
    // SSE: collect text deltas (data_key==text && need_merge)
    const raw = await res.text();
    let out = "";
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const js = s.slice(5).trim();
      if (!js || js === "[DONE]") continue;
      try { const f = JSON.parse(js); if (f.data_key === "text" && f.need_merge) out += (f.text || ""); } catch {}
    }
    return { status: 200, answer: out };
  } catch (e) { return { error: e.message }; }
}

(async () => {
  // Natural, human-plausible prompt (NOT a bot-y "say hi")
  const prompt = "In two sentences, what's the difference between TCP and UDP?";
  const r = await chat("firefox_150", "gpt-5.6", prompt);
  console.log("[gpt-5.6] status:", r.status || r.error);
  if (r.answer !== undefined) {
    // split <think>
    const m = r.answer.match(/^([\s\S]*?)<\/think>([\s\S]*)$/);
    const reasoning = m ? m[1].replace(/<think>/,"").trim() : "";
    const answer = m ? m[2].trim() : r.answer.trim();
    if (reasoning) console.log("  <reasoning len>:", reasoning.length);
    console.log("  ANSWER:", answer.slice(0, 400));
  } else if (r.body) console.log("  body:", r.body);
})();
