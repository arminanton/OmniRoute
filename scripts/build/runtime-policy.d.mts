export type Profile = "omni-app-residential-direct-v1";
export type ConfigBinding =
  | { readonly kind: "connection"; readonly providerId: string; readonly connectionId: string }
  | { readonly kind: "node"; readonly providerId: string; readonly nodeId: string };
export type ConfigAdapter =
  "executor-base-url-v1" | "compatible-node-base-url-v1" | "search-base-url-v1";
export type ProviderGrant =
  | { readonly kind: "builtin"; readonly providerId: string }
  | {
      readonly kind: "configured";
      readonly binding: ConfigBinding;
      readonly adapter: ConfigAdapter;
      readonly endpoint: string;
    };
export type LocalHelperGrant =
  | { readonly role: "browser-cdp"; readonly endpoint: string }
  | { readonly role: "codex-app-server"; readonly endpoint: string };
export interface LockedPolicyV1 {
  readonly schema: 1;
  readonly profile: Profile;
  readonly providers: readonly ProviderGrant[];
  readonly helpers: readonly LocalHelperGrant[];
}
export interface ActivationV1 {
  readonly schema: 1;
  readonly profile: Profile;
  readonly policySha256: string;
}
export type RuntimePolicyState =
  | Readonly<{ mode: "standalone" }>
  | Readonly<{ mode: "locked"; policySha256: string; policy: LockedPolicyV1 }>;
export type EntrypointSelection = ProviderGrant;
export type ProxySelection = "none" | "configured" | "opaque";
export type HelperUse = Readonly<{
  role: LocalHelperGrant["role"];
  endpoint: string;
  phase: "configured" | "connect" | "advertised-cdp-websocket";
}>;
export type PolicyReason =
  | "bootstrap-invalid"
  | "proxy-forbidden"
  | "entrypoint-unapproved"
  | "helper-unapproved"
  | "capability-disabled"
  | "management-auth-required";
export declare class RuntimePolicyError extends Error {
  constructor(reason: PolicyReason);
  readonly code: "OMNI_RUNTIME_POLICY_DENIED";
  readonly reason: PolicyReason;
}
export declare function getRuntimePolicy(): RuntimePolicyState;
export declare function requireLockedBootstrap(): Extract<RuntimePolicyState, { mode: "locked" }>;
export declare function requiresLockedManagementAuth(): boolean;
export declare function assertNoApplicationProxy(selection: ProxySelection): void;
export declare function assertProviderEntrypoint(selection: EntrypointSelection): void;
export declare function assertLocalHelper(use: HelperUse): void;
export declare function assertNotLockedCapability(capability: string): void;
export declare function isRuntimePolicyError(error: unknown): error is RuntimePolicyError;
export declare function markRuntimePolicyResponse<T extends Response>(response: T): T;
export declare function isRuntimePolicyResponse(response: unknown): boolean;
/** Pure, immutable fixture/artifact parsers. These never change the live reader. */
export declare function parseLockedPolicy(value: unknown): LockedPolicyV1;
export declare function parseActivation(value: unknown): ActivationV1;
