import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname, resolve, parse, sep, basename } from "node:path";
import { resolveDataDir } from "./data-dir.mjs";

const CONFIG_VERSION = 1;
const KEYCHAIN_SERVICE = "omniroute-cli";
const KEYCHAIN_DISABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.OMNIROUTE_CONTEXT_KEYCHAIN_DISABLED || "")
);

// `keytar` is optional and native. Keeping it behind a small interface lets
// headless installs use the same CLI without requiring libsecret/Keychain at
// install time, while tests can inject a deterministic fake backend.
let keychainBackend = null;
let keychainOperational = true;
let warnedPlaintextFallback = false;
const credentialCache = new Map();

function isKeychainBackend(value) {
  return (
    value &&
    typeof value.getPassword === "function" &&
    typeof value.setPassword === "function" &&
    typeof value.deletePassword === "function"
  );
}

async function loadKeychainBackend() {
  if (KEYCHAIN_DISABLED) return null;
  try {
    const imported = await import("keytar");
    const candidate = isKeychainBackend(imported?.default) ? imported.default : imported;
    return isKeychainBackend(candidate) ? candidate : null;
  } catch {
    // Native keychain modules are optional and commonly unavailable in
    // containers. The secure file fallback is handled explicitly below.
    return null;
  }
}

function parseCredential(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result = {};
    if (typeof parsed.accessToken === "string" && parsed.accessToken) {
      result.accessToken = parsed.accessToken;
    }
    if (typeof parsed.apiKey === "string" && parsed.apiKey) result.apiKey = parsed.apiKey;
    return result.accessToken || result.apiKey ? result : null;
  } catch {
    // Older/externally managed entries may contain one raw token.
    return { accessToken: value };
  }
}

function credentialForContext(context) {
  const ref = context && typeof context.credentialRef === "string" ? context.credentialRef : "";
  return ref ? credentialCache.get(ref) || null : null;
}

function applyCachedCredential(context) {
  const cached = credentialForContext(context);
  if (!cached) return { ...context };
  return { ...context, ...cached };
}

async function hydrateCredentialCache(cfg) {
  if (!keychainBackend || !keychainOperational) return;
  for (const ref of credentialReferences(cfg)) {
    if (!ref || credentialCache.has(ref)) continue;
    try {
      const parsed = parseCredential(await keychainBackend.getPassword(KEYCHAIN_SERVICE, ref));
      if (parsed) credentialCache.set(ref, parsed);
    } catch {
      keychainOperational = false;
      break;
    }
  }
}

function warnPlaintextFallback() {
  if (warnedPlaintextFallback) return;
  process.stderr.write(
    "Warning: context credentials are stored as plaintext in a verified private config.json (mode 0600).\n"
  );
  warnedPlaintextFallback = true;
}

function storageError(code = "unsafe", committed = false) {
  const message =
    code === "durability"
      ? "Context file was replaced, but durable commit could not be confirmed. Do not retry blindly."
      : code === "warning"
        ? "Context file was committed, but its storage warning could not be written."
        : code === "stale"
          ? "Context configuration changed during an update or refers to a retired credential. Reload it before retrying."
          : code === "unsupported"
            ? "Private plaintext context storage is unsupported on this platform. Use an operational OS keychain."
            : code === "invalid"
              ? "Context configuration is invalid. Repair or migrate it explicitly; existing data was not reset."
              : "Context storage is unsafe or unavailable. Repair or migrate it to an owned private directory (0700) and regular private file (0600).";
  return Object.assign(new Error(message), {
    code: `ERR_CONTEXT_STORAGE_${code.toUpperCase()}`,
    committed,
  });
}

function isPosix() {
  return process.platform !== "win32" && typeof process.geteuid === "function";
}

