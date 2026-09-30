/**
 * Root-provenance reader for MaxAI's residential network namespace lease.
 * This does not infer residential egress from an IP address or trust request/DB/env claims.
 * The privileged writer must clamp publication to the observed kernel lease minus its margin.
 */
import { constants, readFileSync } from "node:fs";
import { lstat, open, readFile, readlink } from "node:fs/promises";
import { z } from "zod";
import type {
  MaxaiEgressAttestation,
  MaxaiEgressRoute,
} from "../../open-sse/services/maxaiTransport.ts";

const DIRECTORY = "/run/omni-egress-attestation";
const ATTESTATION = `${DIRECTORY}/residential-v1.json`;
const PARENTS = ["/", "/run", DIRECTORY] as const;
const MOUNTINFO = "/proc/self/mountinfo";
const MAX_BYTES = 4096;
const MAX_LEASE_MS = 15_000;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INODE = /^[1-9][0-9]{0,19}$/;
const safeMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const payloadSchema = z
  .object({
    v: z.literal(1),
    policyId: z.literal("omni-app-residential-direct-v1"),
    bootId: z.string().regex(UUID),
    appNetnsInode: z
      .string()
      .regex(INODE)
      .refine((value) => INODE.test(value) && BigInt(value) <= UINT64_MAX),
    topologyGeneration: z.string().regex(/^[0-9a-f]{32}$/),
    egressGeneration: z.string().regex(UUID),
    issuedBootMs: safeMs,
    expiresBootMs: safeMs,
  })
  .strict();
const routeSchema = z
  .object({ connectionId: z.string().min(1), proxyFingerprint: z.null() })
  .strict();

/** Bigint metadata preserves Linux inode/device identity without number rounding. */
export interface MaxaiAttestationStat {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface MaxaiAttestationHandle {
  stat(): Promise<MaxaiAttestationStat>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/**
 * Offline fixture boundary, not a production override or attestation installer.
 * Paths remain fixed even for fixtures. A factory instance cannot replace the default reader.
 */
export interface MaxaiAttestationDependencies {
  platform: string;
  uid(): number | undefined;
  euid(): number | undefined;
  lstat(path: string): Promise<MaxaiAttestationStat>;
  open(path: string, flags: number): Promise<MaxaiAttestationHandle>;
  readText(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  wallNow(): number;
}

function requireValid(value: unknown): asserts value {
  if (!value) throw new Error("Invalid namespace attestation");
}

function protectedNode(stat: MaxaiAttestationStat, directory: boolean): void {
  requireValid(
    stat.uid === 0n &&
      (stat.mode & 0o022n) === 0n &&
      (stat.mode & 0o170000n) === (directory ? 0o040000n : 0o100000n) &&
      stat.ino > 0n &&
      stat.dev >= 0n &&
      stat.nlink > 0n
  );
  if (!directory) {
    requireValid(stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(MAX_BYTES));
  }
}

function sameNode(a: MaxaiAttestationStat, b: MaxaiAttestationStat, file: boolean): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    (!file || (a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs))
  );
}

function decodeMountPath(value: string): string {
  // mountinfo only escapes space, tab, newline and backslash with these octal sequences.
  requireValid(!/\\(?!040|011|012|134)/.test(value));
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

function normalizedAbsolute(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.includes("\0") &&
    (path === "/" ||
      path
        .slice(1)
        .split("/")
        .every((part) => part && part !== "." && part !== ".."))
  );
}

function directoryMount(text: string): { identity: string; device: string } {
  requireValid(text.length > 0 && text.length <= 1_048_576);
  let found: { identity: string; device: string } | undefined;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  for (const line of lines) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    requireValid(
      separator >= 6 &&
        fields.length === separator + 4 &&
        fields.every(Boolean) &&
        /^[1-9][0-9]{0,19}$/.test(fields[0]) &&
        /^[0-9]{1,20}$/.test(fields[1]) &&
        /^[0-9]{1,10}:[0-9]{1,10}$/.test(fields[2])
    );
    const root = decodeMountPath(fields[3]);
    const mountpoint = decodeMountPath(fields[4]);
    requireValid(normalizedAbsolute(root) && normalizedAbsolute(mountpoint));
    // A file bind or any nested mount must not replace the reader's directory contents.
    requireValid(!mountpoint.startsWith(`${DIRECTORY}/`));
    if (mountpoint !== DIRECTORY) continue;
    const options = fields[5].split(",");
    requireValid(!found && root !== "/" && options.includes("ro") && !options.includes("rw"));
    // Linux does not reliably expose a "bind" flag here. An exact, dedicated non-root
    // directory mount is required. The writer's superblock may correctly remain rw.
    found = { identity: line, device: fields[2] };
  }
  requireValid(found);
  return found;
}

