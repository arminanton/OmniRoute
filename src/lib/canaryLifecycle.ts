/** Shared with the real Node HTTP server wrapper; all retirement counters are body/socket lifetime. */
export type CanaryCounter = "conversationPins" | "upstreamLeases" | "queuedRequests";
interface CanaryState {
  version: number;
  draining: boolean;
  activeResponses: number;
  activeWebSockets: number;
  pendingUploads: number;
  queuedRequests: number;
  attachedServers: number;
  providers: Partial<Record<CanaryCounter, () => number | null>>;
}
declare global {
  var __omnirouteCanaryLifecycle: CanaryState | undefined;
}
function state(): CanaryState {
  return (globalThis.__omnirouteCanaryLifecycle ||= {
    version: 1,
    draining: false,
    activeResponses: 0,
    activeWebSockets: 0,
    pendingUploads: 0,
    queuedRequests: 0,
    attachedServers: 0,
    providers: {},
  });
}
export function isCanaryControlPath(pathname: string): boolean {
  return ["/api/canary-readiness", "/api/canary-drain", "/api/health", "/api/health/ping"].includes(
    pathname
  );
}
export function isDeploymentDraining(): boolean {
  return state().draining;
}
export function setDeploymentDraining(generation: string, draining: boolean): void {
  if (!process.env.OMNIROUTE_APP_GENERATION || generation !== process.env.OMNIROUTE_APP_GENERATION)
    throw new Error("Deployment generation mismatch");
  state().draining = draining;
}
export function registerCanaryCounter(name: CanaryCounter, getter: () => number | null): void {
  state().providers[name] = getter;
}
export function getCanaryLifecycle() {
  const s = state();
  const observed = s.attachedServers > 0;
  const count = (name: CanaryCounter): number | null => {
    try {
      const value = s.providers[name]?.();
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  return {
    activeResponses: observed ? s.activeResponses : null,
    activeWebSockets: observed ? s.activeWebSockets : null,
    pendingUploads: observed ? s.pendingUploads : null,
    queuedRequests: count("queuedRequests"),
    conversationPins: count("conversationPins"),
    upstreamLeases: count("upstreamLeases"),
    draining: s.draining,
  };
}
