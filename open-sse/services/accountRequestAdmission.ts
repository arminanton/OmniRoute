import { resolveQuotaIdentity } from "./quotaIdentity.ts";
import { acquireMany } from "./accountSemaphore.ts";

type AdmissionCredentials = {
  connectionId?: string | null;
  id?: string | null;
  maxConcurrent?: number | null;
  providerSpecificData?: Record<string, unknown> | null;
};

/**
 * Run one selected-account media request under the shared account cap when the
 * operator enabled shared admission and configured a positive account limit.
 * Unknown/unlimited accounts keep their existing behavior. The supplied signal
 * is also the lease-loss fence for the upstream operation.
 */
export async function withConfiguredSharedAccountAdmission<T>(
  options: {
    provider: string;
    credentials: AdmissionCredentials | null | undefined;
    signal?: AbortSignal;
  },
  operation: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  if (process.env.OMNI_SHARED_ADMISSION !== "true") return operation(options.signal);

  const credentials = options.credentials;
  const configuredCapacity = credentials?.maxConcurrent;
  if (
    typeof configuredCapacity !== "number" ||
    !Number.isFinite(configuredCapacity) ||
    configuredCapacity <= 0
  ) {
    return operation(options.signal);
  }

  const connectionId = credentials.connectionId ?? credentials.id ?? null;
  const key = resolveQuotaIdentity(options.provider, connectionId, credentials);
  if (!key) return operation(options.signal);

  const controller = new AbortController();
  const callerSignal = options.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let release: (() => void) | undefined;
  try {
    try {
      release = await acquireMany(
        [{ key, maxConcurrency: Math.max(1, Math.trunc(configuredCapacity)) }],
        {
          signal: controller.signal,
          onLeaseLost: (error) => controller.abort(error),
        }
      );
    } catch (error) {
      throw Object.assign(
        new Error(
          controller.signal.aborted
            ? "Account capacity admission was cancelled"
            : "Account capacity admission is unavailable"
        ),
        {
          code: "ACCOUNT_ADMISSION_UNAVAILABLE",
          statusCode: controller.signal.aborted ? 499 : 503,
          cause: error,
        }
      );
    }

    controller.signal.throwIfAborted();
    return await operation(controller.signal);
  } finally {
    release?.();
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
