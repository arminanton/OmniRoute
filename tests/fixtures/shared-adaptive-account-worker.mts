import { acquireMany } from "../../open-sse/services/accountSemaphore.ts";
import { observeSharedAdmissionOutcome } from "../../open-sse/services/coordination/sharedSemaphore.ts";
import { resolveSharedAccountAdmissionRequirement } from "../../open-sse/handlers/chatCore/sharedAccountAdmission.ts";
import {
  resolveAccountSemaphoreKey,
  resolveAccountSemaphoreMaxConcurrency,
} from "../../open-sse/handlers/chatCore/executorHelpers.ts";
import { classifyAdmissionFeedback } from "../../open-sse/services/coordination/overloadClassification.ts";
const held = new Map<string, () => void>();
process.on(
  "message",
  async (message: {
    action: string;
    id: string;
    credentials?: Record<string, unknown>;
    timeoutMs?: number;
    status?: number;
    text?: string;
  }) => {
    const credentials = message.credentials ?? {};
    const key = resolveAccountSemaphoreKey({
      provider: "codex",
      model: "synthetic",
      connectionId: "synthetic-account",
      credentials,
    })!;
    try {
      if (message.action === "acquire") {
        const requirement = resolveSharedAccountAdmissionRequirement(
          key,
          resolveAccountSemaphoreMaxConcurrency(credentials),
          credentials
        );
        const release = await acquireMany([requirement], {
          timeoutMs: message.timeoutMs ?? 1000,
          maxQueueSize: 128,
          onLeaseLost: (error) => {
            process.send?.({ id: message.id, error: error.message });
          },
        });
        held.set(message.id, release);
      } else if (message.action === "release") {
        held.get(message.id)?.();
        held.delete(message.id);
      } else if (message.action === "feedback")
        observeSharedAdmissionOutcome(
          key,
          classifyAdmissionFeedback(message.status ?? 200, message.text ?? ""),
          10
        );
      else if (message.action === "stop") {
        for (const release of held.values()) release();
        process.send?.({ id: message.id, ok: true });
        process.exit(0);
      }
      process.send?.({ id: message.id, ok: true });
    } catch (error) {
      process.send?.({
        id: message.id,
        ok: false,
        error: (error as { code?: string }).code ?? String(error),
      });
    }
  }
);
process.send?.({ id: "ready", ok: true });
