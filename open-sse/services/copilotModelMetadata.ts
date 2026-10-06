/** Allowlisted native discovery metadata. No token prices are inferred from request multipliers. */
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

export function parseCopilotModelMetadata(item: Record<string, unknown>) {
  const capabilities = asRecord(item.capabilities);
  const limits = asRecord(capabilities.limits);
  const support = asRecord(capabilities.supports);
  const billing = asRecord(item.billing);
  const inputTokenLimit = positive(limits.max_context_window_tokens);
  const outputTokenLimit = positive(limits.max_output_tokens);
  const multiplier =
    typeof billing.multiplier === "number" &&
    Number.isFinite(billing.multiplier) &&
    billing.multiplier >= 0
      ? billing.multiplier
      : undefined;
  const endpoints = Array.isArray(item.supported_endpoints)
    ? item.supported_endpoints.filter((entry): entry is string => typeof entry === "string")
    : [];
  const supportedEndpoints = endpoints.flatMap((endpoint) =>
    endpoint.includes("/responses")
      ? ["responses"]
      : endpoint.includes("/chat/completions")
        ? ["chat"]
        : endpoint.includes("/messages")
          ? ["messages"]
          : []
  );
  const efforts = Array.isArray(support.reasoning_effort)
    ? support.reasoning_effort.filter(
        (value): value is string => typeof value === "string" && value.length > 0
      )
    : undefined;
  return {
    ...(inputTokenLimit ? { inputTokenLimit } : {}),
    ...(outputTokenLimit ? { outputTokenLimit } : {}),
    ...(supportedEndpoints.length ? { supportedEndpoints: [...new Set(supportedEndpoints)] } : {}),
    ...(efforts ? { supportedThinkingEfforts: efforts } : {}),
    ...(typeof support.vision === "boolean" ? { supportsVision: support.vision } : {}),
    ...(typeof support.tool_calls === "boolean" ? { supportsTools: support.tool_calls } : {}),
    ...(typeof support.reasoning === "boolean" ? { supportsThinking: support.reasoning } : {}),
    ...(multiplier !== undefined ? { premiumRequestMultiplier: multiplier } : {}),
  };
}
