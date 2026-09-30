import { getComboModelProvider } from "@/lib/combos/steps";
import { getDbInstance } from "../core";

/**
 * Refresh credentials must not escape an assigned proxy, even when proxying is
 * switched off. Unlike the legacy chat guard, count dangling assignments and
 * propagate read/parse failures. No URL, password, or token leaves this helper.
 */
export function getRefreshProxyAssignmentState(connectionId?: string, providerId?: string) {
  const db = getDbInstance();
  const connection = connectionId
    ? (db
        .prepare("SELECT provider, proxy_enabled FROM provider_connections WHERE id = ?")
        .get(connectionId) as { provider?: string; proxy_enabled?: number } | undefined)
    : undefined;
  if (connectionId && !connection) throw new Error("Refresh connection unavailable");
  const provider = connection?.provider || providerId || "";
  const comboIds = new Set<string>();
  if (connectionId && provider) {
    const combos = db.prepare("SELECT id, data FROM combos").all() as {
      id: string;
      data: string;
    }[];
    for (const row of combos) {
      const combo = JSON.parse(row.data) as { models?: unknown[] };
      if (
        Array.isArray(combo.models) &&
        combo.models.some((entry) => getComboModelProvider(entry) === provider)
      ) {
        comboIds.add(row.id);
      }
    }
  }
  type Assignment = { scope: string; scope_id?: string; proxy_id?: string; alive: number };
  const assignments = db
    .prepare(
      `SELECT a.scope, a.scope_id, p.id AS proxy_id,
       CASE WHEN ${PROXY_ALIVE_PREDICATE} THEN 1 ELSE 0 END AS alive
     FROM proxy_assignments a LEFT JOIN proxy_registry p ON p.id = a.proxy_id`
    )
    .all() as Assignment[];
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = 'proxyConfig'")
    .all() as { key: string; value: string }[];
  const legacy = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
  type Selection = {
    level: string;
    levelId: string | null;
    source: "registry" | "legacy";
    entries?: Assignment[];
  };
  const registry = (scope: string, id: string | null): Selection | null => {
    const entries = assignments.filter(
      (row) => row.scope === scope && (scope === "global" || row.scope_id === id)
    );
    return entries.length ? { level: scope, levelId: id, source: "registry", entries } : null;
  };
  const inline = (level: string, levelId: string | null, value: unknown): Selection | null =>
    value != null ? { level, levelId, source: "legacy" } : null;
  // Same precedence as settings.resolveProxyForConnection. Only the selected
  // scope may refresh: a dead account pool must not adopt a different identity
  // from a healthy provider/global pool. Mixed healthy/dead members within the
  // SAME pool still rotate normally through the fresh resolver.
  const selected =
    (connectionId ? registry("account", connectionId) : null) ||
    (connectionId ? inline("key", connectionId, legacy.keys?.[connectionId]) : null) ||
    registry("provider", provider) ||
    [...comboIds]
      .map((id) => registry("combo", id) || inline("combo", id, legacy.combos?.[id]))
      .find(Boolean) ||
    inline("provider", provider, legacy.providers?.[provider]) ||
    registry("global", null) ||
    inline("global", null, legacy.global) ||
    null;
  const enabledRow = db
    .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = 'proxyEnabled'")
    .get() as { value: string } | undefined;
  const disabled =
    connection?.proxy_enabled === 0 || (enabledRow && JSON.parse(enabledRow.value) === false);
  const deadPool = selected?.entries && !selected.entries.some((row) => row.proxy_id && row.alive);
  return {
    assigned: Boolean(selected),
    blocked: Boolean(selected && (disabled || deadPool)),
    level: selected?.level,
    levelId: selected?.levelId,
    source: selected?.source,
  };
}

export const PROXY_ALIVE_PREDICATE =
  "(p.status IS NULL OR LOWER(p.status) NOT IN ('inactive','error','disabled','dead','down'))";

export function isGlobalProxyEnabled(db: ReturnType<typeof getDbInstance>): boolean {
  try {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = 'proxyEnabled'")
      .get() as { value?: string } | undefined;
    if (!row?.value) return true;
    try {
      return JSON.parse(row.value) !== false;
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

/**
 * #6246 fail-closed guard for a connection with an assigned dead proxy pool.
 * Explicitly disabling proxying globally or for the connection allows direct egress.
 */
export function hasBlockingProxyAssignment(connectionId: string, providerId?: string): boolean {
  try {
    const db = getDbInstance();
    if (!isGlobalProxyEnabled(db)) return false;

    const conn = db
      .prepare("SELECT provider, proxy_enabled FROM provider_connections WHERE id = ?")
      .get(connectionId) as { provider?: string | null; proxy_enabled?: number } | undefined;
    if (conn && conn.proxy_enabled === 0) return false;
    const provider = conn?.provider ?? providerId ?? null;
    const dead = db
      .prepare(
        `SELECT 1 FROM proxy_assignments a JOIN proxy_registry p ON p.id = a.proxy_id
           WHERE ((a.scope = 'account' AND a.scope_id = ?)
               OR (a.scope = 'provider' AND a.scope_id = ?)
               OR (a.scope = 'global'))
             AND NOT ${PROXY_ALIVE_PREDICATE}
           LIMIT 1`
      )
      .get(connectionId, provider);
    return !!dead;
  } catch {
    return false;
  }
}

/**
 * #7380 fail-closed guard for providers without a connection row. Returns true
 * when a provider/global proxy assignment exists but all assigned proxies are known dead.
 */
export function hasBlockingProxyAssignmentForProvider(providerId: string): boolean {
  try {
    const db = getDbInstance();
    if (!isGlobalProxyEnabled(db)) return false;

    const assignments = db
      .prepare(
        `SELECT
           EXISTS(
             SELECT 1 FROM proxy_assignments a
             WHERE ((a.scope = 'provider' AND a.scope_id = ?)
                 OR a.scope = 'global')
           ) AS assigned,
           EXISTS(
             SELECT 1 FROM proxy_assignments a JOIN proxy_registry p ON p.id = a.proxy_id
             WHERE ((a.scope = 'provider' AND a.scope_id = ?)
                 OR a.scope = 'global')
               AND ${PROXY_ALIVE_PREDICATE}
           ) AS alive`
      )
      .get(providerId, providerId) as { assigned?: number; alive?: number } | undefined;
    return assignments?.assigned === 1 && assignments.alive === 0;
  } catch {
    return false;
  }
}
