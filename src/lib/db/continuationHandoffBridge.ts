import { getUserDatabaseSettings } from "./databaseSettings.ts";
import { getCallLogRetentionDays, getCallLogRetentionDaysOverride } from "../logEnv.ts";
import { getDbInstance } from "./core.ts";
import { getSharedConversationState } from "./sharedConversationState.ts";
import {
  retainSharedResponseContinuation,
  resolveSharedResponseContinuation,
  type RetainedContinuation,
} from "./sharedResponseContinuation.ts";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

export function normalizeContinuationModel(model: string): string {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  const prefix = model.slice(0, slash);
  const canonical =
    Object.entries(PROVIDER_ID_TO_ALIAS).find(([, alias]) => alias === prefix)?.[0] || prefix;
  return canonical + model.slice(slash);
}
export function canRetainContinuationForPrincipal(principal: string): boolean {
  const row = getDbInstance().prepare("SELECT no_log FROM api_keys WHERE id=?").get(principal) as
    { no_log?: unknown } | undefined;
  return row?.no_log === 0;
}

/** Called after a permitted complete artifact is published; never reads the larger original request. */
export function bridgeRetainedResponseArtifact(
  responseId: string,
  principal: string,
  logicalModel: string,
  readLocal: (responseId: string, principal: string) => RetainedContinuation | null
): boolean {
  if (!getSharedConversationState() || !canRetainContinuationForPrincipal(principal)) return false;
  const state = readLocal(responseId, principal);
  const row = getDbInstance()
    .prepare(
      "SELECT video_content_removed,status,timestamp FROM call_logs WHERE response_id=? AND api_key_id=? AND detail_state='ready' ORDER BY timestamp DESC LIMIT 1"
    )
    .get(responseId, principal) as
    { video_content_removed: number; status: number; timestamp: string } | undefined;
  if (!state || !row || row.video_content_removed !== 0 || row.status < 200 || row.status >= 300)
    return false;
  let retentionDays = getCallLogRetentionDays();
  try {
    retentionDays =
      getCallLogRetentionDaysOverride() ?? getUserDatabaseSettings().retention.callLogs;
  } catch {
    /* conservative existing policy default */
  }
  const sourceExpiresAt = Date.parse(row.timestamp) + retentionDays * 86400000;
  return retainSharedResponseContinuation(
    responseId,
    principal,
    normalizeContinuationModel(logicalModel),
    state,
    {
      loggingEnabled: true,
      noLog: false,
      videoRedacted: false,
      sourceReady: true,
      sourceTruncated: false,
      sourceExpiresAt,
    }
  );
}
export function resolveSharedRetainedResponse(
  responseId: string,
  principal: string,
  logicalModel: string
): RetainedContinuation | null {
  if (!canRetainContinuationForPrincipal(principal)) return null;
  return resolveSharedResponseContinuation(
    responseId,
    principal,
    normalizeContinuationModel(logicalModel)
  );
}

/** Logging only authorizes already-published, untruncated artifacts, never original larger bodies. */
export function publishSharedContinuation(
  entry: { responseId?: string | null; apiKeyId?: string | null; requestedModel?: string | null },
  detailState: string,
  noLog: boolean,
  reader: (responseId: string, principal: string) => RetainedContinuation | null
) {
  if (
    detailState !== "ready" ||
    noLog ||
    !entry.responseId ||
    !entry.apiKeyId ||
    !entry.requestedModel
  )
    return;
  try {
    bridgeRetainedResponseArtifact(entry.responseId, entry.apiKeyId, entry.requestedModel, reader);
  } catch {
    /* Optional functional state fails closed, never logging. */
  }
}
