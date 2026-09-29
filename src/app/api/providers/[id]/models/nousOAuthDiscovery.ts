import { validateNousOAuthInferenceBaseUrl } from "@omniroute/open-sse/config/nousOAuth.ts";

/** Nous model prices are live data, not a fixed set of model IDs. */
export interface NousOAuthPublicModel {
  id: string;
  name: string;
  free: boolean;
  isFree: boolean;
  pricing?: { prompt: string; completion: string };
}

export type NousOAuthDiscoveryResult =
  | { models: NousOAuthPublicModel[]; source: "api" | "cache"; warning?: undefined }
  | { models: []; source: "error"; warning: string };

export const NOUS_OAUTH_CATALOG_TTL_MS = 5 * 60_000;
export const NOUS_OAUTH_CATALOG_TIMEOUT_MS = 10_000;
export const NOUS_OAUTH_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
export const NOUS_OAUTH_CATALOG_MAX_ROWS = 5_000;

interface DiscoveryOptions {
  /** Force a fresh request, including when a valid cached catalog exists. */
  refresh?: boolean;
  /** Injectable transport and clock permit isolated, network-free tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Shorter test/request deadline; never extends the production upper bound. */
  timeoutMs?: number;
}

const cache = new Map<
  string,
  { models: NousOAuthPublicModel[]; cachedAt: number; expiresAt: number }
>();
const inFlight = new Map<string, Promise<NousOAuthDiscoveryResult>>();
const UNAVAILABLE = "Nous OAuth public model catalog unavailable";

/** Prevent callers from changing the cached model flags, prices, or names. */
function copyModels(models: NousOAuthPublicModel[]): NousOAuthPublicModel[] {
  return models.map((model) => ({
    ...model,
    ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
  }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Number('') and Number('0x0') are zero, but neither is a decimal price. */
function parsePrice(value: unknown): { zero: boolean; text: string } | null {
  // JSON.parse rounds even a positive numeric literal like 1e-999 to zero.
  // Only original STRING prices can prove an exact zero decimal mantissa.
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  if (!Number.isFinite(Number(text))) return null;
  const mantissa = text.replace(/^[+-]/, "").split(/e/i)[0];
  return { zero: !/[1-9]/.test(mantissa), text };
}

function toPublicModel(value: unknown): NousOAuthPublicModel | null {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || !row.id.trim()) return null;
  // Keep upstream model IDs exactly as sent: callers pass these IDs to /chat/completions.
  const id = row.id;
  const name =
    typeof row.display_name === "string" && row.display_name.trim()
      ? row.display_name
      : typeof row.name === "string" && row.name.trim()
        ? row.name
        : id;
  const pricing = asRecord(row.pricing);
  const prompt = parsePrice(pricing?.prompt);
  const completion = parsePrice(pricing?.completion);
  const free = prompt !== null && completion !== null && prompt.zero && completion.zero;
  // Keep paid names unchanged except for a misleading upstream free suffix.
  const paidName = name.replace(/\s*\(free\)\s*$/i, "").trimEnd() || id;
  // Do not pass a positive underflowing price on to Number()-based consumers,
  // which would otherwise mistake 1e-999 for a verified zero price.
  const safePricing =
    prompt &&
    completion &&
    (prompt.zero || Number(prompt.text) !== 0) &&
    (completion.zero || Number(completion.text) !== 0);
  return {
    id,
    name: free ? (/\(free\)$/i.test(name.trimEnd()) ? name : `${name} (Free)`) : paidName,
    free,
    isFree: free,
    ...(safePricing ? { pricing: { prompt: prompt!.text, completion: completion!.text } } : {}),
  };
}

async function fetchPublicModels(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<NousOAuthPublicModel[]> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Keep the deadline active until the whole body has been read. A fetch-only
  // timeout would permit an unbounded or never-ending /models response body.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error("Nous OAuth catalog deadline exceeded"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(`${baseUrl}/models`, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: abort.signal,
        });
        // Never follow Location, even if the public service redirects to another host.
        if (!response.ok || (response.status >= 300 && response.status < 400)) {
          throw new Error("Nous OAuth catalog request failed");
        }
        const contentLength = response.headers.get("content-length");
        if (
          contentLength &&
          /^\d+$/.test(contentLength.trim()) &&
          Number(contentLength) > NOUS_OAUTH_CATALOG_MAX_BYTES
        ) {
          throw new Error("Nous OAuth catalog body too large");
        }
        if (!response.body) throw new Error("Nous OAuth catalog response has no body");
        const reader = response.body.getReader();
        const cancelReader = () => {
          void reader.cancel().catch(() => {});
        };
        abort.signal.addEventListener("abort", cancelReader, { once: true });
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "";
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > NOUS_OAUTH_CATALOG_MAX_BYTES) {
              abort.abort();
              throw new Error("Nous OAuth catalog body too large");
            }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          abort.signal.removeEventListener("abort", cancelReader);
          reader.releaseLock();
        }
        const payload = asRecord(JSON.parse(text));
        const rows = payload?.data ?? payload?.models;
        if (!Array.isArray(rows)) throw new Error("Invalid Nous OAuth catalog response");
        if (rows.length > NOUS_OAUTH_CATALOG_MAX_ROWS)
          throw new Error("Nous OAuth catalog has too many rows");
        return rows
          .map(toPublicModel)
          .filter((model): model is NousOAuthPublicModel => model !== null);
      })(),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * GET a public catalog from the exact trusted inference base. No OAuth token,
 * DB record, custom endpoint, bearer header, or stale/free static fallback is used.
 * Failed refreshes invalidate old cached flags; failed requests return no rows.
 */
