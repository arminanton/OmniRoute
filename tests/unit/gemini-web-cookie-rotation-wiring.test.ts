import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const executorSource = fs.readFileSync("open-sse/executors/gemini-web.ts", "utf8");
const chatCoreSource = fs.readFileSync("open-sse/handlers/chatCore.ts", "utf8");
const accountRouteSource = fs.readFileSync(
  "src/app/api/providers/gemini-web/account-models/route.ts",
  "utf8"
);

test("Gemini cookie rotation callback carries only base and rotated snapshots as metadata", () => {
  assert.match(
    executorSource,
    /GEMINI_WEB_COOKIE_ROTATION_KEY\]: \{ baseCookie: cookie, rotatedCookie: mergedCookie \}/
  );
});

test("chatCore routes Gemini rotation metadata through atomic persistence", () => {
  const persistPipelineRefresh = chatCoreSource.slice(
    chatCoreSource.indexOf("const persistPipelineRefresh ="),
    chatCoreSource.indexOf("// Keep state classification shared", chatCoreSource.indexOf("const persistPipelineRefresh ="))
  );
  assert.match(persistPipelineRefresh, /splitGeminiCookieRotation\(updated\)/);
  assert.match(persistPipelineRefresh, /persistGeminiWebCookieRotation\(/);
  assert.match(persistPipelineRefresh, /credentialUpdate/);
});

test("Gemini account-model capture routes cookie rotation metadata through atomic persistence", () => {
  assert.match(accountRouteSource, /onCredentialsRefreshed:[\s\S]*?persistGeminiWebCookieRotation\(/);
  assert.doesNotMatch(accountRouteSource, /updateProviderConnection/);
});
