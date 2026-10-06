type ConnectionPreferenceSelection<T> = {
  preferredConnections?: readonly string[] | null;
  allowedConnections: string[] | null;
  select: (allowedConnections: string[] | null) => Promise<T | null | undefined>;
};

export async function selectCredentialWithConnectionPreference<T>({
  preferredConnections,
  allowedConnections,
  select,
}: ConnectionPreferenceSelection<T>): Promise<T | null | undefined> {
  const authorized = allowedConnections === null ? null : new Set(allowedConnections);
  const tried = new Set<string>();

  for (const connectionId of (preferredConnections ?? []).slice(0, 100)) {
    if (typeof connectionId !== "string" || !connectionId || tried.has(connectionId)) continue;
    tried.add(connectionId);
    if (authorized && !authorized.has(connectionId)) continue;

    const selected = await select([connectionId]);
    if (selected !== null && selected !== undefined) return selected;
  }

  return select(allowedConnections);
}
