import assert from "node:assert/strict";
import { constants } from "node:fs";
import { describe, it } from "node:test";
import {
  createMaxaiResidentialNamespaceVerifier,
  type MaxaiAttestationDependencies,
  type MaxaiAttestationStat,
} from "../../src/lib/maxaiEgressAttestation.ts";
import type { MaxaiEgressRoute } from "../../open-sse/services/maxaiTransport.ts";

const DIRECTORY = "/run/omni-egress-attestation";
const FILE = `${DIRECTORY}/residential-v1.json`;
const MOUNTINFO = "/proc/self/mountinfo";
const BOOT = "11111111-1111-4111-8111-111111111111";
const EGRESS = "22222222-2222-4222-8222-222222222222";
const TOPOLOGY = "33333333333343338333333333333333";
const INODE = "18446744073709551615";
const ROUTE = { connectionId: "fixture-connection", proxyFingerprint: null };
const WALL = 1_700_000_000_000;
const MOUNTS =
  [
    "1 0 0:1 / / rw,relatime - overlay overlay rw",
    `2 1 0:44 /public ${DIRECTORY} ro,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=4096k`,
  ].join("\n") + "\n";
const STATUS =
  [
    "Name:\tfixture",
    "Uid:\t1000\t1000\t1000\t1000",
    "NoNewPrivs:\t1",
    ...["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(
      (name) => `${name}:\t0000000000000000`
    ),
  ].join("\n") + "\n";
const PAYLOAD = {
  v: 1,
  policyId: "omni-app-residential-direct-v1",
  bootId: BOOT,
  appNetnsInode: INODE,
  topologyGeneration: TOPOLOGY,
  egressGeneration: EGRESS,
  issuedBootMs: 100_000,
  expiresBootMs: 115_000,
};

function stat(ino: bigint, directory: boolean, dev = 44n): MaxaiAttestationStat {
  return {
    dev,
    ino,
    mode: directory ? 0o040755n : 0o100644n,
    uid: 0n,
    nlink: directory ? 2n : 1n,
    size: 0n,
    mtimeNs: 10n,
    ctimeNs: 20n,
  };
}

/** All fs, proc, UID and clock operations are synthetic; no native runtime calls. */
function fixture() {
  let body: Buffer = Buffer.from(JSON.stringify(PAYLOAD));
  const metadata = new Map<string, MaxaiAttestationStat>([
    ["/", stat(1n, true, 1n)],
    ["/run", stat(2n, true, 1n)],
    [DIRECTORY, stat(3n, true)],
    [FILE, { ...stat(9_007_199_254_740_993n, false), size: BigInt(body.length) }],
  ]);
  const proc = new Map<string, string>([
    [MOUNTINFO, MOUNTS],
    ["/proc/sys/kernel/random/boot_id", `${BOOT}\n`],
    ["/proc/self/status", STATUS],
    ["/proc/uptime", "100.250 23.45\n"],
  ]);
  const opened: Array<{ path: string; flags: number }> = [];
  const closed: string[] = [];
  const reads: string[] = [];
  const faults = new Set<string>();
  const hooks: {
    open?: (path: string) => void;
    read?: () => void;
    lstat?: (path: string) => void;
    proc?: (path: string) => void;
  } = {};
  const state = {
    namespace: `net:[${INODE}]`,
    uid: 1000 as number | undefined,
    euid: 1000 as number | undefined,
    wall: WALL,
    chunkSize: Number.MAX_SAFE_INTEGER,
    eof: false,
  };
  const check = (kind: string, path: string) => {
    if (faults.has(`${kind}:${path}`)) throw new Error("private-fixture-error-not-returned");
  };
  const deps: MaxaiAttestationDependencies = {
    platform: "linux",
    uid: () => state.uid,
    euid: () => state.euid,
    wallNow: () => state.wall,
    lstat: async (path) => {
      check("lstat", path);
      hooks.lstat?.(path);
      const value = metadata.get(path);
      assert.ok(value, `Unexpected lstat path: ${path}`);
      return { ...value };
    },
    open: async (path, flags) => {
      check("open", path);
      opened.push({ path, flags });
      hooks.open?.(path);
      return {
        stat: async () => {
          check("fstat", path);
          const value = metadata.get(path);
          assert.ok(value);
          return { ...value };
        },
        read: async (buffer, offset, length, position) => {
          check("read", path);
          assert.equal(path, FILE);
          hooks.read?.();
          const count = state.eof ? 0 : Math.min(length, body.length - position, state.chunkSize);
          body.copy(buffer, offset, position, position + count);
          return { bytesRead: count };
        },
        close: async () => {
          closed.push(path);
          check("close", path);
        },
      };
    },
    readText: async (path) => {
      reads.push(path);
      check("proc", path);
      hooks.proc?.(path);
      const value = proc.get(path);
      assert.ok(typeof value === "string", `Unexpected proc path: ${path}`);
      return value;
    },
    readlink: async (path) => {
      reads.push(path);
      check("readlink", path);
      assert.equal(path, "/proc/self/ns/net");
      return state.namespace;
    },
  };
  const setBody = (value: string | Buffer) => {
    body = typeof value === "string" ? Buffer.from(value) : value;
    metadata.get(FILE)!.size = BigInt(body.length);
  };
  return {
    deps,
    metadata,
    proc,
    hooks,
    state,
    faults,
    opened,
    closed,
    reads,
    setBody,
    payload: (patch: Record<string, unknown>) => setBody(JSON.stringify({ ...PAYLOAD, ...patch })),
    verify: createMaxaiResidentialNamespaceVerifier(deps),
  };
}

