/**
 * MaxAI has no captured nonmutating credential-sensitive account check in this
 * integration. The public catalog is NOT login evidence. Do not replace this
 * result with discovery, refresh, a cookie GET /models, or paid inference.
 * Saved and staged callers receive the same neutral result; neither can borrow
 * credentials or identity from the other. Callers must not persist health.
 */
export interface MaxaiConnectionCheckResult {
  valid: false;
  skipped: true;
  inconclusive: true;
  unverified: true;
  unsupported: true;
  code: "maxai_verification_unavailable";
  error: string;
}

export function checkMaxaiConnection(): MaxaiConnectionCheckResult {
  return {
    valid: false,
    skipped: true,
    inconclusive: true,
    unverified: true,
    unsupported: true,
    code: "maxai_verification_unavailable",
    error: "MaxAI credentials are unverified. Sign in with the MaxAI email flow; the model catalog does not validate a login.",
  };
}
