import bcrypt from "bcryptjs";
import {
  assertLockedManagementAuthProvisioned,
  requiresLockedManagementAuth,
  RuntimePolicyError,
} from "@/shared/runtimePolicy";

// Keep the provisioning contract available to auth callers without making the
// DB-free settings composition import this password-persistence module.
export { assertLockedManagementAuthProvisioned } from "@/shared/runtimePolicy";

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const MANAGEMENT_PASSWORD_SALT_ROUNDS = 12;

// Well-known placeholder shipped in `.env.example` (INITIAL_PASSWORD=CHANGEME). Bootstrapping
// with it leaves the dashboard open to anyone, so we warn loudly on boot (Seg2 hardening).
const INSECURE_DEFAULT_PASSWORDS = new Set(["CHANGEME"]);

type JsonRecord = Record<string, unknown>;

type MigrationSource = "stored_hash" | "stored_plaintext" | "env" | "missing";

interface EnsureManagementPasswordOptions {
  initialPassword?: string | null;
  logger?: Pick<Console, "log"> & Partial<Pick<Console, "warn">>;
  settings?: JsonRecord;
  source?: string;
}

export interface EnsuredManagementPassword {
  hash: string | null;
  migrated: boolean;
  settings: JsonRecord;
  source: MigrationSource;
}

function getInitialPasswordValue(value: string | null | undefined) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getStoredManagementPassword(settings: JsonRecord | null | undefined) {
  return typeof settings?.password === "string" ? settings.password : "";
}

export function hasManagementPasswordConfigured(settings: JsonRecord | null | undefined) {
  return (
    getStoredManagementPassword(settings).length > 0 ||
    getInitialPasswordValue(process.env.INITIAL_PASSWORD) !== null
  );
}

export function isBcryptHash(value: unknown): value is string {
  return typeof value === "string" && BCRYPT_HASH_PATTERN.test(value);
}

export async function hashManagementPassword(password: string) {
  // Validate the raw replacement itself before hashing can hide a placeholder.
  // Existing passwords, OIDC and INITIAL_PASSWORD must not supply a fallback.
  assertLockedManagementAuthProvisioned({ password });
  return bcrypt.hash(password, MANAGEMENT_PASSWORD_SALT_ROUNDS);
}

export async function verifyManagementPassword(password: string, hash: string) {
  if (!isBcryptHash(hash)) return false;
  return bcrypt.compare(password, hash);
}

export async function ensurePersistentManagementPasswordHash(
  options: EnsureManagementPasswordOptions = {}
): Promise<EnsuredManagementPassword> {
  const settings =
    options.settings ?? ((await (await import("@/lib/db/settings")).getSettings()) as JsonRecord);
  const storedPassword = getStoredManagementPassword(settings);

  if (isBcryptHash(storedPassword)) {
    const lockedManagementAuth = requiresLockedManagementAuth();
    if (lockedManagementAuth) {
      // Only the exact shipped placeholder is checked. A bcrypt-shaped value
      // is not proof of password strength; other legacy credentials need review.
      for (const placeholder of INSECURE_DEFAULT_PASSWORDS) {
        if (await bcrypt.compare(placeholder, storedPassword)) {
          throw new RuntimePolicyError("management-auth-required");
        }
      }
    }
    let nextSettings = settings;
    if (settings.requireLogin === false && lockedManagementAuth) {
      const { updateSettings } = await import("@/lib/db/settings");
      nextSettings = (await updateSettings({ requireLogin: true })) as JsonRecord;
    }
    return {
      hash: storedPassword,
      migrated: false,
      settings: nextSettings,
      source: "stored_hash",
    };
  }

  const bootstrapPassword =
    storedPassword ||
    getInitialPasswordValue(options.initialPassword ?? process.env.INITIAL_PASSWORD);

  if (bootstrapPassword && INSECURE_DEFAULT_PASSWORDS.has(bootstrapPassword)) {
    const warn = options.logger?.warn?.bind(options.logger) ?? console.warn;
    warn(
      '[AUTH][SECURITY] Management password is set to the well-known default "CHANGEME" ' +
        "(INITIAL_PASSWORD in .env.example). Anyone can sign in to the dashboard with it — " +
        "change it immediately via the dashboard or a strong INITIAL_PASSWORD."
    );
  }

  if (!bootstrapPassword) {
    return {
      hash: null,
      migrated: false,
      settings,
      source: "missing",
    };
  }

  const passwordHash = await hashManagementPassword(bootstrapPassword);
  const updates: JsonRecord = { password: passwordHash };

  if (settings.setupComplete !== true) {
    updates.setupComplete = true;
  }
  // Locked provisioning cannot retain a mutable auth bypass while migrating
  // legacy plaintext. Submit the normalized candidate to ordinary admission.
  if (!storedPassword || requiresLockedManagementAuth()) {
    updates.requireLogin = true;
  }

  const { updateSettings } = await import("@/lib/db/settings");
  const nextSettings = (await updateSettings(updates)) as JsonRecord;
  if (options.logger) {
    const context = options.source ? ` during ${options.source}` : "";
    const migrationSource = storedPassword ? "stored plaintext password" : "INITIAL_PASSWORD";
    options.logger.log(`[AUTH] Migrated ${migrationSource} to bcrypt hash${context}`);
  }

  return {
    hash: getStoredManagementPassword(nextSettings) || passwordHash,
    migrated: true,
    settings: nextSettings,
    source: storedPassword ? "stored_plaintext" : "env",
  };
}
