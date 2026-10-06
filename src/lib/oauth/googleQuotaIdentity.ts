/** Conservative CodeAssist account/project admission identity, never an entitlement claim. */
export const GOOGLE_QUOTA_IDENTITY_SCHEMA = "omni-google-codeassist-identity/v1";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const bounded = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ? value
    : null;

/** Call only with an authenticated successful userinfo body and a successful server discovery project. */
export function verifiedGoogleQuotaFields(userInfo: unknown, serverProject: unknown) {
  const subject = bounded(record(userInfo).id, 128);
  const project = bounded(serverProject, 256);
  if (!subject || !project) return {};
  return {
    quotaIdentityVerified: true,
    quotaAccountId: subject,
    quotaRealm: "google-antigravity-codeassist",
    quotaProjectId: project,
    quotaPartition: "account-project",
    quotaIdentityProvenance: {
      schema: GOOGLE_QUOTA_IDENTITY_SCHEMA,
      subjectSource: "google-oauth2-v1-userinfo",
      projectSource: "cloudcode-load-or-onboard",
    },
  };
}

/** Preserve operator grouping; do not retain automatic proof when a replacement login lacks it. */
export function mergeGoogleQuotaFields(existing: unknown, incoming: unknown) {
  const previous = record(existing),
    next = record(incoming);
  const merged = { ...previous, ...next };
  if (
    record(previous.quotaIdentityProvenance).schema === GOOGLE_QUOTA_IDENTITY_SCHEMA &&
    record(next.quotaIdentityProvenance).schema !== GOOGLE_QUOTA_IDENTITY_SCHEMA
  ) {
    for (const field of [
      "quotaIdentityVerified",
      "quotaAccountId",
      "quotaProjectId",
      "quotaIdentityProvenance",
    ])
      delete merged[field];
  }
  for (const field of ["quotaGroup", "quotaRealm", "quotaPartition", "quotaTenantId"])
    if (Object.hasOwn(previous, field)) merged[field] = previous[field];
  return merged;
}
