/**
 * UcExecutor — UC (uncensored.com) subscription-backed persona chat as an
 * OpenAI-compatible OmniRoute provider.
 *
 * UC is a consumer subscription app with no public API on the persona path. This
 * executor reproduces the web app's own persona WebSocket turn:
 *   • mint a 60s Clerk `__session` JWT from the durable `__client` cookie
 *     (see ./uc/clerkAuth.ts), cached per session id and re-minted ~8s early,
 *   • open `wss://internal-6.pubyar.com/ws/{uid}?token={jwt}` with only an
 *     `Origin` header (see ./uc/ws.ts),
 *   • send ONE persona frame: current turn as `text` + prior turns as
 *     `chat_history` (roles human/assistant), NO max_tokens/direct_params
 *     (see ./uc/protocol.ts),
 *   • stream newline-delimited frames, splitting reasoning
 *     (intermediary_message) from the answer (text deltas / raw_text) and
 *     branching the explicit error/quota frames (see ./uc/stream.ts).
 *
 * Tools: UC persona has no native function-calling, so tool schemas are injected
 * as a prompted `<tool>` contract (the same shared shim the web-cookie providers
 * use, translator/webTools.ts) and parsed back into tool_calls.
 *
 * Transport: this executor uses the `ws` client and the ambient patched `fetch`.
 * Operator-configured per-connection proxying applies automatically. UC has no
 * provider-specific TLS impersonation requirement.
 *
 * Auth refresh: the 60s JWT is minted on demand; when the mint 401/403s the
 * durable ~30-day Clerk window has lapsed and the caller is prompted to re-run the
 * browserless email login (see ./uc/emailLogin.ts).
 */
import { BaseExecutor, type ExecuteInput, type ExecutorExecuteResult } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { prepareToolMessages, parseToolCallsFromText } from "../translator/webTools.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import { UC_BASE_URL } from "./uc/constants.ts";
import { resolveUcCredential, type UcCredential } from "./uc/credentials.ts";
import { mintUcSessionToken, ucTokenCache, type UcSessionToken } from "./uc/clerkAuth.ts";
import { assembleUcTurn } from "./uc/protocol.ts";
import { detectUcSoftError, estimateUcTokens } from "./uc/stream.ts";
import { runUcTurn, type UcTurnResult } from "./uc/ws.ts";
import {
  ucUsesCodestyle,
  ucLooksLikeRefusal,
  parseUcExtraDialects,
  buildUcCodestylePreamble,
} from "./uc/toolDialect.ts";
import {
  extractCurrentTurnMedia,
  resolveUcRemoteImages,
  uploadUcBlob,
  type UcMediaBlob,
} from "./uc/media.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const SSE_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream; charset=utf-8",
};

interface OpenAiChatBody {
  messages?: Array<{
    role?: string;
    content?: unknown;
    tool_calls?: unknown;
    tool_call_id?: string;
  }>;
  model?: string;
  tools?: unknown;
}

function errorResponse(
  status: number,
  message: string,
  code: string,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: sanitizeErrorMessage(message),
        type: status >= 500 ? "provider_error" : "invalid_request_error",
      },
    }),
    { status, headers: { ...JSON_HEADERS, ...extraHeaders } }
  );
}

/**
 * Add UC's natural code-style contract to text assembled from the RAW messages.
 * Callers must not pass prepareToolMessages output here: guardrailed models refuse
 * the formal markup even when a natural instruction is also present.
 */
function applyCodestylePreamble(text: string, tools: unknown): string {
  return `${buildUcCodestylePreamble(tools)}\n\n${text}`;
}

/**
 * If the shared `<tool_call>` JSON parser would find nothing but a UC extra dialect
 * (code-style `fn("x")` or Gemini `<tool_code>`) is present, rewrite those calls as
 * canonical `<tool_call>{json}</tool_call>` blocks appended to the answer so the
 * shared buildToolModeResponse parses them uniformly. No-op when the shared parser
 * already sees calls or no extra dialect is present.
 */
