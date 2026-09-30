import test from "node:test";
import assert from "node:assert/strict";
import { RuntimePolicyError, isRuntimePolicyError } from "../../src/shared/runtimePolicy.ts";
import {
  createMaxaiTransport,
  createMaxaiTlsClient,
  createMaxaiTlsDispatcher,
} from "../../open-sse/services/maxaiTransport.ts";
import { MaxAiExecutor } from "../../open-sse/executors/maxai.ts";
import { fetchMaxaiConstants } from "../../open-sse/executors/maxai/constants.ts";
import {
  __setMaxaiConstantsForTest,
  refreshMaxaiConstants,
} from "../../open-sse/executors/maxai/constantsStore.ts";
import {
  maxaiRefreshAccessToken,
  ensureFreshMaxaiCredential,
  __resetMaxaiRefreshStateForTest,
  __maxaiRefreshStateSizeForTest,
  type MaxaiRefreshStore,
} from "../../open-sse/executors/maxai/refresh.ts";
import { uploadMaxaiDocument } from "../../open-sse/executors/maxai/documents.ts";
import {
  requestMaxaiEmailCode,
  verifyMaxaiEmailCode,
} from "../../open-sse/executors/maxai/emailLogin.ts";
import { discoverMaxaiModels } from "../../open-sse/services/maxaiModels.ts";
import { MOCK_CONSTANTS } from "./helpers/maxaiMockConstants.ts";

const endpoint = "https://www.maxai.co/app/";
const token = `mock.${Buffer.from(JSON.stringify({ sub: "mock-user", exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url")}.signature`;
const identity = {
  accessToken: token,
  refreshToken: "synthetic-refresh",
  userId: "mock-user",
  deviceId: "mock-device",
};
const credentials = {
  connectionId: "policy-account-a",
  accessToken: token,
  providerSpecificData: { maxaiDeviceId: identity.deviceId, maxaiUserId: identity.userId },
};
const input = {
  model: "gpt-5.6",
  stream: false,
  credentials,
  body: { messages: [{ role: "user", content: "hello" }] },
};
const denied = () => new RuntimePolicyError("proxy-forbidden");
const sameError = (expected: unknown) => (actual: unknown) =>
  actual === expected && isRuntimePolicyError(actual);
function transport(
  resolve: () => Promise<{ proxyConfig: unknown; blocked: boolean }>,
  tlsFetch: () => Promise<Response>
) {
  return createMaxaiTransport({
    bootNow: () => 1_000,
    resolve,
    profileSupported: () => true,
    verify: async (route) => ({
      ...route,
      kind: "namespace",
      bootId: "boot",
      namespaceId: "namespace",
      generation: "generation",
      expiresAt: Date.now() + 15_000,
      expiresBootMs: 16_000,
    }),
    tlsFetch,
  });
}
function executor(
  fetchImpl: typeof fetch,
  ensureCredential: typeof ensureFreshMaxaiCredential = async ({ credential }) => credential
) {
  return new MaxAiExecutor({ runTransport: async (_id, fn) => fn(), ensureCredential, fetchImpl });
}
test.beforeEach(() => {
  __setMaxaiConstantsForTest(MOCK_CONSTANTS);
  __resetMaxaiRefreshStateForTest();
});

test("MaxAI connection resolver preserves terminal policy identity before proof or native send", async () => {
  const error = denied();
  let sends = 0;
  const t = transport(
    async () => {
      throw error;
    },
    async () => {
      sends++;
      return new Response("unsafe");
    }
  );
  await assert.rejects(
    t.run("account-a", () => t.fetch(endpoint)),
    sameError(error)
  );
  assert.equal(sends, 0);
});

test("MaxAI native admission preserves terminal policy identity without fallback", async () => {
  const error = denied();
  let admissions = 0;
  const t = transport(
    async () => ({ proxyConfig: null, blocked: false }),
    async () => {
      admissions++;
      throw error;
    }
  );
  await assert.rejects(
    t.run("account-a", () => t.fetch(endpoint)),
    sameError(error)
  );
  assert.equal(admissions, 1);
});

