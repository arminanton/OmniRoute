import { acquireConfiguredSharedAccountAdmission } from "../../services/accountRequestAdmission.ts";
import { reserveAccountRequest } from "../../services/accountRequestOccupancy.ts";
import { resolveProviderId } from "@/shared/constants/providers";

export type SearchAdmissionCredentials = {
  id?: string | null;
  connectionId?: string | null;
  provider?: string | null;
  maxConcurrent?: number | null;
  providerSpecificData?: Record<string, unknown> | null;
};

export type SearchAdmissionOutcome<T> =
  { admitted: true; value: T } | { admitted: false; error: string };

/** Reserve only the cache producer's selected account for one provider attempt. */
export async function runWithSearchAccountAdmission<T>(options: {
  provider: string;
  credentials: SearchAdmissionCredentials;
  fallbackConnectionId?: string;
  signal?: AbortSignal;
  attempt: (admissionSignal?: AbortSignal) => Promise<T>;
}): Promise<SearchAdmissionOutcome<T>> {
  const { credentials, signal } = options;
  const releaseLocal = reserveAccountRequest(
    credentials.connectionId || credentials.id || options.fallbackConnectionId
  );
  let sharedAdmission: Awaited<ReturnType<typeof acquireConfiguredSharedAccountAdmission>> = null;
  const throwIfCallerAborted = (cause?: unknown): never => {
    if (signal?.reason !== undefined) throw signal.reason;
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    throw cause;
  };

  try {
    const credentialOwner =
      typeof credentials.provider === "string" && credentials.provider.trim()
        ? resolveProviderId(credentials.provider.trim())
        : options.provider;
    try {
      sharedAdmission = await acquireConfiguredSharedAccountAdmission({
        provider: credentialOwner,
        credentials,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throwIfCallerAborted(error);
      const admissionError = error as { code?: string; message?: string };
      if (admissionError.code === "ACCOUNT_ADMISSION_UNAVAILABLE") {
        return {
          admitted: false,
          error: admissionError.message || "Provider account capacity admission is unavailable",
        };
      }
      throw error;
    }

    if (signal?.aborted) throwIfCallerAborted();
    const value = await options.attempt(sharedAdmission?.signal);
    if (sharedAdmission?.signal.aborted && !signal?.aborted) {
      return {
        admitted: false,
        error: "Provider account capacity admission was lost during search",
      };
    }
    return { admitted: true, value };
  } catch (error) {
    if (signal?.aborted) throwIfCallerAborted(error);
    if (sharedAdmission?.signal.aborted) {
      return {
        admitted: false,
        error: "Provider account capacity admission was lost during search",
      };
    }
    throw error;
  } finally {
    sharedAdmission?.release();
    releaseLocal();
  }
}