function linuxDevice(dev: bigint): string {
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return `${major}:${minor}`;
}

async function readBounded(handle: MaxaiAttestationHandle, size: bigint): Promise<string> {
  const buffer = Buffer.alloc(Number(size) + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    requireValid(
      Number.isInteger(bytesRead) && bytesRead >= 0 && bytesRead <= buffer.length - offset
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  requireValid(offset === Number(size));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    buffer.subarray(0, offset)
  );
}

async function protectedPayload(deps: MaxaiAttestationDependencies): Promise<string> {
  const mount = directoryMount(await deps.readText(MOUNTINFO));
  const handles: MaxaiAttestationHandle[] = [];
  const parents: Array<{
    path: string;
    stat: MaxaiAttestationStat;
    handle: MaxaiAttestationHandle;
  }> = [];
  try {
    for (const path of PARENTS) {
      const stat = await deps.lstat(path);
      protectedNode(stat, true);
      const handle = await deps.open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      handles.push(handle);
      const opened = await handle.stat();
      protectedNode(opened, true);
      requireValid(sameNode(stat, opened, false));
      parents.push({ path, stat, handle });
    }
    const directory = parents[parents.length - 1].stat;
    requireValid(linuxDevice(directory.dev) === mount.device);
    const stat = await deps.lstat(ATTESTATION);
    protectedNode(stat, false);
    requireValid(stat.dev === directory.dev);
    // O_NONBLOCK prevents a raced special file from blocking before fstat rejects it.
    const handle = await deps.open(
      ATTESTATION,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    handles.push(handle);
    const opened = await handle.stat();
    protectedNode(opened, false);
    requireValid(sameNode(stat, opened, true));
    const text = await readBounded(handle, opened.size);
    requireValid(sameNode(opened, await handle.stat(), true));
    requireValid(sameNode(opened, await deps.lstat(ATTESTATION), true));
    for (const parent of parents) {
      requireValid(sameNode(parent.stat, await parent.handle.stat(), false));
      requireValid(sameNode(parent.stat, await deps.lstat(parent.path), false));
    }
    requireValid(directoryMount(await deps.readText(MOUNTINFO)).identity === mount.identity);
    return text;
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

function parsePayload(text: string): z.infer<typeof payloadSchema> {
  const payload = payloadSchema.parse(JSON.parse(text));
  // JSON.parse discards duplicate properties. This schema is flat, so exactly eight
  // colons outside JSON strings must occur; reject duplicate/escaped duplicate keys too.
  let quoted = false;
  let escaped = false;
  let properties = 0;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ":") properties += 1;
  }
  requireValid(properties === 8);
  return payload;
}

function unprivilegedStatus(text: string, uid: number, euid: number): void {
  requireValid(text.length <= 65_536);
  const wanted = new Set(["Uid", "NoNewPrivs", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]);
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    if (!wanted.has(name)) continue;
    requireValid(!values.has(name));
    values.set(name, line.slice(separator + 1).trim());
  }
  requireValid(values.size === wanted.size && values.get("NoNewPrivs") === "1");
  const uids = values
    .get("Uid")
    ?.match(/^([0-9]{1,10})[ \t]+([0-9]{1,10})[ \t]+([0-9]{1,10})[ \t]+([0-9]{1,10})$/);
  requireValid(uids);
  const ids = uids.slice(1).map(Number);
  requireValid(
    ids.every((id) => id > 0 && id <= 4_294_967_295) && ids[0] === uid && ids[1] === euid
  );
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    requireValid(/^0{1,16}$/.test(values.get(name) ?? ""));
  }
}

