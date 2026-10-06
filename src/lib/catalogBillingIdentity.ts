import { splitClaudeEffortSuffix } from "@omniroute/open-sse/config/providerModels.ts";
import { isKnownClaudeEffortBaseModel } from "@omniroute/open-sse/utils/claudeEffortVariants.ts";
import { getRegisteredProviderEffortBaseModelId } from "@omniroute/open-sse/utils/registeredEffortVariants.ts";

/** Exact variant overrides win; inherit only aliases that dispatch actually normalizes. */
export function getCatalogBillingModelCandidates(provider: string, model: string): string[] {
  const registered = getRegisteredProviderEffortBaseModelId(provider, model);
  if (registered) return [model, registered];
  const { baseModel, effort } = splitClaudeEffortSuffix(model);
  if (effort && isKnownClaudeEffortBaseModel(baseModel)) return [model, baseModel];
  return [model];
}
