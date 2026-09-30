/** Pure, DB-free admission for effective proxy configuration candidates. */
import { FEATURE_FLAG_DEFINITIONS } from "./constants/featureFlagDefinitions";
import { assertNoApplicationProxy } from "./runtimePolicy";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  assertNoApplicationProxy("opaque");
  return {};
}

/** Null is confirmed direct; malformed/opaque values are not proof of directness. */
export function assertRuntimePolicyProxySelection(value: unknown): void {
  const configured =
    (typeof value === "string" && value.length > 0) ||
    (isRecord(value) && typeof value.host === "string" && value.host.length > 0);
  assertNoApplicationProxy(value === null ? "none" : configured ? "configured" : "opaque");
}

function assertLegacyEntryShape(value: unknown): void {
  if (value === null) return;
  if (typeof value === "string" && value.length > 0) return;
  if (isRecord(value) && typeof value.host === "string" && value.host.length > 0) return;
  assertNoApplicationProxy("opaque");
}

/**
 * `candidate` is a complete merged settings snapshot. `featureFlags` is the
 * authoritative feature_flags namespace projected by the caller, not a patch.
 * Match resolveFeatureFlag: DB (including an empty string) > nonempty env > default.
 * Dormant rows remain intact. This module performs no DB I/O or mutation.
 */
export function assertRuntimePolicyProxyConfig(
  candidate: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  assertRuntimePolicyConnectionProxyConfig(candidate);
  const legacy = record(candidate.proxyConfig);
  if (Object.hasOwn(legacy, "global")) assertLegacyEntryShape(legacy.global);
  const maps = ["providers", "combos", "keys"].map((key) => record(legacy[key]));
  for (const map of maps) for (const value of Object.values(map)) assertLegacyEntryShape(value);
  if (candidate.proxyAssignments !== undefined && !Array.isArray(candidate.proxyAssignments)) {
    assertNoApplicationProxy("opaque");
  }
  if (
    candidate.proxyApiKeyAssignments !== undefined &&
    !Array.isArray(candidate.proxyApiKeyAssignments)
  ) {
    assertNoApplicationProxy("opaque");
  }
  if (
    candidate.proxyPerKeyConnectionEnabled !== undefined &&
    typeof candidate.proxyPerKeyConnectionEnabled !== "boolean"
  ) {
    assertNoApplicationProxy("opaque");
  }
  if (candidate.proxyEnabled !== false) {
    const configured =
      legacy.global != null ||
      maps.some((map) => Object.values(map).some((value) => value !== null));
    const assigned =
      Array.isArray(candidate.proxyAssignments) && candidate.proxyAssignments.length > 0;
    const perKeyEnabled =
      candidate.perKeyProxyEnabled !== undefined && candidate.perKeyProxyEnabled !== false;
    const apiKeyAssigned =
      perKeyEnabled &&
      candidate.proxyPerKeyConnectionEnabled !== false &&
      Array.isArray(candidate.proxyApiKeyAssignments) &&
      candidate.proxyApiKeyAssignments.length > 0;
    assertNoApplicationProxy(configured || assigned || apiKeyAssigned ? "configured" : "none");
  }
  const flags = record(candidate.featureFlags);
  const key = "PROXY_AUTO_SELECT_ENABLED";
  const value =
    flags[key] !== undefined
      ? flags[key]
      : env[key] !== undefined && env[key] !== ""
        ? env[key]
        : FEATURE_FLAG_DEFINITIONS.find((definition) => definition.key === key)?.defaultValue;
  if (value !== undefined && typeof value !== "string") assertNoApplicationProxy("opaque");
  const autoSelect = value === "true" || value === "1" || value === "yes";
  // Proxy env is independent of the DB toggle. NO_PROXY is per destination and
  // is not proof that every future application request is direct.
  const environmentProxy = PROXY_ENV_KEYS.some((name) => Boolean(env[name]));
  assertNoApplicationProxy(autoSelect || environmentProxy ? "configured" : "none");
}

/**
 * Permission toggles alone do not select a proxy. `proxy`, when supplied, is a
 * server-resolved connection selection, not an untrusted request assertion.
 * Environment selection is checked by the settings/transport adapters.
 */
export function assertRuntimePolicyConnectionProxyConfig(
  candidate: Readonly<Record<string, unknown>>
): void {
  if (Object.hasOwn(candidate, "proxy")) assertRuntimePolicyProxySelection(candidate.proxy);
  else assertNoApplicationProxy("none");
}