function injectExtraDialectCalls(answer: string, requestedTools: unknown, model: string): string {
  const sharedHasCall = !!parseToolCallsFromText(answer, "probe", requestedTools).toolCalls;
  if (sharedHasCall) return answer;
  const extra = parseUcExtraDialects(answer, requestedTools, model);
  if (extra.length === 0) return answer;
  const blocks = extra
    .map(
      (c) =>
        `<tool_call>${JSON.stringify({ name: c.function.name, arguments: c.function.arguments })}</tool_call>`
    )
    .join("\n");
  return `${answer}\n${blocks}`;
}

/**
 * Wrap a Response into the executor wrapper contract
 * `{response, url, headers, transformedBody}` that chatCore + the web-cookie
 * sweep require. `headers`/`transformedBody` are the ACTUAL upstream request
 * capture ("what we sent"); for UC that is the WS handshake headers + the persona
 * frame. Error paths that fail before a frame is assembled pass no capture.
 */
function wrap(
  response: Response,
  url: string,
  capture?: { headers?: Record<string, string>; transformedBody?: unknown }
): { response: Response; url: string; headers: Record<string, string>; transformedBody: unknown } {
  return {
    response,
    url,
    headers: capture?.headers ?? {},
    transformedBody: capture?.transformedBody ?? null,
  };
}

/** Emit one OpenAI chat.completion.chunk. */
function chunk(
  controller: ReadableStreamDefaultController,
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finish: string | null = null
): void {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
}

/** Classify a UC turn error string into an HTTP status + OpenAI error code. */
function classifyTurnError(error: string): { status: number; code: string } {
  const low = error.toLowerCase();
  if (low.includes("message_limit_exceeded"))
    return { status: 429, code: "uc_message_limit_exceeded" };
  if (low.includes("paywall_exceeded")) return { status: 429, code: "uc_paywall_exceeded" };
  if (low.includes("rate_limit_exceeded")) return { status: 429, code: "uc_rate_limit_exceeded" };
  if (low.includes("unauthorized") || low.includes("forbidden")) {
    return { status: 401, code: "uc_auth_error" };
  }
  if (low.includes("timed out")) return { status: 504, code: "uc_timeout" };
  if (low.includes("generation_failed")) return { status: 502, code: "uc_generation_failed" };
  if (low.includes("incomplete_response")) return { status: 502, code: "uc_incomplete_response" };
  return { status: 502, code: "uc_upstream_error" };
}

const UC_QUOTA_ERROR_CODES = new Set([
  "message_limit_exceeded",
  "paywall_exceeded",
  "rate_limit_exceeded",
]);
const ucQuotaCooldowns = new Map<string, number>();
const UC_MAX_RETRY_AFTER_SECONDS = 86_400;

/** Test seam; production cooldowns expire naturally at the captured reset time. */
export function __resetUcQuotaCooldownsForTesting(): void {
  ucQuotaCooldowns.clear();
}

export function parseUcResetAtMs(value: string | undefined, now = Date.now()): number | null {
  const raw = value?.trim();
  if (!raw) return null;

  let parsed: number;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    parsed = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  } else {
    parsed = Date.parse(raw);
  }

  // Date values outside TimeClip's range, unsafe integer timestamps, and stale
  // resets must not create a cooldown or leak nonsensical rate-limit headers.
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed > 8_640_000_000_000_000) {
    return null;
  }
  return parsed > now ? parsed : null;
}

function activeUcCooldown(sid: string, now = Date.now()): number | null {
  const resetAt = ucQuotaCooldowns.get(sid);
  if (!resetAt) return null;
  if (resetAt <= now) {
    ucQuotaCooldowns.delete(sid);
    return null;
  }
  return resetAt;
}

