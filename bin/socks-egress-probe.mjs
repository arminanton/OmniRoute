#!/usr/bin/env node
// Dependency-free SOCKS5 egress probe. Connects through a SOCKS5 proxy to
// api.ipify.org:80 and prints the observed public IP. Proves what residential
// IP the proxy egresses from. Usage: node socks-egress-probe.mjs [host] [port]
import net from 'node:net';

const PROXY_HOST = process.argv[2] || '127.0.0.1';
const PROXY_PORT = parseInt(process.argv[3] || '1055', 10);
const TARGET_HOST = 'api.ipify.org';
const TARGET_PORT = 80;

function fail(msg) { console.log('PROBE_FAIL:', msg); process.exit(1); }

const sock = net.connect(PROXY_PORT, PROXY_HOST);
sock.setTimeout(15000);
sock.on('timeout', () => fail('timeout'));
sock.on('error', (e) => fail(e.message));

let stage = 'greet';
sock.on('connect', () => {
  // greeting: VER=5, NMETHODS=1, METHOD=0 (no auth)
  sock.write(Buffer.from([0x05, 0x01, 0x00]));
});

let buf = Buffer.alloc(0);
sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (stage === 'greet') {
    if (buf.length < 2) return;
    if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('no-auth method rejected: ' + buf.slice(0,2).toString('hex'));
    buf = buf.slice(2);
    // CONNECT: VER=5 CMD=1 RSV=0 ATYP=3(domain) LEN host PORT
    const host = Buffer.from(TARGET_HOST, 'ascii');
    const req = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
      host,
      Buffer.from([(TARGET_PORT >> 8) & 0xff, TARGET_PORT & 0xff]),
    ]);
    stage = 'connect';
    sock.write(req);
    return;
  }
  if (stage === 'connect') {
    if (buf.length < 2) return;
    if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('CONNECT failed, REP=0x' + buf[1].toString(16));
    // consume the bind addr reply (variable); simplest: assume rest arrives, then send HTTP
    buf = Buffer.alloc(0);
    stage = 'http';
    sock.write(`GET / HTTP/1.1\r\nHost: ${TARGET_HOST}\r\nUser-Agent: egress-probe\r\nConnection: close\r\n\r\n`);
    return;
  }
  if (stage === 'http') {
    // accumulate; body after headers is the IP
  }
});

sock.on('close', () => {
  if (stage !== 'http') return;
  const txt = buf.toString('utf8');
  const parts = txt.split('\r\n\r\n');
  const body = (parts[1] || '').trim();
  console.log('EGRESS_IP:', body || '(empty)');
});
