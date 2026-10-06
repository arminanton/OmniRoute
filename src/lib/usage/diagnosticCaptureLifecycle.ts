import { registerCanaryCounter } from "../canaryLifecycle";
import {
  getDiagnosticOverflowActiveWork,
  initializeDiagnosticOverflowStore,
} from "./diagnosticOverflow";

/** Real startup authority; absent/failed initialization remains unknown when enabled. */
export async function bootstrapDiagnosticCaptureLifecycle(): Promise<boolean> {
  registerCanaryCounter("diagnosticCaptureWork", getDiagnosticOverflowActiveWork);
  if (process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED !== "true") return true;
  return initializeDiagnosticOverflowStore();
}
