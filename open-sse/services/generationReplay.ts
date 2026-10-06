import { isGenerationHttpDispatch } from "./logicalRetryBudget.ts";
const phases = ((
  globalThis as typeof globalThis & {
    __omniDispatchPhases?: WeakMap<object, { phase: string; requestStarted: boolean | null }>;
  }
).__omniDispatchPhases ??= new WeakMap<
  object,
  { phase: string; requestStarted: boolean | null }
>());
const uncertain = ((
  globalThis as typeof globalThis & { __omniUncertainGeneration?: WeakSet<object> }
).__omniUncertainGeneration ??= new WeakSet<object>());
export function noteGenerationDispatchPhase(
  error: unknown,
  phase: string,
  requestStarted: boolean | null
): void {
  if (error && typeof error === "object") phases.set(error, { phase, requestStarted });
}
export function getGenerationDispatchPhase(error: unknown) {
  return error && typeof error === "object" ? (phases.get(error) ?? null) : null;
}
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
export function markUncertainGenerationAcceptance(error: unknown): Error {
  const result = error instanceof Error ? error : new Error(String(error));
  uncertain.add(result);
  return result;
}
export function isUncertainGenerationAcceptance(error: unknown): boolean {
  return !!error && typeof error === "object" && uncertain.has(error);
}