function rememberUcCooldown(sid: string, turn: UcTurnResult): number | null {
  if (!turn.errorCode || !UC_QUOTA_ERROR_CODES.has(turn.errorCode)) return null;
  const resetAt = parseUcResetAtMs(turn.nextReset);
  if (!resetAt || resetAt <= Date.now()) return null;
  ucQuotaCooldowns.set(sid, resetAt);
  return resetAt;
}

export function retryAfterHeaders(resetAt: number, now = Date.now()): Record<string, string> {
  const remainingMs = Number.isFinite(resetAt) ? resetAt - now : Number.POSITIVE_INFINITY;
  const seconds = Math.min(UC_MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(remainingMs / 1000)));
  const headers: Record<string, string> = {
    "Retry-After": String(seconds),
  };
  if (
    Number.isFinite(resetAt) &&
    Number.isSafeInteger(resetAt) &&
    resetAt > now &&
    resetAt <= 8_640_000_000_000_000
  ) {
    headers["X-RateLimit-Reset"] = String(Math.ceil(resetAt / 1000));
  }
  return headers;
}

export class UcExecutor extends BaseExecutor {
  constructor() {
    super("uc-persona", PROVIDERS["uc-persona"] ?? { id: "uc-persona", baseUrl: UC_BASE_URL });
  }

  override async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    // The persona WS URL host is the wrapper `url` for every return path.
    const url = UC_BASE_URL;

    const cred = resolveUcCredential(input.credentials?.providerSpecificData);
    if (!cred) {
      return wrap(
        errorResponse(
          401,
          "UC connection is not configured (missing __client cookie, session id, or uid). Run the email login to bootstrap credentials.",
          "uc_unconfigured"
        ),
        url
      );
    }

    const cooldownReset = activeUcCooldown(cred.sid);
    if (cooldownReset) {
      return wrap(
        errorResponse(
          429,
          `UC Persona plan limit is active until ${new Date(cooldownReset).toISOString()}.`,
          "uc_quota_cooldown",
          retryAfterHeaders(cooldownReset)
        ),
        url
      );
    }

