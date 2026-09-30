import { randomUUID } from "node:crypto";
import {
  acquireBrowserPageLease,
  releaseBrowserContext,
} from "@omniroute/open-sse/services/browserPool.ts";
import { isRuntimePolicyError } from "@/shared/runtimePolicy";

const ORIGIN = "https://playground.ai.cloudflare.com/";
const DEADLINE_MS = 45_000;
const MAX_FRAME_BYTES = 2_000_000;
type CatalogTransport = () => Promise<unknown>;
let transportOverride: CatalogTransport | null = null;
export function __setCloudflareCatalogTransportForTests(transport: CatalogTransport | null): void {
  transportOverride = transport;
}

/** Captured 2026-09-30: getModels returns a completed `rpc` result, not chat frames. */
export function parseCloudflarePlaygroundCatalog(
  value: unknown
): Array<{ id: string; name: string }> | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  if (
    envelope.type !== "rpc" ||
    envelope.done !== true ||
    envelope.success !== true ||
    !Array.isArray(envelope.result)
  )
    return null;
  const models = new Map<string, { id: string; name: string }>();
  for (const row of envelope.result) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const task = item.task as { name?: unknown } | undefined;
    if (
      task?.name !== "Text Generation" ||
      typeof item.name !== "string" ||
      !item.name.startsWith("@cf/")
    )
      continue;
    const id = item.name.slice(4);
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(id) || /(?:-lora$|llama-guard)/i.test(id))
      continue;
    // require_workers_paid describes the Workers API plan, not Playground access.
    // The public Playground UI explicitly offers models carrying that flag.
    // Catalog membership is not an inference-health or free-availability claim.
    // Do not publish upstream tools/vision capabilities: this executor is text-only.
    models.set(id, { id, name: id });
  }
  return [...models.values()];
}

/** Runs in the inert browser document. Never loads the application or sends chat/config. */
export function requestCloudflareCatalog(args: {
  timeoutMs: number;
  maxBytes: number;
}): Promise<unknown> {
  return new Promise((resolve) => {
    const id = "catalog-models";
    const room = "playground-" + crypto.randomUUID().replace(/-/g, "").slice(0, 25);
    const ws = new WebSocket(
      "wss://playground.ai.cloudflare.com/agents/playground/" + room + "?_pk=" + crypto.randomUUID()
    );
    let settled = false;
    let bytes = 0;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), args.timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: "rpc", id, method: "getModels", args: [] }));
    ws.onmessage = (event) => {
      const raw = String(event.data);
      bytes += new TextEncoder().encode(raw).byteLength;
      if (bytes > args.maxBytes) {
        finish(null);
        return;
      }
      try {
        const frame = JSON.parse(raw);
        if (frame.id === id && (frame.done || frame.error || frame.success === false))
          finish(frame);
      } catch {
        /* Ignore unrelated malformed frames within the byte/deadline budget. */
      }
    };
    ws.onerror = ws.onclose = () => finish(null);
  });
}

export async function fetchCloudflareCatalogEnvelope(
  timeoutMs = DEADLINE_MS,
  deps = { acquire: acquireBrowserPageLease, release: releaseBrowserContext }
): Promise<unknown> {
  const key = `cloudflare-catalog-${randomUUID()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const aborted = new Promise<never>((_, reject) =>
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("Cloudflare catalog deadline exceeded")),
      { once: true }
    )
  );
  const acquisition = deps.acquire(
    key,
    {
      cookieDomain: "playground.ai.cloudflare.com",
      headless: true,
      preferCloakbrowser: false,
    },
    controller.signal
  );
  // A slow launch may complete after our deadline. Always release its context then.
  let lease: Awaited<typeof acquisition> | null = null;
  void acquisition.then(
    async (lateLease) => {
      if (controller.signal.aborted) {
        await Promise.allSettled([lateLease.release(), deps.release(key)]);
      }
    },
    async () => {
      await deps.release(key).catch(() => {});
    }
  );
  try {
    lease = await Promise.race([acquisition, aborted]);
    const page = lease.page;
    const work = async () => {
      await page.route("**/*", (route) =>
        route.request().url() === ORIGIN
          ? route.fulfill({
              status: 200,
              contentType: "text/html",
              body: "<!doctype html><title>Catalog only</title>",
            })
          : route.abort()
      );
      await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      // esbuild keepNames may inject this helper into serialized callbacks.
      await page.evaluate(() => {
        (window as unknown as { __name: unknown }).__name = (fn: unknown) => fn;
      });
      return page.evaluate(requestCloudflareCatalog, {
        timeoutMs: Math.min(timeoutMs, 30_000),
        maxBytes: MAX_FRAME_BYTES,
      });
    };
    return await Promise.race([work(), aborted]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Closing a disconnected CDP peer must not hold the request open forever.
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([lease?.release(), deps.release(key)]),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, 2_000);
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
}

export async function discoverCloudflarePlaygroundModels(
  transport: CatalogTransport = transportOverride ?? fetchCloudflareCatalogEnvelope
): Promise<Array<{ id: string; name: string }> | null> {
  try {
    return parseCloudflarePlaygroundCatalog(await transport());
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    return null;
  }
}
