"use server";

import { NextResponse } from "next/server";
import { getVersionManagerStatus } from "@/lib/db/versionManager";
import { getSupervisor } from "@/lib/services/registry";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

type VersionManagerStatusRow = Awaited<ReturnType<typeof getVersionManagerStatus>>[number];
type VersionManagerStatusResponseRow = Omit<
  VersionManagerStatusRow,
  "apiKey" | "managementKey" | "configOverrides"
>;

const PRIVATE_STATUS_FIELDS = new Set<string>(["apiKey", "managementKey", "configOverrides"]);
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function toVersionManagerStatusResponse(
  row: VersionManagerStatusRow
): VersionManagerStatusResponseRow {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !PRIVATE_STATUS_FIELDS.has(key))
  ) as VersionManagerStatusResponseRow;
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const rows = await getVersionManagerStatus();

    // Merge live supervisor state into DB rows so callers see consistent data
    // whether they started the service via the legacy or the new UI.
    const enriched = rows.map((row) => {
      const sup = getSupervisor(row.tool);
      if (!sup) return row;

      const live = sup.getStatus();
      return {
        ...row,
        // Prefer live state over DB state for volatile fields.
        status: live.state,
        pid: live.pid ?? row.pid,
        healthStatus: live.health,
        errorMessage: live.lastError ?? row.errorMessage,
      };
    });

    return NextResponse.json(enriched.map(toVersionManagerStatusResponse), {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    const message = sanitizeErrorMessage(
      error instanceof Error ? error.message : "Failed to get status"
    );
    console.error("[version-manager] status error:", message);
    return NextResponse.json({ error: message }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
