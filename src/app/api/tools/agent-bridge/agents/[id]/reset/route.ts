/**
 * POST /api/tools/agent-bridge/agents/[id]/reset
 * LOCAL_ONLY + SPAWN_CAPABLE: registered in routeGuard.ts (prefix
 * /api/tools/agent-bridge/).
 * Restore only this agent's hosts, model mappings, and setup state.
 */
import { execFileSync } from "node:child_process";
import { AgentBridgeResetBodySchema } from "@/shared/schemas/agentBridge";
import { checkDNSEntryForAgent, removeDNSEntry } from "@/mitm/dns/dnsConfig";
import {
  getAgentBridgeState,
  getAllAgentBridgeStates,
  upsertAgentBridgeState,
} from "@/lib/db/agentBridgeState";
import {
  getMappingsForAgent,
  setMappings,
  syncAgentBridgeMappingsToMitmAlias,
} from "@/lib/db/agentBridgeMappings";
import { getCachedPassword, setCachedPassword } from "@/mitm/manager";
import {
  isMitmSudoPasswordRequired,
  normalizeMitmSudoPasswordInput,
  resolveMitmSudoPassword,
} from "@/mitm/sudoGate";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { ALL_TARGETS } from "@/mitm/targets/index";

type Params = { params: Promise<{ id: string }> };

function flushWindowsDnsCache(): void {
  if (process.platform !== "win32") return;
  try {
    execFileSync("ipconfig", ["/flushdns"], { windowsHide: true, stdio: "ignore" });
  } catch {
    // Best effort: hosts-file removal is authoritative; cache flush may be unavailable.
  }
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid JSON body" });
  }
  const parsed = AgentBridgeResetBodySchema.safeParse(body);
  if (!parsed.success) {
    return createErrorResponse({
      status: 400,
      message: "Invalid request body",
      details: parsed.error.flatten(),
    });
  }

  if (!ALL_TARGETS.some((target) => target.id === id)) {
    return createErrorResponse({ status: 404, message: `Unknown agent: ${id}` });
  }

  const sudoPassword = resolveMitmSudoPassword(parsed.data.sudoPassword, getCachedPassword());
  if (isMitmSudoPasswordRequired(sudoPassword)) {
    return createErrorResponse({ status: 400, message: "Missing sudoPassword" });
  }

  try {
    await removeDNSEntry(sudoPassword, id);
    flushWindowsDnsCache();
    setMappings(id, []);
    syncAgentBridgeMappingsToMitmAlias(id);
    upsertAgentBridgeState({ agent_id: id, dns_enabled: false, setup_completed: false });

    const suppliedPassword = normalizeMitmSudoPasswordInput(parsed.data.sudoPassword ?? "");
    if (process.platform !== "win32" && suppliedPassword) setCachedPassword(suppliedPassword);

    const dnsEntryPresent = checkDNSEntryForAgent(id);
    const mappingsCleared = getMappingsForAgent(id).length === 0;
    const state = getAgentBridgeState(id);
    const stateCleared = state !== null && !state.dns_enabled && !state.setup_completed;
    const verified = !dnsEntryPresent && mappingsCleared && stateCleared;
    if (!verified) {
      return createErrorResponse({
        status: 500,
        message: "Agent reset could not be verified",
        details: { verified, dnsEntryPresent, mappingsCleared, stateCleared },
      });
    }

    return Response.json({
      ok: true,
      agent_id: id,
      dns_enabled: false,
      mappingsCleared,
      verified,
      otherAgentsStillActive: getAllAgentBridgeStates().some(
        (otherState) => otherState.agent_id !== id && otherState.dns_enabled
      ),
      restartRequired: true,
    });
  } catch (err) {
    const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    return createErrorResponse({ status: 500, message, details: { verified: false } });
  }
}
