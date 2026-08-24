// Probe the live codex app-server: model/list (ground truth) + turn/start with
// an OmniRoute alias vs a real base model, to prove which model IDs the real
// codex accepts. Raw-node ws JSON-RPC client (no deps).
const net = require("net"), crypto = require("crypto"), fs = require("fs");
const host = "127.0.0.1", port = 1456;
const tok = fs.readFileSync("/run/ws-token", "utf8").trim();
const key = crypto.randomBytes(16).toString("base64"), CRLF = String.fromCharCode(13, 10);
const authHdr = ["Authorization:", "Bearer", tok].join(" ");
const lines = ["GET / HTTP/1.1", "Host: " + host + ":" + port, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: " + key, "Sec-WebSocket-Version: 13", authHdr, "", ""];
const s = net.connect(port, host, () => s.write(lines.join(CRLF)));
let hs = false, buf = Buffer.alloc(0);
const log = (...a) => console.log(...a);
function send(o) { const p = Buffer.from(JSON.stringify(o)), l = p.length; let h = l < 126 ? Buffer.from([0x81, 0x80 | l]) : Buffer.from([0x81, 0x80 | 126, (l >> 8) & 255, l & 255]); const m = crypto.randomBytes(4), k = Buffer.alloc(l); for (let i = 0; i < l; i++) k[i] = p[i] ^ m[i % 4]; s.write(Buffer.concat([h, m, k])); }
function fr() { while (buf.length >= 2) { let len = buf[1] & 127, off = 2; if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; } if (buf.length < off + len) break; const pl = buf.slice(off, off + len); buf = buf.slice(off + len); if (pl.length) mg(pl.toString()); } }
function mg(t) {
  let m; try { m = JSON.parse(t); } catch { return; }
  // auto-approve any server->client request so nothing stalls
  if (m.method && m.id != null) send({ jsonrpc: "2.0", id: m.id, result: { decision: "approved" } });
  if (m.id === 10) { // model/list result
    const models = (m.result && (m.result.models || m.result.items || m.result)) || m.result;
    log("=== model/list RESULT ===");
    log(JSON.stringify(models, null, 2));
    // now start a thread to test turn model acceptance
    send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: "/tmp", approvalPolicy: "never", sandbox: "danger-full-access" } });
  }
  if (m.id === 10 && m.error) { log("model/list ERR " + JSON.stringify(m.error)); send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: "/tmp", approvalPolicy: "never", sandbox: "danger-full-access" } }); }
  if (m.id === 2 && m.result) {
    const tid = m.result.thread.id;
    log("threadId=" + tid + " default model=" + m.result.model);
    // TEST 1: OmniRoute synthetic alias (what the executor currently sends)
    log(">>> TEST turn with model='gpt-5.6-sol-high' (OmniRoute alias)");
    send({ jsonrpc: "2.0", id: 31, method: "turn/start", params: { threadId: tid, input: [{ type: "text", text: "hi", text_elements: [] }], model: "gpt-5.6-sol-high" } });
    global.__tid = tid;
  }
  if (m.id === 31) {
    if (m.error) log("ALIAS turn/start ERR: " + JSON.stringify(m.error));
    else log("ALIAS turn/start ACCEPTED: " + JSON.stringify(m.result).slice(0, 200));
    // TEST 2: real base model + separate effort
    log(">>> TEST turn with model='gpt-5.6-sol' effort='high' (base + effort)");
    send({ jsonrpc: "2.0", id: 32, method: "turn/start", params: { threadId: global.__tid, input: [{ type: "text", text: "hi", text_elements: [] }], model: "gpt-5.6-sol", effort: "high" } });
  }
  if (m.id === 32) {
    if (m.error) log("BASE turn/start ERR: " + JSON.stringify(m.error));
    else log("BASE turn/start ACCEPTED: " + JSON.stringify(m.result).slice(0, 200));
  }
  if (m.method === "error" || m.method === "warning") log("*** " + m.method.toUpperCase() + ": " + JSON.stringify(m.params).slice(0, 300));
}
s.on("data", c => { if (!hs) { buf = Buffer.concat([buf, c]); const i = buf.indexOf(CRLF + CRLF); if (i < 0) return; hs = true; buf = buf.slice(i + 4); send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "probe", version: "1" }, capabilities: null } }); send({ jsonrpc: "2.0", id: 10, method: "model/list", params: {} }); fr(); return; } buf = Buffer.concat([buf, c]); fr(); });
s.on("error", e => log("SOCKERR " + e.message));
setTimeout(() => process.exit(0), 25000);