    // Mint (or reuse a cached) 60s Clerk session JWT.
    let jwt: string;
    try {
      jwt = await this.ensureSessionToken(cred, input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /HTTP 40[13]|unauthorized|forbidden/i.test(msg) ? 401 : 502;
      return wrap(
        errorResponse(
          status,
          `UC auth failed: ${sanitizeErrorMessage(msg)}. If this persists the ~30-day Clerk session lapsed — re-run the email login.`,
          status === 401 ? "uc_auth_error" : "uc_upstream_error"
        ),
        url
      );
    }

    const body = (input.body ?? {}) as OpenAiChatBody;
    const originalMessages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;

    // Vision + doc input (persona blob layer): extract inline images/docs from the
    // current turn, upload each via the presigned-URL flow, and carry the blob
    // refs in the frame. UC parses the blob server-side (image vision, PDF text).
    // The captured persona frame supports exactly one blob. Never silently turn
    // an attachment request into text-only chat: that can produce a plausible but
    // ungrounded answer from a model that never received the image/document.
    let media: UcMediaBlob[] = [];
    const extractedMedia = extractCurrentTurnMedia(originalMessages);
    if (extractedMedia.requestedMediaCount > 1) {
      return wrap(
        errorResponse(
          400,
          "UC persona currently supports one image or document per turn.",
          "uc_too_many_attachments"
        ),
        url
      );
    }
    if (extractedMedia.requestedMediaCount === 1) {
      let uploadCandidates = extractedMedia.inline;
      try {
        if (extractedMedia.remoteImageUrls.length) {
          uploadCandidates = await resolveUcRemoteImages(extractedMedia.remoteImageUrls);
        }
      } catch (err) {
        return wrap(
          errorResponse(
            400,
            `UC could not safely fetch the remote image: ${sanitizeErrorMessage(
              err instanceof Error ? err.message : err
            )}`,
            "uc_invalid_remote_image"
          ),
          url
        );
      }
      if (uploadCandidates.length !== 1) {
        return wrap(
          errorResponse(400, "UC attachment is missing or malformed.", "uc_invalid_attachment"),
          url
        );
      }
      try {
        const blob = await uploadUcBlob(uploadCandidates[0], {
          jwt,
          uid: cred.uid,
          signal: input.signal,
          log: input.log ?? undefined,
        });
        media = blob ? [blob] : [];
      } catch {
        media = [];
      }
      if (media.length !== 1) {
        return wrap(
          errorResponse(
            502,
            "UC could not upload the requested attachment.",
            "uc_attachment_upload_failed"
          ),
          url
        );
      }
    }

    // Tool-calling (prompted protocol). Most models use the shared formal
    // contract. Guardrailed models (currently gpt-5.5) must never see that markup:
    // render their natural code-style contract directly from the raw schemas.
    const codestyle = ucUsesCodestyle(input.model);
    const prepared = codestyle
      ? {
          hasTools: Array.isArray(body.tools) && body.tools.length > 0,
          requestedTools: Array.isArray(body.tools) ? body.tools : [],
          effectiveMessages: originalMessages,
        }
      : prepareToolMessages(
          body as Record<string, unknown>,
          originalMessages as Array<{ role: string; content: unknown }>
        );
    const { hasTools, requestedTools, effectiveMessages } = prepared;

    const assembled = assembleUcTurn(
      effectiveMessages as Array<{ role?: string; content?: unknown; name?: string }>
    );
    let text =
      codestyle && hasTools
        ? applyCodestylePreamble(assembled.text, requestedTools)
        : assembled.text;
    const history = assembled.history;
    if (!text) {
      return wrap(errorResponse(400, "No user message to send to UC.", "uc_empty_request"), url);
    }

    const id = `chatcmpl-uc-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = estimateUcTokens(text);
    const capture = {
      headers: { Origin: "https://uncensored.com" },
      transformedBody: {
        model: input.model,
        text,
        chat_history: history,
        ...(media.length ? { media_blob_name: media[0].blobName } : {}),
      },
    };

    // Tool mode: the <tool> protocol is only parseable once the full reply is in
    // hand, so buffer the whole turn, build a chat.completion, and let the shared
    // shim parse <tool> blocks into tool_calls (with a terminal SSE replay for
    // streaming callers). Mirrors every web-cookie provider's tool path.
    if (hasTools) {
      let turn = await runUcTurn({
        jwt,
        uid: cred.uid,
        model: input.model,
        text,
        history,
        media,
        signal: input.signal,
      });
      const errResp = this.turnErrorResponse(turn, url, cred.sid);
      if (errResp) return errResp;

      let answer = turn.content;
      let reasoning = turn.reasoning;

      // AUTO-CURE: a guardrailed model (NOT already code-style) that REFUSED the
      // <tool_call> markup gets ONE retry with the natural code-style dialect,
      // which slips past the vendor guardrail. Only fires on an actual
      // refusal-with-tools, so the working models never take this path.
      const firstHasCall =
        !!parseToolCallsFromText(answer, "probe", requestedTools).toolCalls ||
        parseUcExtraDialects(answer, requestedTools, input.model).length > 0;
      if (!firstHasCall && !codestyle && ucLooksLikeRefusal(answer)) {
        // Reassemble from the RAW messages so the retry contains no formal
        // `<tool>` system block from prepareToolMessages.
        const curedBase = assembleUcTurn(originalMessages);
        const curedText = applyCodestylePreamble(curedBase.text, requestedTools);
        const retry = await runUcTurn({
          jwt,
          uid: cred.uid,
          model: input.model,
          text: curedText,
          history: curedBase.history,
          media,
          signal: input.signal,
        });
        const retryErrorResponse = this.turnErrorResponse(retry, url, cred.sid);
        if (retryErrorResponse) return retryErrorResponse;
        if (!retry.error && retry.content) {
          const retryHasCall =
            !!parseToolCallsFromText(retry.content, "probe", requestedTools).toolCalls ||
            parseUcExtraDialects(retry.content, requestedTools, input.model).length > 0;
          if (retryHasCall) {
            answer = retry.content;
            reasoning = retry.reasoning;
            input.log?.debug?.("uc", "tool refusal recovered via code-style retry");
          }
        }
      }

      // Supplement the shared <tool> parser with UC's extra dialects (code-style
      // fn("x") + Gemini <tool_code>). If the shared JSON parser found no calls but
      // an extra dialect did, rewrite the answer's calls as <tool_call> JSON so the
      // shared buildToolModeResponse picks them up uniformly.
      answer = injectExtraDialectCalls(answer, requestedTools, input.model);

      const completionTokens = estimateUcTokens(reasoning + answer);
      const buffered = new Response(
        JSON.stringify({
          id,
          object: "chat.completion",
          created,
          model: input.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: answer,
                ...(reasoning ? { reasoning_content: reasoning } : {}),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        }),
        { status: 200, headers: JSON_HEADERS }
      );
      const response = await buildToolModeResponse(buffered, requestedTools, input.stream, {
        cid: id,
        created,
        model: input.model,
        idSeed: "uc",
      });
      return wrap(response, url, capture);
    }

    if (input.stream) {
      const stream = this.buildStream(input, jwt, cred, text, history, media, id, created);
      return wrap(new Response(stream, { status: 200, headers: SSE_HEADERS }), url, capture);
    }

    // Non-streaming: run the turn to completion, build a chat.completion.
    const turn = await runUcTurn({
      jwt,
      uid: cred.uid,
      model: input.model,
      text,
      history,
      media,
      signal: input.signal,
    });
    const errResp = this.turnErrorResponse(turn, url, cred.sid);
    if (errResp) return errResp;

    const answer = turn.content;
    const reasoning = turn.reasoning;
    const completionTokens = estimateUcTokens(reasoning + answer);
    const response = {
      id,
      object: "chat.completion",
      created,
      model: input.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: answer,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
    return wrap(
      new Response(JSON.stringify(response), { status: 200, headers: JSON_HEADERS }),
      url,
      capture
    );
  }

  /**
   * Convert a failed/soft-errored UC turn into an error Response, or null when
   * the turn is a usable answer. A soft-error apology (short transient capacity
   * message returned AS the answer) is surfaced as a retryable 502 so OmniRoute
   * can fall back instead of handing the user a bogus reply.
   */
  private turnErrorResponse(
    turn: UcTurnResult,
    url: string,
    sid: string
  ): ReturnType<typeof wrap> | null {
    if (turn.error) {
      const { status, code } = classifyTurnError(turn.error);
      const resetAt = rememberUcCooldown(sid, turn);
      return wrap(
        errorResponse(
          status,
          `UC persona turn failed: ${turn.error}`,
          code,
          resetAt ? retryAfterHeaders(resetAt) : undefined
        ),
        url
      );
    }
    const soft = detectUcSoftError(turn.content);
    if (soft) {
      return wrap(
        errorResponse(502, `UC returned a transient soft-error: ${soft}`, "uc_soft_error"),
        url
      );
    }
    if (!turn.content) {
      return wrap(errorResponse(502, "UC returned an empty response.", "uc_empty_response"), url);
    }
    return null;
  }

  /**
   * Build a live OpenAI SSE stream from a persona turn. Streams reasoning as
   * `reasoning_content` deltas and the answer as `content` deltas, then a
   * terminal `finish_reason: "stop"`. A mid-stream error frame ends the stream
   * with an error delta (best-effort; the tool path buffers instead).
   */
  private buildStream(
    input: ExecuteInput,
    jwt: string,
    cred: UcCredential,
    text: string,
    history: ReturnType<typeof assembleUcTurn>["history"],
    media: UcMediaBlob[],
    id: string,
    created: number
  ): ReadableStream<Uint8Array> {
    const model = input.model;
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        // Prime the stream with the role delta.
        chunk(controller, id, created, model, { role: "assistant" });
        let sawError: string | null = null;
        let streamed = "";
        const turn = await runUcTurn({
          jwt,
          uid: cred.uid,
          model,
          text,
          history,
          media,
          signal: input.signal,
          onEvent: (evt) => {
            if (evt.kind === "reasoning") {
              chunk(controller, id, created, model, { reasoning_content: evt.text });
            } else if (evt.kind === "delta") {
              streamed += evt.text;
              chunk(controller, id, created, model, { content: evt.text });
            } else if (evt.kind === "error") {
              sawError = evt.text;
            }
          },
        });

        if (turn.error) rememberUcCooldown(cred.sid, turn);
        const err = turn.error ?? sawError;
        // A soft-error apology returned AS the answer is not a real reply — treat
        // it as an error when nothing streamed.
        const soft = !err && !streamed ? detectUcSoftError(turn.content) : null;
        if (err || soft) {
          const reason = err ?? `transient soft-error: ${soft}`;
          const { code } = classifyTurnError(String(reason));
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                error: {
                  code,
                  message: sanitizeErrorMessage(`UC persona turn failed: ${reason}`),
                  type: "provider_error",
                },
              })}\n\n`
            )
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        // Flush the authoritative final content that wasn't already streamed.
        // Short answers arrive ONLY in the terminal `raw_text` (no text deltas),
        // so `turn.content` is the full answer while `streamed` is empty; emit the
        // remainder as one content delta. When deltas WERE streamed, turn.content
        // equals `streamed` and the remainder is empty (nothing extra emitted).
        const remainder = turn.content.startsWith(streamed)
          ? turn.content.slice(streamed.length)
          : turn.content;
        if (remainder) {
          chunk(controller, id, created, model, { content: remainder });
        }

