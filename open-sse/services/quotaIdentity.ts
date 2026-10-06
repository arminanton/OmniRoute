import { createHash } from "node:crypto";

const value = (input: unknown): string | null =>
  typeof input === "string" && input.trim() ? input.trim() : null;

/** No JWT decoding or email matching: grouping is operator-declared or authenticated metadata. */
export function resolveQuotaIdentity(
  provider: string,
  connectionId: string | null | undefined,
  credentials: Record<string, unknown> | null | undefined
): string | null {
  const data = (credentials?.providerSpecificData ?? {}) as Record<string, unknown>;
  const group = value(data.quotaGroup);
  const realm = value(data.quotaRealm) ?? provider;
  const partition = value(data.quotaPartition) ?? "account";
  // accountId by itself does not establish whether API, subscription or project quotas coincide.
  const verified = data.quotaIdentityVerified === true;
  const account = verified ? value(data.quotaAccountId) : null;
  const fallback =
    value(connectionId) ?? value(credentials?.connectionId) ?? value(credentials?.id);
  if (!group && !account) return fallback ? `${provider}:${fallback}` : null;
  const tuple = [
    realm,
    group ?? account,
    value(data.quotaTenantId),
    value(data.quotaProjectId),
    partition,
  ];
  return `quota:v1:${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}
