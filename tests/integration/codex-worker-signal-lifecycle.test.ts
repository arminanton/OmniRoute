import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test(
  "the deployed launcher propagates worker HUP/USR2 exit instead of reloading it",
  { timeout: 15000 },
  async () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/codex-signal-chain-probe.mjs", import.meta.url)
    );
    for (const signal of ["SIGHUP", "SIGUSR2"] as const) {
      const manager = spawn(process.execPath, [fixture], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      try {
        const workerPid = await new Promise<number>((resolve, reject) => {
          let output = "";
          const timer = setTimeout(() => reject(new Error("isolated worker did not start")), 5000);
          manager.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          manager.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            const match = /CODEX_SIGNAL_WORKER=(\d+)/.exec(output);
            if (match) {
              clearTimeout(timer);
              resolve(Number(match[1]));
            }
          });
        });
        const exited = once(manager, "exit");
        process.kill(workerPid, signal);
        const [, propagatedSignal] = await exited;
        assert.equal(propagatedSignal, signal);
        console.log(`CODEX_SIGNAL_E2E signal=${signal} worker_exit_propagates=true`);
      } finally {
        if (manager.exitCode === null && manager.signalCode === null) manager.kill("SIGKILL");
      }
    }
  }
);