function closeQuietly(fd) {
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

function noFollowFlags(flags) {
  return flags | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
}

function statIfPresent(path) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Same-UID/root interference is outside DAC; never trust writable foreign ancestry. */
function openStorageParent(path, { create = false, tighten = false, privateParent = true } = {}) {
  const parent = dirname(resolve(path));
  const root = parse(parent).root;
  const parts = parent.slice(root.length).split(sep).filter(Boolean);
  const uid = isPosix() ? process.geteuid() : null;
  let current = root;
  let fd;
  let opening;
  let previousSticky = false;
  let opened;
  try {
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) current = join(current, parts[index]);
      const leaf = index === parts.length - 1;
      let info = statIfPresent(current);
      let created = false;
      if (!info && create) {
        try {
          fs.mkdirSync(current, { mode: 0o700 });
          created = true;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        info = fs.lstatSync(current);
      }
      if (!info) {
        closeQuietly(fd);
        return null;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
      if (uid !== null) {
        if (leaf || created || previousSticky) {
          if (info.uid !== uid) throw storageError();
        } else if (info.uid !== uid && info.uid !== 0) {
          throw storageError();
        }
        // Only our newly created inode under already trusted ancestry may need
        // pathname chmod: umask0777 prevents opening it to fchmod. Never use
        // this exception for EEXIST or any other pre-existing directory.
        if (created && (info.mode & 0o7777) !== 0o700) fs.chmodSync(current, 0o700);
        opening = fs.openSync(
          current,
          noFollowFlags(fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
        );
        opened = fs.fstatSync(opening);
        if (
          !opened.isDirectory() ||
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.uid !== info.uid
        ) {
          throw storageError();
        }
        if (leaf && tighten && (opened.mode & 0o7777) !== 0o700) {
          fs.fchmodSync(opening, 0o700);
          opened = fs.fstatSync(opening);
        }
        if (
          ((previousSticky && !leaf) || (leaf && privateParent)) &&
          (opened.mode & 0o7777) !== 0o700
        ) {
          throw storageError();
        }
        const sticky = opened.uid === 0 && Boolean(opened.mode & 0o1000);
        if (!leaf && opened.mode & 0o022 && !sticky) throw storageError();
        previousSticky = sticky && Boolean(opened.mode & 0o022);
        // Persist newly created directory entries as well as the final config.
        if (created && fd !== undefined) fs.fsyncSync(fd);
        closeQuietly(fd);
        fd = opening;
        opening = undefined;
      } else {
        // No Windows ACL/privacy claim. Reference-only metadata may still use
        // the working OS keychain; raw-secret file writes are rejected below.
        opened = info;
      }
    }
    return { path: parent, fd, info: opened };
  } catch (error) {
    closeQuietly(opening);
    closeQuietly(fd);
    throw error;
  }
}

function verifyParent(parent) {
  const current = fs.lstatSync(parent.path);
  const opened = parent.fd === undefined ? current : fs.fstatSync(parent.fd);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino ||
    opened.dev !== parent.info.dev ||
    opened.ino !== parent.info.ino ||
    (isPosix() && (opened.uid !== process.geteuid() || (opened.mode & 0o7777) !== 0o700))
  )
    throw storageError();
}

function verifyRegularFile(info, privateMode = true) {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (isPosix() &&
      (info.uid !== process.geteuid() || (privateMode && (info.mode & 0o7777) !== 0o600)))
  )
    throw storageError();
}

function verifyDestination(path) {
  const info = statIfPresent(path);
  if (info) verifyRegularFile(info);
  return info;
}

function hasPlaintextCredential(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      ((key === "accessToken" || key === "apiKey") &&
        typeof item === "string" &&
        item.length > 0) ||
      hasPlaintextCredential(item)
  );
}

function prepareConfigWrite(path) {
  let parent;
  try {
    parent = openStorageParent(path, { create: true, tighten: true });
    verifyParent(parent);
    verifyDestination(path);
  } catch {
    throw storageError();
  } finally {
    closeQuietly(parent?.fd);
  }
}

/** Atomic file replacement, not a transaction with an external keychain. */
function writePrivateJson(path, value, { config = false } = {}) {
  let parent;
  let fd;
  let temporary;
  let committed = false;
  let plaintext = false;
  let failure;
  try {
    validateConfig(value);
    let json;
    try {
      json = JSON.stringify(value, null, 2);
    } catch {
      throw storageError("invalid");
    }
    if (typeof json !== "string") throw storageError("invalid");
    const serialized = JSON.parse(json);
    validateConfig(serialized);
    plaintext = hasPlaintextCredential(serialized);
    if (!isPosix() && plaintext) throw storageError("unsupported");
    parent = openStorageParent(path, { create: true, tighten: config });
    verifyParent(parent);
    verifyDestination(path);
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = join(parent.path, `.${basename(path)}.${randomUUID()}.tmp`);
      try {
        fd = fs.openSync(
          candidate,
          noFollowFlags(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL),
          0o600
        );
        temporary = candidate;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (fd === undefined) throw storageError();
    // An unusually restrictive umask may remove owner bits. Restore and verify
    // on the owned descriptor BEFORE writing the first credential byte.
    verifyRegularFile(fs.fstatSync(fd), false);
    if (isPosix()) fs.fchmodSync(fd, 0o600);
    verifyRegularFile(fs.fstatSync(fd));
    fs.writeFileSync(fd, json, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    verifyParent(parent);
    verifyDestination(path);
    fs.renameSync(temporary, path);
    committed = true;
    temporary = undefined;
    // Windows does not provide the POSIX directory durability/ACL contract.
    // Only non-secret/reference JSON reaches this branch there.
    if (isPosix()) fs.fsyncSync(parent.fd);
    return plaintext;
  } catch (error) {
    failure = committed
      ? Object.assign(storageError("durability", true), { plaintext })
      : error?.code === "ERR_CONTEXT_STORAGE_UNSUPPORTED"
        ? error
        : storageError(error?.code === "ERR_CONTEXT_STORAGE_INVALID" ? "invalid" : "unsafe");
    throw failure;
  } finally {
    closeQuietly(fd);
    if (temporary) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        failure.orphanedTemp = true;
        failure.message += " A private temporary file may require cleanup.";
      }
    }
    closeQuietly(parent?.fd);
  }
}

