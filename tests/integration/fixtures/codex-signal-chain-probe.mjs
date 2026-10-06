import { fileURLToPath } from "node:url";

if (process.argv[2] === "worker") {
  console.log(`CODEX_SIGNAL_WORKER=${process.pid}`);
  setInterval(() => {}, 1000);
} else {
  const runtime =
    process.env.OMNIROUTE_SIGNAL_RUNTIME_MODULE ||
    new URL("../../../scripts/build/runtime-env.mjs", import.meta.url).href;
  const { spawnWithForwardedSignals } = await import(runtime);
  spawnWithForwardedSignals(process.execPath, [fileURLToPath(import.meta.url), "worker"], {
    stdio: "inherit",
  });
}
