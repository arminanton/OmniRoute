import { getUserDatabaseSettings } from "@/lib/db/databaseSettings";
import { CATALOG_CACHE_TTL_MS_DEFAULT, type CatalogPayload } from "./catalogCache";

/** Serialize a completed build without loading synchronous DB-health diagnostics. */
export async function serializeCatalogPayload(built: Response): Promise<CatalogPayload> {
  const body = await built.text();
  const headers: Record<string, string> = {};
  built.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let cacheTTL = CATALOG_CACHE_TTL_MS_DEFAULT;
  try {
    cacheTTL = getUserDatabaseSettings().cache?.modelCatalogCacheTtlMs ?? cacheTTL;
  } catch {
    // Billing/catalog metadata remains discoverable during optional settings failure.
  }
  return { body, headers, status: built.status, cacheTTL };
}
