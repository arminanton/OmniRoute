import type { ExecuteInput } from "@omniroute/open-sse/executors/base.ts";
import { GeminiWebExecutor } from "@omniroute/open-sse/executors/gemini-web.ts";
import type { GeminiWebAccountCatalog } from "@omniroute/open-sse/executors/gemini-web/accountCapture.ts";

export { GeminiWebAccountCatalogError } from "@omniroute/open-sse/executors/gemini-web/accountCapture.ts";

export async function captureGeminiWebAccountModels(
  input: Pick<ExecuteInput, "credentials" | "signal" | "onCredentialsRefreshed" | "log">
): Promise<GeminiWebAccountCatalog> {
  return new GeminiWebExecutor().captureAccountModels(input);
}
