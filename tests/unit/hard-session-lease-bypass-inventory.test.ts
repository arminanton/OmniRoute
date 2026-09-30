import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type InventoryKind = "connection" | "credential" | "executor";
type BypassClass = "A" | "B" | "C";

const EXPECTED: Record<InventoryKind, Record<string, number>> = {
  credential: {
    // Account rotation moved into the managed-aware pipeline. Count both member
    // calls, not only unqualified calls, or the lease inventory misses them.
    "open-sse/handlers/chatCore/providerExecutionPipeline.ts": 2,
    "open-sse/services/imageCombo.ts": 1,
    "open-sse/services/speechCombo.ts": 1,
    "open-sse/services/videoCombo.ts": 2,
    "src/app/api/compression/compare/verify/route.ts": 1,
    "src/app/api/internal/codex-responses-ws/route.ts": 1,
    // PR #11390: rerank listing endpoint probes configured credentials so the
    // dashboard rerank selector only offers providers that can actually serve.
    "src/app/api/memory/rerank-providers/route.ts": 1,
    "src/app/api/search/providers/route.ts": 3,
    "src/app/api/v1/_shared/elevenLabsProxy.ts": 1,
    "src/app/api/v1/audio/speech/route.ts": 1,
    "src/app/api/v1/_shared/videoModelResolution.ts": 1,
    "src/app/api/v1/audio/transcriptions/route.ts": 2,
    "src/app/api/v1/audio/translations/route.ts": 1,
    "src/app/api/v1/classify/route.ts": 1,
    // v3.8.51 #11754: the second resolveImageRouteModel() call (a duplicate
    // of the retirement-check one hoisted before enforceApiKeyPolicy) was
    // removed as dead redundant code, 6->5.
    "src/app/api/v1/images/edits/route.ts": 5,
    "src/app/api/v1/images/generations/route.ts": 3,
    "src/app/api/v1/images/upscale/route.ts": 1,
    "src/app/api/v1/messages/count_tokens/route.ts": 1,
    "src/app/api/v1/moderations/route.ts": 1,
    "src/app/api/v1/music/generations/route.ts": 2,
    "src/app/api/v1/ocr/route.ts": 1,
    "src/app/api/v1/providers/[provider]/embeddings/route.ts": 1,
    "src/app/api/v1/providers/[provider]/images/generations/route.ts": 1,
    "src/app/api/v1/rerank/route.ts": 2,
    "src/app/api/v1/search/route.ts": 2,
    "src/app/api/v1/segment/route.ts": 1,
    "src/app/api/v1/session-leases/route.ts": 1,
    "src/app/api/v1/videos/generations/route.ts": 2,
    "src/app/api/v1/web/fetch/route.ts": 1,
    // #11088/#11271: third site is the synced local-endpoint route — it resolves
    // credentials through getProviderCredentials with the connection allowlist
    // from resolveLocalSyncedEndpointRoute, and handles allRateLimited, so it is
    // fenced the same way as the two pre-existing sites.
    "src/lib/embeddings/service.ts": 3,
    // PR #11390: second site is the generic derived-provider listing fallback —
    // read-only key presence probe used to decide whether a configured chat
    // provider may appear in the memory embedding-source dropdown.
    "src/lib/memory/embedding/index.ts": 2,
    "src/lib/search/executeWebSearch.ts": 2,
    "src/lib/skills/webFetchExecution.ts": 1,
    "src/sse/handlers/chat.ts": 2,
    "src/sse/services/auth.ts": 4,
    "src/sse/services/imageCredentialRetry.ts": 1,
  },
  executor: {
    "open-sse/handlers/chatCore.ts": 3,
    "open-sse/handlers/chatCore/cliproxyModelMapping.ts": 1,
    "open-sse/handlers/chatCore/cliproxyapiCredentials.ts": 1,
    // v3.8.51 #11754: the legacy common ChatGPT Web's synthetic
    // image-edit-continuation ChatGptWebExecutor.execute() call (the sole
    // executor.execute() site in this file) was removed with the provider;
    // no executor site remains here. The clean-room restoration delegates
    // through its adapter and does not reintroduce this bypass call site.
    // Gemini Web's own image handler+file (open-sse/handlers/imageGeneration/providers/geminiWeb.ts)
    // was already retired by #11708 (its .execute() site removed then too).
    "open-sse/handlers/videoGeneration.ts": 1,
    "open-sse/services/compression/eval/executorModelClient.ts": 1,
    "src/lib/compression/judgeModelClient.ts": 1,
    "src/lib/services/quotaAutoPing.ts": 1,
  },
  connection: {
    "open-sse/handlers/autoComboCandidates.ts": 1,
    // Token-refresh CAS and invalid-grant rotation checks add read-only queries.
    "open-sse/handlers/chatCore.ts": 4,
    "open-sse/handlers/cursorCliProxy.ts": 1,
    "open-sse/services/alibabaFreeTier.ts": 1,
    "open-sse/services/alibabaFreeTierQuotaFetcher.ts": 1,
    // Family cooldown persist looks the row up to write PSD, not dispatch.
    "open-sse/services/antigravityFamilyCooldown.ts": 1,
    // v3.8.50 back-merge additions (f95b03d7): combo routing infra and the
    // volcengine-plan binding/auto-sync services query connections the same
    // way as their classified siblings.
    // Dynamic per-target cooldown reads moved out of combo.ts.
    "open-sse/services/combo/executeTargetGates.ts": 1,
    "open-sse/services/combo/providerWildcard.ts": 1,
    // Nous OAuth adds one DB-bound refresh re-read under its SQLite lease.
    "open-sse/services/tokenRefresh.ts": 2,
    "src/lib/providers/volcPlanAutoSyncBackfill.ts": 1,
    "src/lib/providers/volcenginePlanBinding.ts": 1,
    "src/app/(dashboard)/dashboard/tools/agent-bridge/page.tsx": 1,
    "src/app/api/cloud/auth/route.ts": 1,
    "src/app/api/cloud/credentials/update/route.ts": 1,
    "src/app/api/models/route.ts": 1,
    "src/app/api/monitoring/health/route.ts": 1,
    "src/app/api/oauth/[provider]/[action]/route.ts": 6,
    "src/app/api/oauth/codex/import/route.ts": 1,
    "src/app/api/oauth/kiro/api-key/route.ts": 1,
    "src/app/api/oauth/kiro/auto-import/route.ts": 2,
    "src/app/api/oauth/kiro/import/route.ts": 1,
    "src/app/api/oauth/kiro/social-exchange/route.ts": 1,
    "src/app/api/playground/simulate-route/route.ts": 1,
    "src/app/api/provider-nodes/[id]/route.ts": 1,
    "src/app/api/providers/[id]/chatgpt-web-codex-doctor/route.ts": 1,
    // Class C: private MaxAI management login re-reads the canonical row for
    // pending-identity persistence/verification, not chat/account selection.
    // This is not a cross-process one-use, CAS or expiry guarantee.
    "src/app/api/providers/[id]/login/route.ts": 1,
    "src/app/api/providers/[id]/refresh-token/route.ts": 1,
    // Manual Nous refresh re-reads the CAS-persisted row; auxiliary upstream work.
    "src/app/api/providers/[id]/refresh/route.ts": 1,
    "src/app/api/providers/bulk/route.ts": 1,
    "src/app/api/providers/client/route.ts": 1,
    "src/app/api/providers/free-onboarding/route.ts": 2,
    "src/app/api/providers/import/route.ts": 1,
    // Base drift (already present before #11754 boarded, from earlier-merged
    // #11698/#11720 retirement PRs): a third getProviderConnections-family
    // call site landed here without a golden-inventory update at the time.
    "src/app/api/providers/route.ts": 3,
    "src/app/api/providers/test-batch/route.ts": 2,
    "src/app/api/rate-limits/route.ts": 1,
    "src/app/api/services/dario/admin/import-from-omniroute/route.ts": 2,
    "src/app/api/settings/export-json/route.ts": 1,
    "src/app/api/settings/qdrant/embedding-models/route.ts": 1,
    "src/app/api/settings/route.ts": 1,
    "src/app/api/token-health/route.ts": 1,
    "src/app/api/translator/send/route.ts": 1,
    "src/app/api/translator/translate/route.ts": 1,
    "src/app/api/usage/call-logs/route.ts": 1,
    // Read-only management discriminator; RPC dispatch lives in fenced reset-credit services.
    "src/app/api/usage/codex-reset-credit/route.ts": 1,
    "src/app/api/usage/quota/route.ts": 1,
    "src/app/api/usage/utilization/route.ts": 1,
    "src/app/api/v1/vscode/[token]/api/tags/route.ts": 1,
    "src/app/api/v1/vscode/raw/[token]/api/tags/route.ts": 1,
    "src/app/api/v1beta/models/route.ts": 1,
    // Class C: the second read enumerates active rows in awaited locked startup
    // preflight for effective-candidate admission after inventory validation.
    "src/instrumentation-node.ts": 2,
    "src/lib/a2a/skills/providerDiscovery.ts": 1,
    "src/lib/chaos/chaosExecutor.ts": 1,
    "src/lib/cloudAgent/api.ts": 1,
    "src/lib/cloudSync.ts": 1,
    "src/lib/combos/builderOptions.ts": 1,
    "src/lib/copilot/tools.ts": 1,
    "src/lib/credentialHealth/scheduler.ts": 1,
    // Base drift (already present before #11754 boarded, from earlier-merged
    // #11698/#11720 retirement PRs' combined getProviderConnectionById
    // fallback in the three write-path functions): not introduced by this PR.
    "src/lib/db/providers.ts": 3,
    "src/lib/db/readCache.ts": 2,
    "src/lib/freeProviderRankings.ts": 1,
    "src/lib/guardrails/visionBridgeCredentials.ts": 1,
    "src/lib/kimi/tokenRefresh.ts": 1,
    "src/lib/monitoring/providerHealthAutopilot.ts": 1,
    "src/lib/monitoring/providerHealthMatrix.ts": 1,
    "src/lib/oauth/connectionPersistence.ts": 1,
    "src/lib/oauth/services/persistCursorConnection.ts": 1,
    "src/lib/oauth/utils/agyAuthImport.ts": 1,
    "src/lib/oauth/utils/claudeAuthImport.ts": 1,
    "src/lib/oauth/utils/codexAuthImport.ts": 1,
    "src/lib/providerModels/managedModelImport.ts": 1,
    "src/lib/providers/codexConnectionDefaults.ts": 1,
    // Volcano Ark plan connect flow (commit d732cf615): both are connection *persistence*
    // sites, not dispatch. volcenginePlanBinding looks the plan connection up by name to
    // decide update-vs-create during connect (same shape as oauth/connectionPersistence);
    // volcPlanAutoSyncBackfill is a one-shot boot backfill that patches a providerSpecificData
    // flag and issues no upstream call. Neither selects a connection to serve a request, so
    // both stay class C (see CLASSIFICATION below).
    "src/lib/providers/volcPlanAutoSyncBackfill.ts": 1,
    "src/lib/providers/volcenginePlanBinding.ts": 1,
    "src/lib/proxyEgress.ts": 1,
    "src/lib/quota/connectionRecovery.ts": 2,
    "src/lib/sync/bundle.ts": 1,
    // #11495: verify-only sweep queries oauth + cookie connections.
    // Class C: the fifth uncached read replaces a cached terminal-refresh
    // staleness check; missing/changed credentials must not be invalidated.
    "src/lib/tokenHealthCheck.ts": 5,
    "src/lib/tokenHealthCheckCopilot.ts": 1,
    "src/lib/usage/callLogs.ts": 1,
    "src/lib/usage/codexResetCredits.ts": 1,
    "src/lib/usage/comboScoringInspector.ts": 1,
    // Auxiliary upstream Grok reset-credit refresh/RPC checks exclusive-lease isolation.
    "src/lib/usage/grokResetCredits.ts": 1,
    "src/lib/usage/providerLimits.ts": 4,
    "src/lib/usage/resilienceExplain.ts": 1,
    "src/lib/usage/usageStats.ts": 1,
    "src/lib/vncSession/service.ts": 2,
    "src/lib/warmupScheduler.ts": 1,
    "src/shared/services/codexCatalogRevalidation.ts": 2,
    "src/shared/services/modelSyncScheduler.ts": 1,
    "src/sse/handlers/chatHelpers.ts": 1,
    "src/sse/services/auth.ts": 4,
    // Proactive Nous refresh adopts a newer persisted token instead of using a stale bearer.
    "src/sse/services/tokenRefresh.ts": 1,
  },
};