function readConfigFile(path = configPath()) {
  let parent;
  let fd;
  try {
    // Missing configs keep the ordinary in-memory default. An existing unsafe
    // config never becomes a silent default or gets followed into hydration.
    parent = openStorageParent(path, { privateParent: false });
    if (!parent) return defaultConfig();
    const before = verifyDestination(path);
    if (!before) return defaultConfig();
    verifyParent(parent);
    fd = fs.openSync(path, noFollowFlags(fs.constants.O_RDONLY));
    const opened = fs.fstatSync(fd);
    verifyRegularFile(opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw storageError();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw storageError("invalid");
      throw error;
    }
    validateConfig(parsed);
    return parsed;
  } catch (error) {
    throw storageError(error?.code === "ERR_CONTEXT_STORAGE_INVALID" ? "invalid" : "unsafe");
  } finally {
    closeQuietly(fd);
    closeQuietly(parent?.fd);
  }
}

// Resolve keychain state before importing commands can call the synchronous
// compatibility helpers below. Credentials themselves stay in memory; only a
// stable reference is persisted in config.json when keytar is available.
keychainBackend = await loadKeychainBackend();
await hydrateCredentialCache(readConfigFile());

export function configPath() {
  return join(resolveDataDir(), "config.json");
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    currentContext: "default",
    contexts: {
      default: { baseUrl: `http://localhost:${process.env.PORT || "20128"}`, apiKey: null },
    },
  };
}

export function loadContexts() {
  return readConfigFile();
}

/**
 * Synchronous compatibility writer. New credential-bearing code should use
 * `saveContextsSecure()` so tokens are moved to the OS keychain when possible.
 */
export function saveContexts(cfg) {
  saveContextsAt(configPath(), cfg);
}

function saveContextsAt(path, cfg) {
  let plaintext;
  try {
    const snapshot = cloneConfig(cfg);
    assertNoRetiredReferences(snapshot);
    readConfigFile(path);
    plaintext = writePrivateJson(path, snapshot, { config: true });
  } catch (error) {
    if (error.committed && error.plaintext) {
      try {
        warnPlaintextFallback();
      } catch {}
    }
    throw error;
  }
  if (plaintext) {
    try {
      warnPlaintextFallback();
    } catch {
      throw storageError("warning", true);
    }
  }
}

/** Explicit export, never chmod an arbitrary existing output parent. */
export function writeContextExportFile(path, cfg) {
  const snapshot = cloneConfig(cfg);
  assertNoRetiredReferences(snapshot);
  writePrivateJson(resolve(path), snapshot);
}

/** Stable keychain reference; the reference itself is safe to persist in JSON. */
export function contextCredentialRef(name) {
  return `${KEYCHAIN_SERVICE}:context:${encodeURIComponent(String(name))}`;
}

/** Expose a non-secret capability status for diagnostics and tests. */
export function getContextKeychainStatus() {
  return {
    available: Boolean(keychainBackend && keychainOperational),
    disabled: KEYCHAIN_DISABLED,
    fallback: !keychainBackend || !keychainOperational,
  };
}

/**
 * Store context credentials through keytar and write only a credentialRef to
 * config.json. If keytar cannot be used, preserve the credential in the
 * mode-0600 file and emit one explicit warning instead of breaking headless
 * installs.
 */
// Serialize backend operations, NOT command-level/cross-process read-modify-write.
// Automatic GC of old refs is conservative; explicit removals retire only after
// the matching config revision commits durably without those references.
let credentialWriteQueue = Promise.resolve();
const pendingRetirements = new Map();
const retiredReferences = new Set();

function configRevision(cfg) {
  return createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
}

