declare global {
  var __omniPeriodicCoordination:
    | { assertOwner: (() => void) | null; suppressed: Set<string>; startupConfirmed: boolean }
    | undefined;
}
const state = (globalThis.__omniPeriodicCoordination ??= {
  assertOwner: null,
  suppressed: new Set<string>(),
  startupConfirmed: false,
});
export function installPeriodicOwnershipAuthority(assertOwner: () => void): void {
  state.assertOwner = assertOwner;
}
/** Caller-requested work is untouched: invoke only at periodic scheduler registration/ticks. */
export function periodicServicesAllowed(surface: string): boolean {
  if (process.env.OMNI_COORDINATION_PROCESS_ROLE === "generation") {
    state.suppressed.add(surface);
    return false;
  }
  if (
    process.env.OMNI_COORDINATION_PROCESS_ROLE === "maintenance" &&
    process.env.OMNI_SHARED_ADMISSION === "true"
  ) {
    if (!state.assertOwner) return false;
    try {
      state.assertOwner();
      return true;
    } catch {
      return false;
    }
  }
  return true;
}
export function confirmPeriodicStartupBarrier(): void {
  state.startupConfirmed = process.env.OMNI_COORDINATION_PROCESS_ROLE === "generation";
}
export function getPeriodicBarrierEvidence() {
  return {
    confirmed: state.startupConfirmed,
    role: process.env.OMNI_COORDINATION_PROCESS_ROLE ?? "legacy",
    suppressed: [...state.suppressed].sort(),
  };
}
