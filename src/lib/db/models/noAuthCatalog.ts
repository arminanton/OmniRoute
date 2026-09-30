import { z } from "zod";
import { usesNoAuthLiveCatalog } from "@/lib/providers/noAuthCatalogPolicy";
import { getDbInstance } from "../core";
import { normalizeSyncedAvailableModels, type SyncedAvailableModel } from "./synced";
import { finishModelCatalogWriteWithoutBackup } from "./modelCatalogWriteSignals";
import { getKeyValue } from "./shared";

const modelsSchema = z.array(z.object({ id: z.string().trim().min(1) }).passthrough());
const snapshotSchema = z.object({ models: modelsSchema, fetchedAt: z.string().datetime() });
export interface NoAuthModelCatalog {
  models: SyncedAvailableModel[];
  fetchedAt: string;
}

function parseSnapshot(value: string | null, providerId: string): NoAuthModelCatalog | null {
  if (!value || !usesNoAuthLiveCatalog(providerId)) return null;
  try {
    const snapshot = snapshotSchema.parse(JSON.parse(value));
    return { ...snapshot, models: normalizeSyncedAvailableModels(snapshot.models, providerId) };
  } catch {
    return null;
  }
}

/** null means no successful discovery; an empty models array is authoritative. */
export async function readNoAuthModelCatalog(
  providerId: string
): Promise<NoAuthModelCatalog | null> {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'noAuthModelCatalog' AND key = ?")
    .get(providerId);
  return parseSnapshot(getKeyValue(row).value, providerId);
}

export async function getAllNoAuthModelCatalogs(): Promise<Record<string, NoAuthModelCatalog>> {
  const rows = getDbInstance()
    .prepare("SELECT key, value FROM key_value WHERE namespace = 'noAuthModelCatalog'")
    .all();
  const result: Record<string, NoAuthModelCatalog> = {};
  for (const row of rows) {
    const { key, value } = getKeyValue(row);
    if (!key) continue;
    const snapshot = parseSnapshot(value, key);
    if (snapshot) result[key] = snapshot;
  }
  return result;
}

/** Caller must validate upstream success and apply provider eligibility before writing. */
export async function replaceNoAuthModelCatalog(
  providerId: string,
  models: unknown
): Promise<NoAuthModelCatalog> {
  if (!usesNoAuthLiveCatalog(providerId)) throw new Error("Provider has no public live catalog");
  const validated = modelsSchema.parse(models);
  const snapshot = {
    models: normalizeSyncedAvailableModels(validated, providerId),
    fetchedAt: new Date().toISOString(),
  };
  getDbInstance()
    .prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('noAuthModelCatalog', ?, ?)"
    )
    .run(providerId, JSON.stringify(snapshot));
  // This is replaceable discovery cache, not user-owned data. Use the existing
  // no-backup signal to invalidate /v1/models without backing up on every GET.
  finishModelCatalogWriteWithoutBackup();
  return snapshot;
}

export async function deleteNoAuthModelCatalog(providerId: string): Promise<void> {
  const result = getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = 'noAuthModelCatalog' AND key = ?")
    .run(providerId);
  if (result.changes) finishModelCatalogWriteWithoutBackup();
}
