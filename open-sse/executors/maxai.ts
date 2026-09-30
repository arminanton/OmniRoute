/**
 * MaxAiExecutor — MaxAI web-app chat as an OpenAI-compatible OmniRoute provider.
 *
 * MaxAI (chat.maxai.co / api.maxai.me) is a consumer web app with no public API.
 * This executor reproduces the web app's own signed request to `/gpt/cwc/chat`:
 *   • per-request `X-Authorization` signature (see ./signing.ts),
 *   • Firefox-150 identity headers + Bearer access token,
 *   • the full OpenAI transcript flattened into one `message_content` block
 *     (stateless-full-history; see ./protocol.ts),
 *   • SSE response parsed for text deltas, with inline `<think>` reasoning split
 *     out into `reasoning_content` (see ./stream.ts).
 *
 * Egress + TLS: every request uses a connection-bound, independently verified
 * residential route and the installed Firefox 150 / Windows wreq profile.
 * No native fallback is allowed. Offline tests do not prove account acceptance.
 * Refresh uses the same transport and commits token rotation under a durable
 * generation lease/CAS before the current request uses the fresh credential.
 */
import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { BaseExecutor, type ExecuteInput, type ExecutorExecuteResult } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { isForbiddenCustomHeaderName } from "@/shared/constants/upstreamHeaders";
import { resolveMaxaiCredential, type MaxaiCredential } from "./maxai/credentials.ts";
import { buildMaxaiSignedHeaders } from "./maxai/signing.ts";
import { ensureMaxaiConstants } from "./maxai/constantsStore.ts";
import { ensureFreshMaxaiCredential } from "./maxai/refresh.ts";
import { maxaiFetch, runMaxaiConnectionTransport } from "../services/maxaiTransport.ts";
import {
  assembleMaxaiContext,
  buildMaxaiChatBody,
  extractCurrentTurnImages,
  MAXAI_BASE_URL,
  MAXAI_CHAT_PATH,
  maxaiStaticHeaders,
  newConversationId,
} from "./maxai/protocol.ts";
import { resolveMaxaiDocList, type MaxaiDocListEntry } from "./maxai/documents.ts";
import { estimateMaxaiTokens, isMaxaiTextFrame, ThinkSplitter } from "./maxai/stream.ts";
import { prepareToolMessages, parseToolCallsFromText } from "../translator/webTools.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";

function withMaxaiExtraHeaders(
  authoritative: Record<string, string>,
  extra?: Record<string, string> | null
): Record<string, string> {
  const protectedNames = new Set(Object.keys(authoritative).map((name) => name.toLowerCase()));
  const headers = { ...authoritative };
  for (const [name, value] of Object.entries(extra ?? {})) {
    const normalized = name.trim().toLowerCase();
    if (
      protectedNames.has(normalized) ||
      isForbiddenCustomHeaderName(normalized) ||
      normalized.startsWith("sec-ch-ua")
    )
      continue;
    headers[name] = value;
  }
  return headers;
}

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
}

function errorResponse(status: number, message: string, code: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: sanitizeErrorMessage(message),
        type: status >= 500 ? "provider_error" : "invalid_request_error",
      },
    }),
    { status, headers: JSON_HEADERS }
  );
}

/**
 * Wrap a Response into the executor wrapper contract shape
 * `{response, url, headers, transformedBody}` that `chatCore.ts` and the
 * web-cookie/noauth sweep (tests/unit/executor-web-cookie-sweep.test.ts)
 * require. `headers` and `transformedBody` are the ACTUAL upstream request
 * headers and body — chatCore surfaces them as the provider-request-capture
 * ("what we actually sent") in the dashboard and uses the body for service-tier
 * and prompt-cache metadata (chatCore.ts:3680-3688), mirroring the shape returned
 * by every web-cookie sibling (venice-web.ts:92-94, poe-web.ts:121-123). Error
 * paths that fail BEFORE a request is assembled pass no capture — honestly empty,
 * because nothing was sent upstream.
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

/**
 * Detect a tool "narration miss": the model produced no parseable <tool> block
 * but its text shows it was ABOUT to call a tool (talks about the <tool> block
 * or names a requested tool). This is the occasional reasoning-model failure
 * mode (e.g. deepseek-r1) where it reasons about the call instead of emitting
 * it. A true refusal or a normal answer returns false, so we never retry those.
 */