function assertNoRetiredReferences(cfg) {
  for (const ref of credentialReferences(cfg)) {
    if (retiredReferences.has(ref)) throw storageError("stale");
  }
}

function credentialReferences(cfg) {
  return new Set(
    [cfg?.contexts, cfg?.profiles].flatMap((collection) =>
      Object.values(collection || {})
        .map((context) => context?.credentialRef)
        .filter((ref) => typeof ref === "string" && ref)
    )
  );
}

function cloneConfig(cfg) {
  try {
    const next = JSON.parse(JSON.stringify(cfg && typeof cfg === "object" ? cfg : defaultConfig()));
    validateConfig(next);
    return next;
  } catch {
    throw storageError("invalid");
  }
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw storageError("invalid");
  for (const collection of [cfg.contexts, cfg.profiles]) {
    if (collection === undefined || collection === null) continue;
    if (typeof collection !== "object" || Array.isArray(collection)) throw storageError("invalid");
    for (const context of Object.values(collection)) {
      if (!context || typeof context !== "object" || Array.isArray(context))
        throw storageError("invalid");
    }
  }
}

export async function saveContextsSecure(cfg) {
  // Snapshot both values and storage path BEFORE awaiting queued/backend work.
  const path = configPath();
  const next = cloneConfig(cfg);
  const operation = credentialWriteQueue.then(() => saveContextsTransaction(path, next));
  credentialWriteQueue = operation.catch(() => {});
  return operation;
}

