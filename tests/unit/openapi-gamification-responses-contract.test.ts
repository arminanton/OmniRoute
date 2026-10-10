import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const canonicalText = fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const publicSpec = yaml.load(publicText) as { paths: Record<string, Record<string, any>> };

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function operation(pathname: string, method: string): Record<string, any> {
  const result = spec.paths[pathname]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathname}`);
  return result;
}

function schema(name: string): any {
  const result = spec.components.schemas[name];
  assert.ok(result, `missing components.schemas.${name}`);
  return result;
}

function assertJsonSuccess(
  pathname: string,
  method: string,
  status: "200" | "201",
  schemaName: string
): void {
  const op = operation(pathname, method);
  assert.deepEqual(
    Object.keys(op.responses).filter((code) => /^2\d\d$/.test(code)),
    [status],
    `${method.toUpperCase()} ${pathname} success status`
  );
  assert.equal(
    op.responses[status]?.content?.["application/json"]?.schema?.$ref,
    `#/components/schemas/${schemaName}`,
    `${method.toUpperCase()} ${pathname} JSON success schema`
  );
}

test("gamification success statuses, media types, and schemas match route handlers", () => {
  const jsonContracts = [
    [
      "/api/gamification/federation/leaderboard",
      "get",
      "200",
      "GamificationFederationLeaderboardResponse",
    ],
    ["/api/gamification/federation/score", "post", "200", "SuccessResponse"],
    ["/api/gamification/invite", "delete", "200", "SuccessResponse"],
    ["/api/gamification/invite", "get", "200", "GamificationInviteListResponse"],
    ["/api/gamification/invite", "post", "201", "GamificationInviteCreatedResponse"],
    ["/api/gamification/invite/redeem", "post", "200", "GamificationInviteRedeemResponse"],
    ["/api/gamification/leaderboard", "get", "200", "GamificationLeaderboardResponse"],
    ["/api/gamification/level", "get", "200", "GamificationLevelResponse"],
    ["/api/gamification/rotate", "post", "200", "GamificationRotateResponse"],
    ["/api/gamification/servers", "delete", "200", "SuccessResponse"],
    ["/api/gamification/servers", "get", "200", "GamificationServersResponse"],
    ["/api/gamification/servers", "post", "201", "GamificationServerConnectResponse"],
    ["/api/gamification/transfer", "get", "200", "GamificationTransferHistoryResponse"],
    ["/api/gamification/transfer", "post", "200", "GamificationTransferResponse"],
  ] as const;

  for (const [pathname, method, status, schemaName] of jsonContracts) {
    assertJsonSuccess(pathname, method, status, schemaName);
  }

  assert.deepEqual(
    operation("/api/gamification/invite", "get").parameters.map((parameter: any) => [
      parameter.name,
      parameter.in,
      parameter.required,
    ]),
    [["apiKeyId", "query", true]]
  );
  assert.deepEqual(
    operation("/api/gamification/servers", "delete").parameters.map((parameter: any) => [
      parameter.name,
      parameter.in,
      parameter.required,
    ]),
    [["id", "query", true]]
  );
  assert.deepEqual(
    operation("/api/gamification/transfer", "get").parameters.map((parameter: any) => [
      parameter.name,
      parameter.in,
      parameter.required,
    ]),
    [["apiKeyId", "query", true]]
  );

  const stream = operation("/api/gamification/stream", "get");
  assert.deepEqual(
    Object.keys(stream.responses).filter((code) => /^2\d\d$/.test(code)),
    ["200"]
  );
  const eventStream = stream.responses["200"].content["text/event-stream"];
  assert.equal(eventStream.schema.type, "string");
  assert.equal(
    eventStream["x-sse-event-schema"]?.$ref,
    "#/components/schemas/GamificationStreamEvent"
  );
  assert.equal(stream.responses["200"].content["application/json"], undefined);

  assert.match(
    source("src/app/api/gamification/invite/route.ts"),
    /status:\s*201/,
    "invite creation handler returns 201"
  );
  assert.match(
    source("src/app/api/gamification/servers/route.ts"),
    /status:\s*201/,
    "server connection handler returns 201"
  );
  assert.match(
    source("src/app/api/gamification/stream/route.ts"),
    /"Content-Type": "text\/event-stream"/
  );
});