const CLASSIFICATION: Record<InventoryKind, Record<string, BypassClass>> = {
  credential: Object.fromEntries(
    Object.keys(EXPECTED.credential).map((file) => [
      file,
      file === "src/app/api/v1/session-leases/route.ts" ||
      file === "open-sse/handlers/chatCore/providerExecutionPipeline.ts" ||
      file === "src/sse/handlers/chat.ts" ||
      file === "src/sse/services/auth.ts"
        ? "A"
        : "B",
    ])
  ),
  executor: {
    "open-sse/handlers/chatCore.ts": "A",
    "open-sse/handlers/chatCore/cliproxyModelMapping.ts": "A",
    "open-sse/handlers/chatCore/cliproxyapiCredentials.ts": "A",
    "open-sse/handlers/videoGeneration.ts": "B",
    "open-sse/services/compression/eval/executorModelClient.ts": "B",
    "src/lib/compression/judgeModelClient.ts": "B",
    "src/lib/services/quotaAutoPing.ts": "B",
  },
  connection: Object.fromEntries(
    Object.keys(EXPECTED.connection).map((file) => [
      file,
      [
        "open-sse/handlers/autoComboCandidates.ts",
        "open-sse/handlers/chatCore.ts",
        "open-sse/services/alibabaFreeTier.ts",
        "open-sse/services/alibabaFreeTierQuotaFetcher.ts",
        "open-sse/services/combo/executeTargetGates.ts",
        "open-sse/services/combo/providerWildcard.ts",
        "open-sse/services/tokenRefresh.ts",
        "src/app/api/providers/[id]/refresh/route.ts",
        "src/app/api/translator/send/route.ts",
        "src/lib/credentialHealth/scheduler.ts",
        "src/lib/providers/volcPlanAutoSyncBackfill.ts",
        "src/lib/providers/volcenginePlanBinding.ts",
        "src/lib/services/quotaAutoPing.ts",
        "src/lib/usage/codexResetCredits.ts",
        "src/lib/usage/grokResetCredits.ts",
        "src/lib/usage/providerLimits.ts",
        "src/lib/vncSession/service.ts",
        "src/lib/warmupScheduler.ts",
        "src/shared/services/modelSyncScheduler.ts",
        "src/sse/services/auth.ts",
        "src/sse/services/tokenRefresh.ts",
      ].includes(file)
        ? "B"
        : "C",
    ])
  ),
};

