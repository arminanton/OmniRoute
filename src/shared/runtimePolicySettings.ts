import {
  requiresLockedManagementAuth,
  RuntimePolicyError,
  assertLockedManagementAuthProvisioned,
} from "./runtimePolicy";
import { assertRuntimePolicyProxyConfig } from "./runtimePolicyProxyConfig";
import { validateRuntimeHelperSettings } from "./runtimePolicyEntrypoints";

/**
 * Admission for a complete merged settings candidate. No DB reads, writes,
 * network work or fallback. Call before hashing/backups/persistence/side effects.
 * Startup supplies the effective locked auth requirement, not a mutable bypass.
 */
export function assertRuntimePolicySettings(candidate: Readonly<Record<string, unknown>>): void {
  if (!requiresLockedManagementAuth()) return;
  if (candidate.requireLogin === false) {
    throw new RuntimePolicyError("management-auth-required");
  }
  // A password rotation is still plaintext here. Do not let the previous hash,
  // bootstrap env or OIDC config hide an explicitly weak/blank replacement.
  if (candidate.newPassword !== undefined) {
    assertLockedManagementAuthProvisioned({ password: candidate.newPassword });
  }
  assertLockedManagementAuthProvisioned(candidate, process.env.INITIAL_PASSWORD);
  assertRuntimePolicyProxyConfig(candidate);
  validateRuntimeHelperSettings(candidate);
}