        chunk(controller, id, created, model, {}, "stop");
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
  }

  /**
   * Return a valid 60s session JWT: reuse the per-session cache when fresh, else
   * mint a new one, persisting any rotated cookies back to the connection.
   * Throws on a hard mint failure (the caller maps it to a 401/502).
   */
  private async ensureSessionToken(cred: UcCredential, input: ExecuteInput): Promise<string> {
    const cached = ucTokenCache.get(cred.sid);
    if (cached) return cached;

    const result = await mintUcSessionToken({
      sid: cred.sid,
      cookies: cred.cookies,
      signal: input.signal,
    });
    if (!result.ok || !result.token) {
      // Persist any rotated cookies even on failure (they may unstick next time).
      await this.persistRotatedCookies(cred, result.rotatedCookies, input);
      throw new Error(result.error || `Clerk mint HTTP ${result.status}`);
    }

    const token: UcSessionToken = result.token;
    ucTokenCache.set(cred.sid, token);
    await this.persistRotatedCookies(cred, result.rotatedCookies, input);
    return token.jwt;
  }

  /** Merge any rotated cookies into the stored connection credential. */
  private async persistRotatedCookies(
    cred: UcCredential,
    rotated: Record<string, string> | undefined,
    input: ExecuteInput
  ): Promise<void> {
    if (!rotated || Object.keys(rotated).length === 0) return;
    // Only persist when something actually changed vs the stored jar.
    let changed = false;
    const nextCookies = { ...cred.cookies };
    for (const [k, v] of Object.entries(rotated)) {
      if (nextCookies[k] !== v) {
        nextCookies[k] = v;
        changed = true;
      }
    }
    if (!changed) return;
    try {
      await input.onCredentialsRefreshed?.({
        providerSpecificData: {
          ...(input.credentials?.providerSpecificData ?? {}),
          ucCookies: nextCookies,
          // Keep the durable cookie mirror in sync if it rotated (rare).
          ...(nextCookies.__client ? { ucClientCookie: nextCookies.__client } : {}),
        },
      });
    } catch (err) {
      input.log?.warn?.(
        "uc",
        `rotated-cookie persist failed: ${sanitizeErrorMessage(err instanceof Error ? err.message : err)}`
      );
    }
  }
}
