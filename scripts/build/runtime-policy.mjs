/**
 * Canonical locked-runtime authority. Built-ins only: copied byte-for-byte into
 * the standalone artifact and staged role images. No env switch, alternate path,
 * setter, reload or unlock API. Each bundled copy loads its own frozen revision.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

const DIRECTORY = "/run/omni-runtime-policy";
const MARKER = `${DIRECTORY}/required-v1.json`;
const POLICY = `${DIRECTORY}/policy.json`;
const PROFILE = "omni-app-residential-direct-v1";
const ERROR_BRAND = Symbol.for("omniroute.runtime-policy.error.v1");
const RESPONSE_BRAND = Symbol.for("omniroute.runtime-policy.response.v1");
const REASONS = new Set([
  "bootstrap-invalid",
  "proxy-forbidden",
  "entrypoint-unapproved",
  "helper-unapproved",
  "capability-disabled",
  "management-auth-required",
]);
const ADAPTERS = new Set([
  "executor-base-url-v1",
  "compatible-node-base-url-v1",
  "search-base-url-v1",
]);

export class RuntimePolicyError extends Error {
  constructor(reason) {
    const safeReason = REASONS.has(reason) ? reason : "bootstrap-invalid";
    super(`Runtime policy denied this operation (${safeReason}).`);
    this.name = "RuntimePolicyError";
    Object.defineProperties(this, {
      code: { value: "OMNI_RUNTIME_POLICY_DENIED", enumerable: true },
      reason: { value: safeReason, enumerable: true },
      [ERROR_BRAND]: { value: true },
    });
  }
}

export function isRuntimePolicyError(error) {
  return (
    !!error &&
    typeof error === "object" &&
    error[ERROR_BRAND] === true &&
    error.code === "OMNI_RUNTIME_POLICY_DENIED" &&
    REASONS.has(error.reason)
  );
}

export function markRuntimePolicyResponse(response) {
  Object.defineProperty(response, RESPONSE_BRAND, { value: true });
  return response;
}

export function isRuntimePolicyResponse(response) {
  return !!response && typeof response === "object" && response[RESPONSE_BRAND] === true;
}

function invalid() {
  throw new RuntimePolicyError("bootstrap-invalid");
}

function exactObject(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    invalid();
}

function identity(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    invalid();
  return value;
}

function endpoint(value, protocols) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    /[\s\\]/.test(value) ||
    value.includes("?") ||
    value.includes("#")
  )
    invalid();
  // WHATWG URL normalization erases empty userinfo (https://@host) and
  // repairs missing authority delimiters. Approval syntax must not hide either.
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)?.[1];
  if (!authority || authority.includes("@")) invalid();
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (!protocols.includes(url.protocol) || url.username || url.password || !url.hostname) invalid();
  return url;
}

function helperEndpoint(value, role) {
  const url = endpoint(
    value,
    role === "browser-cdp" ? ["http:", "https:", "ws:", "wss:"] : ["ws:", "wss:"]
  );
  // Reject hostname aliases AND alternative numeric spellings before URL's
  // normalization can turn them into a loopback literal (127.1, 0x7f000001...).
  const authority = value.slice(value.indexOf("://") + 3).split("/")[0];
  const literal = authority.startsWith("[")
    ? authority.slice(1, authority.indexOf("]"))
    : authority.split(":")[0];
  const canonical = url.hostname.replace(/^\[|\]$/g, "");
  if (
    literal !== canonical ||
    !(literal === "::1" || (isIP(literal) === 4 && literal.startsWith("127.")))
  )
    invalid();
  if (url.port === "0") invalid();
  return url;
}

function parseBinding(value) {
  if (value?.kind === "connection") {
    exactObject(value, ["kind", "providerId", "connectionId"]);
    return {
      kind: "connection",
      providerId: identity(value.providerId),
      connectionId: identity(value.connectionId),
    };
  }
  exactObject(value, ["kind", "providerId", "nodeId"]);
  if (value.kind !== "node") invalid();
  return { kind: "node", providerId: identity(value.providerId), nodeId: identity(value.nodeId) };
}

function parseGrant(value) {
  if (value?.kind === "builtin") {
    exactObject(value, ["kind", "providerId"]);
    return { kind: "builtin", providerId: identity(value.providerId) };
  }
  exactObject(value, ["kind", "binding", "adapter", "endpoint"]);
  if (value.kind !== "configured" || !ADAPTERS.has(value.adapter)) invalid();
  return {
    kind: "configured",
    binding: parseBinding(value.binding),
    adapter: value.adapter,
    endpoint: endpoint(value.endpoint, ["https:", "http:"]).href,
  };
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Pure schema parser for fixture/artifact validation; never changes live state. */
export function parseLockedPolicy(value) {
  try {
    exactObject(value, ["schema", "profile", "providers", "helpers"]);
    if (
      value.schema !== 1 ||
      value.profile !== PROFILE ||
      !Array.isArray(value.providers) ||
      value.providers.length > 256 ||
      !Array.isArray(value.helpers) ||
      value.helpers.length > 32
    )
      invalid();
    const providers = value.providers.map(parseGrant);
    const seenProviders = new Set();
    for (const grant of providers) {
      const key =
        grant.kind === "builtin"
          ? `builtin:${grant.providerId}`
          : JSON.stringify([grant.binding, grant.adapter]);
      if (seenProviders.has(key)) invalid();
      seenProviders.add(key);
    }
    const seenRoles = new Set();
    const helpers = value.helpers.map((helper) => {
      exactObject(helper, ["role", "endpoint"]);
      if (!["browser-cdp", "codex-app-server"].includes(helper.role) || seenRoles.has(helper.role))
        invalid();
      seenRoles.add(helper.role);
      return { role: helper.role, endpoint: helperEndpoint(helper.endpoint, helper.role).href };
    });
    return freeze({ schema: 1, profile: PROFILE, providers, helpers });
  } catch {
    throw new RuntimePolicyError("bootstrap-invalid");
  }
}

