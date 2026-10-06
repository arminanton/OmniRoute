import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ag-project-scope-"));
process.env.DATA_DIR = directory;
process.env.NODE_ENV = "test";
const project = await import("../../open-sse/services/antigravityRequestProject.ts");
const identity = await import("../../open-sse/services/antigravityIdentity.ts");
const signatures = await import("../../open-sse/services/geminiThoughtSignatureStore.ts");
const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.ts");
const { clearAntigravityProjectCache, ANTIGRAVITY_REQUIRES_MANUAL_PROJECT } =
  await import("../../open-sse/services/antigravityProjectBootstrap.ts");
const { seedAntigravityIdeVersionCache } =
  await import("../../open-sse/services/antigravityVersion.ts");
const model = "gemini-3.1-pro";
const originalFetch = globalThis.fetch;
const originalOverride = process.env.OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE;
const credentials = {
  connectionId: "synthetic-account",
  accessToken: "synthetic-access",
  projectId: "stored-project",
  providerSpecificData: { projectId: "stored-project" },
};
test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalOverride === undefined) delete process.env.OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE;
  else process.env.OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE = originalOverride;
  fs.rmSync(directory, { force: true, recursive: true });
});
async function scoped(body: Record<string, unknown>, input = credentials) {
  const local = await project.withResolvedAntigravityProject(input, body);
  assert.ok(!(local instanceof Response));
  return identity.withAntigravityConversationIdentity(
    "antigravity",
    local,
    "principal",
    "conversation",
    model
  );
}
async function transform(local: typeof credentials, body: Record<string, unknown>) {
  seedAntigravityIdeVersionCache("2.1.1");
  const result = await new AntigravityExecutor().transformRequest(
    model,
    { request: { contents: [] }, ...body },
    true,
    local
  );
  assert.ok(!(result instanceof Response));
  return result;
}
test("stored project wins by default, cloning account metadata and avoiding all discovery", async () => {
  delete process.env.OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE;
  globalThis.fetch = async () => {
    throw new Error("unexpected native request");
  };
  const local = await scoped({ project: "client-project" });
  assert.notEqual(local, credentials);
  assert.equal(local.projectId, "stored-project");
  assert.equal((await transform(local, { project: "client-project" })).project, "stored-project");
  assert.equal(credentials.projectId, "stored-project");
});
test("opt-in override scopes cache to actual outbound project without persisting override", async () => {
  process.env.OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE = "1";
  const [a, b] = await Promise.all([
    scoped({ project: "project-a" }),
    scoped({ project: "project-b" }),
  ]);
  assert.notEqual(a._signatureNamespace, b._signatureNamespace);
  assert.equal(a._antigravitySessionId, b._antigravitySessionId);
  const keyA = signatures.buildGeminiThoughtSignatureKey(a._signatureNamespace, "call-identical");
  const keyB = signatures.buildGeminiThoughtSignatureKey(b._signatureNamespace, "call-identical");
  signatures.storeGeminiThoughtSignature(keyA, "synthetic-signature-a");
  assert.equal(signatures.resolveGeminiThoughtSignature(keyA), "synthetic-signature-a");
  assert.equal(signatures.resolveGeminiThoughtSignature(keyB), null);
  const [envelopeA, envelopeB] = await Promise.all([transform(a, {}), transform(b, {})]);
  assert.equal(envelopeA.project, "project-a");
  assert.equal(envelopeB.project, "project-b");
  assert.equal(credentials.providerSpecificData.projectId, "stored-project");
});
test("first native discovery scopes signatures before translation, with no second bootstrap", async () => {
  clearAntigravityProjectCache();
  let reads = 0;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /:loadCodeAssist$/);
    assert.ok(init?.signal);
    reads++;
    return Response.json({ cloudaicompanionProject: "actual-discovered-project" });
  };
  const input = {
    ...credentials,
    connectionId: undefined,
    accessToken: "fresh-synthetic-token",
    projectId: undefined,
    providerSpecificData: {},
  };
  const resolved = await project.withResolvedAntigravityProject(
    input,
    {},
    new AbortController().signal
  );
  assert.ok(!(resolved instanceof Response));
  const a = identity.withAntigravityConversationIdentity(
    "antigravity",
    { ...resolved, connectionId: credentials.connectionId },
    "principal",
    "conversation",
    model
  );
  const expected = identity.withAntigravityConversationIdentity(
    "antigravity",
    { ...input, connectionId: credentials.connectionId, projectId: "actual-discovered-project" },
    "principal",
    "conversation",
    model
  );
  assert.equal(a._signatureNamespace, expected._signatureNamespace);
  assert.equal((await transform(a as typeof credentials, {})).project, "actual-discovered-project");
  assert.equal(reads, 1);
  assert.equal(input.projectId, undefined);
});
test("only evidenced sentinel is rejected; native opaque project identifiers survive", async () => {
  assert.equal(project.normalizeAntigravityProjectId(ANTIGRAVITY_REQUIRES_MANUAL_PROJECT), null);
  assert.equal(
    project.normalizeAntigravityProjectId(" projects/arbitrary.non-guessed-ID "),
    "projects/arbitrary.non-guessed-ID"
  );
  assert.equal(
    project.selectAntigravityProjectId(
      {
        projectId: ANTIGRAVITY_REQUIRES_MANUAL_PROJECT,
        providerSpecificData: { projectId: "valid-project" },
      },
      {}
    ),
    "valid-project"
  );
  const failed = await project.withResolvedAntigravityProject(
    { projectId: ANTIGRAVITY_REQUIRES_MANUAL_PROJECT },
    {}
  );
  assert.ok(failed instanceof Response);
  assert.equal(failed.status, 422);
  assert.equal((await failed.json()).error.code, "missing_project_id");
});
test("Core resolves native project before signature namespace and translator setup", () => {
  const source = fs.readFileSync("open-sse/handlers/chatCore.ts", "utf8");
  const resolution = source.indexOf(
    "const projectCredentials = await withResolvedAntigravityProject("
  );
  assert.ok(resolution > 0);
  assert.ok(resolution < source.indexOf("credentials = withAntigravityConversationIdentity("));
  assert.ok(resolution < source.indexOf("credentials = withProviderSignatureScope("));
  assert.ok(
    source.indexOf("assertManagedLeaseFence(getCurrentConnectionId());", resolution - 100) <
      resolution
  );
});

test("proper client native signatures remain intact when the request project is resolved", async () => {
  const local = await scoped({ project: "project-client-native" });
  const native = `R${Buffer.from([0x12, 0x02, 0x0a, 0x00]).toString("base64")}`;
  const result = await new AntigravityExecutor().transformRequest(
    model,
    {
      request: {
        contents: [
          {
            role: "model",
            parts: [{ functionCall: { name: "tool", args: {} }, thoughtSignature: native }],
          },
        ],
      },
    },
    true,
    local
  );
  assert.ok(!(result instanceof Response));
  assert.ok(JSON.stringify(result.request).includes(native));
});