async function rejected(f: ReturnType<typeof fixture>, route = ROUTE) {
  assert.equal(await f.verify(route), null);
  assert.deepEqual(f.closed.sort(), f.opened.map(({ path }) => path).sort());
}

describe("MaxAI residential namespace attestation reader (offline fixtures)", () => {
  it("binds a root-owned RO directory lease to the exact route, boot and uint64 namespace", async () => {
    const f = fixture();
    const proof = await f.verify(ROUTE);
    assert.deepEqual(proof, {
      ...ROUTE,
      kind: "namespace",
      bootId: BOOT,
      namespaceId: `net:[${INODE}]`,
      generation: `${TOPOLOGY}:${EGRESS}`,
      expiresBootMs: 115_000,
      expiresAt: WALL + 14_750,
    });
    assert.deepEqual(f.closed, ["/", "/run", DIRECTORY, FILE]);
    assert.deepEqual(
      f.opened.map(({ path }) => path),
      ["/", "/run", DIRECTORY, FILE]
    );
    for (const { path, flags } of f.opened) {
      assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
      assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT), 0);
      if (path !== FILE) assert.equal(flags & constants.O_DIRECTORY, constants.O_DIRECTORY);
      else assert.equal(flags & constants.O_NONBLOCK, constants.O_NONBLOCK);
    }
    assert.ok(f.reads.includes("/proc/uptime"));
  });

  it("handles short reads without widening the bounded file read", async () => {
    const f = fixture();
    f.state.chunkSize = 7;
    assert.ok(await f.verify(ROUTE));
  });

  it("has no proof cache and reflects changed root-published generations", async () => {
    const f = fixture();
    const first = await f.verify(ROUTE);
    f.payload({ egressGeneration: "44444444-4444-4444-8444-444444444444" });
    const second = await f.verify(ROUTE);
    assert.ok(first && second);
    assert.notEqual(first.generation, second.generation);
    f.proc.set("/proc/uptime", "115.000 0.00\n");
    assert.equal(await f.verify(ROUTE), null);
  });

  for (const proxyFingerprint of ["fixture-fingerprint", "", undefined, false]) {
    it(`never grants a namespace proof for proxyFingerprint=${String(proxyFingerprint)}`, async () => {
      const f = fixture();
      const route = { ...ROUTE, proxyFingerprint } as unknown as MaxaiEgressRoute;
      assert.equal(await f.verify(route), null);
      assert.equal(f.opened.length, 0);
      assert.equal(f.reads.length, 0);
    });
  }

  it("copies the route before awaits and does not accept route claims", async () => {
    const f = fixture();
    const route = { ...ROUTE };
    f.hooks.open = () => {
      route.connectionId = "mutated";
    };
    assert.equal((await f.verify(route))?.connectionId, ROUTE.connectionId);
    assert.equal(await f.verify({ ...ROUTE, proof: PAYLOAD } as MaxaiEgressRoute), null);
  });

  const schemaFailures: Array<[string, Record<string, unknown>]> = [
    ["unknown fields", { secret: "not-an-attestation-field" }],
    ["wrong version", { v: 2 }],
    ["wrong policy", { policyId: "other-policy" }],
    ["noncanonical boot UUID", { bootId: BOOT.toUpperCase().replace("1111", "ABCD") }],
    ["noncanonical egress UUID", { egressGeneration: "not-a-uuid" }],
    ["hyphenated topology", { topologyGeneration: BOOT }],
    ["uppercase topology", { topologyGeneration: "A".repeat(32) }],
    ["numeric inode", { appNetnsInode: 42 }],
    ["zero inode", { appNetnsInode: "0" }],
    ["negative inode", { appNetnsInode: "-1" }],
    ["leading zero inode", { appNetnsInode: "042" }],
    ["uint64 overflow", { appNetnsInode: "18446744073709551616" }],
    ["fractional issue", { issuedBootMs: 100_000.5 }],
    ["negative issue", { issuedBootMs: -1 }],
    ["string expiry", { expiresBootMs: "115000" }],
    ["unsafe expiry", { expiresBootMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["null expiry", { expiresBootMs: null }],
  ];
  for (const [name, patch] of schemaFailures) {
    it(`rejects ${name}`, async () => {
      const f = fixture();
      f.payload(patch);
      await rejected(f);
    });
  }

  for (const key of Object.keys(PAYLOAD)) {
    it(`requires ${key}`, async () => {
      const f = fixture();
      const missing: Record<string, unknown> = { ...PAYLOAD };
      delete missing[key];
      f.setBody(JSON.stringify(missing));
      await rejected(f);
    });
  }

  for (const text of [
    "{",
    "null",
    "[]",
    "\uFEFF" + JSON.stringify(PAYLOAD),
    JSON.stringify(PAYLOAD).replace('"v":1', '"v":1,"v":1'),
    JSON.stringify(PAYLOAD).replace('"v":1', '"v":1,"\\u0076":1'),
  ]) {
    it(`rejects malformed, non-object or duplicate JSON: ${text.slice(0, 25)}`, async () => {
      const f = fixture();
      f.setBody(text);
      await rejected(f);
    });
  }

  it("rejects invalid UTF-8 without replacement decoding", async () => {
    const f = fixture();
    f.setBody(Buffer.concat([Buffer.from([0xff]), Buffer.from(JSON.stringify(PAYLOAD))]));
    await rejected(f);
  });

  const times: Array<[string, Record<string, unknown>, boolean]> = [
    ["exact maximum lease", {}, true],
    ["maximum plus one ms", { expiresBootMs: 115_001 }, false],
    [
      "overlong old lease with little remaining",
      { issuedBootMs: 1, expiresBootMs: 100_251 },
      false,
    ],
    ["issue equals now", { issuedBootMs: 100_250 }, true],
    ["future issue", { issuedBootMs: 100_251 }, false],
    ["expiry equals now", { expiresBootMs: 100_250 }, false],
    ["expiry one ms ahead", { expiresBootMs: 100_251 }, true],
    ["expired", { expiresBootMs: 100_249 }, false],
    ["negative lifetime", { issuedBootMs: 100_000, expiresBootMs: 99_999 }, false],
  ];
  for (const [name, patch, accepted] of times) {
    it(`enforces boot-clock boundary: ${name}`, async () => {
      const f = fixture();
      f.payload(patch);
      assert.equal(Boolean(await f.verify(ROUTE)), accepted);
    });
  }

  for (const [uptime, remaining] of [
    ["100.1 0.0\n", 14_900],
    ["100.01 0.00\n", 14_990],
    ["100.001 0.00\n", 14_999],
    ["100.250000000 0.00\n", 14_750],
  ] as const) {
    it(`parses fractional uptime without second rounding: ${uptime.trim()}`, async () => {
      const f = fixture();
      f.proc.set("/proc/uptime", uptime);
      assert.equal((await f.verify(ROUTE))?.expiresAt, WALL + remaining);
    });
  }

  for (const uptime of [
    "100 1",
    "1e2 0.0\n",
    "-100.00 0.00\n",
    "NaN 0.00\n",
    "100.25garbage 0.00\n",
    "9007199254740.993 0.00\n",
    "",
  ]) {
    it(`fails closed on invalid uptime ${JSON.stringify(uptime)}`, async () => {
      const f = fixture();
      f.proc.set("/proc/uptime", uptime);
      await rejected(f);
    });
  }

  it("preserves a one-ms remainder near the safe integer boot-clock limit", async () => {
    const f = fixture();
    f.payload({
      issuedBootMs: Number.MAX_SAFE_INTEGER - 1000,
      expiresBootMs: Number.MAX_SAFE_INTEGER,
    });
    f.proc.set("/proc/uptime", "9007199254740.990 0.00\n");
    assert.equal((await f.verify(ROUTE))?.expiresAt, WALL + 1);
  });

  it("does not extend the wall deadline if the uptime read is delayed", async () => {
    const f = fixture();
    f.hooks.proc = (path) => {
      if (path === "/proc/uptime") f.state.wall += 10;
    };
    assert.equal((await f.verify(ROUTE))?.expiresAt, WALL + 14_750);
  });

  it("fails closed if an awaited uptime read outlasts the projected deadline", async () => {
    const f = fixture();
    f.hooks.proc = (path) => {
      if (path === "/proc/uptime") f.state.wall += 60_000;
    };
    await rejected(f);
  });

  it("uses boot time for validity even after wall-clock rollback", async () => {
    const f = fixture();
    f.state.wall = 10;
    assert.equal((await f.verify(ROUTE))?.expiresAt, 14_760);
    f.proc.set("/proc/uptime", "116.00 0.00\n");
    await rejected(f);
  });

  for (const wall of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    it(`rejects unusable wall projection ${wall}`, async () => {
      const f = fixture();
      f.state.wall = wall;
      await rejected(f);
    });
  }

  it("binds the boot ID exactly", async () => {
    const f = fixture();
    f.proc.set("/proc/sys/kernel/random/boot_id", `${EGRESS}\n`);
    await rejected(f);
  });
  for (const namespace of ["net:[42]", `net:[0${INODE}]`, `net:[${INODE}]\n`, "user:[42]"]) {
    it(`rejects a different or malformed namespace ${JSON.stringify(namespace)}`, async () => {
      const f = fixture();
      f.state.namespace = namespace;
      await rejected(f);
    });
  }

  for (const key of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) {
    it(`requires zero ${key}`, async () => {
      const f = fixture();
      f.proc.set(
        "/proc/self/status",
        STATUS.replace(`${key}:\t0000000000000000`, `${key}:\t0000000000000001`)
      );
      await rejected(f);
    });
    it(`requires present ${key}`, async () => {
      const f = fixture();
      f.proc.set("/proc/self/status", STATUS.replace(`${key}:\t0000000000000000\n`, ""));
      await rejected(f);
    });
  }
  for (const status of [
    STATUS.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
    STATUS.replace("NoNewPrivs:\t1\n", ""),
    STATUS + "CapEff:\t0000000000000000\n",
    STATUS.replace("Uid:\t1000\t1000\t1000\t1000", "Uid:\t1001\t1001\t1001\t1001"),
  ]) {
    it("requires unique complete no-new-privileges and matching UID status", async () => {
      const f = fixture();
      f.proc.set("/proc/self/status", status);
      await rejected(f);
    });
  }
  for (let position = 0; position < 4; position++) {
    it(`rejects root UID at status position ${position}`, async () => {
      const ids = [1000, 1000, 1000, 1000];
      ids[position] = 0;
      const f = fixture();
      f.proc.set("/proc/self/status", STATUS.replace("1000\t1000\t1000\t1000", ids.join("\t")));
      await rejected(f);
    });
  }
  for (const identity of [
    { uid: 0 },
    { euid: 0 },
    { uid: undefined },
    { euid: undefined },
    { uid: -1 },
    { euid: 1.5 },
  ]) {
    it(`requires nonroot process IDs: ${JSON.stringify(identity)}`, async () => {
      const f = fixture();
      Object.assign(f.state, identity);
      await rejected(f);
      assert.equal(f.opened.length, 0);
    });
  }
  it("rejects non-Linux runtimes", async () => {
    const f = fixture();
    f.deps.platform = "darwin";
    await rejected(f);
    assert.equal(f.opened.length, 0);
  });
  it("rejects identity changes during validation", async () => {
    const f = fixture();
    f.hooks.proc = (path) => {
      if (path === "/proc/self/status") f.state.euid = 0;
    };
    await rejected(f);
  });

  const badMounts: Array<[string, string]> = [
    ["no dedicated mount", MOUNTS.split("\n")[0] + "\n"],
    [
      "RW bind with RO superblock",
      MOUNTS.replace("ro,nosuid", "rw,nosuid").replace("rw,size", "ro,size"),
    ],
    ["conflicting mount flags", MOUNTS.replace("ro,nosuid", "ro,rw,nosuid")],
    ["filesystem root rather than dedicated source directory", MOUNTS.replace(" /public ", " / ")],
    ["relative root", MOUNTS.replace(" /public ", " public ")],
    ["dotdot source root", MOUNTS.replace(" /public ", " /safe/../public ")],
    ["file-only bind", MOUNTS.replace(`${DIRECTORY} ro`, `${FILE} ro`)],
    ["nested mount", MOUNTS + `3 2 0:55 /file ${FILE} ro - tmpfs tmpfs rw\n`],
    ["stacked directory mount", MOUNTS + MOUNTS.split("\n")[1] + "\n"],
    ["device mismatch", MOUNTS.replace("0:44", "0:45")],
    ["unknown mount escape", MOUNTS.replace("/public", "/public\\999")],
    ["malformed mountinfo", "not mountinfo\n"],
  ];
  for (const [name, value] of badMounts) {
    it(`rejects ${name}`, async () => {
      const f = fixture();
      f.proc.set(MOUNTINFO, value);
      await rejected(f);
    });
  }
  it("accepts an escaped non-root backing directory with a writable writer superblock", async () => {
    const f = fixture();
    f.proc.set(MOUNTINFO, MOUNTS.replace("/public", "/fixture\\040public"));
    assert.ok(await f.verify(ROUTE));
  });
  it("rejects a remount or replacement during the read", async () => {
    const f = fixture();
    f.hooks.read = () => f.proc.set(MOUNTINFO, MOUNTS.replace("2 1", "4 1"));
    await rejected(f);
  });

  for (const path of ["/", "/run", DIRECTORY, FILE]) {
    for (const [name, patch] of [
      ["nonroot owner", { uid: 1000n }],
      ["group writable", { mode: (path === FILE ? 0o100644n : 0o040755n) | 0o020n }],
      ["world writable", { mode: (path === FILE ? 0o100644n : 0o040755n) | 0o002n }],
      ["symlink", { mode: 0o120777n }],
    ] as const) {
      it(`rejects ${name} at ${path}`, async () => {
        const f = fixture();
        Object.assign(f.metadata.get(path)!, patch);
        await rejected(f);
      });
    }
  }
  for (const [name, patch] of [
    ["hard link", { nlink: 2n }],
    ["unlinked", { nlink: 0n }],
    ["FIFO", { mode: 0o010644n }],
    ["directory", { mode: 0o040755n }],
    ["empty file", { size: 0n }],
    ["oversize file", { size: 4097n }],
    ["different filesystem", { dev: 45n }],
  ] as const) {
    it(`rejects ${name} attestation`, async () => {
      const f = fixture();
      Object.assign(f.metadata.get(FILE)!, patch);
      await rejected(f);
    });
  }

  for (const path of ["/", "/run", DIRECTORY, FILE]) {
    it(`rejects inode replacement between lstat/open for ${path}`, async () => {
      const f = fixture();
      f.hooks.open = (opened) => {
        if (opened === path) f.metadata.get(path)!.ino += 1n;
      };
      await rejected(f);
    });
    it(`rejects post-open inode replacement at ${path}`, async () => {
      const f = fixture();
      f.hooks.read = () => {
        f.metadata.get(path)!.ino += 1n;
      };
      await rejected(f);
    });
  }
  for (const [name, patch] of [
    ["mode", { mode: 0o100666n }],
    ["link count", { nlink: 2n }],
    ["mtime", { mtimeNs: 11n }],
    ["ctime", { ctimeNs: 21n }],
  ] as const) {
    it(`rejects changed file ${name} after reading`, async () => {
      const f = fixture();
      f.hooks.read = () => Object.assign(f.metadata.get(FILE)!, patch);
      await rejected(f);
    });
  }
  it("rejects growth past the initial bounded size", async () => {
    const f = fixture();
    f.metadata.get(FILE)!.size -= 1n;
    await rejected(f);
  });
  it("rejects a truncated read", async () => {
    const f = fixture();
    f.state.eof = true;
    await rejected(f);
  });
  it("rejects a path replaced after the final fstat", async () => {
    const f = fixture();
    let count = 0;
    f.hooks.lstat = (path) => {
      if (path === FILE && ++count === 2) f.metadata.get(FILE)!.ino += 1n;
    };
    await rejected(f);
  });

  for (const fault of [
    `lstat:${FILE}`,
    `open:${FILE}`,
    `fstat:${FILE}`,
    `read:${FILE}`,
    `close:${FILE}`,
    `proc:${MOUNTINFO}`,
    "proc:/proc/sys/kernel/random/boot_id",
    "proc:/proc/uptime",
    "proc:/proc/self/status",
    "readlink:/proc/self/ns/net",
  ]) {
    it(`returns only null and closes handles on ${fault} error`, async () => {
      const f = fixture();
      f.faults.add(fault);
      await rejected(f);
    });
  }
});
