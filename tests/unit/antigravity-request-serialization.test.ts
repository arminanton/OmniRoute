import assert from "node:assert/strict";
import test from "node:test";

import { serializeAntigravityRequest } from "../../open-sse/executors/antigravity/executeAttempt.ts";
import {
  getCliCompatProviders,
  setCliCompatProviders,
} from "../../open-sse/config/cliFingerprints.ts";

const originalCliCompatProviders = getCliCompatProviders();
const originalCliCompatAll = process.env.CLI_COMPAT_ALL;
const originalAntigravityCliCompat = process.env.CLI_COMPAT_ANTIGRAVITY;

function disableAntigravityCliCompat(): void {
  setCliCompatProviders([]);
  delete process.env.CLI_COMPAT_ALL;
  delete process.env.CLI_COMPAT_ANTIGRAVITY;
}

test.after(() => {
  setCliCompatProviders(originalCliCompatProviders);
  if (originalCliCompatAll === undefined) delete process.env.CLI_COMPAT_ALL;
  else process.env.CLI_COMPAT_ALL = originalCliCompatAll;
  if (originalAntigravityCliCompat === undefined) delete process.env.CLI_COMPAT_ANTIGRAVITY;
  else process.env.CLI_COMPAT_ANTIGRAVITY = originalAntigravityCliCompat;
});

function createRequestBody(): Record<string, unknown> {
  return {
    model: "gemini-3.1-pro",
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: "Review this nested request without changing its wire representation." }],
        },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "read_file",
                args: { path: "/workspace/src/index.ts", options: { lineStart: 20 } },
              },
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_file",
              parameters: { type: "OBJECT", properties: { path: { type: "STRING" } } },
            },
          ],
        },
      ],
    },
    project: "projects/synthetic-project",
    requestId: "synthetic-request-id",
    userAgent: "antigravity",
    requestType: "agent",
    enabledCreditTypes: ["GOOGLE_ONE_AI"],
  };
}

function attachToolNameMap(
  body: Record<string, unknown>,
  toolNameMap: Map<string, string>,
  enumerable: boolean
): void {
  Object.defineProperty(body, "_toolNameMap", {
    value: toolNameMap,
    configurable: true,
    enumerable,
    writable: true,
  });
}

test("non-CLI serialization keeps the nested wire JSON and omits a non-enumerable tool map", () => {
  disableAntigravityCliCompat();
  const body = createRequestBody();
  const toolNameMap = new Map([["proxy_read_file", "read_file"]]);
  attachToolNameMap(body, toolNameMap, false);
  const originalBody = structuredClone(body);
  const expectedBodyString = JSON.stringify(body);
  const originalStructuredClone = globalThis.structuredClone;

  // The ordinary path must not allocate a deep clone before JSON serialization.
  globalThis.structuredClone = (() => {
    throw new Error("non-CLI serialization should not structuredClone the request");
  }) as typeof structuredClone;
  let serialized: ReturnType<typeof serializeAntigravityRequest>;
  try {
    serialized = serializeAntigravityRequest(
      "antigravity",
      { "Content-Type": "application/json" },
      body
    );
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }

  assert.equal(serialized.bodyString, expectedBodyString);
  assert.deepEqual(JSON.parse(serialized.bodyString), JSON.parse(expectedBodyString));
  assert.deepEqual(body, originalBody);
  assert.strictEqual(body._toolNameMap, toolNameMap);
  assert.deepEqual([...toolNameMap], [["proxy_read_file", "read_file"]]);
  assert.equal(Object.hasOwn(JSON.parse(serialized.bodyString), "_toolNameMap"), false);
});

test("non-CLI serialization strips an enumerable root tool map without mutating it", () => {
  disableAntigravityCliCompat();
  const body = createRequestBody();
  const toolNameMap = new Map([["proxy_read_file", "read_file"]]);
  attachToolNameMap(body, toolNameMap, true);
  const originalBody = structuredClone(body);
  const expectedBody = structuredClone(body);
  delete expectedBody._toolNameMap;

  const serialized = serializeAntigravityRequest("antigravity", {}, body);

  assert.deepEqual(JSON.parse(serialized.bodyString), expectedBody);
  assert.deepEqual(body, originalBody);
  assert.strictEqual(body._toolNameMap, toolNameMap);
  assert.deepEqual([...toolNameMap], [["proxy_read_file", "read_file"]]);
});

test("CLI compatibility keeps fingerprint ordering and strips the tool map from its clone", () => {
  setCliCompatProviders(["antigravity"]);
  const body = createRequestBody();
  const toolNameMap = new Map([["proxy_read_file", "read_file"]]);
  attachToolNameMap(body, toolNameMap, true);
  const originalBody = structuredClone(body);
  const expectedBody = structuredClone(body);
  delete expectedBody._toolNameMap;
  const headers = {
    "User-Agent": "custom-agent",
    Authorization: "Bearer synthetic-token",
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Extra": "preserved",
  };

  const serialized = serializeAntigravityRequest("antigravity", headers, body);
  const wireBody = JSON.parse(serialized.bodyString);

  assert.deepEqual(wireBody, expectedBody);
  assert.deepEqual(Object.keys(wireBody).slice(0, 7), [
    "project",
    "requestId",
    "request",
    "model",
    "userAgent",
    "requestType",
    "enabledCreditTypes",
  ]);
  assert.deepEqual(Object.keys(serialized.headers).slice(0, 4), [
    "Accept",
    "Authorization",
    "Content-Type",
    "User-Agent",
  ]);
  assert.deepEqual(body, originalBody);
  assert.strictEqual(body._toolNameMap, toolNameMap);
  assert.deepEqual([...toolNameMap], [["proxy_read_file", "read_file"]]);
});