test("provider-shaped policy strings cannot forge the private terminal brand", async () => {
  const forged = Object.assign(new Error("OMNI_RUNTIME_POLICY_DENIED"), {
    code: "OMNI_RUNTIME_POLICY_DENIED",
    reason: "proxy-forbidden",
  });
  assert.equal(isRuntimePolicyError(forged), false);
  const t = transport(
    async () => {
      throw forged;
    },
    async () => new Response("unsafe")
  );
  await assert.rejects(
    t.run("account-a", () => t.fetch(endpoint)),
    (error) => !isRuntimePolicyError(error) && error !== forged
  );
});

test("constants extraction and stale-memo fallback cannot swallow policy denial", async () => {
  const error = denied();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    throw error;
  };
  await assert.rejects(fetchMaxaiConstants({ fetchImpl }), sameError(error));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(refreshMaxaiConstants({ fetchImpl }), sameError(error));
  assert.equal(calls, 1);
});

test("refresh wire preserves terminal policy before any signed grant", async () => {
  const error = denied();
  const urls: string[] = [];
  await assert.rejects(
    maxaiRefreshAccessToken({
      ...identity,
      fetchImpl: async (url) => {
        urls.push(String(url));
        throw error;
      },
    }),
    sameError(error)
  );
  assert.equal(urls.length, 1);
  assert.ok(!urls[0].includes("refresh_access_token"));
});

test("refresh storage does not turn policy denial into a retryable storage error", async () => {
  const error = denied();
  let acquisitions = 0,
    sends = 0;
  await assert.rejects(
    ensureFreshMaxaiCredential({
      connectionId: "policy-storage",
      credential: { ...identity, accessToken: "expired" },
      store: {
        read: async () => {
          throw error;
        },
        acquire: async () => {
          acquisitions++;
          return "busy" as const;
        },
        markSent: async () => false,
        commit: async () => false,
        release: async () => {},
      },
      fetchImpl: async () => {
        sends++;
        return new Response("unsafe");
      },
    }),
    sameError(error)
  );
  assert.equal(acquisitions, 0);
  assert.equal(sends, 0);
});

test("document upload preserves policy instead of allowing a later text-only chat", async () => {
  const error = denied();
  let attempts = 0;
  await assert.rejects(
    uploadMaxaiDocument(
      { filename: "a.txt", mimeType: "text/plain", bytes: Buffer.from([97]) },
      identity,
      {
        fetchImpl: async () => {
          attempts++;
          throw error;
        },
      }
    ),
    sameError(error)
  );
  assert.equal(attempts, 1);
});

test("email request and verification preserve the same trusted terminal denial", async () => {
  const error = denied();
  let attempts = 0;
  const fetchImpl: typeof fetch = async () => {
    attempts++;
    throw error;
  };
  const login = {
    email: "fixture@example.com",
    deviceId: "22222222-2222-4222-8222-222222222222",
    clientUserId: "33333333-3333-4333-8333-333333333333",
    fetchImpl,
  };
  await assert.rejects(requestMaxaiEmailCode(login), sameError(error));
  await assert.rejects(verifyMaxaiEmailCode({ ...login, code: "123456" }), sameError(error));
  assert.equal(attempts, 2);
});

test("discovery preserves policy rather than allowing catalog fallback", async () => {
  const error = denied();
  let sends = 0;
  await assert.rejects(
    discoverMaxaiModels(
      {
        ...credentials,
        fetchImpl: async () => {
          sends++;
          return new Response("unsafe");
        },
      },
      {
        runTransport: async () => {
          throw error;
        },
      }
    ),
    sameError(error)
  );
  assert.equal(sends, 0);
});

test("chat executor preserves resolve/credential/send policy denial for terminal routing", async () => {
  const error = denied();
  let sends = 0;
  const failFetch: typeof fetch = async () => {
    sends++;
    throw error;
  };
  await assert.rejects(
    new MaxAiExecutor({
      runTransport: async () => {
        throw error;
      },
      fetchImpl: failFetch,
    }).execute(input),
    sameError(error)
  );
  assert.equal(sends, 0);
  await assert.rejects(
    executor(failFetch, async () => {
      throw error;
    }).execute(input),
    sameError(error)
  );
  assert.equal(sends, 0);
  await assert.rejects(executor(failFetch).execute(input), sameError(error));
  assert.equal(sends, 1);
});