test("gamification schemas preserve sensitive invite credentials and redact server keys", () => {
  const createdInvite = schema("GamificationInviteCreatedResponse");
  assert.deepEqual([...(createdInvite.required ?? [])].sort(), ["code", "token"]);
  assert.equal(createdInvite.properties.code["x-sensitive"], true);
  assert.equal(createdInvite.properties.token["x-sensitive"], true);

  const inviteItem = schema("GamificationInviteListItem");
  assert.equal(inviteItem.properties.code["x-sensitive"], true);
  assert.equal("token" in inviteItem.properties, false);
  assert.equal("tokenHash" in inviteItem.properties, false);
  const inviteServiceSource = source("src/lib/gamification/invites.ts");
  assert.match(inviteServiceSource, /tokenHash = hashToken\(token\)/);
  assert.match(
    inviteServiceSource,
    /SELECT id, code, server_url, max_uses, use_count, expires_at, revoked_at, created_at/
  );
  assert.doesNotMatch(inviteServiceSource, /SELECT[^`]*token_hash[^`]*FROM invite_tokens/);

  const redeemRequest = schema("GamificationInviteRedeemRequest");
  assert.equal(redeemRequest.properties.code.writeOnly, true);
  assert.equal(redeemRequest.properties.code["x-sensitive"], true);

  const connectRequest = schema("GamificationServerConnectRequest");
  assert.equal(connectRequest.properties.apiKey.writeOnly, true);
  assert.equal(connectRequest.properties.apiKey["x-sensitive"], true);
  const createdServer = schema("GamificationServerCreated");
  assert.deepEqual([...(createdServer.required ?? [])].sort(), [
    "errorMessage",
    "id",
    "lastSyncAt",
    "name",
    "status",
    "url",
  ]);
  assert.equal("apiKey" in createdServer.properties, false);
  assert.equal("apiKeyHash" in createdServer.properties, false);
  assert.match(
    source("src/lib/gamification/servers.ts"),
    /return \{ id, name, url, status: "connected", lastSyncAt: null, errorMessage: null \}/
  );
  const serverDbSource = source("src/lib/db/gamification.ts");
  assert.match(
    serverDbSource,
    /SELECT id, name, url, connected_at, last_sync_at, status, error_message FROM community_servers/
  );
  assert.match(source("src/lib/gamification/servers.ts"), /pbkdf2Sync\(apiKey/);
});

test("gamification leaderboard and stream projections match their source field allowlists", () => {
  const federationEntry = schema("GamificationFederationLeaderboardEntry");
  assert.deepEqual([...(federationEntry.required ?? [])].sort(), ["apiKeyId", "score"]);
  assert.equal(federationEntry.additionalProperties, false);
  assert.deepEqual(Object.keys(federationEntry.properties).sort(), ["apiKeyId", "score"]);
  assert.match(
    source("src/app/api/gamification/federation/leaderboard/route.ts"),
    /entries: entries\.map\(\(e: any\) => \(\{\s*apiKeyId: e\.apiKeyId,\s*score: e\.score,\s*\}\)\)/
  );

  const dashboardEntry = schema("GamificationLeaderboardEntry");
  assert.deepEqual(Object.keys(dashboardEntry.properties).sort(), [
    "apiKeyId",
    "name",
    "scope",
    "score",
    "updatedAt",
  ]);
  assert.deepEqual(dashboardEntry.properties.name.type, ["string", "null"]);
  const leaderboardSource = source("src/app/api/gamification/leaderboard/route.ts");
  assert.match(leaderboardSource, /Only\s+\* the name is added/);
  assert.match(leaderboardSource, /names\.get\(entry\.apiKeyId\) \?\? null/);

  const frameUnion = schema("GamificationStreamEvent");
  assert.deepEqual(frameUnion.oneOf.map((item: any) => item.$ref).sort(), [
    "#/components/schemas/GamificationStreamErrorFrame",
    "#/components/schemas/GamificationStreamLeaderboardFrame",
  ]);
  const streamSource = source("src/app/api/gamification/stream/route.ts");
  assert.match(streamSource, /type: "leaderboard"/);
  assert.match(streamSource, /event: error/);
  assert.match(streamSource, /: heartbeat/);
});

test("gamification response schemas are mirrored in the public OpenAPI artifact", () => {
  assert.equal(publicText, canonicalText);
  for (const pathname of [
    "/api/gamification/federation/leaderboard",
    "/api/gamification/federation/score",
    "/api/gamification/invite",
    "/api/gamification/invite/redeem",
    "/api/gamification/leaderboard",
    "/api/gamification/level",
    "/api/gamification/rotate",
    "/api/gamification/servers",
    "/api/gamification/stream",
    "/api/gamification/transfer",
  ]) {
    assert.deepEqual(publicSpec.paths[pathname], spec.paths[pathname], `${pathname} mirror`);
  }
});
