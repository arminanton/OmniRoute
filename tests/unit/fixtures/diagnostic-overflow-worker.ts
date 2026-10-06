import { DiagnosticOverflowStore } from "../../../src/lib/usage/diagnosticOverflow.ts";
const store = new DiagnosticOverflowStore({
  root: process.argv[2],
  maxTotalBytes: Number(process.argv[3]),
  leaseMs: Number(process.argv[4] ?? 60000),
});
const trace = store.createTrace({ provider: "antigravity" });
const attempt = await trace.beginAttempt({ requestBody: "" });
console.log(JSON.stringify({ ready: true, traceId: trace.traceId, attemptId: attempt.id }));
await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
if (process.argv[5] === "hold") {
  await attempt.writeResponse(Buffer.alloc(65536, 97));
  console.log(JSON.stringify({ written: true }));
  await new Promise<void>(() => {});
} else {
  for (let bytes = 0; bytes < 700000; bytes += 65536)
    await attempt.writeResponse(Buffer.alloc(Math.min(65536, 700000 - bytes), 97));
  await attempt.finish();
  await trace.finish();
  console.log(JSON.stringify({ done: true, reference: trace.snapshot() }));
  store.close();
  process.stdin.destroy();
}
