import { test } from "node:test";
import assert from "node:assert";
import {
  normalizeParams,
  findSpecPathsWithoutRoute,
  findOperationsMissingPathParameters,
  findRouteMethodMismatches,
  KNOWN_STALE_SPEC,
} from "../../scripts/check/check-openapi-routes.mjs";
import { reportStaleEntries } from "../../scripts/check/lib/allowlist.mjs";

test("normalizeParams collapses any {param} name to {}", () => {
  assert.equal(normalizeParams("/api/providers/{providerId}/models"), "/api/providers/{}/models");
});

test("documented path with a real route is not flagged", () => {
  assert.deepEqual(findSpecPathsWithoutRoute(["/api/usage"], ["/api/usage"]), []);
});

test("param name mismatch still matches (param-insensitive)", () => {
  assert.deepEqual(
    findSpecPathsWithoutRoute(["/api/providers/{id}"], ["/api/providers/{providerId}"]),
    []
  );
});

test("flags a documented path that has no real route (invented endpoint)", () => {
  assert.deepEqual(findSpecPathsWithoutRoute(["/api/ghost", "/api/usage"], ["/api/usage"]), [
    "/api/ghost",
  ]);
});

test("path parameter references satisfy path-template declarations", () => {
  assert.deepEqual(
    findOperationsMissingPathParameters(
      {
        "/api/providers/{id}": {
          parameters: [{ $ref: "#/components/parameters/ResourceId" }],
          get: { responses: {} },
          patch: { parameters: [{ name: "id", in: "path" }], responses: {} },
        },
      },
      { parameters: { ResourceId: { name: "id", in: "path" } } }
    ),
    []
  );
});

test("reports path-template variables missing from an operation", () => {
  assert.deepEqual(
    findOperationsMissingPathParameters({
      "/api/providers/{providerId}/models/{modelId}": {
        parameters: [{ name: "providerId", in: "path" }],
        get: { parameters: [{ name: "q", in: "query" }], responses: {} },
      },
    }),
    [
      {
        method: "GET",
        path: "/api/providers/{providerId}/models/{modelId}",
        missing: ["modelId"],
      },
    ]
  );
});

test("route method audit finds missing and undocumented operations", () => {
  assert.deepEqual(
    findRouteMethodMismatches(
      {
        "/api/settings/{id}": { get: {}, delete: {} },
      },
      new Map([["/api/settings/{settingId}", ["GET", "PUT"]]])
    ),
    [{ path: "/api/settings/{id}", missing: ["PUT"], extra: ["DELETE"] }]
  );
});

// --- stale-allowlist enforcement (6A.3) ---

test("stale-enforcement: allowlist entry no longer needed causes gate to flag it", () => {
  // Simulate a KNOWN_STALE_SPEC entry whose spec path now has a real route.
  const liveOrphans: string[] = []; // route was created → no orphans left
  const stale = (reportStaleEntries as (a: Set<string>, l: string[], g: string) => string[])(
    new Set(["/api/agent-bridge/{id}/state"]),
    liveOrphans,
    "openapi-routes"
  );
  assert.deepEqual(stale, ["/api/agent-bridge/{id}/state"]);
});

test("stale-enforcement: live repo has zero stale entries in KNOWN_STALE_SPEC", () => {
  // KNOWN_STALE_SPEC is empty today; this anchors that invariant.
  assert.equal((KNOWN_STALE_SPEC as Set<string>).size, 0);
});
