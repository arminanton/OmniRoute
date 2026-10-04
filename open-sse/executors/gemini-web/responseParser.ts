/** Parse complete browser response bodies; byte chunks are decoded before framing. */
export interface GeminiWebResponse {
  text: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  malformed: boolean;
  truncated: boolean;
}

const MAX_BODY_LENGTH = 16 * 1024 * 1024;
const ERRORS: Record<string, [string, boolean]> = {
  "1037": ["Gemini usage limit reached", true],
  "1050": ["Gemini model selection is inconsistent", false],
  "1052": ["Gemini model is unavailable", false],
  "1060": ["Gemini temporarily rejected this account or IP", true],
};

export function parseGeminiWebResponse(
  input: string | Uint8Array | Iterable<Uint8Array>
): GeminiWebResponse {
  const result: GeminiWebResponse = {
    text: null,
    error: null,
    malformed: false,
    truncated: false,
  };
  let raw = "";
  try {
    if (typeof input === "string") raw = input;
    else {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (const chunk of input instanceof Uint8Array ? [input] : input) {
        raw += decoder.decode(chunk, { stream: true });
        if (raw.length > MAX_BODY_LENGTH) throw new Error("Response too large");
      }
      raw += decoder.decode();
    }
    if (raw.length > MAX_BODY_LENGTH) throw new Error("Response too large");
  } catch {
    result.malformed = true;
    return result;
  }

  const readError = (code: unknown) => {
    if (typeof code !== "number" && typeof code !== "string") return;
    if (!String(code) || String(code) === "0") return;
    const key = String(code);
    const [message, retryable]: [string, boolean] = Object.hasOwn(ERRORS, key)
      ? ERRORS[key]
      : ["Gemini returned an upstream error", false];
    result.error = { code: key, message, retryable };
  };
  const readFrame = (frame: string) => {
    try {
      const value: unknown = JSON.parse(frame);
      if (!Array.isArray(value)) {
        result.malformed = true;
        return;
      }
      const rows = typeof value[0] === "string" ? [value] : value;
      for (const row of rows) {
        if (!Array.isArray(row)) {
          result.malformed = true;
          continue;
        }
        readError(row[5]?.[2]?.[0]?.[1]?.[0]);
        if (row[0] !== "wrb.fr") continue;
        if (row[2] == null) continue;
        if (typeof row[2] !== "string") {
          result.malformed = true;
          continue;
        }
        try {
          const inner = JSON.parse(row[2]);
          const parts = inner?.[4]?.[0]?.[1];
          if (Array.isArray(parts)) {
            const text = parts.filter((part: unknown) => typeof part === "string").join("");
            if (text) result.text = text;
          }
        } catch {
          result.malformed = true;
        }
      }
    } catch {
      result.malformed = true;
    }
  };

  let offset = 0;
  if (raw.startsWith(")]}'")) offset = 4;
  while (offset < raw.length) {
    while (/\s/.test(raw[offset] ?? "") && offset < raw.length) offset++;
    if (offset === raw.length) break;
    // Existing browser fixtures and some RPC replies omit the length header.
    if (raw[offset] === "[") {
      const end = raw.indexOf("\n", offset);
      readFrame(raw.slice(offset, end < 0 ? raw.length : end));
      offset = end < 0 ? raw.length : end + 1;
      continue;
    }
    const newline = raw.indexOf("\n", offset);
    if (newline < 0) {
      result.truncated = /^\d+$/.test(raw.slice(offset));
      result.malformed = !result.truncated;
      break;
    }
    const header = raw.slice(offset, newline).replace(/\r$/, "");
    if (!/^\d+$/.test(header)) {
      result.malformed = true;
      break;
    }
    const length = Number(header);
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_BODY_LENGTH) {
      result.malformed = true;
      break;
    }
    offset = newline + 1;
    // JavaScript string offsets already count UTF-16 code units, not UTF-8 bytes.
    if (raw.length - offset < length) {
      result.truncated = true;
      break;
    }
    readFrame(raw.slice(offset, offset + length));
    offset += length;
  }
  return result;
}
