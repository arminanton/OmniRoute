import { getDbInstance } from "@/lib/db/core";
import { calculateCostDetailed } from "@/lib/usage/costCalculator";

interface UsageModelRow {
  provider: string;
  model: string;
  serviceTier: string;
  requestCount: number;
  affectedKeyIds: string | null;
}

export interface UnpricedUsageModelGroup {
  provider: string;
  model: string;
  requestCount: number;
  affectedKeyIds: string[];
  affectedKeyCount: number;
  pricingFailure: boolean;
}

/** Aggregates unpriced models since `sinceIso`, optionally through `untilIso` inclusive. */
export async function getUnpricedUsageModelGroups(
  sinceIso: string,
  untilIso?: string
): Promise<UnpricedUsageModelGroup[]> {
  const untilFilter = untilIso === undefined ? "" : "AND timestamp <= ?";
  const rows = getDbInstance()
    .prepare(
      `
      SELECT
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
        COUNT(*) as requestCount,
        GROUP_CONCAT(DISTINCT NULLIF(TRIM(api_key_id), '')) as affectedKeyIds
      FROM usage_history
      WHERE timestamp >= ?
        ${untilFilter}
        AND success = 1
        AND NULLIF(TRIM(provider), '') IS NOT NULL
        AND NULLIF(TRIM(model), '') IS NOT NULL
      GROUP BY LOWER(provider), LOWER(model), COALESCE(NULLIF(service_tier, ''), 'standard')
    `
    )
    .all(sinceIso, ...(untilIso === undefined ? [] : [untilIso])) as UsageModelRow[];
  const groups = new Map<string, UnpricedUsageModelGroup>();

  for (const row of rows) {
    const result = await calculateCostDetailed(
      row.provider,
      row.model,
      {},
      {
        provider: row.provider,
        model: row.model,
        serviceTier: row.serviceTier,
      }
    );
    if (!result.missingPricing && !result.failed) continue;

    const key = `${row.provider}:${row.model}`;
    const group = groups.get(key) ?? {
      provider: row.provider,
      model: row.model,
      requestCount: 0,
      affectedKeyIds: [],
      affectedKeyCount: 0,
      pricingFailure: false,
    };
    group.requestCount += Number(row.requestCount) || 0;
    group.affectedKeyIds = [
      ...new Set([
        ...group.affectedKeyIds,
        ...(row.affectedKeyIds ?? "").split(",").filter(Boolean),
      ]),
    ];
    group.affectedKeyCount = group.affectedKeyIds.length;
    group.pricingFailure ||= result.failed;
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => b.requestCount - a.requestCount);
}
