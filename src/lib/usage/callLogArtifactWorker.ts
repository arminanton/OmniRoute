import { parentPort } from "node:worker_threads";

import {
  CALL_LOGS_DIR,
  writeCallArtifact,
  type CallLogArtifact,
  type CallLogArtifactWriteResult,
} from "./callLogArtifacts.ts";

type WriteRequest = {
  id: number;
  artifact: CallLogArtifact;
  environment: {
    pipelineMaxSizeKb?: string;
    chatDebugFile?: string;
    appLogLevel?: string;
  };
};

type WriteReply = {
  id: number;
  result: CallLogArtifactWriteResult | null;
  failureReason?: "storage_unavailable" | "build_phase" | "write_failed" | "worker_exception";
};

function applyWriteEnvironment(environment: WriteRequest["environment"]): void {
  const values = {
    CALL_LOG_PIPELINE_MAX_SIZE_KB: environment.pipelineMaxSizeKb,
    CHAT_DEBUG_FILE: environment.chatDebugFile,
    APP_LOG_LEVEL: environment.appLogLevel,
  };
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

parentPort?.on("message", (request: WriteRequest) => {
  const originalConsoleError = console.error;
  let result: CallLogArtifactWriteResult | null = null;
  let failureReason: WriteReply["failureReason"];

  try {
    // The writer reads these options lazily; mirror the caller's per-write environment snapshot.
    applyWriteEnvironment(request.environment);
    // writeCallArtifact's legacy error includes filesystem paths. Keep worker failures generic.
    console.error = () => {};
    result = writeCallArtifact(request.artifact);
    if (!result) {
      if (!CALL_LOGS_DIR) failureReason = "storage_unavailable";
      else if (
        process.env.NEXT_PHASE === "phase-production-build" ||
        process.env.OMNIROUTE_BUILDING === "1"
      ) {
        failureReason = "build_phase";
      } else failureReason = "write_failed";
    }
  } catch {
    result = null;
    failureReason = "worker_exception";
  } finally {
    console.error = originalConsoleError;
  }

  try {
    parentPort?.postMessage({ id: request.id, result, failureReason } satisfies WriteReply);
  } catch {
    parentPort?.postMessage({
      id: request.id,
      result: null,
      failureReason: "worker_exception",
    } satisfies WriteReply);
  }
});
