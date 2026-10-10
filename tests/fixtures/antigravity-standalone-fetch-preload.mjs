/**
 * Test-only egress fence for the built standalone Antigravity HTTP harness.
 * Next bundles Undici into the route chunks, so fetch-wrapper interception is
 * not the security boundary. This preload also fences DNS, TCP, TLS and UDP.
 * Only loopback and the four synthetic test origins may reach a socket.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";

const bridgePort = Number(process.env.OMNIROUTE_TEST_CLOUDCODE_BRIDGE_PORT);
const auditDirectory = process.env.OMNIROUTE_TEST_FETCH_AUDIT_DIR;
const testCaFile = process.env.NODE_EXTRA_CA_CERTS;
if (
  !Number.isInteger(bridgePort) ||
  bridgePort <= 0 ||
  bridgePort > 65_535 ||
  !auditDirectory ||
  !testCaFile ||
  !fs.existsSync(testCaFile)
) {
  throw new Error(
    "standalone socket fence requires a loopback TLS bridge, audit directory and test CA"
  );
}

const standaloneRequire = createRequire(
  path.join(process.cwd(), "__standalone_test_socket_fence__.cjs")
);
const net = standaloneRequire("node:net");
const dns = standaloneRequire("node:dns");
const tls = standaloneRequire("node:tls");
const dgram = standaloneRequire("node:dgram");
const nativeFetch = globalThis.fetch.bind(globalThis);
const nativeSocketConnect = net.Socket.prototype.connect;
const nativeTlsConnect = tls.connect.bind(tls);
const LOOPBACK_HOST = "127.0.0.1";
const SYNTHETIC_DNS_HOST = "127.0.0.2";
const IDE_VERSION_URL =
  "https://antigravity-auto-updater-974169037036.us-central1.run.app/releases";
const CLI_VERSION_URL =
  "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest";
const cloudCodeHosts = new Set([
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
]);
const versionHosts = new Set([
  "antigravity-auto-updater-974169037036.us-central1.run.app",
  "api.github.com",
]);
const syntheticHosts = new Set([...cloudCodeHosts, ...versionHosts]);
const bridgeOrigin = new URL(`https://${LOOPBACK_HOST}:${bridgePort}`);
const auditStartedAt = process.hrtime.bigint();
let audit = makeAudit();
let undici;
let originalUndiciFetch;
let nativeUndiciFetch;

function makeAudit() {
  return {
    cloudCodeFetchRewrites: 0,
    syntheticVersionResponses: 0,
    cloudCodeDnsRedirects: 0,
    cloudCodeTlsRoutes: 0,
    cloudCodeSocketRoutes: 0,
    loopbackSockets: 0,
    blockedFetches: 0,
    blockedDnsLookups: 0,
    blockedSockets: 0,
    blockedSocketReasons: {
      unixDomain: 0,
      unexpectedSyntheticPort: 0,
      reservedSentinel: 0,
      nonLoopbackTcp: 0,
      unsupportedTcp: 0,
      unexpectedSyntheticTlsPort: 0,
      nonLoopbackTls: 0,
      unsupportedTls: 0,
    },
    blockedSocketTargets: [],
    blockedDatagrams: 0,
    tcpSocketErrors: 0,
    tlsSocketErrors: 0,
    socketInformationalEvents: 0,
    socketErrorsByCode: {},
    socketErrorsByMessage: {},
    socketErrorEvents: [],
    preloadLocalTlsSelfChecks: 0,
  };
}

function recordSocketError(transport, error) {
  const rawCode = typeof error?.code === "string" ? error.code : "";
  if (rawCode === "UND_ERR_INFO") {
    audit.socketInformationalEvents++;
    return;
  }
  const code = /^(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_[A-Z0-9_]{1,48})$/.test(rawCode)
    ? rawCode
    : "other";
  if (transport === "tls") audit.tlsSocketErrors++;
  else audit.tcpSocketErrors++;
  const key = `${transport}:${code}`;
  audit.socketErrorsByCode[key] = (audit.socketErrorsByCode[key] || 0) + 1;
  const message =
    String(error?.message || "unspecified")
      .replace(/https?:\/\/[^\s)"']+/gi, "[url]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
      .replace(/:\d{1,5}\b/g, ":[port]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "unspecified";
  let messageKey = `${transport}:${message}`;
  if (!Object.hasOwn(audit.socketErrorsByMessage, messageKey)) {
    if (Object.keys(audit.socketErrorsByMessage).length >= 16) messageKey = `${transport}:other`;
  }
  audit.socketErrorsByMessage[messageKey] = (audit.socketErrorsByMessage[messageKey] || 0) + 1;
  if (audit.socketErrorEvents.length < 32) {
    audit.socketErrorEvents.push({
      transport,
      code,
      message,
      timestamp: Date.now(),
      elapsedMs: Number(process.hrtime.bigint() - auditStartedAt) / 1_000_000,
    });
  }
}

function normalizedHost(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isLoopbackHost(value) {
  const host = normalizedHost(value);
  return (
    host === "localhost" || host === "::1" || (net.isIP(host) === 4 && host.startsWith("127."))
  );
}

function blockedError(kind) {
  return Object.assign(new Error(`standalone test egress fence blocked ${kind}`), {
    code: "OMNIROUTE_TEST_EGRESS_BLOCKED",
  });
}

function blockSocket(reason, kind, host = "", port = null) {
  audit.blockedSockets++;
  audit.blockedSocketReasons[reason]++;
  const safeHost = normalizedHost(host);
  const target = {
    reason,
    host: /^[a-z0-9.:-]{1,253}$/.test(safeHost) ? safeHost : "[redacted]",
    port:
      Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65_535
        ? Number(port)
        : null,
  };
  if (
    audit.blockedSocketTargets.length < 8 &&
    !audit.blockedSocketTargets.some(
      (entry) =>
        entry.reason === target.reason && entry.host === target.host && entry.port === target.port
    )
  ) {
    audit.blockedSocketTargets.push(target);
  }
  throw blockedError(kind);
}

function requestUrl(input) {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  if (input && typeof input === "object" && typeof input.url === "string") {
    return new URL(input.url);
  }
  throw new TypeError("standalone test fetch fence received an unsupported request input");
}

function createFetchGuard(fetchImpl, targetAudit = audit) {
  return async function guardedFetch(input, init) {
    const url = requestUrl(input);
    const host = normalizedHost(url.hostname);
    if (cloudCodeHosts.has(host)) {
      if (url.pathname !== "/v1internal:streamGenerateContent") {
        targetAudit.blockedFetches++;
        throw blockedError("unexpected Cloud Code path");
      }
      targetAudit.cloudCodeFetchRewrites++;
      const destination = new URL(`${url.pathname}${url.search}`, bridgeOrigin);
      if (input instanceof Request) {
        return fetchImpl(new Request(destination, new Request(input, init)));
      }
      return fetchImpl(destination, init);
    }
    if (url.href === IDE_VERSION_URL) {
      targetAudit.syntheticVersionResponses++;
      return Response.json([{ version: "2.5.5" }]);
    }
    if (url.href === CLI_VERSION_URL) {
      targetAudit.syntheticVersionResponses++;
      return Response.json({ tag_name: "v1.2.16" });
    }
    if ((url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(host)) {
      return fetchImpl(input, init);
    }
    targetAudit.blockedFetches++;
    throw blockedError("non-loopback fetch");
  };
}

function loopbackDnsResult(host, options = {}) {
  const normalized = normalizedHost(host);
  if (syntheticHosts.has(normalized)) {
    audit.cloudCodeDnsRedirects++;
    const address = { address: SYNTHETIC_DNS_HOST, family: 4 };
    return options.all ? [address] : address;
  }
  if (isLoopbackHost(normalized)) {
    const address = {
      address: normalized === "localhost" ? LOOPBACK_HOST : normalized,
      family: net.isIP(normalized) || 4,
    };
    return options.all ? [address] : address;
  }
  audit.blockedDnsLookups++;
  throw blockedError("DNS lookup");
}

function lookupOptionsAndCallback(options, callback) {
  if (typeof options === "function") return { options: {}, callback: options };
  if (typeof options === "number") return { options: { family: options }, callback };
  return { options: options || {}, callback };
}

function guardedLookup(hostname, options, callback) {
  const parsed = lookupOptionsAndCallback(options, callback);
  let answer;
  try {
    answer = loopbackDnsResult(hostname, parsed.options);
  } catch (error) {
    if (typeof parsed.callback === "function") {
      process.nextTick(() => parsed.callback(error));
      return;
    }
    return Promise.reject(error);
  }
  if (typeof parsed.callback === "function") {
    process.nextTick(() => {
      if (parsed.options.all) parsed.callback(null, answer);
      else parsed.callback(null, answer.address, answer.family);
    });
    return;
  }
  return Promise.resolve(answer);
}

function blockDnsQuery(_hostname, ...args) {
  audit.blockedDnsLookups++;
  const error = blockedError("DNS query");
  const callback = [...args].reverse().find((value) => typeof value === "function");
  if (callback) {
    process.nextTick(() => callback(error));
    return;
  }
  return Promise.reject(error);
}

function routeSocketOptions(inputOptions) {
  const options = { ...inputOptions };
  if (options.path) {
    blockSocket("unixDomain", "Unix-domain socket", "[unix]");
  }
  const host = normalizedHost(options.host ?? options.hostname ?? "localhost");
  const port = Number(options.port || 0);
  if (syntheticHosts.has(host) || (host === SYNTHETIC_DNS_HOST && port === 443)) {
    if (port !== 443) {
      blockSocket("unexpectedSyntheticPort", "unexpected synthetic destination port", host, port);
    }
    options.host = LOOPBACK_HOST;
    options.hostname = LOOPBACK_HOST;
    options.port = bridgePort;
    audit.cloudCodeSocketRoutes++;
    return options;
  }
  if (host === SYNTHETIC_DNS_HOST) {
    blockSocket("reservedSentinel", "reserved synthetic DNS address", host, port);
  }
  if (!isLoopbackHost(host)) {
    blockSocket("nonLoopbackTcp", "non-loopback socket", host, port);
  }
  options.host = host === "localhost" ? LOOPBACK_HOST : host;
  audit.loopbackSockets++;
  return options;
}

function socketConnectArguments(args) {
  const first = args[0];
  if (first && typeof first === "object") {
    return { options: { ...first }, rest: args.slice(1) };
  }
  if (typeof first === "number") {
    const host = typeof args[1] === "string" ? args[1] : "localhost";
    const rest = typeof args[1] === "string" ? args.slice(2) : args.slice(1);
    return { options: { port: first, host }, rest };
  }
  blockSocket("unsupportedTcp", "unsupported socket destination");
}

function guardedSocketConnect(...args) {
  const parsed = socketConnectArguments(args);
  const options = routeSocketOptions(parsed.options);
  const bridgeSocket = options.host === LOOPBACK_HOST && Number(options.port) === bridgePort;
  if (bridgeSocket) this.once("error", (error) => recordSocketError("tcp", error));
  return nativeSocketConnect.call(this, options, ...parsed.rest);
}

function tlsConnectArguments(args) {
  const first = args[0];
  if (first && typeof first === "object") {
    return { options: { ...first }, rest: args.slice(1) };
  }
  if (typeof first === "number") {
    const options = { port: first, host: "localhost" };
    const rest = [];
    for (const argument of args.slice(1)) {
      if (typeof argument === "string" && options.host === "localhost") {
        options.host = argument;
      } else if (argument && typeof argument === "object") {
        Object.assign(options, argument);
      } else if (typeof argument === "function") {
        rest.push(argument);
      }
    }
    return { options, rest };
  }
  blockSocket("unsupportedTls", "unsupported TLS destination");
}

function guardedTlsConnect(...args) {
  const parsed = tlsConnectArguments(args);
  const options = parsed.options;
  const host = normalizedHost(
    options.host ?? options.hostname ?? options.servername ?? "localhost"
  );
  const servername = normalizedHost(options.servername);
  const syntheticDestination =
    syntheticHosts.has(host) || (host === SYNTHETIC_DNS_HOST && syntheticHosts.has(servername));
  if (syntheticDestination) {
    if (Number(options.port || 443) !== 443) {
      blockSocket(
        "unexpectedSyntheticTlsPort",
        "unexpected synthetic TLS port",
        host,
        Number(options.port || 443)
      );
    }
    options.servername = options.servername || host;
    options.host = LOOPBACK_HOST;
    options.hostname = LOOPBACK_HOST;
    options.port = bridgePort;
    audit.cloudCodeTlsRoutes++;
  } else if (!isLoopbackHost(host)) {
    blockSocket("nonLoopbackTls", "non-loopback TLS socket", host, Number(options.port || 443));
  }
  try {
    const socket = nativeTlsConnect.call(tls, options, ...parsed.rest);
    if (syntheticDestination) socket.once("error", (error) => recordSocketError("tls", error));
    return socket;
  } catch (error) {
    if (syntheticDestination) recordSocketError("tls", error);
    throw error;
  }
}

function blockDatagramSend(...args) {
  audit.blockedDatagrams++;
  const error = blockedError("UDP datagram");
  const callback = [...args].reverse().find((value) => typeof value === "function");
  if (callback) {
    process.nextTick(() => callback(error));
    return;
  }
  throw error;
}

function installSocketFence() {
  dns.lookup = guardedLookup;
  dns.promises.lookup = (hostname, options = {}) => guardedLookup(hostname, options);
  for (const name of [
    "lookupService",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCaa",
    "resolveCname",
    "resolveMx",
    "resolveNaptr",
    "resolveNs",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
    "reverse",
  ]) {
    if (typeof dns[name] === "function") dns[name] = blockDnsQuery;
    if (typeof dns.promises[name] === "function") dns.promises[name] = blockDnsQuery;
    if (typeof dns.Resolver?.prototype?.[name] === "function") {
      dns.Resolver.prototype[name] = blockDnsQuery;
    }
    if (typeof dns.promises.Resolver?.prototype?.[name] === "function") {
      dns.promises.Resolver.prototype[name] = blockDnsQuery;
    }
  }
  net.Socket.prototype.connect = guardedSocketConnect;
  tls.connect = guardedTlsConnect;
  dgram.Socket.prototype.send = blockDatagramSend;
  syncBuiltinESMExports();
}

async function assertFetchGuardSelfCheck() {
  const selfAudit = makeAudit();
  const probeGuard = createFetchGuard(async (input) => {
    if (!(input instanceof URL) || input.origin !== bridgeOrigin.origin) {
      throw new Error("standalone fetch fence self-check rewrite failed");
    }
    return new Response(null, { status: 204 });
  }, selfAudit);
  await probeGuard(
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
  );
  let blocked = false;
  try {
    await probeGuard("https://example.invalid/private");
  } catch (error) {
    blocked = error?.code === "OMNIROUTE_TEST_EGRESS_BLOCKED";
  }
  if (!blocked || selfAudit.cloudCodeFetchRewrites !== 1 || selfAudit.blockedFetches !== 1) {
    throw new Error("standalone fetch fence self-check failed");
  }
}

async function assertDnsAndSocketFenceSelfCheck() {
  const mappedDns = await new Promise((resolve, reject) => {
    dns.lookup("daily-cloudcode-pa.googleapis.com", (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  if (mappedDns.address !== SYNTHETIC_DNS_HOST || mappedDns.family !== 4) {
    throw new Error("standalone allowlisted DNS self-check did not map to the sentinel address");
  }

  const dnsError = await new Promise((resolve) => {
    dns.lookup("example.invalid", (error) => resolve(error));
  });
  if (dnsError?.code !== "OMNIROUTE_TEST_EGRESS_BLOCKED") {
    throw new Error("standalone non-allowlisted DNS self-check failed");
  }
  const socket = new net.Socket();
  let blocked = false;
  try {
    socket.connect({ host: "203.0.113.1", port: 443 });
  } catch (error) {
    blocked = error?.code === "OMNIROUTE_TEST_EGRESS_BLOCKED";
  } finally {
    socket.destroy();
  }
  if (!blocked) throw new Error("standalone non-loopback socket self-check failed");

  const localSocket = new net.Socket();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("loopback socket self-check timed out")),
        3_000
      );
      localSocket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      localSocket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      localSocket.connect({ host: SYNTHETIC_DNS_HOST, port: 443 });
    });
  } finally {
    localSocket.destroy();
  }
}

async function assertLoopbackTlsSelfCheck() {
  await new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "cloudcode-pa.googleapis.com",
      port: 443,
      servername: "cloudcode-pa.googleapis.com",
      timeout: 3_000,
    });
    const timer = setTimeout(
      () => socket.destroy(new Error("loopback TLS self-check timed out")),
      3_000
    );
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      audit.preloadLocalTlsSelfChecks++;
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function installFetchFences() {
  globalThis.fetch = createFetchGuard(nativeFetch);
  undici.fetch = createFetchGuard(nativeUndiciFetch);
  if (undici.fetch === originalUndiciFetch) {
    throw new Error("standalone fetch fence could not replace the external undici export");
  }
}

installSocketFence();
await assertFetchGuardSelfCheck();
await assertDnsAndSocketFenceSelfCheck();
await assertLoopbackTlsSelfCheck();

// Self-check traffic is excluded from runtime counters; it is a local TLS
// handshake only and does not send an HTTP/provider request.
const preloadLocalTlsSelfChecks = audit.preloadLocalTlsSelfChecks;
audit = makeAudit();
audit.preloadLocalTlsSelfChecks = preloadLocalTlsSelfChecks;
// Load external Undici only after the builtin socket methods are fenced. Some
// versions cache connector functions during module initialization.
undici = standaloneRequire("undici");
originalUndiciFetch = undici.fetch;
nativeUndiciFetch = originalUndiciFetch.bind(undici);
installFetchFences();

process.once("exit", () => {
  try {
    fs.mkdirSync(auditDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(auditDirectory, `${process.pid}.json`), JSON.stringify(audit), {
      mode: 0o600,
    });
  } catch {
    // The harness detects a missing audit record and fails the run.
  }
});
