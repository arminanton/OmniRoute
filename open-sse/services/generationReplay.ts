import { getGenerationDispatchPhase } from "./generationDispatchEvidence.ts";
export {
  noteGenerationDispatchPhase,
  getGenerationDispatchPhase,
  markUncertainGenerationAcceptance,
  isUncertainGenerationAcceptance,
} from "./generationDispatchEvidence.ts";
/** Transport safety is independent of the chat-only logical retry budget. */
export function canReplayHttpDispatch(
  input: unknown,
  options: { method?: string } | undefined,
  error: unknown
): boolean {
  const method = (
    options?.method ??
    (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  // A serializable body/correlation ID is not upstream idempotency evidence.
  const phase = getGenerationDispatchPhase(error);
  return phase?.requestStarted === false && phase.phase === "transport_queue";
}

/** Compatibility name for existing generation callers; no budget/classification changes. */
export const canReplayGenerationDispatch = canReplayHttpDispatch;
