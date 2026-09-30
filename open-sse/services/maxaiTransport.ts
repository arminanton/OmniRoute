/** MaxAI's only production HTTP transport. No ambient/native/proxy fallback. */
import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { TlsClient, type CreateSessionFn, type TlsFetchOptions } from "../utils/tlsClient.ts";
import { proxyConfigToUrl } from "../utils/proxyDispatcher.ts";
import { runWithProxyContext } from "../utils/proxyFetch.ts";
import { readMaxaiBootTimeMs } from "@/lib/maxaiEgressAttestation";

export const MAXAI_TLS_PROFILE = { browser: "firefox_150", os: "windows" } as const;
const MAX_ATTESTATION_MS = 15_000;
const FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0";

export interface MaxaiEgressRoute {
  connectionId: string;
  /** SHA-256 of the exact selected proxy URL, including credentials. Never the URL itself. */
  proxyFingerprint: string | null;
}

/** Evidence is produced by a trusted host verifier, not by request/DB/env fields. */
export interface MaxaiEgressAttestation extends MaxaiEgressRoute {
  kind: "proxy" | "namespace";
  bootId: string;
  namespaceId: string;
  generation: string;
  /** Authoritative Linux CLOCK_BOOTTIME deadline, including system suspend. */
  expiresBootMs: number;
  /** Informational wall-clock projection only; never permission to send. */
  expiresAt: number;
}
export type MaxaiEgressVerifier = (
  route: Readonly<MaxaiEgressRoute>
) => Promise<MaxaiEgressAttestation | null>;

export class MaxaiTransportError extends Error {
  readonly code = "MAXAI_TRANSPORT_UNAVAILABLE";
  constructor() {
    super("MaxAI verified residential Firefox transport unavailable");
  }
}

type Dependencies = {
  /** Trusted synchronous clock; a request cannot supply or override it. */
  bootNow: () => number;
  resolve: (connectionId: string) => Promise<{ proxyConfig: unknown; blocked: boolean }>;
  verify: MaxaiEgressVerifier;
  profileSupported: () => boolean;
  tlsFetch: (
    url: string,
    options: TlsFetchOptions,
    beforeDispatch: () => void
  ) => Promise<Response>;
  /** Offline clock/scheduler seam. Return an idempotent cancellation function. */
  setTimer?: (callback: () => void, delayMs: number, referenced?: boolean) => () => void;
};
type Scope = {
  route: MaxaiEgressRoute;
  proof: MaxaiEgressAttestation;
  proxy: string | null;
  used: boolean;
  expiresBootMs: number;
  lastBootMs: number;
  invalidated: boolean;
  closed: boolean;
  owners: number;
  cancelRenewal: (() => void) | null;
  cancelVerification: (() => void) | null;
  pendingRenewal: Promise<void> | null;
};

