/**
 * Sanitizes a custom API path to prevent path traversal attacks.
 * Valid paths must start with '/', contain no '..' segments,
 * no null bytes, and be reasonable in length.
 */
export function sanitizePath(path: string): boolean {
  if (typeof path !== "string") return false;
  if (!path.startsWith("/")) return false;
  if (/[\\\s#]/.test(path)) return false;
  if ([...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false;
  if (path.includes("..")) return false; // path traversal
  if (path.length > 512) return false; // sanity limit
  return true;
}

export function mergeAbortSignals(primary: AbortSignal, secondary: AbortSignal): AbortSignal {
  const controller = new AbortController();

  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };

  if (primary.aborted) {
    abortFrom(primary);
    return controller.signal;
  }
  if (secondary.aborted) {
    abortFrom(secondary);
    return controller.signal;
  }

  primary.addEventListener("abort", () => abortFrom(primary), { once: true });
  secondary.addEventListener("abort", () => abortFrom(secondary), { once: true });
  return controller.signal;
}

/**
 * Strip the OmniRoute provider prefix from tool model fields (e.g.
 * `cc/claude-opus-4-8` → `claude-opus-4-8`). Versioned built-in tool types carry
 * an 8-digit date suffix (`advisor_20260301`, `bash_20250124`); non-versioned
 * server tools (Task/subagent, web_search) carry the same prefixed model. The
 * real Claude CLI sends a bare model id there, never a prefixed one, so a leaked
 * OmniRoute prefix makes Anthropic reject the request.
 *
 * Two mechanisms, applied to any tool with a string `model`:
 * 1. Versioned built-in types (`type` matches `_\d{8}$`): strip the last path
 *    segment (`model.split("/").pop()`), matching legacy behavior for kiro/ etc.
 * 2. Any tool whose model starts with a 9router Claude provider prefix
 *    (`cc/`, `claude/`): strip exactly that prefix (`slice`), preserving foreign
 *    providers such as `openrouter/anthropic/...` — mirrors upstream
 *    normalizeClaudeServerToolModels (9router#2649).
 * Mutates in place.
 */
const CLAUDE_TOOL_MODEL_PREFIXES = ["cc/", "claude/"] as const;

export function stripVersionedToolModelPrefix(tools: unknown): void {
  if (!Array.isArray(tools)) return;
  for (const t of tools as Array<Record<string, unknown>>) {
    if (typeof t.model !== "string") continue;
    const model = t.model;
    if (
      typeof t.type === "string" &&
      /^[a-z][a-z0-9_]*_\d{8}$/.test(t.type) &&
      model.includes("/")
    ) {
      t.model = model.split("/").pop();
    } else {
      const prefix = CLAUDE_TOOL_MODEL_PREFIXES.find((candidate) => model.startsWith(candidate));
      if (prefix) t.model = model.slice(prefix.length);
    }
  }
}
