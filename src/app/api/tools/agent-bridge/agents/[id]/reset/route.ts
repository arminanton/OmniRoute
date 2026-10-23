/**
 * POST /api/tools/agent-bridge/agents/[id]/reset
 * LOCAL_ONLY + SPAWN_CAPABLE: registered in routeGuard.ts (prefix
 * /api/tools/agent-bridge/).
 * Restore only this agent's hosts, model mappings, and setup state.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentBridgeResetBodySchema } from "@/shared/schemas/agentBridge";
import { removeDNSEntries, resolveHostsForAgent } from "@/mitm/dns/dnsConfig";
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

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

function getAgentDnsResetPlan(
  agentId: string,
  states: ReturnType<typeof getAllAgentBridgeStates>
): { hostsToRemove: string[]; hostsPreservedForOtherAgents: string[] } {
  const selectedHosts = resolveHostsForAgent(agentId);
  const siblingHosts = new Set(
    states
      .filter((state) => state.agent_id !== agentId && state.dns_enabled)
      .flatMap((state) => resolveHostsForAgent(state.agent_id))
      .map(normalizeHost)
  );
  const hostsToRemove = selectedHosts.filter((host) => !siblingHosts.has(normalizeHost(host)));
  const hostsPreservedForOtherAgents = selectedHosts.filter((host) =>
    siblingHosts.has(normalizeHost(host))
  );
  return { hostsToRemove, hostsPreservedForOtherAgents };
}

function hostsFilePath(): string {
  if (os.platform() === "win32") {
    return path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "drivers",
      "etc",
      "hosts"
    );
  }
  return "/etc/hosts";
}

function readHostsFile(): string | null {
  try {
    return fs.readFileSync(hostsFilePath(), "utf8");
  } catch {
    // An unreadable hosts file cannot be treated as proof that entries are absent.
    return null;
  }
}

function hasDnsEntriesForHosts(hosts: string[], hostsContent: string): boolean {
  const selectedHosts = new Set(hosts.map(normalizeHost));
  if (selectedHosts.size === 0) return false;

  return hostsContent.split(/\r?\n/).some((line) => {
    const parts = line.split("#", 1)[0].trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2 || isIP(parts[0]) === 0) return false;
    return parts.slice(1).some((host) => selectedHosts.has(normalizeHost(host)));
  });
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
    const dnsResetPlan = getAgentDnsResetPlan(id, getAllAgentBridgeStates());
    await removeDNSEntries(dnsResetPlan.hostsToRemove, sudoPassword);
    if (dnsResetPlan.hostsToRemove.length > 0) flushWindowsDnsCache();
    setMappings(id, []);
    syncAgentBridgeMappingsToMitmAlias(id);
    upsertAgentBridgeState({ agent_id: id, dns_enabled: false, setup_completed: false });

    const suppliedPassword = normalizeMitmSudoPasswordInput(parsed.data.sudoPassword ?? "");
    if (process.platform !== "win32" && suppliedPassword) setCachedPassword(suppliedPassword);

    const hostsContent = dnsResetPlan.hostsToRemove.length > 0 ? readHostsFile() : "";
    const dnsEntriesRemain =
      hostsContent === null
        ? null
        : hasDnsEntriesForHosts(dnsResetPlan.hostsToRemove, hostsContent);
    const dnsCleared = dnsEntriesRemain === false;
    const mappingsCleared = getMappingsForAgent(id).length === 0;
    const state = getAgentBridgeState(id);
    const stateCleared = state !== null && !state.dns_enabled && !state.setup_completed;
    const verified = dnsCleared && mappingsCleared && stateCleared;
    if (!verified) {
      return createErrorResponse({
        status: 500,
        message: "Agent reset could not be verified",
        details: {
          verified,
          dnsEntriesRemain,
          dnsCheckSucceeded: hostsContent !== null,
          mappingsCleared,
          stateCleared,
        },
      });
    }

    return Response.json({
      ok: true,
      agent_id: id,
      dns_enabled: false,
      mappingsCleared,
      verified,
      dnsHostsPreservedForOtherAgents: dnsResetPlan.hostsPreservedForOtherAgents,
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
