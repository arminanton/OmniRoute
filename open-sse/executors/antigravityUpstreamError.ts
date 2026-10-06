/**
 * Build a sanitized OpenAI-style error body for a non-ok Antigravity/agy upstream
 * response (#3229).
 *
 * The non-streaming executor path previously fed 4xx/5xx responses into the SSE
 * collector, which produced a synthetic `{"object":"chat.completion","content":""}`
 * success envelope — masking the real error. Route non-ok responses through
 * `buildErrorBody` instead so the client sees a proper error (hard rule #12).
 */
import { projectGoogleError } from "../utils/googleErrorDiagnostics.ts";
import { buildErrorBody } from "../utils/error.ts";
import { isGeoBlockedError } from "../services/errorClassifier.ts";

// The dashboard "Test Connection" for antigravity only probes the OAuth userinfo
// endpoint (https://www.googleapis.com/oauth2/v1/userinfo), which is NOT
// geo-restricted — so a green tick does not prove the model path works. Spell
// this out in the geo-block message so operators stop chasing accounts.
const GEO_BLOCKED_HINT =
  "The Cloud Code API is not offered from this server's current egress location " +
  '("User location is not supported for the API use."). This is not an account ' +
  "problem: the connection test only validates the Google OAuth token and does not " +
  "call the model API. Route antigravity/agy egress through a proxy in a " +
  "supported region (e.g. US/EU) or use a different provider.";

export function buildAntigravityUpstreamError(status: number, statusText: string, rawBody: string) {
  let upstreamDetails: unknown;
  try {
    upstreamDetails = JSON.parse(rawBody);
  } catch {
    // upstream body is not JSON (e.g. HTML error page) — omit structured details
  }
  const native =
    upstreamDetails && typeof upstreamDetails === "object"
      ? projectGoogleError((upstreamDetails as Record<string, unknown>).error)
      : undefined;
  const wrap = (message: string) => {
    const body = buildErrorBody(status, message, upstreamDetails);
    if (native) body.upstream_details = { error: native };
    return body;
  };
  const suffix = statusText ? `: ${statusText}` : "";
  if (isGeoBlockedError(rawBody)) {
    return wrap(`Antigravity upstream error (${status})${suffix}. ${GEO_BLOCKED_HINT}`);
  }
  return wrap(`Antigravity upstream error (${status})${suffix}`);
}
