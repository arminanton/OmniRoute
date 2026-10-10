import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import {
  buildOpenApiContractInventory,
  loadOpenApiContractInventory,
  renderOpenApiContractInventory,
} from "../../scripts/check/openapi-contract-inventory.mjs";

const ROOT = process.cwd();
const CANONICAL_SPEC = path.join(ROOT, "docs/openapi.yaml");
const INVENTORY_REPORT = path.join(ROOT, "docs/architecture/OPENAPI_CONTRACT_INVENTORY.md");

test("OpenAPI inventory resolves response refs and classifies deliberate non-body routes", () => {
  const inventory = buildOpenApiContractInventory({
    openapi: "3.1.0",
    components: {
      responses: {
        SharedSuccess: {
          description: "Shared success",
          content: { "application/json": { schema: { type: "object" } } },
        },
      },
    },
    paths: {
      "/typed": {
        post: { responses: { "200": { $ref: "#/components/responses/SharedSuccess" } } },
      },
      "/partial": {
        post: {
          responses: {
            "200": { content: { "application/json": { schema: { type: "object" } } } },
            "201": { description: "Created without a declared body" },
          },
        },
      },
      "/content-without-schema": {
        post: { responses: { "200": { content: { "application/json": {} } } } },
      },
      "/head-probe": { head: { responses: { "200": { description: "No body" } } } },
      "/empty-delete": { delete: { responses: { "204": { description: "Deleted" } } } },
      "/preflight": { options: { responses: { "204": { description: "CORS preflight" } } } },
      "/legacy-redirect": { get: { responses: { "308": { description: "Redirect" } } } },
      "/socket": { get: { responses: { "101": { description: "WebSocket upgrade" } } } },
      "/{omniRouteCatchAll}": {
        get: {
          operationId: "getCatchAll",
          responses: { "404": { description: "No route" } },
        },
      },
      "/failure-only": { post: { responses: { "400": { description: "Bad request" } } } },
      "/explicit-public": {
        get: {
          security: [],
          responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/anonymous-alternative": {
        get: {
          security: [{ BearerAuth: [] }, {}],
          responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/conditional-without-security": {
        get: {
          description: "May permit anonymous access when requireLogin is disabled.",
          responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  });

  assert.equal(inventory.operationCount, 13);
  assert.equal(inventory.responseContent.candidateOperations, 6);
  assert.equal(inventory.responseContent.fullyTypedOperations, 4);
  assert.equal(inventory.responseContent.untypedOperations, 2);
  assert.deepEqual(inventory.responseContent.gapStateCounts, {
    "content-without-schema": 1,
    "no-content": 1,
    "unresolved-response": 0,
  });
  assert.deepEqual(inventory.responseContent.exemptions, {
    "204-only": 1,
    "catch-all-error-response": 1,
    "cors-options": 1,
    "error-only-or-no-success-status": 1,
    "head-no-success-status": 0,
    "head-success-bodyless": 1,
    "not-modified-only": 0,
    "redirect-only": 1,
    "websocket-upgrade": 1,
  });
  assert.equal(inventory.security.explicitPublic, 1);
  assert.equal(inventory.security.includesAnonymousAlternative, 1);
  assert.equal(inventory.security.conditionalAuthText, 1);
  assert.equal(inventory.security.conditionalAuthWithMissingSecurity, 1);
});

test("OpenAPI inventory counts the standard 2XX response range as a success response", () => {
  const inventory = buildOpenApiContractInventory({
    paths: {
      "/wildcard-success": {
        get: {
          responses: {
            "2XX": {
              description: "Any successful response",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  });

  assert.equal(inventory.operationCount, 1);
  assert.equal(inventory.responseContent.candidateOperations, 1);
  assert.equal(inventory.responseContent.fullyTypedOperations, 1);
  assert.equal(inventory.responseContent.untypedOperations, 0);
  assert.equal(inventory.responseContent.no2xxOperations.length, 0);
});

test("canonical OpenAPI inventory reconciles the checked-in report counts", () => {
  const document = yaml.load(fs.readFileSync(CANONICAL_SPEC, "utf8"));
  const inventory = loadOpenApiContractInventory(CANONICAL_SPEC);
  assert.equal(inventory.pathCount, Object.keys(document.paths).length);
  assert.equal(inventory.pathCount, 705);
  assert.equal(inventory.operationCount, 1029);
  assert.equal(inventory.responseContent.candidateOperations, 981);
  assert.equal(inventory.responseContent.fullyTypedOperations, 865);
  assert.equal(inventory.responseContent.untypedOperations, 116);
  assert.deepEqual(inventory.responseContent.gapStateCounts, {
    "content-without-schema": 0,
    "no-content": 116,
    "unresolved-response": 0,
  });
  assert.equal(inventory.responseContent.bodyless204Operations.length, 16);
  assert.equal(inventory.responseContent.no2xxOperations.length, 30);
  assert.equal(inventory.responseContent.headOperationCount, 8);
  assert.equal(inventory.responseContent.headWithSuccessStatusCount, 2);
  assert.equal(inventory.responseContent.headWithoutSuccessStatusCount, 6);
  assert.deepEqual(inventory.responseContent.exemptions, {
    "204-only": 16,
    "catch-all-error-response": 10,
    "cors-options": 0,
    "error-only-or-no-success-status": 5,
    "head-no-success-status": 6,
    "head-success-bodyless": 2,
    "not-modified-only": 0,
    "redirect-only": 8,
    "websocket-upgrade": 1,
  });
  assert.equal(inventory.security.operationDeclared, 842);
  assert.equal(inventory.security.missing, 187);
  assert.equal(inventory.security.invalidDeclaration, 0);
  assert.equal(inventory.security.explicitPublic, 15);
  assert.equal(inventory.security.requiresDeclaredScheme, 156);
  assert.equal(inventory.security.includesAnonymousAlternative, 671);
  assert.equal(inventory.security.conditionalAuthText, 314);
  assert.equal(inventory.security.conditionalAuthWithMissingSecurity, 0);
  assert.equal(
    fs.readFileSync(INVENTORY_REPORT, "utf8"),
    renderOpenApiContractInventory(inventory),
    "the checked-in report must match current canonical counts"
  );
});

test("security inheritance is reported separately from operation declarations", () => {
  const inventory = buildOpenApiContractInventory({
    security: [{ BearerAuth: [] }],
    paths: {
      "/inherited-from-path": {
        security: [{ ManagementSessionAuth: [] }],
        get: {
          responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/inherited-from-root": {
        get: {
          responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/declared-public": {
        get: {
          security: [],
          responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  });
  assert.equal(inventory.security.inheritedFromPath, 1);
  assert.equal(inventory.security.inheritedFromRoot, 1);
  assert.equal(inventory.security.explicitPublic, 1);
  assert.equal(inventory.security.operationDeclared, 1);
  assert.equal(inventory.security.missing, 0);
});