function selectedProxy(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      const parsed = new URL(value);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.search ||
        parsed.hash ||
        (parsed.pathname && parsed.pathname !== "/")
      )
        throw new MaxaiTransportError();
    } catch {
      throw new MaxaiTransportError();
    }
  }
  if (typeof value === "object") {
    const type = String((value as { type?: unknown }).type || "http").toLowerCase();
    if (type !== "http" && type !== "https") throw new MaxaiTransportError();
  }
  try {
    const url = proxyConfigToUrl(value, { allowSocks5: false });
    if (!url) throw new MaxaiTransportError();
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname && parsed.pathname !== "/")
    )
      throw new MaxaiTransportError();
    return url;
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    throw new MaxaiTransportError();
  }
}
function proofMatches(
  proof: MaxaiEgressAttestation | null,
  route: MaxaiEgressRoute,
  now: number
): proof is MaxaiEgressAttestation {
  return (
    !!proof &&
    proof.connectionId === route.connectionId &&
    proof.proxyFingerprint === route.proxyFingerprint &&
    proof.kind === (route.proxyFingerprint ? "proxy" : "namespace") &&
    [proof.bootId, proof.namespaceId, proof.generation].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 256
    ) &&
    Number.isSafeInteger(proof.expiresBootMs) &&
    proof.expiresBootMs > now &&
    proof.expiresBootMs - now <= MAX_ATTESTATION_MS
  );
}
const API_PATHS = new Set([
  "/oauth/signin_with_email",
  "/oauth/verify_secret_code",
  "/oauth/refresh_access_token",
  "/gpt/cwc/chat",
  "/gpt/get_image_generate_response",
  "/models/get_config",
  "/app/upload_document",
  "/gpt/speech_to_text",
]);
const OPTION_KEYS = new Set(["method", "headers", "body", "signal", "redirect"]);
function checkedRequest(
  input: RequestInfo | URL,
  init: RequestInit
): { url: string; options: TlsFetchOptions } {
  if (typeof input !== "string" && !(input instanceof URL)) throw new MaxaiTransportError();
  if (
    Object.keys(init).some((key) => !OPTION_KEYS.has(key)) ||
    (init.redirect && init.redirect !== "error")
  )
    throw new MaxaiTransportError();
  const url = new URL(input);
  const method = (init.method || "GET").toUpperCase();
  if (url.username || url.password || url.search || url.hash) throw new MaxaiTransportError();
  const publicBundle =
    url.origin === "https://www.maxai.co" &&
    method === "GET" &&
    (url.pathname === "/app/" ||
      /^\/_next\/static\/chunks\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname));
  const signed =
    url.origin === "https://api.maxai.me" && method === "POST" && API_PATHS.has(url.pathname);
  if (!publicBundle && !signed) throw new MaxaiTransportError();
  const headers = new Headers(init.headers);
  if (
    (headers.has("user-agent") && headers.get("user-agent") !== FIREFOX_UA) ||
    [...headers.keys()].some((name) => name.startsWith("sec-ch-ua"))
  )
    throw new MaxaiTransportError();
  headers.set("user-agent", FIREFOX_UA);
  if (
    publicBundle &&
    ["authorization", "cookie", "x-authorization"].some((name) => headers.has(name))
  )
    throw new MaxaiTransportError();
  const body = init.body;
  if (
    body != null &&
    typeof body !== "string" &&
    !(body instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(body) &&
    !(body instanceof URLSearchParams) &&
    !(body instanceof Blob) &&
    !(body instanceof FormData)
  )
    throw new MaxaiTransportError();
  if (publicBundle && body != null) throw new MaxaiTransportError();
  return {
    url: url.href,
    options: {
      method,
      headers,
      body: body as TlsFetchOptions["body"],
      signal: init.signal,
      redirect: "error",
    },
  };
}

