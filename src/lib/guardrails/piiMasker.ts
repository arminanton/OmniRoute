import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "./base";
import { processPII } from "@/shared/utils/inputSanitizer";
import { sanitizePII, sanitizePIIResponse } from "@/lib/piiSanitizer";

import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

type PiiDetection = {
  count: number;
  type: string;
};

type JsonRecord = Record<string, unknown>;

function isRequestPiiMaskingEnabled() {
  // Request PII redaction is controlled by PII_REDACTION_ENABLED feature flag (DB > env > default).
  // INPUT_SANITIZER_MODE only governs prompt-injection policy (warn/block/log).
  return isFeatureFlagEnabled("PII_REDACTION_ENABLED");
}

function sanitizeStringValue(text: string) {
  const result = processPII(text, isRequestPiiMaskingEnabled());
  return {
    detections: result.detections,
    modified: result.text !== text,
    text: result.text,
  };
}

function applyToContentValue(
  value: unknown,
  detections: PiiDetection[]
): { modified: boolean; value: unknown } {
  if (typeof value === "string") {
    const result = sanitizeStringValue(value);
    detections.push(...result.detections);
    return {
      modified: result.modified,
      value: result.text,
    };
  }

  if (Array.isArray(value)) {
    let modified = false;
    const nextValue = value.map((entry) => {
      if (typeof entry === "string") {
        const result = sanitizeStringValue(entry);
        detections.push(...result.detections);
        modified ||= result.modified;
        return result.text;
      }

      if (entry && typeof entry === "object") {
        const record = { ...(entry as JsonRecord) };
        if (typeof record.text === "string") {
          const result = sanitizeStringValue(record.text);
          detections.push(...result.detections);
          modified ||= result.modified;
          record.text = result.text;
        }
        if (typeof record.content === "string") {
          const result = sanitizeStringValue(record.content);
          detections.push(...result.detections);
          modified ||= result.modified;
          record.content = result.text;
        }
        return record;
      }

      return entry;
    });
    return { modified, value: nextValue };
  }

  return { modified: false, value };
}

function cloneAndMaskRequestPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { detections: [] as PiiDetection[], modified: false, payload };
  }

  const payloadRecord = payload as JsonRecord;
  const detections: PiiDetection[] = [];
  let modified = false;

  const sanitizeMessageLikeList = (list: unknown) => {
    if (!Array.isArray(list)) return list;
    let listModified = false;
    const nextList = list.map((entry) => {
      // Responses API can pass plain strings in input[]
      if (typeof entry === "string") {
        const result = sanitizeStringValue(entry);
        detections.push(...result.detections);
        if (result.modified) {
          listModified = true;
          return result.text;
        }
        return entry;
      }
      if (!entry || typeof entry !== "object") return entry;
      const record = entry as JsonRecord;
      let entryModified = false;
      let nextContent = record.content;
      let nextText = record.text;

      if ("content" in record) {
        const result = applyToContentValue(record.content, detections);
        if (result.modified) {
          entryModified = true;
          nextContent = result.value;
        }
      }
      if (typeof record.text === "string") {
        const result = sanitizeStringValue(record.text);
        detections.push(...result.detections);
        if (result.modified) {
          entryModified = true;
          nextText = result.text;
        }
      }
      if (entryModified) {
        listModified = true;
        return {
          ...record,
          ...("content" in record ? { content: nextContent } : {}),
          ...(typeof record.text === "string" ? { text: nextText } : {}),
        };
      }
      return entry;
    });

    if (listModified) {
      modified = true;
      return nextList;
    }
    return list;
  };

  let nextSystem = payloadRecord.system;
  let nextMessages = payloadRecord.messages;
  let nextInput = payloadRecord.input;
  let nextPrompt = payloadRecord.prompt;

  if (typeof payloadRecord.system === "string") {
    const result = sanitizeStringValue(payloadRecord.system);
    detections.push(...result.detections);
    if (result.modified) {
      modified = true;
      nextSystem = result.text;
    }
  } else if (Array.isArray(payloadRecord.system)) {
    nextSystem = sanitizeMessageLikeList(payloadRecord.system);
  }

  if (Array.isArray(payloadRecord.messages)) {
    nextMessages = sanitizeMessageLikeList(payloadRecord.messages);
  }

  if (Array.isArray(payloadRecord.input)) {
    nextInput = sanitizeMessageLikeList(payloadRecord.input);
  } else if (typeof payloadRecord.input === "string") {
    const result = sanitizeStringValue(payloadRecord.input);
    detections.push(...result.detections);
    if (result.modified) {
      modified = true;
      nextInput = result.text;
    }
  }

  if (typeof payloadRecord.prompt === "string") {
    const result = sanitizeStringValue(payloadRecord.prompt);
    detections.push(...result.detections);
    if (result.modified) {
      modified = true;
      nextPrompt = result.text;
    }
  } else if (Array.isArray(payloadRecord.prompt)) {
    nextPrompt = sanitizeMessageLikeList(payloadRecord.prompt);
  }

  return {
    detections,
    modified,
    payload: modified
      ? {
          ...payloadRecord,
          ...(nextSystem !== payloadRecord.system ? { system: nextSystem } : {}),
          ...(nextMessages !== payloadRecord.messages ? { messages: nextMessages } : {}),
          ...(nextInput !== payloadRecord.input ? { input: nextInput } : {}),
          ...(nextPrompt !== payloadRecord.prompt ? { prompt: nextPrompt } : {}),
        }
      : payload,
  };
}

function maskResponsesOutput(response: JsonRecord) {
  let modified = false;

  if (typeof response.output_text === "string") {
    const result = sanitizePII(response.output_text);
    if (result.redacted) {
      response.output_text = result.text;
      modified = true;
    }
  }

  if (Array.isArray(response.output)) {
    response.output = response.output.map((item) => {
      if (!item || typeof item !== "object") return item;
      const nextItem = { ...(item as JsonRecord) };
      if (Array.isArray(nextItem.content)) {
        nextItem.content = nextItem.content.map((part) => {
          if (!part || typeof part !== "object") return part;
          const nextPart = { ...(part as JsonRecord) };
          if (typeof nextPart.text === "string") {
            const result = sanitizePII(nextPart.text);
            if (result.redacted) {
              nextPart.text = result.text;
              modified = true;
            }
          }
          return nextPart;
        });
      }
      return nextItem;
    });
  }

  return modified;
}

export class PIIMaskerGuardrail extends BaseGuardrail {
  constructor(options: { enabled?: boolean; priority?: number } = {}) {
    super("pii-masker", {
      enabled: options.enabled,
      priority: options.priority ?? 10,
    });
  }

  async preCall(payload: unknown, _context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    const result = cloneAndMaskRequestPayload(payload);
    if (!result.modified) {
      return {
        block: false,
        meta: result.detections.length > 0 ? { detections: result.detections.length } : null,
      };
    }

    return {
      block: false,
      meta: { detections: result.detections.length, redacted: true },
      modifiedPayload: result.payload,
    };
  }

  async postCall(response: unknown, _context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      return { block: false };
    }

    const clonedResponse = JSON.parse(JSON.stringify(response)) as JsonRecord;
    const before = JSON.stringify(clonedResponse);
    const sanitized = sanitizePIIResponse(clonedResponse) as JsonRecord;
    const modifiedResponsesShape = maskResponsesOutput(sanitized);
    const after = JSON.stringify(sanitized);
    const modified = before !== after || modifiedResponsesShape;

    if (!modified) return { block: false };

    return {
      block: false,
      meta: { redacted: true },
      modifiedResponse: sanitized,
    };
  }
}
