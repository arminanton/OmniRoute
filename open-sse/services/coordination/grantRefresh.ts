import { createHash } from "node:crypto";
import { runFencedTask, getFencedTaskContext } from "./fencedTask.ts";

const NAMESPACE = "coordinatedGrantRotations/v1";
/** Exact native grant+client realm only; never joins email identities or subscription quotas. */
export async function runCoordinatedGrantRefresh<T>(
  realm: string,
  grant: string,
  operation: (currentGrant: string) => Promise<T>,
  depth = 0
): Promise<T> {
  if (process.env.OMNI_SHARED_ADMISSION !== "true") return operation(grant);
  if (depth >= 32) throw new Error("Credential rotation chain requires reconciliation");
  if (typeof grant !== "string" || !grant) throw new Error("Shared grant identity is required");
  const key = createHash("sha256")
    .update(JSON.stringify([realm, grant]))
    .digest("hex");
  const { getDbInstance } = await import("@/lib/db/core");
  const { encrypt, decrypt } = await import("@/lib/db/encryption");
  const db = getDbInstance();
  if (db.driver === "sql.js")
    throw new Error("Shared credential rotations require durable native SQLite");
  // Refuse BEFORE consuming a grant if the configured storage would expose credentials.
  if (!encrypt("coordination-encryption-probe")?.startsWith("enc:v1:"))
    throw new Error("Shared rotations require storage encryption");
  return runFencedTask(`grant:${key}`, async ({ assertOwner }) => {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace=? AND key=?")
      .get(NAMESPACE, key) as { value: string } | undefined;
    if (row) {
      const cached = JSON.parse(decrypt(row.value, { quiet: true }) ?? "null") as {
        expiresAt: number;
        result: T;
      } | null;
      if (cached && cached.expiresAt > Date.now()) return cached.result;
      const next = (cached?.result as Record<string, unknown> | undefined)?.refreshToken;
      // A consumed grant is never presented again: follow its encrypted successor.
      if (typeof next === "string" && next !== grant) {
        const result = await runCoordinatedGrantRefresh(realm, next, operation, depth + 1);
        assertOwner();
        db.prepare("UPDATE key_value SET value=? WHERE namespace=? AND key=?").run(
          encrypt(JSON.stringify({ expiresAt: Date.now() + 60000, result })),
          NAMESPACE,
          key
        );
        return result;
      }
    }
    const result = await operation(grant);
    assertOwner();
    const value = result as Record<string, unknown> | null;
    if (
      value &&
      !value.error &&
      (typeof value.accessToken === "string" || typeof value.token === "string")
    ) {
      const portable = Object.fromEntries(
        Object.entries(value).filter(([field]) =>
          [
            "accessToken",
            "refreshToken",
            "expiresIn",
            "expiresAt",
            "idToken",
            "token",
            "endpoint",
          ].includes(field)
        )
      );
      const encrypted = encrypt(
        JSON.stringify({ expiresAt: Date.now() + 60000, result: portable })
      );
      db.prepare(
        "INSERT INTO key_value(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value"
      ).run(NAMESPACE, key, encrypted);
    }
    return result;
  });
}
export function assertRefreshOwner(): void {
  getFencedTaskContext()?.assertOwner();
}

export async function isCoordinatedRotationStoreReady(): Promise<boolean> {
  try {
    const [{ getDbInstance }, { encrypt }] = await Promise.all([
      import("@/lib/db/core"),
      import("@/lib/db/encryption"),
    ]);
    return (
      getDbInstance().driver !== "sql.js" &&
      encrypt("coordination-readiness")?.startsWith("enc:v1:") === true
    );
  } catch {
    return false;
  }
}
