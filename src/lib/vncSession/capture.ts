import { z } from "zod";
import { normalizeChatGptWebStorageState } from "@omniroute/open-sse/utils/chatgptWebExecutorAdapter.ts";
import {
  decodeChatGptWebCodexSecrets,
  encodeChatGptWebCodexSecrets,
} from "@omniroute/open-sse/executors/chatgpt-web-codex/credentials.ts";

export const BROWSER_LOGIN_PROVIDERS = ["gemini-web", "chatgpt-web", "chatgpt-web-codex"] as const;
export type BrowserLoginProvider = (typeof BROWSER_LOGIN_PROVIDERS)[number];

export function isBrowserLoginProvider(value: unknown): value is BrowserLoginProvider {
  return (
    typeof value === "string" && BROWSER_LOGIN_PROVIDERS.some((provider) => provider === value)
  );
}

const cookieSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^;=\s]+$/),
  value: z
    .string()
    .max(256 * 1024)
    .regex(/^[^;\r\n]*$/),
  domain: z.string().min(1).max(253),
  path: z.string().startsWith("/").max(4096),
  expires: z.number().finite(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
  partitionKey: z.string().optional(),
});
const stateSchema = z.object({
  cookies: z.array(cookieSchema).max(1000),
  origins: z
    .array(
      z.object({
        origin: z.string().url(),
        localStorage: z
          .array(z.object({ name: z.string().max(4096), value: z.string().max(1024 * 1024) }))
          .max(1000),
      })
    )
    .max(20),
});

/** Validate captured first-party state, never claim an upstream verification occurred. */
export function browserLoginCredential(
  provider: BrowserLoginProvider,
  input: unknown,
  oldApiKey?: string
): string {
  if (!BROWSER_LOGIN_PROVIDERS.includes(provider))
    throw new Error("Unsupported browser login provider");
  if (JSON.stringify(input)?.length > 4 * 1024 * 1024)
    throw new Error("Browser capture is too large");
  const state = stateSchema.parse(input);
  const domain = provider === "gemini-web" ? "google.com" : "chatgpt.com";
  const origin = provider === "gemini-web" ? "https://gemini.google.com" : "https://chatgpt.com";
  if (
    state.cookies.some((cookie) => {
      const host = cookie.domain.replace(/^\./, "");
      return host !== domain && !host.endsWith(`.${domain}`);
    }) ||
    state.origins.some((entry) => entry.origin !== origin)
  ) {
    throw new Error("Browser capture contains foreign session data");
  }
  if (provider === "gemini-web") {
    if (!state.cookies.some((cookie) => cookie.name === "__Secure-1PSID" && cookie.value)) {
      throw new Error("Complete Google sign-in before capturing the session");
    }
    return state.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  }
  if (
    !state.cookies.some(
      (cookie) => /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(cookie.name) && cookie.value
    )
  ) {
    throw new Error("Complete ChatGPT sign-in before capturing the session");
  }
  const normalized = normalizeChatGptWebStorageState(state);
  if (provider === "chatgpt-web") return JSON.stringify(normalized);
  let runtimeKey: string | undefined;
  if (oldApiKey) {
    try {
      runtimeKey = decodeChatGptWebCodexSecrets(oldApiKey).runtimeKey;
    } catch {
      throw new Error("Existing ChatGPT credential cannot be preserved safely");
    }
  }
  return encodeChatGptWebCodexSecrets({
    storageState: normalized as unknown as Record<string, unknown>,
    runtimeKey,
  });
}

const SECRET_KEYS = new Set([
  "storageState",
  "cookies",
  "origins",
  "cookie",
  "sessionToken",
  "session-token",
  "__Secure-next-auth.session-token",
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
]);
export function withoutBrowserSessionSecrets(
  data: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !SECRET_KEYS.has(key)));
}

interface CaptureConnection {
  provider?: string;
  apiKey?: string;
  providerSpecificData?: Record<string, unknown>;
}
export interface BrowserCaptureDeps {
  encryptionEnabled(): boolean;
  unavailable(connectionId: string): Promise<boolean>;
  read(connectionId: string): Promise<CaptureConnection | null>;
  update(
    connectionId: string,
    patch: { apiKey: string; providerSpecificData: Record<string, unknown> }
  ): Promise<unknown>;
}
async function defaultDeps(): Promise<BrowserCaptureDeps> {
  const [db, encryption, isolation] = await Promise.all([
    import("@/lib/db/providers"),
    import("@/lib/db/encryption"),
    import("@/lib/exclusiveLeaseIsolation"),
  ]);
  return {
    encryptionEnabled: encryption.isEncryptionEnabled,
    unavailable: isolation.isConnectionUnavailableToAuxiliaryActivity,
    read: db.getProviderConnectionById,
    update: db.updateProviderConnection,
  };
}

/** All secrets go into encrypted apiKey, never plaintext providerSpecificData. */
export async function saveBrowserLoginCapture(
  connectionId: string,
  provider: BrowserLoginProvider,
  storageState: unknown,
  dependencies?: BrowserCaptureDeps
): Promise<{ captured: true; updatedFields: string[] }> {
  const deps = dependencies ?? (await defaultDeps());
  if (!deps.encryptionEnabled())
    throw new Error("Credential encryption is required for browser login");
  if (await deps.unavailable(connectionId))
    throw new Error("Browser login unavailable for this connection");
  const connection = await deps.read(connectionId);
  if (!connection || connection.provider !== provider)
    throw new Error("Provider connection changed during login");
  const apiKey = browserLoginCredential(provider, storageState, connection.apiKey);
  const providerSpecificData = withoutBrowserSessionSecrets(connection.providerSpecificData || {});
  // Recheck after capture normalization before committing any credential.
  if (await deps.unavailable(connectionId))
    throw new Error("Browser login unavailable for this connection");
  await deps.update(connectionId, { apiKey, providerSpecificData });
  return { captured: true, updatedFields: ["apiKey"] };
}