function isToolNarrationMiss(text: string, requestedTools: unknown): boolean {
  if (!text) return false;
  if (/<tool\b/.test(text)) return true; // mentioned the tag but it didn't parse
  const names = Array.isArray(requestedTools)
    ? (requestedTools as Array<{ function?: { name?: unknown } }>)
        .map((t) => (typeof t?.function?.name === "string" ? t.function.name : ""))
        .filter(Boolean)
    : [];
  // Names it a tool AND signals intent to use it (not merely mentioning it).
  const intent = /\b(I('| wi)ll|let me|I can|going to|need to)\b/i.test(text);
  return intent && names.some((n) => text.includes(n));
}

/** A short, soft nudge appended to the transcript for the single retry turn. */
function toolNudge(originalText: string): string {
  return (
    originalText +
    "\n\n[A quick note: if a client tool would help answer this, please go ahead " +
    "and emit the <tool> block directly rather than describing it — just the block " +
    "on its own line. If no tool is needed, a normal answer is perfectly fine.]"
  );
}

/** Emit one OpenAI `chat.completion.chunk`. */
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

type MaxaiExecutorDependencies = {
  fetchImpl?: typeof fetch;
  runTransport?: typeof runMaxaiConnectionTransport;
  ensureCredential?: typeof ensureFreshMaxaiCredential;
};

export class MaxAiExecutor extends BaseExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly runTransport: typeof runMaxaiConnectionTransport;
  private readonly ensureCredential: typeof ensureFreshMaxaiCredential;

  constructor(deps: MaxaiExecutorDependencies = {}) {
    super("maxai", PROVIDERS.maxai ?? { id: "maxai", baseUrl: MAXAI_BASE_URL });
    this.fetchImpl = deps.fetchImpl ?? maxaiFetch;
    this.runTransport = deps.runTransport ?? runMaxaiConnectionTransport;
    this.ensureCredential = deps.ensureCredential ?? ensureFreshMaxaiCredential;
  }

  override async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    try {
      input.signal?.throwIfAborted();
      return await this.runTransport(input.credentials?.connectionId ?? "", () =>
        this.executeBound(input)
      );
    } catch (error) {
      if (isRuntimePolicyError(error)) throw error;
      if (input.signal?.aborted) throw input.signal.reason;
      const status =
        error && typeof error === "object" && "status" in error && typeof error.status === "number"
          ? error.status
          : 503;
      return wrap(
        errorResponse(
          status,
          "MaxAI account or verified transport unavailable.",
          "maxai_account_unavailable"
        ),
        MAXAI_BASE_URL + MAXAI_CHAT_PATH
      );
    }
  }

  private async executeBound(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    // The MaxAI chat endpoint URL is the wrapper's `url` for every return path
    // (error and success alike), so define it once up front.
    const url = MAXAI_BASE_URL + MAXAI_CHAT_PATH;

    let cred = resolveMaxaiCredential(
      input.credentials?.providerSpecificData,
      input.credentials?.accessToken || input.credentials?.apiKey,
      input.credentials?.refreshToken
    );
    if (!cred) {
      return wrap(
        errorResponse(
          401,
          "MaxAI connection is not configured (missing access token, device id, or user id). Sign in to mint a token.",
          "maxai_unconfigured"
        ),
        url
      );
    }

    // The shared coordinator owns the durable lease/CAS write. Never call the
    // generic snapshot persistence callback again after a successful rotation.
    cred = await this.ensureCredential({
      connectionId: input.credentials.connectionId,
      credential: cred,
      signal: input.signal,
      fetchImpl: this.fetchImpl,
    });
    input.signal?.throwIfAborted();
    const accessToken = cred.accessToken;

    const body = (input.body ?? {}) as OpenAiChatBody;

    // Tool-calling (prompted protocol): when the request carries tools[], inject
    // the <tool> contract into the messages so the model learns the client tools
    // and how to invoke them (see translator/webTools.ts). MaxAI has no native
    // function-calling; this is the same prompted-tool shim the web-cookie
    // providers use. The response side parses <tool> blocks back into tool_calls.
    const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
      body as Record<string, unknown>,
      (body.messages ?? []) as Array<{ role: string; content: unknown }>
    );

    let text: string;
    try {
      text = assembleMaxaiContext(effectiveMessages);
    } catch {
      return wrap(
        errorResponse(400, "No user message to send to MaxAI.", "maxai_empty_request"),
        url
      );
    }

    // Vision input: attach the CURRENT user turn's images (data: / http(s):) to
    // message_content so vision-capable MaxAI models actually see them. Extract
    // from the original messages (pre-tool-munging); text stays flattened.
    const originalMessages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    const imageUrls = extractCurrentTurnImages(originalMessages);

    // Doc-RAG: upload any inline documents (base64 file/input_file/document
    // parts) on the current turn to /app/upload_document and attach the
    // resulting doc_list to the chat body. Missing or failed document uploads
    // must not silently turn a grounded request into a text-only answer.
    let docList: MaxaiDocListEntry[];
    try {
      docList = await resolveMaxaiDocList(
        originalMessages,
        { accessToken, userId: cred.userId, deviceId: cred.deviceId },
        { signal: input.signal ?? undefined, fetchImpl: this.fetchImpl }
      );
    } catch (error) {
      if (isRuntimePolicyError(error)) throw error;
      input.signal?.throwIfAborted();
      const status =
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error.status === 400 || error.status === 413)
          ? error.status
          : 502;
      return wrap(
        errorResponse(status, "MaxAI document could not be processed.", "maxai_document_error"),
        url
      );
    }

    const constants = await ensureMaxaiConstants({
      signal: input.signal,
      fetchImpl: this.fetchImpl,
    });
    if (!constants) {
      return wrap(
        errorResponse(
          401,
          "MaxAI signing constants unavailable (extraction failed); cannot sign the request.",
          "maxai_auth_error"
        ),
        url
      );
    }

    const conversationId = newConversationId();
    const chatBody = buildMaxaiChatBody({
      conversationId,
      text,
      modelName: input.model,
      appVersion: constants.appVersion,
      imageUrls,
      docList: docList.length ? docList : undefined,
    });

    const signedHeaders = buildMaxaiSignedHeaders(
      {
        path: MAXAI_CHAT_PATH,
        userId: cred.userId,
        deviceId: cred.deviceId,
      },
      constants
    );
    const headers = withMaxaiExtraHeaders(
      {
        ...maxaiStaticHeaders(),
        ...signedHeaders,
        Authorization: `Bearer ${accessToken}`,
      },
      input.upstreamExtraHeaders
    );

    let upstream: Response;
    try {
      upstream = await this.fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers,
        body: JSON.stringify(chatBody),
        signal: input.signal ?? undefined,
      });
    } catch (error) {
      if (isRuntimePolicyError(error)) throw error;
      input.signal?.throwIfAborted();
      return wrap(errorResponse(502, "MaxAI request failed.", "maxai_transport_error"), url);
    }

    if (upstream.status !== 200 || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      // 401/418 = auth expired/masked-reject; surface so the caller can prompt a re-mint.
      // A body-too-large rejection (MaxAI answers 422 "...message you submitted being
      // too long...") is INPUT-bound: classify it as context_length_exceeded so
      // OmniRoute's compression/overflow pipeline can shrink and retry instead of
      // treating it as an opaque provider error.
      const tooLong = /too\s+long|exceeds?\b.*\bcontext|context.*(?:exceeded|too long|limit)/i.test(
        detail
      );
      if (tooLong) {
        return wrap(
          errorResponse(400, "MaxAI request exceeds the context limit.", "context_length_exceeded"),
          url
        );
      }
      const status = upstream.status === 418 ? 401 : upstream.status || 502;
      return wrap(
        errorResponse(
          status,
          `MaxAI upstream request failed (HTTP ${upstream.status}).`,
          upstream.status === 401 || upstream.status === 418
            ? "maxai_auth_error"
            : "maxai_upstream_error"
        ),
        url
      );
    }

    const id = `chatcmpl-${conversationId}`;
    const created = Math.floor(Date.now() / 1000);
    const promptTokens = estimateMaxaiTokens(text);

    // Tool mode: MaxAI streams plain text, and the <tool> protocol is only
    // parseable once the full reply is in hand. So when tools are active we
    // buffer the whole body, build a chat.completion, and let the shared shim
    // parse <tool> blocks into tool_calls (emitting a terminal SSE replay for
    // streaming callers). This mirrors every web-cookie provider's tool path.
    if (hasTools) {
      const raw = await upstream.text();
      let { reasoning, answer } = collectNonStream(raw);

      // Reliability: if the model narrated about the tool but emitted no
      // parseable <tool> block (occasional reasoning-model miss), do ONE gentle
      // nudged retry and keep it only if it actually produces a tool call.
      const firstHasToolCall = !!parseToolCallsFromText(answer, "probe", requestedTools).toolCalls;
      if (!firstHasToolCall && isToolNarrationMiss(reasoning + "\n" + answer, requestedTools)) {
        const retry = await this.retryToolTurn(
          cred,
          accessToken,
          input,
          toolNudge(text),
          imageUrls,
          docList
        );
        if (retry && parseToolCallsFromText(retry.answer, "probe", requestedTools).toolCalls) {
          reasoning = retry.reasoning;
          answer = retry.answer;
          input.log?.debug?.("maxai", "tool narration-miss recovered via one nudged retry");
        }
      }

      const completionTokens = estimateMaxaiTokens(reasoning + answer);
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
        idSeed: "maxai",
      });
      return wrap(response, url, { headers, transformedBody: chatBody });
    }

    if (input.stream) {
      const stream = this.buildStream(upstream.body, id, created, input.model, promptTokens);
      return wrap(new Response(stream, { status: 200, headers: SSE_HEADERS }), url, {
        headers,
        transformedBody: chatBody,
      });
    }

    // Non-streaming: collect the whole SSE body, split think, build a chat.completion.
    const raw = await upstream.text();
    const { reasoning, answer } = collectNonStream(raw);
    const completionTokens = estimateMaxaiTokens(reasoning + answer);
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
      { headers, transformedBody: chatBody }
    );
  }

  /**
   * Run a single follow-up MaxAI turn with a gentle nudge appended, used to
   * recover a reasoning-model "narration miss" (the model talked ABOUT the
   * <tool> block instead of emitting it). Bounded to one extra call; returns the
   * split { reasoning, answer } or null on any failure (caller keeps the original).
   */
  private async retryToolTurn(
    cred: MaxaiCredential,
    accessToken: string,
    input: ExecuteInput,
    nudgedText: string,
    imageUrls: string[],
    docList: MaxaiDocListEntry[]
  ): Promise<{ reasoning: string; answer: string } | null> {
    try {
      input.signal?.throwIfAborted();
      const constants = await ensureMaxaiConstants({
        signal: input.signal,
        fetchImpl: this.fetchImpl,
      });
      if (!constants) return null;
      const retryBody = buildMaxaiChatBody({
        conversationId: newConversationId(),
        text: nudgedText,
        modelName: input.model,
        appVersion: constants.appVersion,
        imageUrls,
        docList,
      });
      const headers = withMaxaiExtraHeaders(
        {
          ...maxaiStaticHeaders(),
          ...buildMaxaiSignedHeaders(
            {
              path: MAXAI_CHAT_PATH,
              userId: cred.userId,
              deviceId: cred.deviceId,
            },
            constants
          ),
          Authorization: `Bearer ${accessToken}`,
        },
        input.upstreamExtraHeaders
      );
      const res = await this.fetchImpl(MAXAI_BASE_URL + MAXAI_CHAT_PATH, {
        method: "POST",
        redirect: "error",
        headers,
        body: JSON.stringify(retryBody),
        signal: input.signal ?? undefined,
      });
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      return collectNonStream(await res.text());
    } catch (error) {
      if (isRuntimePolicyError(error)) throw error;
      input.signal?.throwIfAborted();
      return null;
    }
  }

  /** Bridge the MaxAI SSE body into an OpenAI chat.completion.chunk stream. */
  private buildStream(
    source: ReadableStream<Uint8Array>,
    id: string,
    created: number,
    model: string,
    promptTokens: number
  ): ReadableStream {
    const splitter = new ThinkSplitter();
    const decoder = new TextDecoder();
    let sseBuf = "";
    let sentRole = false;
    let completionChars = 0;

    const emitDelta = (controller: ReadableStreamDefaultController, r: string, a: string) => {
      if (!sentRole && (r || a)) {
        chunk(controller, id, created, model, { role: "assistant" });
        sentRole = true;
      }
      if (r) {
        chunk(controller, id, created, model, { reasoning_content: r });
        completionChars += r.length;
      }
      if (a) {
        chunk(controller, id, created, model, { content: a });
        completionChars += a.length;
      }
    };

    const processFrame = (controller: ReadableStreamDefaultController, jsonStr: string) => {
      if (!jsonStr || jsonStr === "[DONE]") return;
      let frame: unknown;
      try {
        frame = JSON.parse(jsonStr);
      } catch {
        return;
      }
      if (isMaxaiTextFrame(frame)) {
        const { reasoning, answer } = splitter.feed(frame.text);
        emitDelta(controller, reasoning, answer);
      }
    };

    const reader = source.getReader();
    let cancelled = false;
    return new ReadableStream({
      async cancel(reason) {
        cancelled = true;
        await reader.cancel(reason);
      },
      async start(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (done) break;
            sseBuf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = sseBuf.indexOf("\n")) !== -1) {
              const line = sseBuf.slice(0, nl).trim();
              sseBuf = sseBuf.slice(nl + 1);
              if (line.startsWith("data:")) processFrame(controller, line.slice(5).trim());
            }
          }
          // flush held tail from the think splitter
          const tail = splitter.flush();
          emitDelta(controller, tail.reasoning, tail.answer);
          // final chunk with usage + finish
          const completionTokens = estimateMaxaiTokens("x".repeat(completionChars));
          const finalChunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try {
            controller.error(err);
          } catch {
            /* already errored */
          }
        } finally {
          reader.releaseLock();
        }
      },
    });
  }
}

/** Collect a full MaxAI SSE body into split { reasoning, answer } (non-stream). */
function collectNonStream(raw: string): { reasoning: string; answer: string } {
  const splitter = new ThinkSplitter();
  let reasoning = "";
  let answer = "";
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const js = s.slice(5).trim();
    if (!js || js === "[DONE]") continue;
    let frame: unknown;
    try {
      frame = JSON.parse(js);
    } catch {
      continue;
    }
    if (isMaxaiTextFrame(frame)) {
      const out = splitter.feed(frame.text);
      reasoning += out.reasoning;
      answer += out.answer;
    }
  }
  const tail = splitter.flush();
  return { reasoning: reasoning + tail.reasoning, answer: answer + tail.answer };
}
