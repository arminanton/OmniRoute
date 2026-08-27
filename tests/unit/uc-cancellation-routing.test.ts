import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const speechRoute = fs.readFileSync("src/app/api/v1/audio/speech/route.ts", "utf8");
const speechHandler = fs.readFileSync("open-sse/handlers/audioSpeech.ts", "utf8");
const videoRoute = fs.readFileSync("src/app/api/v1/videos/generations/route.ts", "utf8");
const videoHandler = fs.readFileSync("open-sse/handlers/videoGeneration.ts", "utf8");

test("UC media routes and shared handlers preserve the request abort signal", () => {
  assert.match(speechRoute, /handleAudioSpeech\(\{[\s\S]*?signal: request\.signal,[\s\S]*?\}\)/);
  assert.match(speechHandler, /handleUcTextToSpeech\(\{[\s\S]*?signal,[\s\S]*?\}\)/);
  assert.match(videoRoute, /handleVideoGeneration\(\{[\s\S]*?signal: request\.signal,[\s\S]*?\}\)/);
  assert.match(
    videoHandler,
    /handleUcVideoGeneration\(\{ model, provider, body, credentials, log, signal \}\)/
  );
});
