import type { SemaphoreRequirement } from "../../services/accountSemaphore.ts";

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Local starting policy, never a claim about an upstream subscription's capacity. */
export const SHARED_ACCOUNT_BOOTSTRAP = parsePositiveInt(
  process.env.OMNI_SHARED_ACCOUNT_BOOTSTRAP,
  4
);
export const SHARED_ACCOUNT_DEFAULT_CEILING = parsePositiveInt(
  process.env.OMNI_SHARED_ACCOUNT_CEILING,
  32
);

export function resolveSharedAccountAdmissionRequirement(
  key: string | null,
  maxConcurrency: number | null,
  credentials: Record<string, unknown> | null | undefined
): SemaphoreRequirement {
  const requirement: SemaphoreRequirement = { key: key || "", maxConcurrency };
  if (process.env.OMNI_SHARED_ADMISSION !== "true" || !key) return requirement;
  // Explicit zero (and legacy non-positive bypasses) never inherit a default cap.
  if (maxConcurrency != null && maxConcurrency <= 0) return requirement;
  const data = credentials?.providerSpecificData as Record<string, unknown> | undefined;
  if (data?.quotaAdaptiveAdmission === false) {
    return { ...requirement, maxConcurrency: maxConcurrency ?? SHARED_ACCOUNT_BOOTSTRAP };
  }
  const ceiling = maxConcurrency ?? SHARED_ACCOUNT_DEFAULT_CEILING;
  const initial =
    maxConcurrency != null && maxConcurrency > 0
      ? maxConcurrency
      : SHARED_ACCOUNT_BOOTSTRAP;
  return {
    ...requirement,
    maxConcurrency: ceiling,
    adaptive: true,
    initialConcurrency: Math.min(initial, ceiling),
  };
}
