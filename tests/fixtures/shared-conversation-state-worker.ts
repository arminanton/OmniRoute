import {
  getSharedConversationState,
  closeSharedConversationStateForTests,
} from "../../src/lib/db/sharedConversationState.ts";
import { completeConversationStateHandoffChallenge } from "../../open-sse/services/conversationState/readiness.ts";
import {
  storeGeminiThoughtSignature,
  clearGeminiThoughtSignatures,
} from "../../open-sse/services/geminiThoughtSignatureStore.ts";
const [operation, value, extra, model] = process.argv.slice(2);
let result: unknown;
if (operation === "attest") result = completeConversationStateHandoffChallenge(value);
else if (operation === "write-signature") {
  storeGeminiThoughtSignature(value, extra);
  result = true;
} else if (operation === "clear-signatures") {
  clearGeminiThoughtSignatures();
  result = true;
} else if (operation === "claim-pin") result = getSharedConversationState()?.pin(value, 30000);
else if (operation === "pin-owner") result = getSharedConversationState()?.pinOwner(value);
else if (operation === "resolve-continuation") {
  const { resolvePreviousResponseState } =
    await import("../../src/lib/db/responsesContinuationStore.ts");
  result = resolvePreviousResponseState(value, extra, model);
} else throw new Error("Unknown fixture operation");
closeSharedConversationStateForTests();
console.log(JSON.stringify({ result }));
