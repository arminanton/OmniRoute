import type { RegistryEntry } from "../../shared.ts";
import { MAXAI_REGISTRY_MODELS } from "../../../../executors/maxai/catalog.ts";

/**
 * MaxAI — the MaxAI web app (chat.maxai.co / api.maxai.me) as an OpenAI-compatible
 * provider. A signed web-app port (like zai-web): each request carries a
 * per-request `X-Authorization` signature + a Bearer access token minted by the
 * email login or manual credential import. Network routing follows the operator's connection
 * configuration; provider-scoped TLS impersonation uses a Firefox-150 profile.
 *
 * authType `apikey`/authHeader `bearer`: the OpenAI-style access token is stored
 * on the connection and replayed as `Authorization: Bearer`; the device id +
 * user id ride in providerSpecificData and are folded into the signature. The
 * executor attempts the signed `/oauth` refresh path when the access token nears
 * expiry and otherwise prompts reauthentication on auth rejection.
 */
export const maxaiProvider: RegistryEntry = {
  id: "maxai",
  alias: "mx",
  format: "openai",
  executor: "maxai",
  baseUrl: "https://api.maxai.me",
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 128000,
  models: MAXAI_REGISTRY_MODELS,
};