/** /proc/uptime is Linux CLOCK_BOOTTIME, including suspend. Never use os.uptime(). */
function bootMilliseconds(text: string, upperBound = false): number {
  const match = text.match(/^(0|[1-9][0-9]{0,12})\.([0-9]{1,9})[ \t]+[0-9]{1,16}\.[0-9]{1,9}\n?$/);
  requireValid(match);
  let milliseconds = BigInt(match[1]) * 1000n + BigInt(match[2].padEnd(3, "0").slice(0, 3));
  // /proc/uptime truncates to its printed precision (usually 10ms). Treat
  // the unseen fraction as elapsed so an accepted lease is never extended.
  if (upperBound) milliseconds += 10n ** BigInt(Math.max(0, 3 - match[2].length));
  requireValid(milliseconds <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(milliseconds);
}

/** Pure fixture seam for the fixed Linux boot clock; includes suspend time. */
export function maxaiBootTimeUpperBound(text: string): number {
  return bootMilliseconds(text, true);
}

/** Fixed trusted clock, sampled synchronously next to native dispatch. */
export function readMaxaiBootTimeMs(): number {
  const text = readFileSync("/proc/uptime", "utf8");
  requireValid(text.length <= 128);
  return maxaiBootTimeUpperBound(text);
}

async function verify(
  route: Readonly<MaxaiEgressRoute>,
  deps: MaxaiAttestationDependencies
): Promise<MaxaiEgressAttestation> {
  const selectedRoute = routeSchema.parse(route);
  requireValid(deps.platform === "linux");
  const uid = deps.uid();
  const euid = deps.euid();
  requireValid(
    typeof uid === "number" &&
      Number.isInteger(uid) &&
      uid > 0 &&
      typeof euid === "number" &&
      Number.isInteger(euid) &&
      euid > 0
  );
  const payload = parsePayload(await protectedPayload(deps));
  const [boot, namespace, status] = await Promise.all([
    deps.readText("/proc/sys/kernel/random/boot_id"),
    deps.readlink("/proc/self/ns/net"),
    deps.readText("/proc/self/status"),
  ]);
  requireValid(boot === payload.bootId || boot === `${payload.bootId}\n`);
  requireValid(namespace === `net:[${payload.appNetnsInode}]`);
  unprivilegedStatus(status, uid, euid);
  requireValid(deps.uid() === uid && deps.euid() === euid);
  // Sample wall time before the awaited boot-clock read. A delayed read must never
  // extend the lease when projecting it into the transport's wall-clock deadline.
  const wallNow = deps.wallNow();
  const now = bootMilliseconds(await deps.readText("/proc/uptime"));
  requireValid(
    payload.issuedBootMs <= now &&
      now < payload.expiresBootMs &&
      payload.expiresBootMs - payload.issuedBootMs <= MAX_LEASE_MS
  );
  const remainingMs = payload.expiresBootMs - now;
  const expiresAt = wallNow + remainingMs;
  const finishedWall = deps.wallNow();
  requireValid(
    Number.isSafeInteger(wallNow) &&
      wallNow >= 0 &&
      Number.isSafeInteger(finishedWall) &&
      finishedWall >= 0 &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > finishedWall &&
      expiresAt - finishedWall <= MAX_LEASE_MS
  );
  return {
    ...selectedRoute,
    kind: "namespace",
    bootId: payload.bootId,
    namespaceId: namespace,
    generation: `${payload.topologyGeneration}:${payload.egressGeneration}`,
    // Authoritative deadline for transport permission. expiresAt is telemetry
    // only; wall-clock rollback/suspend can never authorize a renewal.
    expiresBootMs: payload.expiresBootMs,
    expiresAt,
  };
}

export function createMaxaiResidentialNamespaceVerifier(deps: MaxaiAttestationDependencies) {
  return async (route: Readonly<MaxaiEgressRoute>): Promise<MaxaiEgressAttestation | null> => {
    try {
      return await verify(route, deps);
    } catch {
      // Missing, stale, malformed and unverifiable claims all fail identically. No raw details.
      return null;
    }
  };
}

const productionVerifier = createMaxaiResidentialNamespaceVerifier({
  platform: process.platform,
  uid: () => process.getuid?.(),
  euid: () => process.geteuid?.(),
  lstat: (path) => lstat(path, { bigint: true }),
  open: async (path, flags) => {
    const handle = await open(path, flags);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
  readText: (path) => readFile(path, "utf8"),
  readlink,
  wallNow: () => Date.now(),
});

/** Fixed Linux paths and trusted OS dependencies; no environment/request configuration. */
export async function verifyMaxaiResidentialNamespace(
  route: Readonly<MaxaiEgressRoute>
): Promise<MaxaiEgressAttestation | null> {
  return productionVerifier(route);
}
