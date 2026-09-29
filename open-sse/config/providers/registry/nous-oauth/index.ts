import type { RegistryEntry } from "../../shared.ts";
import { nous_researchProvider } from "../nous-research/index.ts";
import { NOUS_OAUTH_INFERENCE_BASE_URLS } from "../../../nousOAuth.ts";

/** Device OAuth and API-key connections must never share a provider/alias. */
export const nous_oauthProvider: RegistryEntry = {
  id: "nous-oauth",
  alias: "nso",
  format: "openai",
  executor: "nous-oauth",
  baseUrl: `${NOUS_OAUTH_INFERENCE_BASE_URLS[0]}/chat/completions`,
  authType: "oauth",
  authHeader: "bearer",
  passthroughModels: true,
  models: nous_researchProvider.models,
};