/** Pure marker parser; no path argument and no enable/unlock fields. */
export function parseActivation(value) {
  try {
    exactObject(value, ["schema", "profile", "policySha256"]);
    if (
      value.schema !== 1 ||
      value.profile !== PROFILE ||
      typeof value.policySha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.policySha256)
    )
      invalid();
    return freeze({ schema: 1, profile: PROFILE, policySha256: value.policySha256 });
  } catch {
    throw new RuntimePolicyError("bootstrap-invalid");
  }
}

function directoryStat(path, immutable = false) {
  const stat = fs.lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    (stat.mode & 0o7022) !== 0 ||
    (immutable && (stat.mode & 0o777) !== 0o555)
  )
    invalid();
  return stat;
}

function fileStat(stat, limit) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    (stat.mode & 0o7777) !== 0o444 ||
    stat.nlink !== 1 ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 1 ||
    stat.size > limit
  )
    invalid();
}

function sameFile(a, b) {
  return ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].every(
    (key) => a[key] === b[key]
  );
}

function readProtected(path, limit) {
  const before = fs.lstatSync(path);
  fileStat(before, limit);
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const opened = fs.fstatSync(fd);
    fileStat(opened, limit);
    if (!sameFile(before, opened)) invalid();
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== opened.size ||
      !sameFile(opened, after) ||
      !sameFile(after, fs.lstatSync(path))
    )
      invalid();
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

let state;
let failure;
const STANDALONE = Object.freeze({ mode: "standalone" });

export function getRuntimePolicy() {
  if (failure) throw failure;
  if (state) return state;
  try {
    // Only an entirely absent reserved directory means ordinary standalone.
    // An existing/torn directory or any other I/O error must never unlock.
    let rootStat;
    try {
      rootStat = fs.lstatSync(DIRECTORY);
    } catch (error) {
      if (error?.code === "ENOENT") {
        state = STANDALONE;
        return state;
      }
      throw error;
    }
    directoryStat("/");
    directoryStat("/run");
    const checked = directoryStat(DIRECTORY, true);
    if (!sameFile(rootStat, checked)) invalid();
    const markerBytes = readProtected(MARKER, 1024);
    const policyBytes = readProtected(POLICY, 256 * 1024);
    const marker = parseActivation(JSON.parse(markerBytes.toString("utf8")));
    const digest = createHash("sha256").update(policyBytes).digest("hex");
    if (digest !== marker.policySha256) invalid();
    const policy = parseLockedPolicy(JSON.parse(policyBytes.toString("utf8")));
    if (!sameFile(checked, directoryStat(DIRECTORY, true))) invalid();
    state = freeze({ mode: "locked", policySha256: digest, policy });
    return state;
  } catch {
    // Never expose ENOENT/MODULE_NOT_FOUND: Next treats these as absent middleware.
    failure = new RuntimePolicyError("bootstrap-invalid");
    throw failure;
  }
}

export function requireLockedBootstrap() {
  const current = getRuntimePolicy();
  if (current.mode !== "locked") {
    failure = new RuntimePolicyError("bootstrap-invalid");
    throw failure;
  }
  return current;
}

export function requiresLockedManagementAuth() {
  return getRuntimePolicy().mode === "locked";
}

export function assertNoApplicationProxy(selection) {
  if (getRuntimePolicy().mode === "locked" && selection !== "none") {
    throw new RuntimePolicyError("proxy-forbidden");
  }
}

export function assertProviderEntrypoint(selection) {
  const current = getRuntimePolicy();
  if (current.mode !== "locked") return;
  try {
    const normalized = JSON.stringify(parseGrant(selection));
    if (current.policy.providers.some((grant) => JSON.stringify(grant) === normalized)) return;
  } catch {
    /* Invalid projections deny exactly like unapproved projections. */
  }
  throw new RuntimePolicyError("entrypoint-unapproved");
}

function port(url) {
  return url.port || (["https:", "wss:"].includes(url.protocol) ? "443" : "80");
}

export function assertLocalHelper(use) {
  const current = getRuntimePolicy();
  if (current.mode !== "locked") return;
  try {
    exactObject(use, ["role", "endpoint", "phase"]);
    if (!["configured", "connect", "advertised-cdp-websocket"].includes(use.phase)) invalid();
    const grant = current.policy.helpers.find((helper) => helper.role === use.role);
    if (grant) {
      const selected = helperEndpoint(use.endpoint, use.role);
      if (use.phase !== "advertised-cdp-websocket" && selected.href === grant.endpoint) return;
      if (use.role === "browser-cdp" && use.phase === "advertised-cdp-websocket") {
        const approved = new URL(grant.endpoint);
        const wsProtocol = ["https:", "wss:"].includes(approved.protocol) ? "wss:" : "ws:";
        if (
          selected.protocol === wsProtocol &&
          selected.hostname === approved.hostname &&
          port(selected) === port(approved) &&
          /^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(selected.pathname)
        )
          return;
      }
    }
  } catch {
    /* Malformed helper projections deny without disclosing the endpoint. */
  }
  throw new RuntimePolicyError("helper-unapproved");
}

export function assertNotLockedCapability(_capability) {
  if (getRuntimePolicy().mode === "locked") throw new RuntimePolicyError("capability-disabled");
}
