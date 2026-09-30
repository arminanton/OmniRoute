// STAGED. Pure validation exports are tested with synthetic snapshots only.
// Runtime inspection is invoked only by the future disposable/container entrypoint.
import fs from "node:fs";

export const PUBLIC_DIRECTORY = "/run/omni-egress-attestation";
export const PUBLIC_FILE = `${PUBLIC_DIRECTORY}/residential-v1.json`;
export const POLICY_ID = "omni-app-residential-direct-v1";
const CAP_KEYS = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["v", "policyId", "bootId", "appNetnsInode", "topologyGeneration", "egressGeneration", "issuedBootMs", "expiresBootMs"].sort();

function assert(value, message) {
  if (!value) throw new Error(message);
}

export function parseStatus(text) {
  return Object.fromEntries(text.trim().split("\n").map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
}

export function parseBootMs(text) {
  const match = /^(\d+)(?:\.(\d+))?\s/.exec(text);
  assert(match, "invalid Linux uptime");
  const result = Number(match[1]) * 1000 + Number(((match[2] || "") + "000").slice(0, 3));
  assert(Number.isSafeInteger(result), "invalid Linux uptime range");
  return result;
}

export function mountAt(text, target) {
  const decode = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const found = text.trim().split("\n").map((line) => line.split(" "))
    .filter((fields) => decode(fields[4] || "") === target);
  assert(found.length === 1, "missing/ambiguous protected directory mount");
  return new Set(found[0][5].split(","));
}

export function validateSnapshot(claim, snapshot) {
  assert(claim && typeof claim === "object" && !Array.isArray(claim) &&
    JSON.stringify(Object.keys(claim).sort()) === JSON.stringify(FIELDS), "invalid attestation schema");
  assert(claim.v === 1 && claim.policyId === POLICY_ID, "unsupported attestation policy");
  assert(UUID.test(claim.bootId) && claim.bootId === snapshot.bootId, "wrong Linux boot");
  assert(typeof claim.appNetnsInode === "string" && /^[1-9][0-9]{0,19}$/.test(claim.appNetnsInode) &&
    BigInt(claim.appNetnsInode) <= 18446744073709551615n &&
    claim.appNetnsInode === snapshot.netnsInode, "wrong application network namespace");
  assert(/^[0-9a-f]{32}$/.test(claim.topologyGeneration) && UUID.test(claim.egressGeneration), "invalid generation");
  const now = snapshot.bootMs;
  assert(Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(claim.issuedBootMs) &&
    Number.isSafeInteger(claim.expiresBootMs) && claim.issuedBootMs >= 0 &&
    claim.issuedBootMs <= now && now < claim.expiresBootMs &&
    claim.expiresBootMs - claim.issuedBootMs <= 15000, "stale/future/excessive attestation lease");
  const status = snapshot.status;
  assert(status.Uid?.split(/\s+/).every((v) => v === "10001") &&
    status.Uid.split(/\s+/).length === 4 && status.Gid?.split(/\s+/).every((v) => v === "10001") &&
    status.Gid.split(/\s+/).length === 4, "nonroot fixed UID/GID required");
  assert((status.Groups || "").split(/\s+/).filter(Boolean).every((v) => v === "10001"), "unexpected supplemental groups");
  assert(status.NoNewPrivs === "1" && status.Seccomp === "2", "NNP and seccomp required");
  assert(CAP_KEYS.every((key) => typeof status[key] === "string" && /^0+$/.test(status[key])), "all capabilities must be empty");
  assert(snapshot.uidMap.trim().split(/\s+/).join(" ") === "0 0 4294967295", "host user namespace required for root provenance");
  assert(mountAt(snapshot.mountinfo, PUBLIC_DIRECTORY).has("ro"), "attestation directory must be a read-only bind");
  assert(mountAt(snapshot.mountinfo, "/").has("ro"), "workload root filesystem must be read-only");
  return {bootId: claim.bootId, namespaceId: `net:[${claim.appNetnsInode}]`,
    generation: `${claim.topologyGeneration}:${claim.egressGeneration}`};
}

function checkRootPath(path, directory) {
  const info = fs.lstatSync(path, {bigint: true});
  assert((directory ? info.isDirectory() : info.isFile()) && info.uid === 0n &&
    (info.mode & 0o022n) === 0n, "unprotected attestation path");
  return info;
}

export function validatePublicMetadata(info, directory = false) {
  assert((directory ? info.isDirectory() : info.isFile()) && info.uid === 0n && info.gid === 0n &&
    (info.mode & 0o7777n) === (directory ? 0o755n : 0o444n) &&
    (directory || (info.nlink === 1n && info.size > 0n && info.size <= 4096n)), "unprotected PUBLIC metadata");
}

export function inspectBoundary() {
  for (const path of ["/", "/run", PUBLIC_DIRECTORY]) checkRootPath(path, true);
  const publicInfo = fs.lstatSync(PUBLIC_DIRECTORY, {bigint: true});
  validatePublicMetadata(publicInfo, true);
  const directory = fs.openSync(PUBLIC_DIRECTORY, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const fd = fs.openSync(PUBLIC_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd, {bigint: true});
    validatePublicMetadata(info);
    const content = fs.readFileSync(fd, "utf8");
    assert(Buffer.byteLength(content) <= 4096, "oversized attestation file");
    const snapshot = {
      bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      netnsInode: fs.statSync("/proc/self/ns/net", {bigint: true}).ino.toString(),
      bootMs: parseBootMs(fs.readFileSync("/proc/uptime", "utf8")),
      status: parseStatus(fs.readFileSync("/proc/self/status", "utf8")),
      uidMap: fs.readFileSync("/proc/self/uid_map", "utf8"),
      mountinfo: fs.readFileSync("/proc/self/mountinfo", "utf8"),
    };
    const claim = JSON.parse(content);
    // The trusted writer emits this exact canonical form. This also rejects
    // duplicate JSON keys without accepting JSON.parse's last-value fallback.
    assert(content === JSON.stringify(claim, Object.keys(claim).sort()) + "\n", "noncanonical public document");
    const result = validateSnapshot(claim, snapshot);
    for (const path of ["/var/run/docker.sock", "/run/podman/podman.sock", "/run/dbus/system_bus_socket",
      "/run/omni-egress/tailscaled.sock", "/run/netns", "/dev/net/tun", "/host"]) {
      assert(!fs.existsSync(path), "forbidden host control path exposed");
    }
    assert(fs.fstatSync(directory, {bigint: true}).ino === fs.lstatSync(PUBLIC_DIRECTORY, {bigint: true}).ino,
      "attestation directory changed");
    return result;
  } finally {
    fs.closeSync(fd);
    fs.closeSync(directory);
  }
}
