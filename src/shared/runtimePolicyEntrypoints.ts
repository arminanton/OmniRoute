/**
 * Locked-profile configuration-entrypoint admission. This leaf has no DB imports.
 * Approval and adapter coverage are separate. The production inventory is staged
 * empty until the owner reviews the actual provider/connection/node set. Synthetic
 * projection fixtures below this boundary are not production approvals.
 */
import {
  getRuntimePolicy,
  RuntimePolicyError,
  assertProviderEntrypoint,
  assertLocalHelper,
  assertNotLockedCapability,
  type ConfigAdapter,
  type ConfigBinding,
  type EntrypointSelection,
} from "./runtimePolicy";
import { assertRuntimePolicyConnectionProxyConfig } from "./runtimePolicyProxyConfig";

type Candidate = Readonly<Record<string, unknown>>;
export interface ReviewedRuntimeProviderAdapter {
  readonly providerId: string;
  readonly builtin: boolean;
  readonly adapters: readonly ConfigAdapter[];
  /** Exact connection adapter selected by reviewed server code, never request config. */
  readonly connectionAdapter?: "executor-base-url-v1" | "search-base-url-v1";
  /** Every non-baseUrl field needs explicit review. Unknown overrides never become builtin. */
  readonly nonRoutingFields: readonly string[];
}
export const REVIEWED_RUNTIME_PROVIDER_ADAPTERS: readonly ReviewedRuntimeProviderAdapter[] =
  Object.freeze([]);

interface ProviderProjection {
  readonly providerId: string;
  readonly binding?: ConfigBinding;
  readonly adapter?: ConfigAdapter;
  readonly providerSpecificData?: Candidate;
}

function deny(): never {
  throw new RuntimePolicyError("entrypoint-unapproved");
}
function record(value: unknown): Candidate {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Candidate) : {};
}
function selected(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}
function normalizedEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\s\\?#]/.test(value))
    return deny();
  if (!/^https?:\/\/[^/]+/i.test(value)) return deny();
  const authority = value.slice(value.indexOf("://") + 3).split("/")[0];
  if (authority.includes("@")) return deny();
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return deny();
    return url.href;
  } catch {
    return deny();
  }
}
function supported(providerId: string, inventory: readonly ReviewedRuntimeProviderAdapter[]) {
  return inventory.find((entry) => entry.providerId === providerId) ?? deny();
}

/** Pure projection: caller must supply identities resolved by the server, not request JSON. */
export function projectProviderEntrypoint(
  candidate: ProviderProjection,
  inventory: readonly ReviewedRuntimeProviderAdapter[]
): EntrypointSelection {
  const coverage = supported(candidate.providerId, inventory);
  const data = candidate.providerSpecificData ?? {};
  for (const key of Object.keys(data)) {
    if (selected(data[key]) && key !== "baseUrl" && !coverage.nonRoutingFields.includes(key))
      deny();
  }
  if (!selected(data.baseUrl)) {
    if (!coverage.builtin || candidate.binding?.kind === "node") deny();
    return { kind: "builtin", providerId: candidate.providerId };
  }
  const binding = candidate.binding;
  if (!binding || binding.providerId !== candidate.providerId) deny();
  const identity =
    binding.kind === "node"
      ? binding.nodeId
      : binding.kind === "connection"
        ? binding.connectionId
        : null;
  if (typeof identity !== "string" || !identity || identity.trim() !== identity) deny();
  const adapter =
    candidate.adapter ??
    (binding.kind === "node" ? "compatible-node-base-url-v1" : coverage.connectionAdapter);
  if (!adapter || !coverage.adapters.includes(adapter)) deny();
  if ((binding.kind === "node") !== (adapter === "compatible-node-base-url-v1")) deny();
  return { kind: "configured", binding, adapter, endpoint: normalizedEndpoint(data.baseUrl) };
}

/** Called by startup and again at use; JSON grants cannot enable uncovered code. */
export function assertRuntimeEntrypointInventory(): void {
  const state = getRuntimePolicy();
  if (state.mode !== "locked") return;
  for (const grant of state.policy.providers) {
    const providerId = grant.kind === "builtin" ? grant.providerId : grant.binding.providerId;
    const coverage = supported(providerId, REVIEWED_RUNTIME_PROVIDER_ADAPTERS);
    if (grant.kind === "builtin" ? !coverage.builtin : !coverage.adapters.includes(grant.adapter))
      deny();
  }
}

/** Before lazy import, credential refresh, provider discovery or lease acquisition. */
export function assertRuntimeProviderSupported(providerId: string): void {
  const state = getRuntimePolicy();
  if (state.mode !== "locked") return;
  supported(providerId, REVIEWED_RUNTIME_PROVIDER_ADAPTERS);
  if (
    !state.policy.providers.some(
      (grant) =>
        (grant.kind === "builtin" ? grant.providerId : grant.binding.providerId) === providerId
    )
  )
    deny();
}