export async function discoverNousOAuthModels(
  inferenceBaseUrl: unknown,
  options: DiscoveryOptions = {}
): Promise<NousOAuthDiscoveryResult> {
  let baseUrl: string;
  try {
    baseUrl = validateNousOAuthInferenceBaseUrl(inferenceBaseUrl);
  } catch {
    return { models: [], source: "error", warning: "Invalid Nous OAuth inference base URL" };
  }

  // Monotonic time avoids extending the TTL when the wall clock is set back.
  const now = options.now ?? (() => performance.now());
  const cached = cache.get(baseUrl);
  const timestamp = now();
  if (cached && !options.refresh && timestamp >= cached.cachedAt && timestamp < cached.expiresAt) {
    return { models: copyModels(cached.models), source: "cache" };
  }
  // An expired cache must never serve stale free flags, including on failure.
  cache.delete(baseUrl);

  let pending = inFlight.get(baseUrl);
  if (!pending) {
    pending = (async (): Promise<NousOAuthDiscoveryResult> => {
      try {
        const requestedTimeout = options.timeoutMs;
        const timeoutMs =
          typeof requestedTimeout === "number" &&
          Number.isFinite(requestedTimeout) &&
          requestedTimeout >= 1
            ? Math.min(requestedTimeout, NOUS_OAUTH_CATALOG_TIMEOUT_MS)
            : NOUS_OAUTH_CATALOG_TIMEOUT_MS;
        const models = await fetchPublicModels(baseUrl, options.fetchImpl ?? fetch, timeoutMs);
        const cachedAt = now();
        cache.set(baseUrl, {
          models,
          cachedAt,
          expiresAt: cachedAt + NOUS_OAUTH_CATALOG_TTL_MS,
        });
        return { models, source: "api" };
      } catch {
        // Never return an old free badge because discovery failed or timed out.
        cache.delete(baseUrl);
        return { models: [], source: "error", warning: UNAVAILABLE };
      }
    })();
    inFlight.set(baseUrl, pending);
  }
  try {
    const result = await pending;
    return result.source === "error" ? result : { ...result, models: copyModels(result.models) };
  } finally {
    if (inFlight.get(baseUrl) === pending) inFlight.delete(baseUrl);
  }
}

/** Test isolation only; not called by the API route. */
export function clearNousOAuthDiscoveryCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
