import { assertNotLockedCapability } from "@/shared/runtimePolicy";
import type { CloudAgentBase } from "./baseAgent.ts";
import { JulesAgent } from "./agents/jules.ts";
import { DevinAgent } from "./agents/devin.ts";
import { CodexCloudAgent } from "./agents/codex.ts";
import { CursorCloudAgent } from "./agents/cursor.ts";

const AGENTS: Record<string, CloudAgentBase> = {
  jules: new JulesAgent(),
  devin: new DevinAgent(),
  "codex-cloud": new CodexCloudAgent(),
  // #4227: Cursor Background/Cloud Agents via the official REST API (API-key based,
  // no IDE-OAuth ban risk). Distinct provider id from the OAuth chat provider `cursor`.
  "cursor-cloud": new CursorCloudAgent(),
};

// Keep lookup available for local task cancellation. Only upstream operations are denied.
// Stable wrappers also guard callers that retain an agent between requests.
for (const [providerId, agent] of Object.entries(AGENTS)) {
  const operations = {
    createTask: agent.createTask.bind(agent),
    getStatus: agent.getStatus.bind(agent),
    approvePlan: agent.approvePlan.bind(agent),
    sendMessage: agent.sendMessage.bind(agent),
    listSources: agent.listSources.bind(agent),
  };
  const guarded = Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      (...args: unknown[]) => {
        assertNotLockedCapability("cloud-agent");
        return Reflect.apply(operation, agent, args);
      },
    ])
  );
  AGENTS[providerId] = new Proxy(agent, {
    get(target, property, receiver) {
      if (typeof property === "string" && Object.hasOwn(guarded, property)) {
        return guarded[property];
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export function getAgent(providerId: string): CloudAgentBase | null {
  return AGENTS[providerId] || null;
}

export function getAvailableAgents(): string[] {
  return Object.keys(AGENTS);
}

export function isCloudAgentProvider(providerId: string): boolean {
  return providerId in AGENTS;
}

export { JulesAgent, DevinAgent, CodexCloudAgent, CursorCloudAgent };
export type { CloudAgentBase } from "./baseAgent.ts";