// Symbols survive internal object spread but cannot be forged by JSON fields. No
// exported symbol or setter for the policy authority; this marks server-resolved
// configuration provenance only. Duplicate bundles share this nonsecret marker.
const BINDING = Symbol.for("omniroute.runtime-policy.server-config-binding.v1");
type BoundData = Candidate & { readonly [BINDING]?: ConfigBinding };
export function bindRuntimeProviderData(
  data: Candidate,
  binding: ConfigBinding
): Record<string, unknown> {
  if (getRuntimePolicy().mode !== "locked") return data as Record<string, unknown>;
  return { ...data, [BINDING]: Object.freeze({ ...binding }) };
}
export function assertRuntimeExecutorEntrypoint(
  providerId: string,
  credentials?: { readonly providerSpecificData?: Candidate } | null,
  adapter?: ConfigAdapter
): void {
  if (getRuntimePolicy().mode !== "locked") return;
  const data = record(credentials?.providerSpecificData) as BoundData;
  validateRuntimeHelperSettings(data);
  assertProviderEntrypoint(
    projectProviderEntrypoint(
      {
        providerId,
        binding: data[BINDING],
        adapter,
        providerSpecificData: data,
      },
      REVIEWED_RUNTIME_PROVIDER_ADAPTERS
    )
  );
}

/** Merged effective connection candidate, before persistence or network probes. */
export function validateProviderConnectionCandidate(
  candidate: Candidate
): EntrypointSelection | undefined {
  if (getRuntimePolicy().mode !== "locked") return;
  assertRuntimePolicyConnectionProxyConfig(candidate);
  const data = record(candidate.providerSpecificData) as BoundData;
  const providerId =
    data[BINDING]?.providerId ?? (typeof candidate.provider === "string" ? candidate.provider : "");
  validateRuntimeHelperSettings(data);
  const binding: ConfigBinding = data[BINDING] ?? {
    kind: "connection",
    providerId,
    connectionId: typeof candidate.id === "string" ? candidate.id : "",
  };
  const selection = projectProviderEntrypoint(
    { providerId, binding, providerSpecificData: data },
    REVIEWED_RUNTIME_PROVIDER_ADAPTERS
  );
  assertProviderEntrypoint(selection);
  return selection;
}

/** Use the canonical stored node ID, never the caller's display prefix/type. */
export function validateProviderNodeCandidate(candidate: Candidate): void {
  if (getRuntimePolicy().mode !== "locked") return;
  const providerId = typeof candidate.id === "string" ? candidate.id : "";
  const data: Record<string, unknown> = {};
  for (const key of ["baseUrl", "apiType", "chatPath", "modelsPath", "customHeaders"]) {
    if (selected(candidate[key])) data[key] = candidate[key];
  }
  assertProviderEntrypoint(
    projectProviderEntrypoint(
      {
        providerId,
        binding: { kind: "node", providerId, nodeId: providerId },
        adapter: "compatible-node-base-url-v1",
        providerSpecificData: data,
      },
      REVIEWED_RUNTIME_PROVIDER_ADAPTERS
    )
  );
}

/** Pure helper candidate validator; connection fields have already been merged. */
export function validateRuntimeHelperSettings(candidate: Candidate): void {
  if (getRuntimePolicy().mode !== "locked") return;
  for (const [key, role] of [
    ["browserCdpEndpoint", "browser-cdp"],
    ["codexAppServerUrl", "codex-app-server"],
  ] as const) {
    if (selected(candidate[key]))
      assertLocalHelper({
        role,
        endpoint: typeof candidate[key] === "string" ? candidate[key] : "",
        phase: "configured",
      });
  }
  for (const key of [
    "chromeExecutablePath",
    "browserHostDescriptorPath",
    "browserHelperScriptPath",
  ]) {
    if (selected(candidate[key])) assertNotLockedCapability("dynamic-helper-launch");
  }
  if (candidate.browserHost === "launcher") assertNotLockedCapability("dynamic-helper-launch");
}

/** Explicit environment input keeps startup/settings composition free of DB/env reads. */
export function validateRuntimeHelperEnvironment(environment: Candidate): void {
  if (getRuntimePolicy().mode !== "locked") return;
  for (const [key, role] of [
    ["OBSCURA_CDP_ENDPOINT", "browser-cdp"],
    ["CHATGPT_WEB_CODEX_CDP_URL", "browser-cdp"],
    ["OMNIROUTE_CODEX_APPSERVER_WS", "codex-app-server"],
  ] as const) {
    if (selected(environment[key]))
      assertLocalHelper({
        role,
        endpoint: typeof environment[key] === "string" ? environment[key] : "",
        phase: "configured",
      });
  }
}