function sourceFiles(directory: string): string[] {
  const absolute = path.join(REPO_ROOT, directory);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(?:cjs|js|mjs|ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

function countCalls(): Record<InventoryKind, Record<string, number>> {
  const actual: Record<InventoryKind, Record<string, number>> = {
    connection: {},
    credential: {},
    executor: {},
  };
  for (const file of [...sourceFiles("src"), ...sourceFiles("open-sse"), ...sourceFiles("bin")]) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const increment = (kind: InventoryKind) => {
      // Normalize to forward slashes so the frozen inventory is
      // platform-independent (EXPECTED keys are POSIX-style).
      const key = file.split(path.sep).join("/");
      actual[kind][key] = (actual[kind][key] ?? 0) + 1;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression)) {
          if (
            expression.text === "getProviderCredentials" ||
            expression.text === "getProviderCredentialsWithQuotaPreflight"
          ) {
            increment("credential");
          }
          if (
            expression.text === "getProviderConnectionById" ||
            expression.text === "getProviderConnections"
          ) {
            increment("connection");
          }
        } else if (ts.isPropertyAccessExpression(expression)) {
          // Managed-aware recovery now calls through a connection context member.
          // Include member calls or extraction from chatCore hides live credential
          // selectors from this inventory altogether.
          if (
            expression.name.text === "getProviderCredentials" ||
            expression.name.text === "getProviderCredentialsWithQuotaPreflight"
          ) {
            increment("credential");
          }
          if (
            expression.name.text === "execute" &&
            ts.isIdentifier(expression.expression) &&
            ["executor", "fallbackExecutor", "providerExecutor", "streamExecutor"].includes(
              expression.expression.text
            )
          ) {
            increment("executor");
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return actual;
}

// These Class C additions are pinned to their actual function/block, not a
// whole-file guard-token match that could be satisfied by an unrelated path.
function parsedSource(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

function syntax(node: ts.Node): string {
  return node.getText().replace(/\s+/g, "");
}

function only<T>(nodes: readonly T[], description: string): T {
  assert.equal(nodes.length, 1, description);
  const node = nodes[0];
  assert.ok(node, description);
  return node;
}

function namedFunction(source: ts.SourceFile, name: string) {
  const declaration = only(
    source.statements.filter(ts.isFunctionDeclaration).filter((node) => node.name?.text === name),
    `one top-level function ${name}`
  );
  const body = declaration.body;
  assert.ok(body, `${name} has a body`);
  return { declaration, body };
}

function initializer(block: ts.Block, name: string): ts.Expression {
  const declaration = only(
    block.statements
      .filter(ts.isVariableStatement)
      .flatMap((node) => [...node.declarationList.declarations])
      .filter((node) => syntax(node.name) === name),
    `one direct declaration ${name}`
  );
  assert.ok(declaration.initializer, `${name} has an initializer`);
  return declaration.initializer;
}

function directIf(block: ts.Block, condition: string): ts.IfStatement {
  return only(
    block.statements
      .filter(ts.isIfStatement)
      .filter((node) => syntax(node.expression) === condition),
    `one direct guard ${condition}`
  );
}

function blockBody(node: ts.Node): ts.Block {
  assert.ok(ts.isBlock(node), "expected a bounded block");
  return node;
}

function callExpression(node: ts.Node, callee: string): ts.CallExpression {
  assert.ok(ts.isCallExpression(node), `expected call to ${callee}`);
  assert.equal(syntax(node.expression), callee);
  return node;
}

function awaitedCall(node: ts.Node, callee: string): ts.CallExpression {
  assert.ok(ts.isAwaitExpression(node), `${callee} must be awaited`);
  return callExpression(node.expression, callee);
}

function callsWithin(scope: ts.Node, callee: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && syntax(node.expression) === callee) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return calls;
}

function assertOrdered(...nodes: ts.Node[]): void {
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1];
    const next = nodes[index];
    assert.ok(previous.end <= next.getStart(), "guards/work must stay in the required order");
  }
}

test("hard-lease credential, executor, and connection-query inventory has no unclassified site", () => {
  const actual = countCalls();
  assert.deepEqual(actual, EXPECTED);
  for (const kind of Object.keys(EXPECTED) as InventoryKind[]) {
    assert.deepEqual(Object.keys(CLASSIFICATION[kind]).sort(), Object.keys(EXPECTED[kind]).sort());
    for (const classification of Object.values(CLASSIFICATION[kind])) {
      assert.match(classification, /^[ABC]$/);
    }
  }
});

test("Class C locked startup reads admit every active row before helper startup", () => {
  const file = "src/instrumentation-node.ts";
  assert.equal(CLASSIFICATION.connection[file], "C");
  const source = parsedSource(file);
  const preflight = namedFunction(source, "preflightLockedRuntime").body;
  const lockedGate = directIf(preflight, 'getRuntimePolicy().mode!=="locked"');
  assert.equal(preflight.statements[0], lockedGate);
  assert.equal(syntax(lockedGate.thenStatement), "return;");
  const inventoryCheck = only(
    preflight.statements
      .filter(ts.isExpressionStatement)
      .filter((node) => syntax(node.expression) === "assertRuntimeEntrypointInventory()"),
    "direct startup inventory validation"
  );
  const activeRows = only(
    preflight.statements
      .filter(ts.isForOfStatement)
      .filter((node) => syntax(node.expression) === "awaitgetProviderConnections({isActive:true})"),
    "active-row enumeration inside locked preflight"
  );
  assert.equal(callsWithin(preflight, "getProviderConnections").length, 1);
  assert.equal(syntax(activeRows.initializer), "constconnection");
  assert.deepEqual(blockBody(activeRows.statement).statements.map(syntax), [
    "awaitassertResolvedProviderConnectionEntrypoint(connection);",
  ]);
  assertOrdered(lockedGate, inventoryCheck, activeRows);

  const register = namedFunction(source, "registerNodejs").body;
  // Close the passive readiness latch before the async preflight can yield.
  // All later dynamic imports and helper startup in registerNodejs follow its await.
  assert.deepEqual(register.statements.slice(0, 3).map(syntax), [
    "getRuntimePolicy();",
    "markServerStarting();",
    "awaitpreflightLockedRuntime();",
  ]);
  const preflightCall = only(callsWithin(register, "preflightLockedRuntime"), "one boot preflight");
  for (const startupImport of callsWithin(register, "import")) {
    assertOrdered(preflightCall, startupImport);
  }
  for (const callee of [
    "registerQuotaFetchers",
    "initApiBridgeServer",
    "initCredentialHealthCheck",
  ]) {
    assertOrdered(preflightCall, only(callsWithin(register, callee), `one ${callee} startup`));
  }
});

test("Class C terminal-refresh re-read rejects missing or changed credentials before invalidation", () => {
  const file = "src/lib/tokenHealthCheck.ts";
  assert.equal(CLASSIFICATION.connection[file], "C");
  const check = namedFunction(parsedSource(file), "checkConnection").body;
  assert.equal(syntax(initializer(check, "attemptedRefreshToken")), "conn.refreshToken");
  assert.equal(syntax(initializer(check, "attemptedAccessToken")), "conn.accessToken||null");
  const terminal = blockBody(directIf(check, "isUnrecoverableRefreshError(result)").thenStatement);
  assert.deepEqual(terminal.statements.slice(0, 2).map(syntax), [
    "constcurrentConnection=awaitgetProviderConnectionById(conn.id);",
    "if(!currentConnection)return;",
  ]);
  const read = awaitedCall(initializer(terminal, "currentConnection"), "getProviderConnectionById");
  assert.deepEqual(read.arguments.map(syntax), ["conn.id"]);
  assert.equal(callsWithin(terminal, "getProviderConnectionById").length, 1);
  assert.equal(callsWithin(terminal, "getCachedProviderConnectionById").length, 0);
  const missing = directIf(terminal, "!currentConnection");
  assert.equal(syntax(missing.thenStatement), "return;");
  const changedPair = initializer(terminal, "credentialsChangedSinceSweep");
  assert.equal(
    syntax(changedPair),
    "!!currentConnection&&(currentConnection.refreshToken!==attemptedRefreshToken||" +
      "(currentConnection.accessToken||null)!==attemptedAccessToken)"
  );
  const changed = directIf(terminal, "credentialsChangedSinceSweep");
  const changedBody = blockBody(changed.thenStatement);
  assert.equal(changedBody.statements.length, 3);
  const [healthWrite, warning, earlyReturn] = changedBody.statements;
  assert.ok(ts.isExpressionStatement(healthWrite));
  assert.deepEqual(
    awaitedCall(healthWrite.expression, "updateProviderConnection").arguments.map(syntax),
    ["conn.id", "{lastHealthCheckAt:now,}"]
  );
  assert.ok(ts.isExpressionStatement(warning));
  callExpression(warning.expression, "logWarn");
  assert.equal(syntax(earlyReturn), "return;");

  const invalidation = only(
    callsWithin(terminal, "updateProviderConnection").filter(
      (node) =>
        ts.isAwaitExpression(node.parent) &&
        ts.isExpressionStatement(node.parent.parent) &&
        node.parent.parent.parent === terminal
    ),
    "direct terminal invalidation after both stale-credential exits"
  );
  const update = invalidation.arguments[1];
  assert.ok(update && ts.isObjectLiteralExpression(update));
  const status = only(
    update.properties
      .filter(ts.isPropertyAssignment)
      .filter((node) => syntax(node.name) === "testStatus"),
    "invalidation status"
  );
  assert.equal(syntax(status.initializer), '"expired"');
  assertOrdered(read, missing, changedPair, changed, invalidation);
});

test("Class C private MaxAI login read stays authenticated, transport-scoped and persistence-first", () => {
  const file = "src/app/api/providers/[id]/login/route.ts";
  assert.equal(CLASSIFICATION.connection[file], "C");
  const source = parsedSource(file);
  const post = namedFunction(source, "POST").body;
  assert.deepEqual(post.statements.slice(0, 2).map(syntax), [
    "constauth=awaitrequireManagementAuth(req);",
    "if(auth)returnauth;",
  ]);
  const providerRead = awaitedCall(
    initializer(post, "provider"),
    "getCachedProviderConnectionById"
  );
  assert.deepEqual(providerRead.arguments.map(syntax), ["id"]);
  const maxaiBranch = directIf(post, 'providerSlug==="maxai"||providerSlug==="mx"');
  assertOrdered(directIf(post, "auth"), providerRead, maxaiBranch);
  const transport = only(
    callsWithin(maxaiBranch.thenStatement, "runMaxaiConnectionTransport"),
    "one account-scoped MaxAI login transport"
  );
  assert.ok(ts.isAwaitExpression(transport.parent));
  assert.ok(ts.isReturnStatement(transport.parent.parent));
  assert.equal(transport.arguments.length, 2);
  assert.equal(syntax(transport.arguments[0]), "id");
  const callback = transport.arguments[1];
  assert.ok(ts.isArrowFunction(callback));
  assert.equal(callback.parameters.length, 0);
  const loginCall = callExpression(callback.body, "loginMaxaiEmail");
  assert.deepEqual(loginCall.arguments.map(syntax), ["id", "body", "req.signal"]);
  assert.equal(
    only(callsWithin(source, "loginMaxaiEmail"), "sole private login caller"),
    loginCall
  );

  const { declaration, body: login } = namedFunction(source, "loginMaxaiEmail");
  assert.ok(!declaration.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword));
  const parsed = callExpression(initializer(login, "parsed"), "maxaiLoginBodySchema.safeParse");
  assert.deepEqual(parsed.arguments.map(syntax), ["body"]);
  const inputGuard = directIf(login, "!parsed.success||signal.aborted");
  assert.equal(syntax(inputGuard.thenStatement), "returnmaxaiLoginFailure(400);");
  const data = initializer(login, "data");
  assert.equal(syntax(data), "parsed.data");
  const canonicalRead = awaitedCall(initializer(login, "connection"), "getProviderConnectionById");
  assert.deepEqual(canonicalRead.arguments.map(syntax), ["connectionId"]);
  assert.equal(
    only(callsWithin(source, "getProviderConnectionById"), "canonical login read"),
    canonicalRead
  );
  const rowGuard = directIf(
    login,
    '!connection||signal.aborted||!["maxai","mx"].includes(' +
      "resolveProviderSlug(connectionasRecord<string,unknown>))"
  );
  assert.equal(syntax(rowGuard.thenStatement), "returnmaxaiLoginFailure(400);");
  const rawPsd = initializer(login, "rawPsd");
  assert.equal(syntax(rawPsd), "connection.providerSpecificData");
  const psd = initializer(login, "psd");
  assert.equal(
    syntax(psd),
    'rawPsd&&typeofrawPsd==="object"&&!Array.isArray(rawPsd)?' +
      "(rawPsdasRecord<string,unknown>):{}"
  );
  const requestBranch = directIf(login, 'data.step==="request"');
  assertOrdered(parsed, inputGuard, data, canonicalRead, rowGuard, rawPsd, psd, requestBranch);

  const request = blockBody(requestBranch.thenStatement);
  const identity = callExpression(
    initializer(request, "identity"),
    "maxaiLoginIdentitySchema.safeParse"
  );
  assert.deepEqual(identity.arguments.map(syntax), [
    "{email:data.email,deviceId:psd.maxaiDeviceId??psd.deviceId??randomUUID()," +
      "clientUserId:psd.maxaiClientUserId??psd.clientUserId??randomUUID(),}",
  ]);
  const identityGuard = directIf(request, "!identity.success");
  assert.equal(syntax(identityGuard.thenStatement), "returnmaxaiLoginFailure(400);");
  const identityFields = initializer(request, "{email,deviceId,clientUserId}");
  assert.equal(syntax(identityFields), "identity.data");
  const saveTry = only(
    request.statements.filter(ts.isTryStatement),
    "pending identity persistence"
  );
  const save = awaitedCall(initializer(saveTry.tryBlock, "saved"), "updateProviderConnection");
  assert.deepEqual(save.arguments.map(syntax), [
    "connectionId",
    "{providerSpecificData:{...psd,maxaiDeviceId:deviceId," +
      "maxaiClientUserId:clientUserId,maxaiLoginEmail:email,},}",
  ]);
  const savedGuard = directIf(saveTry.tryBlock, "!saved");
  assert.equal(syntax(savedGuard.thenStatement), "returnmaxaiLoginFailure(500);");
  assertOrdered(save, savedGuard);
  assert.ok(saveTry.catchClause);
  const catchStatements = saveTry.catchClause.block.statements;
  assert.equal(
    syntax(catchStatements[catchStatements.length - 1]),
    "returnmaxaiLoginFailure(500);"
  );
  const abortGuard = directIf(request, "signal.aborted");
  assert.equal(syntax(abortGuard.thenStatement), "returnmaxaiLoginFailure(400);");
  const send = awaitedCall(initializer(request, "result"), "requestMaxaiEmailCode");
  assert.deepEqual(send.arguments.map(syntax), ["{email,deviceId,signal}"]);
  assert.equal(callsWithin(login, "requestMaxaiEmailCode").length, 1);
  assertOrdered(identity, identityGuard, identityFields, saveTry, abortGuard, send);

  // Canonical pending identity, not caller-supplied identity. This does not
  // claim cross-process one-use/CAS/expiry of the pending email login.
  const pending = callExpression(
    initializer(login, "pending"),
    "maxaiLoginIdentitySchema.safeParse"
  );
  assert.deepEqual(pending.arguments.map(syntax), [
    "{email:psd.maxaiLoginEmail,deviceId:psd.maxaiDeviceId,clientUserId:psd.maxaiClientUserId,}",
  ]);
  const pendingGuard = directIf(
    login,
    "!pending.success||!data.code||" +
      "(data.email&&data.email.toLowerCase()!==pending.data.email.toLowerCase())"
  );
  assert.equal(syntax(pendingGuard.thenStatement), "returnmaxaiLoginFailure(400);");
  const verify = awaitedCall(initializer(login, "result"), "verifyMaxaiEmailCode");
  assert.deepEqual(verify.arguments.map(syntax), ["{...pending.data,code:data.code,signal}"]);
  assert.equal(callsWithin(login, "verifyMaxaiEmailCode").length, 1);
  assertOrdered(requestBranch, pending, pendingGuard, verify);
});

