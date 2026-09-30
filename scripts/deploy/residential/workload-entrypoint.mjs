// STAGED fixed deployment entrypoint. No source image defaults are changed.
import fs from "node:fs";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {inspectBoundary, mountAt} from "./boundary-check.mjs";
import {requireLockedBootstrap, assertLocalHelper} from "./runtime-policy.mjs";

const role = process.argv[2];
const profile = process.argv[3] || "locked-experimental-v1";
const kernelProfile = profile === "kernel-residential-v1";
const fail = () => { console.error("workload refused: runtime policy or boundary check failed"); process.exit(1); };
let proof;
try {
  if (kernelProfile) {
    // Explicit separate deployment profile, NOT approval of the experimental
    // adapter table. Never accept an image with a hidden/torn locked authority.
    try {
      fs.lstatSync("/run/omni-runtime-policy");
      throw new Error("mixed deployment profiles");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (role === "boundary-only") throw new Error("invalid kernel workload role");
  } else {
    if (profile !== "locked-experimental-v1") throw new Error("unknown profile");
    requireLockedBootstrap();
    assertPolicyMount();
  }
  proof = inspectBoundary();
} catch { fail(); }

function assertPolicyMount() {
  const options = mountAt(fs.readFileSync("/proc/self/mountinfo", "utf8"), "/run/omni-runtime-policy");
  if (!options.has("ro")) throw new Error("runtime authority must be a read-only directory bind");
}

function assertMatchingAppAuthority() {
  // Refuse an older/mixed app image before any app import. This is not proof
  // that every dispatch sink is guarded; source/build/native reviews stay gates.
  for (const path of ["/app", "/app/build"]) {
    const info = fs.lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid app code path");
  }
  const expected = fs.readFileSync(new URL("./runtime-policy.mjs", import.meta.url));
  const path = "/app/build/runtime-policy.mjs";
  const before = fs.lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.size !== expected.length) throw new Error("invalid app authority module");
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);
  try {
    const opened = fs.fstatSync(fd);
    if (!same(before, opened) || !fs.readFileSync(fd).equals(expected) || !same(opened, fs.fstatSync(fd))) {
      throw new Error("mixed app authority module");
    }
  } finally { fs.closeSync(fd); }
}

function start(binary, args) {
  const child = spawn(binary, args, {stdio: "inherit", env: process.env, shell: false});
  child.on("error", fail);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return child;
}

function chromiumPath() {
  // Pinned Playwright browser image, no runtime downloader or arbitrary command.
  const candidates = [];
  for (const revision of fs.readdirSync("/ms-playwright")) {
    if (!/^chromium(-headless-shell)?-[0-9]+$/.test(revision)) continue;
    for (const leaf of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-linux-arm64/chrome"]) {
      const candidate = `/ms-playwright/${revision}/${leaf}`;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) candidates.push(candidate);
    }
  }
  if (candidates.length !== 1) throw new Error("browser artifact missing or ambiguous");
  return candidates[0];
}

try {
  if (role === "boundary-only") {
    // Future disposable check ONLY: no app import, private DB or provider call.
    // The probe must first be compiled for the pinned runtime architecture.
    const child = start("/opt/omni-runtime/capability-probe", []);
    child.removeAllListeners("exit");
    child.on("exit", (code) => {
      if (code !== 0) return fail();
      const file = fileURLToPath(new URL("./boundary-check.mjs", import.meta.url));
      const policyFile = fileURLToPath(new URL("./runtime-policy.mjs", import.meta.url));
      const script = `import fs from "node:fs"; import {requireLockedBootstrap} from ${JSON.stringify(policyFile)}; import {inspectBoundary, mountAt} from ${JSON.stringify(file)}; ${assertPolicyMount.toString()} requireLockedBootstrap(); assertPolicyMount(); inspectBoundary();`;
      const grandchild = start(process.execPath, ["--input-type=module", "-e", script]);
      grandchild.removeAllListeners("exit");
      grandchild.on("exit", (childCode) => {
        if (childCode !== 0) return fail();
        console.log(JSON.stringify({schema: 1, boundaryOnly: true, ...proof, childInheritance: true}));
        process.exit(0);
      });
    });
  } else if (role === "app") {
    if (!kernelProfile) assertMatchingAppAuthority();
    // Require the actual trusted peer-stamp/WS wrapper, never bare-server fallback.
    if (!fs.statSync("/app/server-ws.mjs").isFile()) throw new Error("missing app wrapper");
    fs.mkdirSync("/app/data/home", {recursive: true, mode: 0o700});
    process.chdir("/app");
    start(process.execPath, ["/app/dev/run-standalone.mjs"]);
  } else if (role === "browser") {
    assertLocalHelper({role: "browser-cdp", endpoint: "http://127.0.0.1:9222", phase: "configured"});
    fs.mkdirSync("/browser-profile/home", {recursive: true, mode: 0o700});
    start(chromiumPath(), ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222",
      "--user-data-dir=/browser-profile/chromium", "--no-first-run", "--no-default-browser-check", "about:blank"]);
  } else if (role === "codex") {
    assertLocalHelper({role: "codex-app-server", endpoint: "ws://127.0.0.1:1456", phase: "configured"});
    start("/usr/local/bin/codex", ["app-server", "--listen", "ws://127.0.0.1:1456",
      "--ws-auth", "capability-token", "--ws-token-file", "/run/codex-appserver/token"]);
  } else fail();
} catch { fail(); }
