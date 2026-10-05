import { createHash } from "node:crypto";
import { buildErrorBody } from "../../utils/error.ts";
import { isModelLocked, hasPerModelQuota } from "../accountFallback.ts";
import { isProviderInCooldown } from "../providerCooldownTracker.ts";
import { getCircuitBreaker } from "../../../src/shared/utils/circuitBreaker.ts";
import type { ResilienceSettings } from "../../../src/lib/resilience/settings";
import { checkCredentialGate } from "../credentialGate.ts";
import { canAffordRequest } from "../../../src/lib/quota/quotaScheduler.ts";
import { resolveQuotaExhaustionCutoffForTarget } from "./quotaExhaustionCutoff.ts";
import type { ResetWindowConfig } from "./quotaScoring.ts";
import { parseModel } from "../model.ts";
import type { ComboLogger, IsModelAvailable } from "./types.ts";

import type { ResolvedComboTarget } from "./types.ts";

type NativeTurnPin = {
  comboName: string;
  modelStr: string;
  provider: string;
  connectionId: string;
  createdAt: number;
  expiresAt: number;
};

const TTL_MS = 45 * 60_000;
const MAX_PINS = 1_000;
const pins = new Map<string, NativeTurnPin>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function turnMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = record(body.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try {
      return record(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  return record(raw);
}

export function nativeCodexTurnKey(
  body: Record<string, unknown>,
  comboName: string
): string | null {
  const metadata = turnMetadata(body);
  const threadId = typeof metadata?.thread_id === "string" ? metadata.thread_id : "";
  const turnId = typeof metadata?.turn_id === "string" ? metadata.turn_id : "";
  if (!threadId || !turnId) return null;
  return createHash("sha256").update(JSON.stringify({ comboName, threadId, turnId })).digest("hex");
}

function prune(now = Date.now()): void {
  for (const [key, pin] of pins) if (pin.expiresAt <= now) pins.delete(key);
  while (pins.size > MAX_PINS) {
    const oldest = pins.keys().next().value as string | undefined;
    if (!oldest) break;
    pins.delete(oldest);
  }
}

export function getNativeCodexTurnPin(
  body: Record<string, unknown>,
  comboName: string
): NativeTurnPin | null {
  prune();
  const key = nativeCodexTurnKey(body, comboName);
  return key ? (pins.get(key) ?? null) : null;
}

export function pinNativeCodexTurn(args: {
  body: Record<string, unknown>;
  comboName: string;
  target: ResolvedComboTarget;
  connectionId: string;
}): void {
  const key = nativeCodexTurnKey(args.body, args.comboName);
  if (!key || !args.connectionId) return;
  const existing = pins.get(key);
  if (
    existing &&
    (existing.modelStr !== args.target.modelStr || existing.provider !== args.target.provider)
  ) {
    throw new Error("Native Codex turn target changed after output was emitted");
  }
  // ConnectionId changes are allowed (failover to sibling connection)
  // as long as provider + model stay the same.
  const now = Date.now();
  pins.set(key, {
    comboName: args.comboName,
    modelStr: args.target.modelStr,
    provider: args.target.provider,
    connectionId: args.connectionId,
    createdAt: existing?.createdAt ?? now,
    expiresAt: now + TTL_MS,
  });
  prune(now);
}

/**
 * Apply a native Codex turn pin to the target list.
 *
 * Returns all compatible targets (same provider + model) with the pinned
 * connection preferred first. This allows fill-first failover: if the
 * pinned connection is rejected by a pre-dispatch gate, the combo engine
 * tries the next compatible connection instead of returning 503.
 *
 * Provider + model remain locked for the turn — only the connection
 * can fall over.
 */
export function applyNativeCodexTurnPin(
  targets: ResolvedComboTarget[],
  pin: NativeTurnPin,
  activeConnectionIds?: string[]
): ResolvedComboTarget[] {
  const compatible = targets
    .filter(
      (candidate) => candidate.modelStr === pin.modelStr && candidate.provider === pin.provider
    )
    .flatMap((target) => {
      if (target.connectionId || !activeConnectionIds?.length) return [target];
      const eligible = activeConnectionIds.filter(
        (id) => !target.allowedConnectionIds?.length || target.allowedConnectionIds.includes(id)
      );
      return eligible.length
        ? eligible.map((connectionId) => ({
            ...target,
            connectionId,
            executionKey: `${target.executionKey}@${connectionId}`,
          }))
        : [target];
    });
  if (compatible.length === 0) return [];

  // Affinity only reorders the CURRENT eligible pool. Replacing its first
  // candidate with a missing pin resurrects a disabled/removed account and
  // discards a healthy sibling. Dynamic targets expand from the current active
  // pool so per-account model locks and same-model fallback remain visible.
  const pinnedIndex = compatible.findIndex((t) => t.connectionId === pin.connectionId);
  const allowedConnectionIds = compatible
    .map((t) => t.connectionId)
    .filter((id): id is string => id !== null);

  // Pinned connection first, then same-provider/model siblings as fallback
  const ordered =
    pinnedIndex < 0
      ? compatible
      : [compatible[pinnedIndex], ...compatible.filter((_, i) => i !== pinnedIndex)];

  return ordered.map((target) =>
    target.connectionId && !target.allowedConnectionIds?.length
      ? { ...target, allowedConnectionIds }
      : target
  );
}

export function revokeNativeCodexTurnPinsForConnection(connectionId: string): number {
  let revoked = 0;
  for (const [key, pin] of pins) {
    if (pin.connectionId !== connectionId) continue;
    pins.delete(key);
    revoked += 1;
  }
  return revoked;
}

export const NATIVE_CODEX_PINNED_MODEL_UNAVAILABLE_CODE = "NATIVE_CODEX_PINNED_MODEL_UNAVAILABLE";
export const NATIVE_CODEX_PINNED_MODEL_UNAVAILABLE_MESSAGE =
  "The model handling this native Codex turn is no longer available. This turn cannot switch providers or models after output has been emitted. Start a new turn to allow Combo routing to select another model.";

export function createPinnedModelUnavailableResponse(): Response {
  const body = buildErrorBody(400, NATIVE_CODEX_PINNED_MODEL_UNAVAILABLE_MESSAGE, undefined, {
    code: NATIVE_CODEX_PINNED_MODEL_UNAVAILABLE_CODE,
    type: "invalid_request_error",
  });
  return new Response(JSON.stringify(body), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

export interface CheckPinnedTargetsModelScopedUnusableOptions {
  pinnedTargets: ResolvedComboTarget[];
  resilienceSettings?: ResilienceSettings | null;
  quotaCutoffResetWindowConfig?: ResetWindowConfig;
  comboName: string;
  body: Record<string, unknown>;
  log?: ComboLogger;
  isModelAvailable?: IsModelAvailable;
}

export async function isPinnedTargetModelScopedUnusable(args: {
  target: ResolvedComboTarget;
  resilienceSettings?: ResilienceSettings | null;
  quotaCutoffResetWindowConfig?: ResetWindowConfig;
  comboName: string;
  body: Record<string, unknown>;
  log?: ComboLogger;
  isModelAvailable?: IsModelAvailable;
}): Promise<boolean> {
  const {
    target,
    resilienceSettings,
    quotaCutoffResetWindowConfig,
    comboName,
    body,
    log,
    isModelAvailable,
  } = args;
  const provider = target.provider;
  const connectionId = target.connectionId || "";
  const rawModel = parseModel(target.modelStr).model || target.modelStr;

  if (provider && provider !== "unknown") {
    const cb = getCircuitBreaker(provider);
    if (cb.getStatus().state === "OPEN") return false;
    if (
      resilienceSettings?.providerCooldown?.enabled &&
      (isProviderInCooldown(provider, connectionId || undefined, resilienceSettings) ||
        isProviderInCooldown(provider, undefined, resilienceSettings))
    ) {
      return false;
    }
  }

  if (
    connectionId &&
    checkCredentialGate(connectionId, provider, target.modelStr).allowed === false
  ) {
    return false;
  }

  if (provider && rawModel && isModelLocked(provider, connectionId, rawModel)) return true;

  if (
    process.env.OMNIROUTE_QUOTA_AWARE_ROUTING === "1" &&
    provider &&
    connectionId &&
    !canAffordRequest(connectionId, target.modelStr, body).affordable
  ) {
    return true;
  }

  if (provider && connectionId && quotaCutoffResetWindowConfig) {
    const cutoff = await resolveQuotaExhaustionCutoffForTarget(
      provider,
      connectionId,
      resilienceSettings,
      quotaCutoffResetWindowConfig,
      comboName,
      log ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      target.modelStr
    );
    if (cutoff.blocked) return true;
  }

  if (isModelAvailable) {
    const available = await Promise.resolve(isModelAvailable(target.modelStr, target)).catch(
      () => true
    );
    if (
      !available &&
      provider &&
      rawModel &&
      (isModelLocked(provider, connectionId, rawModel) || hasPerModelQuota(provider, rawModel))
    ) {
      return true;
    }
  }

  return false;
}

export async function areAllPinnedTargetsModelScopedUnusable(
  options: CheckPinnedTargetsModelScopedUnusableOptions
): Promise<boolean> {
  if (!options.pinnedTargets?.length) return false;
  for (const target of options.pinnedTargets) {
    if (!(await isPinnedTargetModelScopedUnusable({ target, ...options }))) {
      return false;
    }
  }
  return true;
}

export function clearNativeCodexTurnPinsForTests(): void {
  pins.clear();
}