async function saveContextsTransaction(path, next) {
  next.version = next.version || CONFIG_VERSION;
  if (!next.contexts && next.profiles) {
    next.contexts = next.profiles;
    delete next.profiles;
  }
  next.contexts = next.contexts || {};
  // Read before any directory repair or backend mutation. Never silently
  // overwrite an unreadable, malformed or insecure existing configuration.
  const oldConfig = readConfigFile(path);
  const oldRevision = configRevision(oldConfig);
  const oldRefs = credentialReferences(oldConfig);
  const retirements = pendingRetirements.get(path);
  assertNoRetiredReferences(next);
  prepareConfigWrite(path);

  const backend = keychainBackend;
  const staged = [];
  const updates = [];
  // Generate every reference before mutating any backend. Invalid names or a
  // failed random source cannot leak earlier staged entries or raw errors.
  try {
    for (const collection of [next.contexts, next.profiles]) {
      for (const [name, context] of Object.entries(collection || {})) {
        const accessToken = typeof context.accessToken === "string" ? context.accessToken : "";
        const apiKey = typeof context.apiKey === "string" ? context.apiKey : "";
        if (!accessToken && !apiKey) continue;
        updates.push({
          context,
          ref:
            backend && keychainOperational ? `${contextCredentialRef(name)}:${randomUUID()}` : null,
          credential: { ...(accessToken ? { accessToken } : {}), ...(apiKey ? { apiKey } : {}) },
        });
      }
    }
  } catch {
    throw storageError("invalid");
  }
  for (const { context, ref, credential } of updates) {
    if (backend && keychainOperational) {
      // Never overwrite an active reference before the new JSON is committed.
      // Track even a failed setPassword: backends may fail after storing it.
      staged.push({ ref, credential });
      try {
        await backend.setPassword(KEYCHAIN_SERVICE, ref, JSON.stringify(credential));
        context.credentialRef = ref;
        delete context.accessToken;
        delete context.apiKey;
      } catch {
        keychainOperational = false;
        // A stale reference must not override a newly supplied raw credential.
        delete context.credentialRef;
      }
    } else {
      delete context.credentialRef;
    }
  }

  let writeError;
  try {
    if (configRevision(readConfigFile(path)) !== oldRevision) throw storageError("stale");
    saveContextsAt(path, next);
  } catch (error) {
    writeError = error;
  }
  const committed = !writeError || writeError.committed === true;
  const publishedRefs = committed ? credentialReferences(next) : oldRefs;
  if (committed) {
    for (const { ref, credential } of staged) {
      if (publishedRefs.has(ref)) credentialCache.set(ref, credential);
    }
  }
  // Mark ALL explicitly requested retirements before ANY cleanup await. A
  // concurrent synchronous writer must not republish a soon-to-be-deleted ref.
  const eligibleRetirements = [];
  let cleanupFailed = false;
  if (committed && retirements) {
    pendingRetirements.delete(path);
    if (!writeError) {
      for (const [ref, request] of retirements) {
        if (request.revision !== oldRevision || publishedRefs.has(ref)) continue;
        if (!isPosix()) {
          // Windows metadata writes do not prove directory durability/ACLs.
          cleanupFailed = true;
          continue;
        }
        retiredReferences.add(ref);
        eligibleRetirements.push([ref, request]);
      }
    }
  }
  // Automatically clean only NEW unpublished entries. Old changed-credential
  // refs remain conservative; only a matched explicit removal retires them.
  // In particular no old ref is retired on uncertain postcommit durability.
  for (const { ref } of staged) {
    if (publishedRefs.has(ref)) continue;
    try {
      await backend.deletePassword(KEYCHAIN_SERVICE, ref);
    } catch {
      cleanupFailed = true;
    }
  }
  for (const [ref, request] of eligibleRetirements) {
    try {
      if (credentialReferences(readConfigFile(path)).has(ref)) continue;
      await request.backend.deletePassword(KEYCHAIN_SERVICE, ref);
      credentialCache.delete(ref);
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    try {
      process.stderr.write(
        "Warning: an unused OS-keychain context entry could not be removed. Published credentials were retained.\n"
      );
    } catch {
      if (!writeError) writeError = storageError("warning", committed);
    }
  }
  if (writeError) throw writeError;
  return { usedKeychain: Boolean(backend && keychainOperational), config: next };
}

/** Defer a published entry's removal until its matching config commit. */
export async function deleteContextCredential(name, context) {
  const path = configPath();
  const requested = context?.credentialRef;
  const operation = credentialWriteQueue.then(async () => {
    const cfg = readConfigFile(path);
    const candidate = context || cfg.contexts?.[name] || cfg.profiles?.[name] || {};
    const ref = requested || candidate.credentialRef || contextCredentialRef(name);
    if (!keychainBackend || !keychainOperational) return false;
    if (credentialReferences(cfg).has(ref)) {
      const pending = pendingRetirements.get(path) || new Map();
      pending.set(ref, { revision: configRevision(cfg), backend: keychainBackend });
      pendingRetirements.set(path, pending);
      return true; // Accepted for retirement, not deleted before publication.
    }
    try {
      retiredReferences.add(ref);
      await keychainBackend.deletePassword(KEYCHAIN_SERVICE, ref);
      credentialCache.delete(ref);
      return true;
    } catch {
      keychainOperational = false;
      return false;
    }
  });
  credentialWriteQueue = operation.catch(() => {});
  return operation;
}

/** Explicitly migrate legacy plaintext context credentials. */
export async function migrateContextCredentials() {
  const cfg = loadContexts();
  const pending = [cfg.contexts, cfg.profiles].some((collection) =>
    Object.values(collection || {}).some((context) => context?.accessToken || context?.apiKey)
  );
  if (!pending) return { migrated: false, pending: false, ...getContextKeychainStatus() };
  const result = await saveContextsSecure(cfg);
  return { migrated: result.usedKeychain, pending: true, ...getContextKeychainStatus() };
}

/** Test-only backend injection; no secret is returned by this function. */
export async function setContextKeychainBackendForTests(backend) {
  keychainBackend = isKeychainBackend(backend) ? backend : null;
  keychainOperational = true;
  credentialCache.clear();
  pendingRetirements.clear();
  retiredReferences.clear();
  warnedPlaintextFallback = false;
  await hydrateCredentialCache(readConfigFile());
}

/**
 * Resolve the active context for a CLI invocation.
 *
 * Canonical schema is `{ currentContext, contexts }` (written by
 * `omniroute contexts ...`). For backward compatibility we also read the legacy
 * `{ activeProfile, profiles }` shape and a bare top-level `baseUrl` — older
 * configs and `api.mjs::getBaseUrl` used those before remote-mode unified the
 * store. `overrideName` (from `--context`/`OMNIROUTE_CONTEXT`) wins when set.
 *
 * A context may carry `{ baseUrl, accessToken?, apiKey?, scope?, description? }`.
 * `accessToken` is the scoped CLI access token (preferred); `apiKey` is the
 * legacy inference key kept for back-compat.
 */
export function resolveActiveContext(overrideName) {
  const cfg = loadContexts();
  const contexts = cfg.contexts || cfg.profiles || {};
  const name = overrideName || cfg.currentContext || cfg.activeProfile || "default";
  const found = contexts[name] || contexts.default;
  if (found) return applyCachedCredential(found);
  if (cfg.baseUrl) return { baseUrl: cfg.baseUrl };
  return { baseUrl: `http://localhost:${process.env.PORT || "20128"}` };
}

/** Async variant for callers that need to observe a just-created keychain entry. */
export async function resolveActiveContextAsync(overrideName) {
  await hydrateCredentialCache(readConfigFile());
  return resolveActiveContext(overrideName);
}
