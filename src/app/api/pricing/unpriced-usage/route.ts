import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getUnpricedUsageModelGroups } from "@/lib/db/usageModelGroups";
import { getUnpricedUsageBudgetPolicy } from "@/shared/utils/featureFlags";

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

/** GET /api/pricing/unpriced-usage — management-only pricing coverage report. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - EIGHT_DAYS_MS);
  try {
    return NextResponse.json({
      windowStartIso: windowStart.toISOString(),
      windowEndIso: windowEnd.toISOString(),
      policy: getUnpricedUsageBudgetPolicy(),
      items: await getUnpricedUsageModelGroups(windowStart.toISOString(), windowEnd.toISOString()),
    });
  } catch (error) {
    console.error("Error fetching unpriced usage:", error);
    return NextResponse.json({ error: "Failed to fetch unpriced usage" }, { status: 500 });
  }
}
