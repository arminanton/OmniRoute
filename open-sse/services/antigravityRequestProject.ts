import { getFencedTaskContext } from "./coordination/fencedTask.ts";
import { combineAbortSignals } from "../utils/combineAbortSignals.ts";
import {
  ensureAntigravityProjectAssigned,
  ANTIGRAVITY_REQUIRES_MANUAL_PROJECT,
} from "./antigravityProjectBootstrap.ts";
import { persistDiscoveredAntigravityProjectId } from "./antigravityProjectPersist.ts";
import { markAntigravityMissingCloudCodeProject } from "./antigravityProjectPersistence.ts";
import { getAntigravityClientProfile } from "./antigravityClientProfile.ts";

type ProjectCredentials = {
  projectId?: string | null;
  accessToken?: string | null;
  connectionId?: string | null;
  providerSpecificData?: Record<string, unknown> | null;
};
// Private request-local binding survives translation without trusting client body metadata.
const resolvedProjects = new WeakMap<object, string>();

/** Reject only the bootstrap's native sentinel; ordinary Google IDs are opaque. */
export function normalizeAntigravityProjectId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const project = value.trim();
  return project && project !== ANTIGRAVITY_REQUIRES_MANUAL_PROJECT ? project : null;
}

export function selectAntigravityProjectId(
  credentials: ProjectCredentials,
  body: unknown,
  allowBodyOverride = process.env.OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE === "1"
): string | null {
  const bound = resolvedProjects.get(credentials);
  if (bound) return bound;
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const bodyProject = normalizeAntigravityProjectId(record.project);
  const stored =
    normalizeAntigravityProjectId(credentials.projectId) ||
    normalizeAntigravityProjectId(credentials.providerSpecificData?.projectId);
  return allowBodyOverride && bodyProject ? bodyProject : stored || bodyProject;
}

/** Resolve before cache translation, using the existing bounded/configured bootstrap transport.
 * Only an authenticated discovery is persisted; client overrides remain request-local.
 */
export async function withResolvedAntigravityProject<T extends ProjectCredentials>(
  credentials: T,
  body: unknown,
  signal?: AbortSignal
): Promise<T | Response> {
  if (resolvedProjects.has(credentials)) return credentials;
  let projectId = selectAntigravityProjectId(credentials, body);
  let requiresManualProject = false;
  if (!projectId && credentials.accessToken) {
    const owner = getFencedTaskContext();
    owner?.assertOwner();
    const effectiveSignal = owner
      ? signal
        ? combineAbortSignals([signal, owner.signal])
        : owner.signal
      : signal;
    const discovered = await ensureAntigravityProjectAssigned(
      credentials.accessToken,
      fetch,
      getAntigravityClientProfile(credentials),
      effectiveSignal
    );
    owner?.assertOwner();
    effectiveSignal?.throwIfAborted();
    projectId = normalizeAntigravityProjectId(discovered);
    if (projectId)
      await persistDiscoveredAntigravityProjectId(
        credentials.connectionId,
        projectId,
        credentials.providerSpecificData
      );
    requiresManualProject = discovered === ANTIGRAVITY_REQUIRES_MANUAL_PROJECT;
  }
  if (!projectId) {
    markAntigravityMissingCloudCodeProject(credentials?.connectionId);
    if (requiresManualProject) {
      // Google no longer auto-creates GCP projects for standard-tier
      // accounts (tracked in #8491): fail fast with a clear instruction
      // instead of the generic 422 — a fabricated/omitted id only earns a
      // delayed 429 RESOURCE_EXHAUSTED from Google's quota check.
      const errorBody = {
        error: {
          message:
            "GCP_PROJECT_REQUIRED: Google Antigravity now requires a free GCP Project ID. " +
            "Create one at console.cloud.google.com and enter it in Providers → Antigravity " +
            "(connection settings → Project ID). Automatic project creation is no longer " +
            "available for personal accounts.",
          type: "gcp_project_required",
          code: "gcp_project_required",
        },
      };
      // 422, not 403: chatCore's generic "401/403 → refresh credentials and
      // retry" path would otherwise hit Google's OAuth token endpoint on
      // every request from an affected account — pointless, since refreshing
      // the token cannot create a GCP project. 422 also matches the sibling
      // missing_project_id error, which the client already maps to a clear
      // "action needed" prompt.
      const resp = new Response(JSON.stringify(errorBody), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
      // Returning a Response object signals the executor to stop and forward it
      return resp;
    }
    // (#489) Return a structured error instead of throwing — gives the client a clear signal
    // to show a "Reconnect OAuth" prompt rather than an opaque "Internal Server Error".
    const errorMsg =
      "Missing Google projectId for Antigravity account. Auto-discovery via loadCodeAssist " +
      "found no Cloud Code project. Please reconnect OAuth in Providers → Antigravity (and " +
      "ensure the Google account has completed Gemini Code Assist onboarding).";
    const errorBody = {
      error: {
        message: errorMsg,
        type: "oauth_missing_project_id",
        code: "missing_project_id",
      },
    };
    const resp = new Response(JSON.stringify(errorBody), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
    // Returning a Response object signals the executor to stop and forward it
    return resp;
  }

  const local = {
    ...credentials,
    projectId,
    providerSpecificData: { ...credentials.providerSpecificData, projectId },
  } as T;
  resolvedProjects.set(local, projectId);
  return local;
}