/** Dependency injection is for offline tests/trusted startup, never a request option. */
export function createMaxaiTransport(deps: Dependencies) {
  const context = new AsyncLocalStorage<Scope>();
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, delayMs: number, referenced = false) => {
      const timer = setTimeout(callback, delayMs);
      if (!referenced) timer.unref();
      return () => clearTimeout(timer);
    });
  const stopRenewal = (scope: Scope) => {
    scope.cancelRenewal?.();
    scope.cancelRenewal = null;
    const cancel = scope.cancelVerification;
    scope.cancelVerification = null;
    cancel?.();
  };
  const invalidate = (scope: Scope): never => {
    scope.invalidated = true;
    stopRenewal(scope);
    throw new MaxaiTransportError();
  };
  const bootNow = (): number => {
    const now = deps.bootNow();
    if (!Number.isSafeInteger(now) || now < 0) throw new MaxaiTransportError();
    return now;
  };
  const assertLive = (scope: Scope): number => {
    if (scope.invalidated || scope.closed || scope.owners <= 0) throw new MaxaiTransportError();
    let now: number;
    try {
      now = bootNow();
    } catch {
      return invalidate(scope);
    }
    if (now < scope.lastBootMs || now >= scope.expiresBootMs) return invalidate(scope);
    scope.lastBootMs = now;
    return now;
  };
  const closeOwner = (scope: Scope): void => {
    scope.owners -= 1;
    if (scope.owners === 0) {
      scope.closed = true;
      stopRenewal(scope);
    }
  };
  const retain = (scope: Scope, signal?: AbortSignal | null): (() => void) => {
    signal?.throwIfAborted();
    assertLive(scope);
    scope.owners += 1;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      signal?.removeEventListener("abort", release);
      closeOwner(scope);
    };
    signal?.addEventListener("abort", release, { once: true });
    return release;
  };
  const verifyBounded = async (
    route: MaxaiEgressRoute,
    scope?: Scope
  ): Promise<MaxaiEgressAttestation | null> => {
    let reject!: (error: MaxaiTransportError) => void;
    const stopped = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const stop = () => reject(new MaxaiTransportError());
    const cancelTimeout = setTimer(stop, 1_000, true);
    if (scope) scope.cancelVerification = stop;
    try {
      return await Promise.race([
        Promise.resolve().then(() => deps.verify(Object.freeze({ ...route }))),
        stopped,
      ]);
    } finally {
      cancelTimeout();
      if (scope?.cancelVerification === stop) scope.cancelVerification = null;
    }
  };
  const scheduleRenewal = (scope: Scope): void => {
    if (scope.closed || scope.invalidated || scope.owners <= 0 || scope.pendingRenewal) return;
    let now: number;
    try {
      now = assertLive(scope);
    } catch {
      return;
    }
    scope.cancelRenewal?.();
    // Renew locally with margin; never send a provider request from this timer.
    const delay = Math.max(1, Math.min(5_000, Math.floor((scope.expiresBootMs - now) / 3)));
    scope.cancelRenewal = setTimer(() => {
      scope.cancelRenewal = null;
      void renew(scope).catch(() => {});
    }, delay);
  };
  const renew = (scope: Scope): Promise<void> => {
    try {
      assertLive(scope);
    } catch (error) {
      return Promise.reject(error);
    }
    if (scope.pendingRenewal) return scope.pendingRenewal;
    scope.cancelRenewal?.();
    scope.cancelRenewal = null;
    let pending!: Promise<void>;
    pending = (async () => {
      try {
        const proof = await verifyBounded(scope.route, scope);
        // Check the OLD accepted deadline after EVERY verifier wait, before
        // accepting renewal. A late same-generation proof cannot bridge a lapse.
        const now = assertLive(scope);
        if (
          !proofMatches(proof, scope.route, now) ||
          proof.bootId !== scope.proof.bootId ||
          proof.namespaceId !== scope.proof.namespaceId ||
          proof.generation !== scope.proof.generation ||
          !deps.profileSupported()
        )
          return invalidate(scope);
        assertLive(scope);
        scope.expiresBootMs = Math.max(scope.expiresBootMs, proof.expiresBootMs);
      } catch {
        return invalidate(scope);
      } finally {
        if (scope.pendingRenewal === pending) scope.pendingRenewal = null;
        scheduleRenewal(scope);
      }
    })();
    scope.pendingRenewal = pending;
    return pending;
  };
  const withOwner = async <T>(operation: () => Promise<T>): Promise<T> => {
    const scope = context.getStore();
    // This helper only retains an existing scope; it never grants HTTP access.
    // Standalone injected-fetch helpers may run with no transport context.
    if (!scope) return operation();
    const release = retain(scope);
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const discardResponse = (response: Response | undefined): void => {
    try {
      void response?.body?.cancel().catch(() => {});
    } catch {
      /* Locked/failed body. */
    }
  };
  const waitForNative = async (
    request: { url: string; options: TlsFetchOptions },
    scope: Scope,
    signal: AbortSignal | null | undefined,
    beforeDispatch: () => void
  ): Promise<Response> => {
    signal?.throwIfAborted();
    let rejectAbort!: (reason: unknown) => void;
    let abandoned = false;
    let response: Response | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      abandoned = true;
      discardResponse(response);
      rejectAbort(signal?.reason ?? new MaxaiTransportError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const native = Promise.resolve()
        .then(() => {
          // The microtask and any native session creation wait are separate
          // boundaries. Both must check this call's current permission.
          beforeDispatch();
          return deps.tlsFetch(
            request.url,
            {
              ...request.options,
              proxy: scope.proxy,
              sessionScope: `maxai:${scope.route.connectionId}:${scope.proof.bootId}:${scope.proof.namespaceId}:${scope.proof.generation}`,
            },
            beforeDispatch
          );
        })
        .then((received) => {
          response = received;
          if (abandoned) discardResponse(received);
          return received;
        });
      return await Promise.race([native, aborted]);
    } catch (error) {
      abandoned = true;
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
  const fetchImpl: typeof fetch = async (input, init: RequestInit = {}) => {
    init.signal?.throwIfAborted();
    const scope = context.getStore();
    if (!scope) throw new MaxaiTransportError();
    assertLive(scope);
    const request = checkedRequest(input, init);
    // A pending native header/upload wait is an owned operation, independent
    // of a canceled waiter on a shared refresh. Its own signal may release it.
    const release = retain(scope, init.signal);
    try {
      await renew(scope);
      const beforeDispatch = () => {
        init.signal?.throwIfAborted();
        assertLive(scope);
        if (!deps.profileSupported()) return invalidate(scope);
        // The kernel gate, not this userspace sample, is the final packet
        // boundary if the process suspends immediately after the clock read.
        assertLive(scope);
      };
      beforeDispatch();
      let response: Response;
      try {
        response = await waitForNative(request, scope, init.signal, beforeDispatch);
      } catch (error) {
        if (isRuntimePolicyError(error)) throw error;
        try {
          assertLive(scope);
        } catch {
          /* Latch lapse, but never retry. */
        }
        init.signal?.throwIfAborted();
        throw new MaxaiTransportError();
      }
      scope.used = true;
      // An already-authorized request may finish after a lapse. Keep its
      // response; the irreversible latch only denies SUBSEQUENT sends.
      try {
        assertLive(scope);
      } catch {
        /* Do not discard an accepted response. */
      }
      try {
        init.signal?.throwIfAborted();
        if (
          response.redirected ||
          (response.status >= 300 && response.status < 400) ||
          (response.url && response.url !== request.url)
        )
          return invalidate(scope);
      } catch (error) {
        discardResponse(response);
        throw error;
      }
      return response;
    } finally {
      release();
    }
  };
  const run = async <T>(connectionId: string, fn: () => Promise<T>): Promise<T> => {
    if (typeof connectionId !== "string" || !connectionId.trim() || connectionId.length > 256)
      throw new MaxaiTransportError();
    const active = context.getStore();
    if (active) {
      if (active.route.connectionId !== connectionId) throw new MaxaiTransportError();
      return withOwner(fn);
    }
    if (!deps.profileSupported()) throw new MaxaiTransportError();
    let resolved: Awaited<ReturnType<Dependencies["resolve"]>>;
    try {
      resolved = await deps.resolve(connectionId);
    } catch (error) {
      if (isRuntimePolicyError(error)) throw error;
      throw new MaxaiTransportError();
    }
    if (resolved.blocked) throw new MaxaiTransportError();
    const proxy = selectedProxy(resolved.proxyConfig);
    const route = Object.freeze({
      connectionId,
      proxyFingerprint: proxy ? createHash("sha256").update(proxy).digest("hex") : null,
    });
    let proof: MaxaiEgressAttestation | null;
    try {
      proof = await verifyBounded(route);
    } catch {
      throw new MaxaiTransportError();
    }
    const now = bootNow();
    if (!proofMatches(proof, route, now)) throw new MaxaiTransportError();
    const scope: Scope = {
      route,
      proof: Object.freeze({ ...proof }),
      proxy,
      used: false,
      expiresBootMs: proof.expiresBootMs,
      lastBootMs: now,
      invalidated: false,
      closed: false,
      owners: 1,
      cancelRenewal: null,
      cancelVerification: null,
      pendingRenewal: null,
    };
    scheduleRenewal(scope);
    try {
      return await context.run(scope, () =>
        proxy
          ? runWithProxyContext(proxy, fn, { requireProxy: true, skipUnreachableProbe: true })
          : fn()
      );
    } finally {
      closeOwner(scope);
    }
  };
  return { run, withOwner, fetch: fetchImpl, used: () => context.getStore()?.used === true };
}

const runtimeRequire = createRequire(import.meta.url);
type ProfileRuntime = {
  createSession: CreateSessionFn;
  getProfiles: () => string[];
  getOperatingSystems: () => string[];
  getEmulationHeaders: (browser: string, os: string) => { get: (name: string) => string | null };
};
function runtime(): ProfileRuntime {
  const loaded = Reflect.apply(runtimeRequire, undefined, ["wreq-js"]) as ProfileRuntime;
  if (
    typeof loaded.createSession !== "function" ||
    !loaded.getProfiles?.().includes(MAXAI_TLS_PROFILE.browser) ||
    !loaded.getOperatingSystems?.().includes(MAXAI_TLS_PROFILE.os) ||
    loaded
      .getEmulationHeaders?.(MAXAI_TLS_PROFILE.browser, MAXAI_TLS_PROFILE.os)
      .get("user-agent") !== FIREFOX_UA
  )
    throw new MaxaiTransportError();
  return loaded;
}
export function maxaiFirefoxProfileSupported(): boolean {
  try {
    runtime();
    return true;
  } catch {
    return false;
  }
}
const nativeDispatchGuard = new AsyncLocalStorage<() => void>();

/** Dedicated client keeps profile/cookies/circuits separate from generic TLS. */
export function createMaxaiTlsClient(
  createSession: CreateSessionFn = (options) => runtime().createSession(options),
  beforeDispatch: () => void = () => {
    const guard = nativeDispatchGuard.getStore();
    if (!guard) throw new MaxaiTransportError();
    guard();
  }
): TlsClient {
  return new TlsClient(
    async (options) => {
      const session = await createSession({ ...options, ...MAXAI_TLS_PROFILE });
      return {
        fetch: (url, init) => {
          // TlsClient awaited session creation before arriving here. Recheck the
          // caller's OLD deadline after that wait, immediately before native fetch.
          beforeDispatch();
          return session.fetch(url, init);
        },
        close: () => session.close(),
        ...(session.getCookies
          ? { getCookies: (url: string | URL) => session.getCookies!(url) }
          : {}),
      };
    },
    128,
    true
  );
}
/** Bind each call's guard, never the context that first constructed a session. */
export function createMaxaiTlsDispatcher(client: TlsClient): Dependencies["tlsFetch"] {
  return (url, options, beforeDispatch) =>
    nativeDispatchGuard.run(beforeDispatch, () => client.fetch(url, options));
}
const client = createMaxaiTlsClient();
let trustedVerifier: MaxaiEgressVerifier = async (route) => {
  try {
    const { verifyMaxaiResidentialNamespace } = await import("@/lib/maxaiEgressAttestation");
    return await verifyMaxaiResidentialNamespace(route);
  } catch {
    return null;
  }
};
/** Trusted application bootstrap only. No env/DB/request flag is residential evidence. */
export function installMaxaiEgressVerifier(verifier: MaxaiEgressVerifier): void {
  trustedVerifier = verifier;
}
const production = createMaxaiTransport({
  bootNow: readMaxaiBootTimeMs,
  resolve: async (connectionId) => {
    const { resolveGuardedProxyConfig } = await import("@/lib/tokenHealthCheckProxyGuard");
    const resolved = await resolveGuardedProxyConfig(connectionId, "maxai");
    // The native library has no documented no-system-proxy switch. A namespace
    // route must not accidentally inherit an environmental proxy. Refuse it
    // rather than claiming that proxy:null proves the lower runtime ignores env.
    if (
      !resolved.proxyConfig &&
      ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(
        (key) => process.env[key]
      )
    ) {
      return { proxyConfig: null, blocked: true };
    }
    return resolved;
  },
  verify: (route) => trustedVerifier(route),
  profileSupported: maxaiFirefoxProfileSupported,
  tlsFetch: createMaxaiTlsDispatcher(client),
});
export const maxaiFetch = production.fetch;
export const runMaxaiConnectionTransport = production.run;
export const withMaxaiTransportOwner = production.withOwner;
export const wasMaxaiTlsUsed = production.used;
