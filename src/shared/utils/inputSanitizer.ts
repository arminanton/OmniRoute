/**
 * Input Sanitizer — FASE-01 Security Hardening
 *
 * Detects prompt injection patterns and redacts PII from LLM requests.
 * Configurable via environment variables or dashboard settings.
 *
 * @module inputSanitizer
 */

import { parseEnvBoolean } from "@/shared/utils/envBoolean";
import { resolveBlockThreshold, shouldBlockDetections } from "@/shared/utils/injectionSeverity";

// ─── Prompt Injection Patterns ───────────────────────────────────────

/** @type {Array<{name: string, pattern: RegExp, severity: string}>} */
const INJECTION_PATTERNS = [
  {
    name: "system_override",
    pattern:
      /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/i,
    severity: "high",
  },
  {
    name: "role_hijack",
    pattern:
      /\b(you\s+are\s+now|act\s+as\s+if|pretend\s+(to\s+be|you\s+are)|from\s+now\s+on\s+you\s+are)\b/i,
    severity: "medium",
  },
  {
    name: "system_prompt_leak",
    // #4041: require a system/initial/hidden/original qualifier before prompt|instructions.
    // The old pattern matched a bare "instructions" after reveal/show/display/etc, so it
    // tripped `high` on essentially all coding-agent traffic ("show the instructions",
    // "display your instructions"), making the always-on guard a hot-path false-positive.
    // Real leak attempts ("reveal your system prompt", "print the initial prompt") still
    // match, and qualified instruction leaks ("display your system instructions") now do too.
    pattern:
      /\b(reveals?|shows?|displays?|prints?|outputs?|repeats?)\s+((your|the)\s+)?(system|initial|hidden|original)\s+(prompt|instructions?)/i,
    severity: "high",
  },
  {
    name: "delimiter_injection",
    pattern: /(\[SYSTEM\]|\[INST\]|<<SYS>>|<\|im_start\|>|<\|system\|>|<\|user\|>)/i,
    severity: "high",
  },
  {
    name: "jailbreak_dan",
    pattern: /\b(DAN|do\s+anything\s+now|jailbreak|developer\s+mode|enable\s+developer)\b/i,
    severity: "medium",
  },
  {
    name: "encoding_evasion",
    pattern:
      /\b(base64\s+decode|rot13|hex\s+decode|unicode\s+escape)\b.*\b(instruction|prompt|command)\b/i,
    severity: "medium",
  },
];

/**
 * Maximum number of characters scanned for prompt-injection patterns.
 *
 * The guard joins every message/system string into one buffer and runs several
 * regexes over it on every chat request. With no cap that is O(body) CPU on the
 * hot path — at high concurrency with 300 KB bodies it is a self-inflicted
 * latency/GC source. Injection directives sit near the top of a prompt, so
 * scanning hundreds of KB of pasted code / RAG context buys only CPU. We bound
 * the scan to the first 16 KB (generous: real directives are far shorter) before
 * the regex loop. The body-size caps that protect ingestion live elsewhere;
 * this constant only bounds the regex scan. Refs #3932 / #4041.
 */
export const MAX_INJECTION_SCAN_BYTES = 16 * 1024;

// ─── PII Patterns ────────────────────────────────────────────────────

/** @type {Array<{name: string, pattern: RegExp, replacement: string}>} */
const PII_PATTERNS = [
  {
    name: "email",
    // Bound both sides of `@`: the unbounded local-part `+` makes V8 retry a
    // long code/context string from many word boundaries when it contains no
    // email, turning PII detection into quadratic work on large prompts.
    pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}\b/g,
    replacement: "[EMAIL_REDACTED]",
  },
  {
    name: "cpf",
    pattern: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
    replacement: "[CPF_REDACTED]",
  },
  {
    name: "cnpj",
    pattern: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g,
    replacement: "[CNPJ_REDACTED]",
  },
  {
    name: "credit_card",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    replacement: "[CARD_REDACTED]",
  },
  {
    name: "phone_br",
    pattern: /\b\(?\d{2}\)?\s?\d{4,5}-?\d{4}\b/g,
    replacement: "[PHONE_REDACTED]",
  },
  {
    name: "ssn_us",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN_REDACTED]",
  },
];

// ─── Configuration ────────────────────────────────────────────────────

/**
 * Get sanitizer configuration from environment.
 * @returns {{ enabled: boolean, mode: string, piiRedaction: boolean }}
 */
function getConfig() {
  return {
    // Default ON (opt-out). Truthy/falsy parsing accepts true/1/yes/on and false/0/no/off.
    enabled: parseEnvBoolean(process.env.INPUT_SANITIZER_ENABLED, true),
    mode: process.env.INPUT_SANITIZER_MODE || "warn", // "warn" | "block" | "redact"
    piiRedaction: parseEnvBoolean(process.env.PII_REDACTION_ENABLED, false),
    blockThreshold: resolveBlockThreshold(),
  };
}

// ─── Core Functions ───────────────────────────────────────────────────

