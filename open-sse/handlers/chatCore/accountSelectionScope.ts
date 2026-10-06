/** Routing-layer constraints are internal dispatch inputs, never taken from request bodies. */
export interface AccountSelectionScope {
  pinnedConnectionId?: string | null;
  allowedConnectionIds?: readonly string[] | null;
}
export function resolveAccountSelectionScope(
  explicit: AccountSelectionScope | null,
  apiKeyAllowed: readonly string[] | null | undefined
): AccountSelectionScope {
  if (explicit) return explicit;
  // API-key empty lists mean unrestricted; explicit intersection [] means no eligible account.
  return { allowedConnectionIds: apiKeyAllowed?.length ? apiKeyAllowed : null };
}
