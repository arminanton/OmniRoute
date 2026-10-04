/** Account catalog decoder. Protocol-only, synthetic-fixture tested; no network calls. */
export type GeminiWebAccountModel = {
  id: string;
  displayName: string;
  description: string;
};

const MAX_BODY_LENGTH = 2 * 1024 * 1024;
const MAX_MODELS = 128;
const STATUS_RPC = "uqlm3e";

/**
 * Fail closed: only an available account's complete, unambiguous catalog is returned.
 * IDs remain opaque. Display names are not model versions or selection headers.
 * Errors deliberately contain no upstream response data.
 */
export function parseGeminiWebAccountModels(raw: string): GeminiWebAccountModel[] {
  const invalid = () => new Error("Invalid Gemini Web account model response");
  if (typeof raw !== "string" || raw.length > MAX_BODY_LENGTH) throw invalid();
  let position = raw.startsWith(")]}'") ? 4 : 0;
  let models: GeminiWebAccountModel[] | undefined;

  while (position < raw.length) {
    while (/\s/.test(raw[position] ?? "") && position < raw.length) position++;
    if (position === raw.length) break;
    const newline = raw.indexOf("\n", position);
    if (newline === -1) throw invalid();
    const lengthText = raw.slice(position, newline).trim();
    if (!/^\d{1,7}$/.test(lengthText)) throw invalid();
    const length = Number(lengthText);
    position = newline + 1;
    if (!length || length > MAX_BODY_LENGTH || position + length > raw.length) throw invalid();
    let rows: unknown;
    try {
      rows = JSON.parse(raw.slice(position, position + length));
    } catch {
      throw invalid();
    }
    position += length;
    if (!Array.isArray(rows)) throw invalid();
    for (const row of rows) {
      if (!Array.isArray(row) || row[0] !== "wrb.fr" || row[1] !== STATUS_RPC) continue;
      // Repeated status payloads could disagree. Do not merge account snapshots.
      if (models !== undefined || typeof row[2] !== "string") throw invalid();
      let payload: unknown;
      try {
        payload = JSON.parse(row[2]);
      } catch {
        throw invalid();
      }
      if (!Array.isArray(payload)) throw invalid();
      if (payload[14] !== 1000) throw new Error("Gemini Web account model catalog unavailable");
      const entries: unknown = payload[15];
      if (!Array.isArray(entries) || !entries.length || entries.length > MAX_MODELS)
        throw invalid();
      const ids = new Set<string>();
      models = entries.map((entry): GeminiWebAccountModel => {
        if (!Array.isArray(entry)) throw invalid();
        const [id, displayName, description] = entry;
        if (
          typeof id !== "string" ||
          !id.trim() ||
          id.length > 256 ||
          typeof displayName !== "string" ||
          !displayName.trim() ||
          displayName.length > 512 ||
          typeof description !== "string" ||
          description.length > 8192 ||
          ids.has(id)
        )
          throw invalid();
        ids.add(id);
        return { id, displayName, description };
      });
    }
  }
  if (!models) throw invalid();
  return models;
}
