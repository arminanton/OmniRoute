import {
  getRuntimeCoordinationCapabilities,
  getRuntimeCoordinationCounts,
} from "@omniroute/open-sse/services/coordination/sharedSemaphore";
import { getPhysicalGenerationCount } from "@omniroute/open-sse/services/generationLifetime";
import { getCanaryLifecycle, registerCanaryCounter } from "./canaryLifecycle";
import { pingDb } from "./db/core";
import { boundedCanaryProbe } from "./canaryProbe";

export interface CoordinationReadiness {
  protocol: "omni-coordination/v1";
  accountAdmission: boolean;
  refreshOwnership: boolean;
  backgroundOwnership: boolean;
  conversationState: boolean;
}
const unavailable: CoordinationReadiness = {
  protocol: "omni-coordination/v1",
  accountAdmission: false,
  refreshOwnership: false,
  backgroundOwnership: false,
  conversationState: false,
};
/** Components register actual health checks at bootstrap; a client/env declaration is never proof. */
declare global {
  var __omnirouteCanaryReadinessProbes: Map<string, () => Promise<boolean>> | undefined;
}
const probes = (globalThis.__omnirouteCanaryReadinessProbes ||= new Map<
  string,
  () => Promise<boolean>
>());
export function registerCanaryReadinessProbe(
  component: Exclude<keyof CoordinationReadiness, "protocol">,
  probe: () => Promise<boolean>
): void {
  probes.set(component, probe);
}
export async function getCanaryReadiness() {
  registerCanaryCounter(
    "queuedRequests",
    () => getRuntimeCoordinationCounts()?.queuedGeneration ?? null
  );
  registerCanaryCounter("upstreamLeases", getPhysicalGenerationCount);
  const coordination: CoordinationReadiness = {
    ...unavailable,
    ...(await boundedCanaryProbe(getRuntimeCoordinationCapabilities, unavailable)),
  };
  await Promise.all(
    [...probes].map(async ([component, probe]) => {
      coordination[component as Exclude<keyof CoordinationReadiness, "protocol">] =
        (await boundedCanaryProbe(probe, false)) === true;
    })
  );
  let databaseReady = false;
  try {
    databaseReady = pingDb();
  } catch {}
  const generation = process.env.OMNIROUTE_APP_GENERATION || "";
  const lifecycle = getCanaryLifecycle();
  const ready = Boolean(
    generation &&
    databaseReady &&
    Object.entries(coordination)
      .filter(([k]) => k !== "protocol")
      .every(([, v]) => v === true)
  );
  return {
    schema: "omni-canary-readiness/v1",
    generation,
    ready,
    databaseReady,
    coordination,
    lifecycle,
  };
}
