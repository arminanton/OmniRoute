// Structural subset keeps the staged artifact testable without installing Prime into OmniRoute.
interface DiscoveryModel {
  id: string;
  type?: string;
  owned_by?: string;
  context_length?: number;
  context_window?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  capabilities?: {
    reasoning?: boolean;
    thinking?: boolean;
    vision?: boolean;
    effort_tiers?: string[];
  };
  pricing?: { input?: number; output?: number; cached?: number; cache_creation?: number };
  api_format?: string;
  supported_endpoints?: string[];
  input_modalities?: string[];
  billing_metadata?: unknown;
  lifecycle_notice?: unknown;
}
type ExtensionContext = {
  model?: { id: string };
  ui: { notify(message: string, level: "warning" | "error" | "info"): void };
};
type ExtensionAPI = {
  registerProvider(id: string, configuration: Record<string, unknown>): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, context: ExtensionContext): Promise<void>;
    }
  ): void;
  on(
    name: "session_start",
    handler: (event: unknown, context: ExtensionContext) => Promise<void>
  ): void;
};
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// One artifact for both hosts. Existing endpoints remain defaults until ingress promotion.
const defaultBaseUrl = process.env.OMNI_PRIME_BASE_URL || "http://127.0.0.1:20129/v1";

function readKey(): string {
  try {
    const key = execFileSync(
      "/bin/bash",
      [
        "-c",
        'source "$1" >/dev/null 2>&1 && printf "%s" "$MARIA_OMNI"',
        "omni-key",
        join(homedir(), ".intra-env"),
      ],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    if (key) return key;
  } catch {
    /* Report only the safe error below. */
  }
  throw new Error("Cannot read MARIA_OMNI from ~/.intra-env");
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function price(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function createOmniExtension(
  options: {
    baseUrl?: string;
    readKey?: () => string;
    fetch?: typeof globalThis.fetch;
  } = {}
) {
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  const getKey = options.readKey ?? readKey;
  const request = options.fetch ?? globalThis.fetch;
  return async function (pi: ExtensionAPI) {
    async function discoverOnce() {
      let response: Response;
      const query = `${baseUrl}/models?prefix=alias&configuredOnly=true`;
      const key = getKey();
      const signal = AbortSignal.timeout(60000);
      try {
        response = await request(query, {
          headers: { Authorization: `Bearer ${key}` },
          signal,
        });
      } catch (error) {
        throw new Error(
          `OmniRoute /models request failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      // One bounded retry only for the explicit cold-catalog readiness response.
      if (response.status === 503 && response.headers.get("Retry-After")) {
        const seconds = Number(response.headers.get("Retry-After"));
        await response.body?.cancel();
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(5000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : 2000))
          )
        );
        response = await request(query, {
          headers: { Authorization: `Bearer ${key}` },
          signal,
        });
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300).replace(/\s+/g, " ").trim();
        throw new Error(
          `OmniRoute /models returned ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`
        );
      }

      let payload: { data?: DiscoveryModel[] };
      try {
        payload = (await response.json()) as { data?: DiscoveryModel[] };
      } catch (error) {
        const timedOut =
          error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
        throw new Error(
          `OmniRoute /models ${timedOut ? "timed out while reading the response body" : "returned invalid JSON"}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!Array.isArray(payload.data))
        throw new Error("OmniRoute /models response has no data array");

      const source = payload.data.filter((m) => m?.type !== "image" && m?.type !== "video");
      const ids = source
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      if (duplicates.length)
        throw new Error(
          `OmniRoute returned duplicate model IDs: ${[...new Set(duplicates)].join(", ")}`
        );
      if (ids.length !== source.length)
        throw new Error(
          `OmniRoute returned ${source.length - ids.length} model(s) without a valid ID`
        );

      const missingContext: string[] = [];
      const missingOutput: string[] = [];
      const missingPricing: string[] = [];
      const models = source.map((m) => {
        const context = m.context_length ?? m.context_window ?? m.max_input_tokens;
        const output = m.max_output_tokens;
        if (!(typeof context === "number" && context > 0)) missingContext.push(m.id);
        if (!(typeof output === "number" && output > 0)) missingOutput.push(m.id);
        const capabilities = m.capabilities ?? {};
        const tiers = Array.isArray(capabilities.effort_tiers) ? capabilities.effort_tiers : [];
        const thinkingLevelMap = Object.fromEntries(
          ["minimal", "low", "medium", "high", "xhigh", "max"]
            .filter((level) => tiers.includes(level))
            .map((level) => [level, level])
        );
        const pricing = m.pricing ?? {};
        const knownPrice = [pricing.input, pricing.output].every(
          (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
        );
        if (!knownPrice) missingPricing.push(m.id);
        return {
          id: m.id,
          // Prime requires numeric costs; make placeholder zero visibly distinct from free.
          name: knownPrice
            ? m.id
            : `${m.id} [${m.owned_by === "combo" ? "dynamic cost" : "cost unknown"}]`,
          api:
            m.api_format === "responses" || m.supported_endpoints?.includes("responses")
              ? ("openai-responses" as const)
              : ("openai-completions" as const),
          reasoning: capabilities.reasoning === true || capabilities.thinking === true,
          ...(Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}),
          input:
            m.input_modalities?.includes("image") || capabilities.vision === true
              ? (["text", "image"] as ("text" | "image")[])
              : (["text"] as ("text" | "image")[]),
          contextWindow: positive(context, 128000),
          maxTokens: positive(output, 32000),
          cost: {
            input: price(pricing.input),
            output: price(pricing.output),
            cacheRead: price(pricing.cached),
            cacheWrite: price(pricing.cache_creation),
          },
          compat: {
            supportsReasoningEffort: tiers.length > 0,
            supportsUsageInStreaming: true,
          },
        };
      });

      if (!models.length) throw new Error("OmniRoute returned no text models");
      pi.registerProvider("omni", {
        name: "OmniRoute",
        baseUrl,
        apiKey: key,
        api: "openai-completions",
        models,
      });
      return {
        count: models.length,
        missingContext,
        missingOutput,
        missingPricing,
        billing: new Map(
          source.map((m) => [
            m.id,
            {
              pricing: m.pricing,
              billing_metadata: m.billing_metadata,
              lifecycle_notice: m.lifecycle_notice,
              dynamic: m.owned_by === "combo",
            },
          ])
        ),
      };
    }

    let inFlight: ReturnType<typeof discoverOnce> | undefined;
    function discover() {
      if (inFlight) return inFlight;
      const pending = discoverOnce();
      inFlight = pending;
      const cleanup = () => {
        if (inFlight === pending) inFlight = undefined;
      };
      void pending.then(cleanup, cleanup);
      return pending;
    }

    function warnMissing(
      result: Awaited<ReturnType<typeof discover>>,
      notify?: (message: string, level: "warning") => void
    ) {
      const parts = [
        result.missingContext.length ? `${result.missingContext.length} missing context limit` : "",
        result.missingOutput.length ? `${result.missingOutput.length} missing output limit` : "",
        result.missingPricing.length
          ? `${result.missingPricing.length} missing prices (cost estimates incomplete)`
          : "",
      ].filter(Boolean);
      if (!parts.length) return;
      const message = `Omni metadata warning: ${parts.join(", ")}; unknown prices use SDK placeholders, not free usage. Fallback token limits may apply. Run /omni-missing-models for IDs.`;
      notify ? notify(message, "warning") : console.warn(`[omni] ${message}`);
    }

    let lastResult: Awaited<ReturnType<typeof discover>> | undefined;
    let startupError: string | undefined;
    pi.on("session_start", async (_event, ctx) => {
      if (startupError)
        ctx.ui.notify(
          `Omni model discovery failed: ${startupError}. Run /omni-refresh to retry.`,
          "error"
        );
    });
    pi.registerCommand("omni-refresh", {
      description: "Refresh models from OmniRoute",
      handler: async (_args, ctx) => {
        try {
          lastResult = await discover();
          startupError = undefined;
          ctx.ui.notify(`Omni: loaded ${lastResult.count} models`, "info");
          warnMissing(lastResult, (message, level) => ctx.ui.notify(message, level));
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
        }
      },
    });
    pi.registerCommand("omni-billing", {
      description: "Show known billing basis for an Omni model (never an inferred invoice)",
      handler: async (args, ctx) => {
        try {
          if (!lastResult) lastResult = await discover();
          const id = args.trim() || ctx.model?.id;
          const metadata = id ? lastResult.billing.get(id) : undefined;
          if (!metadata) {
            ctx.ui.notify(
              "Specify an available Omni model ID, for example /omni-billing cx/gpt-6.1-sol-medium",
              "warning"
            );
            return;
          }
          ctx.ui.notify(
            JSON.stringify(
              {
                model: id,
                ...metadata,
                notes: metadata.dynamic
                  ? "Dynamic route: final selected provider/model and actual reported usage determine cost."
                  : "Catalog prices are token-value estimates; absent rates mean unknown, not free. Credits, included allowances and USD invoices are separate.",
              },
              null,
              2
            ),
            "info"
          );
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
        }
      },
    });
    pi.registerCommand("omni-missing-models", {
      description: "Show Omni models using fallback token limits",
      handler: async (_args, ctx) => {
        if (!lastResult) lastResult = await discover();
        ctx.ui.notify(
          `Missing context (${lastResult.missingContext.length}): ${lastResult.missingContext.join(", ") || "none"}\nMissing output (${lastResult.missingOutput.length}): ${lastResult.missingOutput.join(", ") || "none"}\nMissing pricing (${lastResult.missingPricing.length}): ${lastResult.missingPricing.join(", ") || "none"}`,
          "warning"
        );
      },
    });

    try {
      lastResult = await discover();
      warnMissing(lastResult);
    } catch (error) {
      startupError = (error as Error).message;
      console.warn(`[omni] ${startupError}`);
    }
  };
}

export default createOmniExtension();
