import test from "node:test";
import assert from "node:assert/strict";

import { GET } from "../../src/app/api/telemetry/summary/route.ts";
import { RequestTelemetry, recordTelemetry } from "../../src/shared/utils/requestTelemetry.ts";
import { clearQuotaMonitors, startQuotaMonitor } from "../../open-sse/services/quotaMonitor.ts";
import { clearSessions, touchSession } from "../../open-sse/services/sessionManager.ts";

test.afterEach(() => {
  clearQuotaMonitors();
  clearSessions();
});

test("telemetry summary route includes totalRequests alias plus session/quota monitor signals", async () => {
  const telemetry = new RequestTelemetry("telemetry-route");
  telemetry.startPhase("parse");
  telemetry.endPhase();
  recordTelemetry(telemetry);

  touchSession("sess-route", "conn-route");
  startQuotaMonitor("sess-route", "codex", "conn-route", {
    providerSpecificData: { quotaMonitorEnabled: true },
  });

  const response = await GET(
    new Request("http://localhost:20128/api/telemetry/summary?windowMs=600000")
  );
  const payload = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.ok(payload.totalRequests >= 1);
  assert.equal(payload.sessions.activeCount, 1);
  assert.equal(payload.sessions.stickyBoundCount, 1);
  assert.equal(payload.quotaMonitor.active, 1);
});

test("coarse provider wait is explicitly distinct from physical socket connect", async () => {
  const { PHASES, getTelemetrySummary } =
    await import("../../src/shared/utils/requestTelemetry.ts");
  assert.ok(PHASES.includes("provider_wait"));
  assert.ok(!PHASES.includes("connect" as never));
  const record = new RequestTelemetry("provider-wait-scope");
  record.startPhase("provider_wait");
  record.endPhase();
  recordTelemetry(record);
  assert.ok(getTelemetrySummary().phaseBreakdown.provider_wait);
});
