import test from "node:test";
import assert from "node:assert/strict";
import {
  browserLoginCredential,
  saveBrowserLoginCapture,
  type BrowserCaptureDeps,
} from "../../src/lib/vncSession/capture.ts";

const chatState = {
  cookies: [
    {
      name: "__Secure-next-auth.session-token",
      value: "synthetic",
      domain: ".chatgpt.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [
    { origin: "https://chatgpt.com", localStorage: [{ name: "preference", value: "test" }] },
  ],
};
const googleState = {
  cookies: [{ ...chatState.cookies[0], name: "__Secure-1PSID", domain: ".google.com" }],
  origins: [],
};
test("true ChatGPT storageState preserves cookie metadata and first-party localStorage", () => {
  assert.deepEqual(JSON.parse(browserLoginCredential("chatgpt-web", chatState)), chatState);
});
test("Codex capture writes version 2 state and preserves unrelated runtime credential", () => {
  const old = JSON.stringify({ version: 2, cookie: "old-cookie", runtimeKey: "synthetic-runtime" });
  assert.deepEqual(JSON.parse(browserLoginCredential("chatgpt-web-codex", chatState, old)), {
    version: 2,
    storageState: chatState,
    runtimeKey: "synthetic-runtime",
  });
});
test("Gemini capture requires Google auth cookie and emits provider cookie contract", () => {
  assert.equal(browserLoginCredential("gemini-web", googleState), "__Secure-1PSID=synthetic");
  assert.throws(() => browserLoginCredential("gemini-web", { cookies: [], origins: [] }));
});
test("capture rejects foreign domains, origins, partial metadata, and header injection", () => {
  assert.throws(() =>
    browserLoginCredential("chatgpt-web", {
      ...chatState,
      cookies: [{ ...chatState.cookies[0], domain: ".chatgpt.com.evil.test" }],
    })
  );
  assert.throws(() =>
    browserLoginCredential("chatgpt-web", {
      ...chatState,
      origins: [{ origin: "https://evil.test", localStorage: [] }],
    })
  );
  assert.throws(() =>
    browserLoginCredential("chatgpt-web", {
      ...chatState,
      cookies: [{ name: "storageState", value: "not-exported-state" }],
    })
  );
  assert.throws(() =>
    browserLoginCredential("gemini-web", {
      ...googleState,
      cookies: [{ ...googleState.cookies[0], value: "x\r\nHeader: injected" }],
    })
  );
  assert.throws(() => browserLoginCredential("chatgpt-web", { cookies: [], origins: [] }));
});
test("capture writes encrypted field only, strips stale plaintext shadow state and returns no secrets", async () => {
  const patches: unknown[] = [];
  const deps: BrowserCaptureDeps = {
    encryptionEnabled: () => true,
    unavailable: async () => false,
    read: async () => ({
      provider: "chatgpt-web",
      providerSpecificData: { storageState: "stale", cookie: "stale", locale: "en-US" },
    }),
    update: async (_id, patch) => {
      patches.push(patch);
    },
  };
  const result = await saveBrowserLoginCapture("account-a", "chatgpt-web", chatState, deps);
  assert.deepEqual(result, { captured: true, updatedFields: ["apiKey"] });
  assert.deepEqual(patches, [
    { apiKey: JSON.stringify(chatState), providerSpecificData: { locale: "en-US" } },
  ]);
});
test("encryption, account binding and active leases fail closed without credential writes", async () => {
  let writes = 0;
  const deps: BrowserCaptureDeps = {
    encryptionEnabled: () => false,
    unavailable: async () => false,
    read: async () => ({ provider: "chatgpt-web" }),
    update: async () => {
      writes++;
    },
  };
  await assert.rejects(saveBrowserLoginCapture("account-a", "chatgpt-web", chatState, deps));
  deps.encryptionEnabled = () => true;
  await assert.rejects(saveBrowserLoginCapture("account-a", "gemini-web", googleState, deps));
  deps.unavailable = async () => true;
  await assert.rejects(saveBrowserLoginCapture("account-a", "chatgpt-web", chatState, deps));
  assert.equal(writes, 0);
});
