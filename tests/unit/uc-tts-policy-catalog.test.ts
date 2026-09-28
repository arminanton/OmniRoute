import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_SPEECH_PROVIDERS,
  UC_TTS_POLICY_DISABLED,
  getAllAudioModels,
  getSpeechProvider,
} from "../../open-sse/config/audioRegistry.ts";
import {
  getRegistryMediaKinds,
  resolveProviderServiceKinds,
} from "../../open-sse/config/mediaServiceKinds.ts";

test("disabled UC TTS is not advertised as an available voice model or media kind", () => {
  assert.equal(UC_TTS_POLICY_DISABLED, true);
  assert.ok(AUDIO_SPEECH_PROVIDERS.uc, "keep explicit UC speech route for its policy error");
  assert.ok(getSpeechProvider("uc"), "explicit requests must still return the D3 policy error");
  assert.equal(
    getAllAudioModels().some((model) => model.id === "uc/jade"),
    false
  );
  assert.equal(getRegistryMediaKinds("uc").includes("tts"), false);
  const kinds = resolveProviderServiceKinds("uc", ["llm"]);
  assert.ok(kinds.includes("llm"));
  assert.ok(kinds.includes("image"));
  assert.ok(kinds.includes("video"));
  assert.equal(kinds.includes("tts"), false);
});
