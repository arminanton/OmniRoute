const REDACTED = "[REDACTED]";

const SENSITIVE_NAME_FRAGMENTS = [
  "authorization",
  "proxyauthorization",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
  "cookie",
  "signature",
  "session",
];

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveHeaderName(name: string): boolean {
  const normalized = normalizeName(name);
  return (
    normalized === "key" ||
    normalized.endsWith("clientkey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("refreshkey") ||
    normalized.endsWith("privatekey") ||
    SENSITIVE_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  );
}

function isSensitiveCredentialField(name: string): boolean {
  const normalized = normalizeName(name);
  return (
    normalized === "key" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("copilottoken") ||
    normalized.endsWith("authtoken") ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("clientsecret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("sessionid") ||
    normalized.endsWith("sessiontoken") ||
    normalized === "secret"
  );
}

function collectSensitiveCredentialValues(
  value: unknown,
  fieldName = "",
  output: string[] = []
): string[] {
  if (typeof value === "string") {
    if (isSensitiveCredentialField(fieldName) && value.length > 0) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectSensitiveCredentialValues(entry, fieldName, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const [name, child] of Object.entries(value)) {
      collectSensitiveCredentialValues(child, name, output);
    }
  }
  return output;
}

function replaceKnownSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

function redactSensitiveUrl(url: string, secrets: readonly string[]): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = REDACTED;
    if (parsed.password) parsed.password = REDACTED;

    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveHeaderName(key)) parsed.searchParams.set(key, REDACTED);
    }

    if (parsed.hash) parsed.hash = REDACTED;
    return replaceKnownSecrets(parsed.toString(), secrets);
  } catch {
    // Provider URLs are normally absolute. Keep the preview useful if a custom
    // adapter emits a relative URL, while still stripping known credential values.
    return replaceKnownSecrets(url, secrets);
  }
}

function redactHeaderValue(name: string, value: string, secrets: readonly string[]): string {
  if (!isSensitiveHeaderName(name)) return replaceKnownSecrets(value, secrets);

  // Preserve a non-secret authentication scheme (Bearer/Key/Basic) to keep the
  // preview useful without returning the credential itself.
  const authScheme = value.trim().match(/^([A-Za-z][A-Za-z0-9._-]*)\s+\S/);
  if (authScheme && /^(?:bearer|key|basic|token)$/i.test(authScheme[1])) {
    return `${authScheme[1]} ${REDACTED}`;
  }
  return REDACTED;
}

/**
 * Build the safe, display-only portion of the translator's step-4 request preview.
 * The caller must continue using the original URL and headers for any upstream
 * request; these values are only for a response sent back to the UI/CLI.
 */
export function redactProviderRequestPreview(
  url: string,
  headers: Record<string, string>,
  credentials: unknown
): { url: string; headers: Record<string, string> } {
  const secrets = collectSensitiveCredentialValues(credentials).filter(
    (secret, index, all) => secret.length > 0 && all.indexOf(secret) === index
  );

  const safeHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, redactHeaderValue(name, value, secrets)])
  );

  return { url: redactSensitiveUrl(url, secrets), headers: safeHeaders };
}
