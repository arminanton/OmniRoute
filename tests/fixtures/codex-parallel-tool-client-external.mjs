import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const [readyFile, resultFile, logFile] = process.argv.slice(2);
if (!readyFile || !resultFile || !logFile) {
  throw new Error("Usage: codex-parallel-tool-client-external.mjs READY RESULT LOG");
}

const readyDeadline = Date.now() + 210_000;
while (!fs.existsSync(readyFile) && Date.now() < readyDeadline) await delay(100);
if (!fs.existsSync(readyFile)) throw new Error("Timed out waiting for the Codex test gateway");

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixture = path.join(repoRoot, "tests/fixtures/codex-parallel-tool-client.mjs");
const child = spawn(
  "systemd-run",
  [
    "--user",
    "--scope",
    "--quiet",
    `--unit=omni-codex-load-${process.pid}`,
    "--property=MemoryMax=3G",
    "--property=CPUQuota=200%",
    `--setenv=CODEX_CAPTURE_CLIENT_CONFIG_FILE=${readyFile}`,
    "--",
    process.execPath,
    fixture,
  ],
  { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }
);

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
const [code, signal] = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
});

fs.mkdirSync(path.dirname(resultFile), { recursive: true, mode: 0o700 });
fs.writeFileSync(logFile, stderr, { mode: 0o600 });
const result = { exitCode: code, signal, error: null, clientResult: null };
if (code === 0) {
  const jsonStart = stdout.indexOf('{\n  "benchmark"');
  if (jsonStart >= 0) {
    try {
      result.clientResult = JSON.parse(stdout.slice(jsonStart));
    } catch (error) {
      result.error = `Could not parse client output: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    result.error = `Client output did not contain benchmark JSON: ${stdout.slice(0, 500)}`;
  }
} else {
  result.error = stderr.slice(-6000) || `Client process exited with ${code ?? signal}`;
}

const temporaryResultFile = `${resultFile}.tmp`;
fs.writeFileSync(temporaryResultFile, JSON.stringify(result), { mode: 0o600 });
fs.renameSync(temporaryResultFile, resultFile);
if (result.error) {
  process.stderr.write(`${result.error}\n`);
  process.exitCode = 1;
}