test("chat document denial stops before chat send and preserves the terminal brand", async () => {
  const error = denied();
  const urls: string[] = [];
  await assert.rejects(
    executor(async (url) => {
      urls.push(String(url));
      throw error;
    }).execute({
      ...input,
      body: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read" },
              { type: "input_file", filename: "a.txt", file_data: "data:text/plain;base64,YQ==" },
            ],
          },
        ],
      },
    }),
    sameError(error)
  );
  assert.equal(urls.length, 1);
  assert.ok(urls[0].endsWith("/app/upload_document"));
});

test("tool retry policy denial remains terminal instead of returning the first narration", async () => {
  const error = denied();
  let calls = 0;
  const ex = executor(async () => {
    calls++;
    if (calls === 2) throw error;
    return new Response(
      `data: ${JSON.stringify({ data_key: "text", need_merge: true, text: "Let me call get_weather now." })}\n\ndata: [DONE]\n\n`
    );
  });
  await assert.rejects(
    ex.execute({
      ...input,
      body: {
        ...input.body,
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      },
    }),
    sameError(error)
  );
  assert.equal(calls, 2);
});

test("policy rejection drops only in-memory waiter state and never reopens durable SENT generation", async () => {
  const policyError = denied();
  let sent = false,
    posts = 0,
    commits = 0,
    releases = 0,
    acquires = 0;
  const credential = { ...identity, accessToken: "expired" };
  const store: MaxaiRefreshStore = {
    read: async () => ({ ...credential, credentialVersion: "opaque-snapshot" }),
    acquire: async () => {
      acquires++;
      return sent ? "quarantined" : "acquired";
    },
    markSent: async () => {
      sent = true;
      return true;
    },
    commit: async () => {
      commits++;
      return false;
    },
    release: async () => {
      releases++;
    },
  };
  const fetchImpl: typeof fetch = async (url) => {
    if (String(url).endsWith("/oauth/refresh_access_token")) {
      posts++;
      throw policyError;
    }
    return new Response("No matching public chunks in fixture");
  };
  const args = { connectionId: "sent-policy-account", credential, store, fetchImpl };
  await assert.rejects(ensureFreshMaxaiCredential(args), sameError(policyError));
  assert.equal(__maxaiRefreshStateSizeForTest(), 0);
  assert.equal(sent, true);
  await assert.rejects(
    ensureFreshMaxaiCredential(args),
    (error) =>
      !!error && typeof error === "object" && "code" in error && error.code === "quarantined"
  );
  assert.equal(acquires, 2);
  assert.equal(posts, 1);
  assert.equal(commits, 0);
  assert.equal(releases, 1);
  assert.equal(sent, true);
});

test("actual MaxAI TLS adapter preserves native-factory policy denial with zero native sends", async () => {
  const error = denied();
  let creates = 0;
  const client = createMaxaiTlsClient(async () => {
    creates++;
    throw error;
  });
  const t = createMaxaiTransport({
    bootNow: () => 1_000,
    resolve: async () => ({ proxyConfig: null, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => ({
      ...route,
      kind: "namespace",
      bootId: "boot",
      namespaceId: "namespace",
      generation: "generation",
      expiresAt: Date.now() + 15_000,
      expiresBootMs: 16_000,
    }),
    tlsFetch: createMaxaiTlsDispatcher(client),
  });
  try {
    await assert.rejects(
      t.run("native-policy-account", () => t.fetch(endpoint)),
      sameError(error)
    );
    // Check BEFORE closeAll(), which clears circuits and would hide a penalty.
    const health = client.getCircuitState(
      null,
      "maxai:native-policy-account:boot:namespace:generation"
    );
    assert.equal(health.failureCount, 0);
    assert.equal(health.circuitTripped, false);
    assert.equal(health.coolDownRemainingMs, 0);
    assert.equal(creates, 1);
  } finally {
    await client.closeAll();
  }
});