test("managed request surfaces are fenced centrally or rejected before independent dispatch", () => {
  const chat = fs.readFileSync(path.join(REPO_ROOT, "src/sse/handlers/chat.ts"), "utf8");
  const core = fs.readFileSync(path.join(REPO_ROOT, "open-sse/handlers/chatCore.ts"), "utf8");
  const pipeline = fs.readFileSync(
    path.join(REPO_ROOT, "open-sse/handlers/chatCore/providerExecutionPipeline.ts"),
    "utf8"
  );
  const ws = fs.readFileSync(
    path.join(REPO_ROOT, "src/app/api/internal/codex-responses-ws/route.ts"),
    "utf8"
  );
  const internalKeys = fs.readFileSync(path.join(REPO_ROOT, "src/lib/db/apiKeys.ts"), "utf8");
  const auxiliaryIsolationSources = [
    "src/app/api/providers/[id]/models/route.ts",
    "src/app/api/translator/send/route.ts",
    "src/app/api/translator/translate/route.ts",
    "src/lib/api/modelTestRunner.ts",
    "src/lib/services/quotaAutoPing.ts",
    "src/lib/usage/codexResetCredits.ts",
    "src/lib/usage/grokResetCredits.ts",
    "src/lib/vncSession/service.ts",
    "src/lib/warmupScheduler.ts",
    "src/shared/services/modelSyncScheduler.ts",
  ].map((file) => fs.readFileSync(path.join(REPO_ROOT, file), "utf8"));
  const unfencedUsageRefreshSource = fs.readFileSync(
    path.join(REPO_ROOT, "src/lib/usage/providerLimits.ts"),
    "utf8"
  );

  assert.match(chat, /parseManagedLeaseRequestContext\(request\.headers\)/);
  assert.match(chat, /isManagedComboUnsupported/);
  assert.match(core, /assertManagedLeaseFence\(attemptConnectionId\)/);
  assert.match(
    core,
    /assertManagedLeaseFence\(getExecutionConnectionId\(getExecutionCredentials\(\)\)\)/
  );
  // Both streaming and non-streaming callers must disallow account rotation for
  // managed leases; the extracted pipeline must honor that policy before either
  // credential query, while pinning the expected connection before/after send.
  assert.equal(
    (
      core.match(/allowAccountRotation:\s*!managedLease && comboStrategy !== "context-relay"/g) ||
      []
    ).length,
    2,
    "both pipeline legs must disable rotation for managed leases"
  );
  assert.equal((core.match(/expectedConnectionId:\s*managedLease/g) || []).length, 2);
  assert.match(pipeline, /const canRotateAccount = policy\.allowAccountRotation && !isolateProbe/);
  assert.match(pipeline, /const before = assertLease\(policy, connection, wire\.currentModel\)/);
  assert.match(pipeline, /const after = assertLease\(policy, connection, wire\.currentModel\)/);
  assert.match(
    pipeline,
    /canRotateAccount &&\s*target\.provider === "codex" &&[\s\S]*?\.getProviderCredentials\("codex"/
  );
  assert.match(
    pipeline,
    /if \(canRotateAccount && target\.provider === "antigravity" && status === 422\)[\s\S]*?\.getProviderCredentials\("antigravity"/
  );
  assert.match(ws, /LEASE_UNSUPPORTED_TRANSPORT/);
  assert.match(internalKeys, /!k\.scopes\?\.includes\(EXCLUSIVE_LEASE_SCOPE\)/);
  for (const source of auxiliaryIsolationSources) {
    assert.match(source, /isConnectionUnavailableToAuxiliaryActivity/);
  }
  // Usage/quota refresh is read-only admin telemetry (#11758) and must not inherit
  // the exclusive-lease auxiliary fence that blocks model tests, translation, VNC,
  // reset-credits, and warmup.
  assert.doesNotMatch(unfencedUsageRefreshSource, /isConnectionUnavailableToAuxiliaryActivity/);
});

test("SQLite claim-race retry removes only the lost candidate from the same policy-valid set", () => {
  const auth = fs.readFileSync(path.join(REPO_ROOT, "src/sse/services/auth.ts"), "utf8");

  assert.match(auth, /_leaseCandidateIds: candidateIds/);
  assert.match(auth, /excludeConnectionIds: \[\.\.\.excludedConnectionIds, connection\.id\]/);
  assert.match(
    auth,
    /pendingCredentialSelection =\s*await selectedCredentials\.selectNextLeaseCandidate\?\.\(connectionId\)/
  );
  assert.doesNotMatch(auth, /exclusiveChatRouting|exclusiveCredentialSelection/);
});
