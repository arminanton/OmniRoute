import {
  requiresLockedManagementAuth,
  RuntimePolicyError,
} from "../../scripts/build/runtime-policy.mjs";

/** Server-only facade. Every bundle reads the same fixed protected revision. */
export {
  getRuntimePolicy,
  requireLockedBootstrap,
  requiresLockedManagementAuth,
  assertNoApplicationProxy,
  assertProviderEntrypoint,
  assertLocalHelper,
  assertNotLockedCapability,
  RuntimePolicyError,
  isRuntimePolicyError,
  markRuntimePolicyResponse,
  isRuntimePolicyResponse,
} from "../../scripts/build/runtime-policy.mjs";
export type {
  Profile,
  ConfigBinding,
  ConfigAdapter,
  ProviderGrant,
  LocalHelperGrant,
  LockedPolicyV1,
  ActivationV1,
  RuntimePolicyState,
  EntrypointSelection,
  ProxySelection,
  HelperUse,
  PolicyReason,
} from "../../scripts/build/runtime-policy.mjs";

/** Pure, DB-free provisioning admission. Call before migrating legacy plaintext. */
export function assertLockedManagementAuthProvisioned(
  settings: Readonly<Record<string, unknown>>,
  initialPassword?: string | null
): void {
  if (!requiresLockedManagementAuth()) return;
  // Match password migration precedence. Callers explicitly project the env;
  // the pure validator does not read credentials/configuration on its own.
  const stored = typeof settings.password === "string" ? settings.password : "";
  const candidate = stored || (typeof initialPassword === "string" ? initialPassword : "");
  if (candidate.trim() === "CHANGEME") throw new RuntimePolicyError("management-auth-required");
  if (candidate.trim()) return;
  const oidcConfigured =
    settings.oidcEnabled === true &&
    [settings.oidcIssuer, settings.oidcClientId, settings.oidcClientSecret].every(
      (value) => typeof value === "string" && value.trim().length > 0
    );
  if (!oidcConfigured) throw new RuntimePolicyError("management-auth-required");
}
