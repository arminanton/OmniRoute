/** Native combination retains abort reasons and does not accumulate hand-written listeners. */
export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}
