import { hasEligibleConnectionForModel } from "@/domain/connectionModelRules";

/** Scope eligibility to the model's provider; another provider's account cannot enable it. */
export function filterConfiguredCatalogModels(
  models: Array<Record<string, unknown>>,
  connections: Array<{ provider: string; isActive?: boolean; providerSpecificData?: unknown }>,
  aliases: Record<string, string>,
  nodeIdsByPrefix: Readonly<Record<string, string>> = {}
): Array<Record<string, unknown>> {
  const canonical = (key: string) => nodeIdsByPrefix[key] || aliases[key] || key;
  return models.filter((model) => {
    if (model.owned_by === "combo") return true;
    const owner = typeof model.owned_by === "string" ? canonical(model.owned_by) : null;
    if (!owner) return false;
    const eligible = connections.filter(
      (connection) => connection.isActive !== false && canonical(connection.provider) === owner
    );
    return hasEligibleConnectionForModel(eligible, model.root || model.id);
  });
}
