import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/db/providers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { projectProviderClientConnection } from "@/lib/providers/providerClientProjection";

// GET /api/providers/client - List safe provider metadata for dashboard client widgets.
// Credentials are never returned from this client-oriented endpoint.
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const connections = await getProviderConnections();
    const clientConnections = connections.map(projectProviderClientConnection);
    return NextResponse.json({ connections: clientConnections });
  } catch (error) {
    console.log("Error fetching providers for client:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}
