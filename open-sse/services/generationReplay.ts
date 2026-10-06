import { isGenerationHttpDispatch } from "./logicalRetryBudget.ts";
import { getGenerationDispatchPhase } from "./generationDispatchEvidence.ts";
export {
  noteGenerationDispatchPhase,
  getGenerationDispatchPhase,
  markUncertainGenerationAcceptance,
  isUncertainGenerationAcceptance,
} from "./generationDispatchEvidence.ts";
/** A serializable body/correlation ID is not evidence of upstream idempotency. */
export function canReplayGenerationDispatch(
  input: unknown,
  options: { method?: string } | undefined,
  error: unknown
): boolean {
  if (!isGenerationHttpDispatch(input, options)) return true;
  const phase = getGenerationDispatchPhase(error);
  return phase?.requestStarted === false && phase.phase === "transport_queue";
}