/**
 * @typedef {Object} SanitizeResult
 * @property {boolean} blocked - Whether the request should be blocked
 * @property {boolean} modified - Whether the content was modified (PII redacted)
 * @property {Array<{pattern: string, severity: string, match: string}>} detections
 * @property {Array<{type: string, count: number}>} piiDetections
 * @property {Object} [sanitizedBody] - Modified body (if PII redaction active)
 */

/**
 * Extract all message content strings from a chat body.
 * Supports both `messages[]` (OpenAI/Claude) and `input[]` (Responses API).
 * @param {Object} body
 * @returns {string[]}
 */
function extractMessageContents(body, maxChars = Infinity) {
  const contents = [];
  let totalChars = 0;

  const pushString = (str) => {
    if (typeof str !== "string" || totalChars >= maxChars) return;
    if (totalChars + str.length > maxChars) {
      const needed = maxChars - totalChars;
      contents.push(str.slice(0, needed));
      totalChars = maxChars;
    } else {
      contents.push(str);
      totalChars += str.length;
    }
  };

  const messageSource = body.messages !== undefined ? body.messages : body.input;
  const messages = Array.isArray(messageSource)
    ? messageSource
    : messageSource === undefined || messageSource === null
      ? []
      : [messageSource];
  for (const msg of messages) {
    if (totalChars >= maxChars) break;
    if (typeof msg === "string") {
      pushString(msg);
    } else if (msg && typeof msg.content === "string") {
      pushString(msg.content);
    } else if (msg && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (totalChars >= maxChars) break;
        if (typeof part === "string") {
          pushString(part);
        } else if (part && typeof part.text === "string") {
          pushString(part.text);
        }
      }
    }
  }

  // Also check system prompt
  if (totalChars < maxChars) {
    if (typeof body.system === "string") {
      pushString(body.system);
    } else if (Array.isArray(body.system)) {
      for (const s of body.system) {
        if (totalChars >= maxChars) break;
        if (typeof s === "string") pushString(s);
        else if (s && typeof s.text === "string") pushString(s.text);
      }
    }
  }

  if (totalChars < maxChars && typeof body.input === "string") pushString(body.input);
  if (totalChars < maxChars) {
    if (typeof body.prompt === "string") pushString(body.prompt);
    else if (Array.isArray(body.prompt)) {
      for (const p of body.prompt) {
        if (totalChars >= maxChars) break;
        if (typeof p === "string") pushString(p);
      }
    }
  }
  if (totalChars < maxChars && typeof body.instructions === "string") pushString(body.instructions);
  if (totalChars < maxChars && typeof body.query === "string") pushString(body.query);
  if (totalChars < maxChars && Array.isArray(body.documents)) {
    for (const d of body.documents) {
      if (totalChars >= maxChars) break;
      if (typeof d === "string") pushString(d);
      else if (d && typeof d.text === "string") pushString(d.text);
    }
  }

  return contents;
}

/**
 * Scan content for prompt injection patterns.
 * @param {string} text
 * @returns {Array<{pattern: string, severity: string, match: string}>}
 */
function detectInjection(text) {
  const detections = [];
  // Bound the regex scan to the first 16 KB — see MAX_INJECTION_SCAN_BYTES
  // (hot-path perf, #3932 / #4041). Slice before the loop so each pattern only
  // ever scans the capped prefix, never the full (possibly hundreds of KB) body.
  const scanText =
    text.length > MAX_INJECTION_SCAN_BYTES ? text.slice(0, MAX_INJECTION_SCAN_BYTES) : text;
  for (const rule of INJECTION_PATTERNS) {
    const match = scanText.match(rule.pattern);
    if (match) {
      detections.push({
        pattern: rule.name,
        severity: rule.severity,
        match: match[0].slice(0, 50), // truncate for logging
      });
    }
  }
  return detections;
}

/**
 * Scan and optionally redact PII from text.
 * @param {string} text
 * @param {boolean} redact - If true, replaces PII with placeholders
 * @returns {{ text: string, detections: Array<{type: string, count: number}> }}
 */
function processPII(text, redact = false) {
  const detections = [];
  let processed = text;
  const hasEmailCandidate = text.includes("@");
  const hasDigit = /\d/.test(text);

  for (const rule of PII_PATTERNS) {
    if (rule.name === "email") {
      if (!hasEmailCandidate) continue;
    } else {
      if (!hasDigit) continue;
      if (rule.name === "cpf" && (!text.includes(".") || !text.includes("-"))) continue;
      if (rule.name === "cnpj" && (!text.includes("/") || !text.includes("-"))) continue;
      if (rule.name === "ssn_us" && !text.includes("-")) continue;
    }
    const matches = text.match(rule.pattern);
    if (matches && matches.length > 0) {
      detections.push({ type: rule.name, count: matches.length });
      if (redact) {
        processed = processed.replace(rule.pattern, rule.replacement);
      }
    }
  }

  return { text: processed, detections };
}

/**
 * Sanitize a chat request body.
 *
 * @param {Object} body - The chat completion request body
 * @param {Object} [logger] - Logger instance (defaults to console)
 * @returns {SanitizeResult}
 */
export function sanitizeRequest(body, logger = console) {
  const config = getConfig();

  const result = {
    blocked: false,
    modified: false,
    detections: [],
    piiDetections: [],
    sanitizedBody: null,
  };

  if (!config.enabled) return result;

  // Injection directives sit near the top. When PII redaction is disabled (default),
  // only extract up to MAX_INJECTION_SCAN_BYTES to avoid multi-megabyte allocations.
  const contents = config.piiRedaction
    ? extractMessageContents(body)
    : extractMessageContents(body, MAX_INJECTION_SCAN_BYTES);
  const fullText = contents.join("\n");

  // ── Prompt Injection Detection ──
  const injections = detectInjection(fullText);
  if (injections.length > 0) {
    result.detections = injections;

    const highSeverity = injections.filter((d) => d.severity === "high");
    const logLevel = highSeverity.length > 0 ? "warn" : "info";

    if (logger[logLevel]) {
      logger[logLevel](
        `[SANITIZER] Prompt injection detected: ${injections.map((d) => d.pattern).join(", ")}`
      );
    }

    // Shared threshold policy with evaluatePromptInjection / createInjectionGuard.
    // Default threshold is "high" (medium is observe-only unless lowered via env).
    if (config.mode === "block" && shouldBlockDetections(injections, config.blockThreshold)) {
      result.blocked = true;
      return result;
    }
  }

  // ── PII Detection / Redaction ──
  // PII rewrite is controlled by PII_REDACTION_ENABLED only.
  // INPUT_SANITIZER_MODE is reserved for prompt-injection policy (warn/block/log).
  if (config.piiRedaction) {
    const piiResult = processPII(fullText, true);
    result.piiDetections = piiResult.detections;

    if (piiResult.detections.length > 0) {
      logger.warn?.(
        `[SANITIZER] PII detected: ${piiResult.detections.map((d) => `${d.type}(${d.count})`).join(", ")}`
      );

      // Deep clone and replace message contents with redacted versions
      result.sanitizedBody = redactBody(body);
      result.modified = true;
    }
  }

  return result;
}

/**
 * Deep clone body and replace message contents with PII-redacted versions.
 * @param {Object} body
 * @returns {Object}
 */
function redactBody(body) {
  // Deep clone to avoid mutating original
  const clone = JSON.parse(JSON.stringify(body));
  const messageSource = clone.messages !== undefined ? clone.messages : clone.input;
  const messages = Array.isArray(messageSource)
    ? messageSource
    : messageSource === undefined || messageSource === null
      ? []
      : [messageSource];

  const redactContentValue = (value) => {
    if (typeof value === "string") {
      return processPII(value, true).text;
    }
    if (Array.isArray(value)) {
      return value.map((part) => {
        if (typeof part === "string") {
          return processPII(part, true).text;
        }
        if (part && typeof part === "object") {
          const next = { ...part };
          if (typeof next.text === "string") {
            next.text = processPII(next.text, true).text;
          }
          if (typeof next.content === "string") {
            next.content = processPII(next.content, true).text;
          }
          return next;
        }
        return part;
      });
    }
    return value;
  };

  const redactedMessages = messages.map((msg) => {
    if (typeof msg === "string") {
      return processPII(msg, true).text;
    }
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const next = { ...msg };
    if ("content" in next) {
      next.content = redactContentValue(next.content);
    }
    if (typeof next.text === "string") {
      next.text = processPII(next.text, true).text;
    }
    return next;
  });

  if (clone.messages !== undefined) {
    clone.messages = Array.isArray(clone.messages) ? redactedMessages : redactedMessages[0];
  } else if (clone.input !== undefined) {
    clone.input = Array.isArray(clone.input) ? redactedMessages : redactedMessages[0];
  }

  if (typeof clone.system === "string") {
    clone.system = processPII(clone.system, true).text;
  } else if (Array.isArray(clone.system)) {
    clone.system = clone.system.map((entry) => {
      if (typeof entry === "string") return processPII(entry, true).text;
      if (entry && typeof entry === "object") {
        const next = { ...entry };
        if (typeof next.text === "string") next.text = processPII(next.text, true).text;
        if (typeof next.content === "string") next.content = processPII(next.content, true).text;
        return next;
      }
      return entry;
    });
  }

  if (typeof clone.input === "string") {
    clone.input = processPII(clone.input, true).text;
  }
  if (typeof clone.prompt === "string") {
    clone.prompt = processPII(clone.prompt, true).text;
  } else if (Array.isArray(clone.prompt)) {
    clone.prompt = clone.prompt.map((entry) =>
      typeof entry === "string" ? processPII(entry, true).text : entry
    );
  }

  return clone;
}

export { detectInjection, processPII, extractMessageContents, INJECTION_PATTERNS, PII_PATTERNS };
