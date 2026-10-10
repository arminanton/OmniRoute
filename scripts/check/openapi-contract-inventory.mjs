#!/usr/bin/env node
/**
 * Deterministic inventory of OpenAPI success-body and security declarations.
 *
 * This is a read-only report: it loads the canonical OpenAPI document and never
 * contacts an application or edits the specification. It deliberately reports
 * declaration coverage, not proof that a schema is semantically exact or that
 * runtime authorization matches the contract.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as yaml from "js-yaml";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const BODYLESS_SUCCESS = new Set(["204"]);
const REDIRECT_STATUSES = new Set(["301", "302", "303", "307", "308"]);
const RESPONSE_EXEMPTION_KINDS = [
  "204-only",
  "catch-all-error-response",
  "cors-options",
  "error-only-or-no-success-status",
  "head-no-success-status",
  "head-success-bodyless",
  "not-modified-only",
  "redirect-only",
  "websocket-upgrade",
];
const RESPONSE_GAP_STATES = ["content-without-schema", "no-content", "unresolved-response"];
const CONDITIONAL_AUTH_TEXT =
  /conditional|configuration-dependent|require[_ ]?login|require[_ ]?api[_ ]?key|may permit anonymous|may be anonymous|anonymous access (?:is|may be|can be) (?:available|permitted|accepted)|when (?:login|authentication|auth|this setting) (?:is )?(?:disabled|off|unlocked)|unlocked (?:standalone|management)|when (?:requirelogin|require_api_key)/i;

function resolveLocalRef(value, components, seen = new Set()) {
  if (!value || typeof value !== "object" || typeof value.$ref !== "string") return value;
  const ref = value.$ref;
  if (!ref.startsWith("#/components/") || seen.has(ref)) return null;
  seen.add(ref);
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current = components;
  for (const part of parts.slice(1)) current = current?.[part];
  return current ? resolveLocalRef(current, components, seen) : null;
}

function responseContentState(responseValue, components) {
  const response = resolveLocalRef(responseValue, components);
  if (!response || typeof response !== "object") return "unresolved-response";
  const content = response.content;
  if (!content || typeof content !== "object" || Object.keys(content).length === 0) {
    return "no-content";
  }
  const mediaTypes = Object.keys(content).sort();
  const hasSchema = mediaTypes.some((mediaType) => {
    const media = resolveLocalRef(content[mediaType], components);
    const schema = media && typeof media === "object" ? media.schema : undefined;
    return schema === true || schema === false || (schema !== null && typeof schema === "object");
  });
  return hasSchema ? "schema" : "content-without-schema";
}

function successResponseStatuses(operation) {
  return Object.entries(operation.responses ?? {})
    .map(([status, response]) => ({ status, response }))
    .filter(({ status }) => /^2\d\d$/.test(status) || status === "2XX")
    .sort((left, right) => responseStatusOrder(left.status) - responseStatusOrder(right.status));
}

function responseStatusOrder(status) {
  return status === "2XX" ? 200 : Number(status);
}

function operationText(pathTemplate, method, operation) {
  return [pathTemplate, method, operation.operationId, operation.summary, operation.description]
    .filter((value) => typeof value === "string")
    .join(" ");
}

function isCatchAll(pathTemplate, operation) {
  return (
    operation["x-nextjs-catch-all"] === true ||
    /\{[^}]*catch.?all[^}]*\}/i.test(pathTemplate) ||
    /catch.?all/i.test(operationText(pathTemplate, "", operation))
  );
}

function responseExemption(pathTemplate, method, operation, successes) {
  if (method === "options") return "cors-options";
  if (method === "head") {
    return successes.length > 0 ? "head-success-bodyless" : "head-no-success-status";
  }
  if (successes.length && successes.every(({ status }) => BODYLESS_SUCCESS.has(status))) {
    return "204-only";
  }
  if (!successes.length) {
    const responses = operation.responses ?? {};
    const statuses = Object.keys(responses).filter((status) => /^\d{3}$/.test(status));
    if (statuses.includes("101")) return "websocket-upgrade";
    if (statuses.some((status) => REDIRECT_STATUSES.has(status))) return "redirect-only";
    if (statuses.includes("304")) return "not-modified-only";
    if (isCatchAll(pathTemplate, operation)) return "catch-all-error-response";
    return "error-only-or-no-success-status";
  }
  return null;
}

function effectiveSecurity(pathItem, operation, root) {
  if (Object.hasOwn(operation, "security")) {
    return { value: operation.security, source: "operation" };
  }
  if (Object.hasOwn(pathItem, "security")) {
    return { value: pathItem.security, source: "path" };
  }
  if (Object.hasOwn(root, "security")) {
    return { value: root.security, source: "root" };
  }
  return { value: undefined, source: "missing" };
}

function securityState(security) {
  if (security.value === undefined) return "undeclared";
  if (!Array.isArray(security.value)) return "invalid-declaration";
  if (security.value.length === 0) return "explicit-public";
  const hasAnonymousAlternative = security.value.some(
    (alternative) =>
      alternative && typeof alternative === "object" && Object.keys(alternative).length === 0
  );
  return hasAnonymousAlternative ? "includes-anonymous-alternative" : "requires-declared-scheme";
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function renderTable(headers, rows, rightAlignedColumns = []) {
  const rightAligned = new Set(rightAlignedColumns);
  const widths = headers.map((header, column) => {
    const longest = Math.max(
      header.length,
      ...rows.map((row) => String(row[column] ?? "").length),
      3
    );
    return longest + (rightAligned.has(column) ? 0 : 1);
  });
  const line = (cells) =>
    `| ${cells
      .map((cell, column) => {
        const value = String(cell ?? "");
        return rightAligned.has(column)
          ? value.padStart(widths[column])
          : value.padEnd(widths[column] - 1);
      })
      .join(" | ")} |`;
  const separator = `| ${widths
    .map((width, column) => `${"-".repeat(width - 1)}${rightAligned.has(column) ? ":" : ""}`)
    .join(" | ")} |`;
  return [line(headers), separator, ...rows.map(line)];
}

/** Build a stable inventory from an already-parsed OpenAPI document. */
export function buildOpenApiContractInventory(document) {
  const paths = document.paths ?? {};
  const components = document.components ?? {};
  const operations = [];
  const responseExemptions = {};
  const securityCounts = {
    operationDeclared: 0,
    inheritedFromPath: 0,
    inheritedFromRoot: 0,
    missing: 0,
    explicitPublic: 0,
    requiresDeclaredScheme: 0,
    includesAnonymousAlternative: 0,
    invalidDeclaration: 0,
    conditionalAuthText: 0,
    conditionalAuthWithMissingSecurity: 0,
  };

  for (const [pathTemplate, pathItem] of Object.entries(paths).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const [methodRaw, operation] of Object.entries(pathItem).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      const method = methodRaw.toLowerCase();
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== "object") continue;

      const successes = successResponseStatuses(operation);
      const bodySuccesses = successes.filter(({ status }) => !BODYLESS_SUCCESS.has(status));
      const exemption = responseExemption(pathTemplate, method, operation, successes);
      const statusStates = bodySuccesses.map(({ status, response }) => ({
        status,
        state: responseContentState(response, components),
      }));
      const responseCandidate =
        bodySuccesses.length > 0 && method !== "head" && method !== "options";
      const fullyTyped = responseCandidate && statusStates.every(({ state }) => state === "schema");
      if (exemption) increment(responseExemptions, exemption);

      const security = effectiveSecurity(pathItem, operation, document);
      const state = securityState(security);
      if (security.source === "operation") securityCounts.operationDeclared++;
      else if (security.source === "path") securityCounts.inheritedFromPath++;
      else if (security.source === "root") securityCounts.inheritedFromRoot++;
      else securityCounts.missing++;
      if (state === "explicit-public") securityCounts.explicitPublic++;
      else if (state === "requires-declared-scheme") securityCounts.requiresDeclaredScheme++;
      else if (state === "includes-anonymous-alternative")
        securityCounts.includesAnonymousAlternative++;
      else if (state === "invalid-declaration") securityCounts.invalidDeclaration++;
      const conditionalAuth = CONDITIONAL_AUTH_TEXT.test(
        operationText(pathTemplate, method, operation)
      );
      if (conditionalAuth) {
        securityCounts.conditionalAuthText++;
        if (state === "undeclared") securityCounts.conditionalAuthWithMissingSecurity++;
      }

      operations.push({
        method: method.toUpperCase(),
        path: pathTemplate,
        operationId: operation.operationId ?? null,
        successStatuses: successes.map(({ status }) => status),
        bodySuccessStatuses: bodySuccesses.map(({ status }) => status),
        responseCandidate,
        fullyTyped,
        responseStatusStates: statusStates,
        responseExemption: exemption,
        securityState: state,
        securitySource: security.source,
        conditionalAuthText: conditionalAuth,
      });
    }
  }

  const candidateOperations = operations.filter((operation) => operation.responseCandidate);
  const typedOperations = candidateOperations.filter((operation) => operation.fullyTyped);
  const responseGaps = candidateOperations
    .filter((operation) => !operation.fullyTyped)
    .map((operation) => ({
      method: operation.method,
      path: operation.path,
      operationId: operation.operationId,
      missingStatuses: operation.responseStatusStates
        .filter(({ state }) => state !== "schema")
        .map(({ status, state }) => ({ status, state })),
    }));
  const no2xxOperations = operations.filter((operation) => operation.successStatuses.length === 0);
  const headOperations = operations.filter((operation) => operation.method === "HEAD");
  const bodyless204Operations = operations.filter(
    (operation) =>
      operation.successStatuses.length > 0 && operation.bodySuccessStatuses.length === 0
  );
  const typedCount = typedOperations.length;
  const candidateCount = candidateOperations.length;
  const normalizedExemptions = Object.fromEntries(
    RESPONSE_EXEMPTION_KINDS.map((kind) => [kind, responseExemptions[kind] ?? 0])
  );
  const normalizedGapStates = Object.fromEntries(
    RESPONSE_GAP_STATES.map((state) => [
      state,
      responseGaps.reduce((count, operation) => {
        return (
          count + operation.missingStatuses.filter((missing) => missing.state === state).length
        );
      }, 0),
    ])
  );

  return {
    schemaVersion: 1,
    source: "docs/openapi.yaml",
    version: document.info?.version ?? "unknown",
    pathCount: Object.keys(paths).length,
    operationCount: operations.length,
    responseContent: {
      candidateOperations: candidateCount,
      fullyTypedOperations: typedCount,
      untypedOperations: responseGaps.length,
      coveragePercent:
        candidateCount === 0 ? 100 : Number(((typedCount / candidateCount) * 100).toFixed(2)),
      bodyless204Operations: bodyless204Operations.map(
        ({ method, path, operationId, successStatuses }) => ({
          method,
          path,
          operationId,
          statuses: successStatuses,
        })
      ),
      bodylessHeadOperations: operations
        .filter((operation) => operation.method === "HEAD")
        .map(({ method, path, operationId, successStatuses, responseStatusStates }) => ({
          method,
          path,
          operationId,
          statuses: successStatuses,
          responseStatusStates,
        })),
      headOperationCount: headOperations.length,
      headWithSuccessStatusCount: headOperations.filter(
        (operation) => operation.successStatuses.length > 0
      ).length,
      headWithoutSuccessStatusCount: headOperations.filter(
        (operation) => operation.successStatuses.length === 0
      ).length,
      no2xxOperations: no2xxOperations.map(
        ({ method, path, operationId, responseExemption, securityState }) => ({
          method,
          path,
          operationId,
          exemption: responseExemption,
          securityState,
        })
      ),
      exemptions: normalizedExemptions,
      gapStateCounts: normalizedGapStates,
      gaps: responseGaps,
    },
    security: {
      ...securityCounts,
      missingDeclarations: operations
        .filter((operation) => operation.securityState === "undeclared")
        .map(({ method, path, operationId, conditionalAuthText }) => ({
          method,
          path,
          operationId,
          conditionalAuthText,
        })),
    },
  };
}

export function renderOpenApiContractInventory(inventory) {
  const { responseContent, security } = inventory;
  const pct = `${responseContent.coveragePercent.toFixed(2)}%`;
  const exemptionRows = Object.entries(responseContent.exemptions).map(([kind, count]) => [
    kind,
    count,
  ]);
  const gapStateRows = Object.entries(responseContent.gapStateCounts).map(([state, count]) => [
    state,
    count,
  ]);
  const conditionalMissingRows = security.missingDeclarations
    .filter(({ conditionalAuthText }) => conditionalAuthText)
    .map(({ method, path: operationPath, operationId }) => {
      return [method, `\`${operationPath}\``, `\`${operationId ?? "(no operationId)"}\``];
    });

  return [
    "---",
    'title: "OpenAPI Response and Security Declaration Inventory"',
    `version: ${inventory.version}`,
    "---",
    "",
    "# OpenAPI response and security declaration inventory",
    "",
    `Generated from \`${inventory.source}\` by \`npm run report:openapi-contract-inventory\`. This is a static declaration inventory; it does not prove runtime behavior or schema semantic completeness.`,
    "",
    `- Paths: ${inventory.pathCount}`,
    `- Operations: ${inventory.operationCount}`,
    `- Body-bearing success-response candidates: ${responseContent.candidateOperations}`,
    `- Candidates with a schema on every declared non-204 2xx response: ${responseContent.fullyTypedOperations} (${pct})`,
    `- Candidates with at least one missing/untyped non-204 2xx response: ${responseContent.untypedOperations}`,
    `- Bodyless 204-only operations: ${responseContent.bodyless204Operations.length}`,
    `- HEAD operations: ${responseContent.headOperationCount} (${responseContent.headWithSuccessStatusCount} declare success statuses; ${responseContent.headWithoutSuccessStatusCount} have no declared 2xx)`,
    `- Operations with no declared 2xx response: ${responseContent.no2xxOperations.length}`,
    "",
    "The candidate denominator excludes HEAD/OPTIONS, operations whose only success is 204, and operations with no declared 2xx. Each candidate must describe a schema for every declared non-204 2xx status. Local component response `$ref`s are resolved; a content entry without a `schema` is counted as untyped. The full operation/status gap list is available from `node scripts/check/openapi-contract-inventory.mjs --json`.",
    "",
    "## Classified non-candidate responses",
    "",
    ...renderTable(["Classification", "Operations"], exemptionRows, [1]),
    "",
    "## Response-content gap states",
    "",
    ...renderTable(["Missing response-content state", "Status occurrences"], gapStateRows, [1]),
    "",
    "## Security declarations",
    "",
    `- Operation-level declarations: ${security.operationDeclared}`,
    `- Inherited declarations: path=${security.inheritedFromPath}, root=${security.inheritedFromRoot}`,
    `- Missing effective declarations: ${security.missing}`,
    `- Invalid declarations: ${security.invalidDeclaration}`,
    `- Explicitly public (security: []): ${security.explicitPublic}`,
    `- Nonempty declarations requiring a named scheme: ${security.requiresDeclaredScheme}`,
    `- Nonempty declarations including an anonymous empty-object alternative: ${security.includesAnonymousAlternative}`,
    `- Conditional-auth language detected in operation text: ${security.conditionalAuthText}`,
    `- Conditional-auth language with an effective security declaration: ${security.conditionalAuthText - security.conditionalAuthWithMissingSecurity}`,
    `- Conditional-auth language with no effective security declaration: ${security.conditionalAuthWithMissingSecurity}`,
    "",
    "A missing security declaration is reported as undocumented, not presumed public. The conditional-auth detector is a review aid based on operation text, not an authorization evaluator. Complete missing-declaration candidates are included in the command's `--json` output.",
    "",
    "### Conditional-auth text with no effective security declaration",
    "",
    ...renderTable(
      ["Method", "Path", "operationId"],
      conditionalMissingRows.length > 0 ? conditionalMissingRows : [["(none)", "", ""]]
    ),
    "",
  ].join("\n");
}

export function loadOpenApiContractInventory(openapiPath) {
  const document = yaml.load(fs.readFileSync(openapiPath, "utf8"));
  if (!document || typeof document !== "object" || !document.paths) {
    throw new Error(`OpenAPI document has no paths object: ${openapiPath}`);
  }
  return buildOpenApiContractInventory(document);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const inventory = loadOpenApiContractInventory(path.join(root, "docs/openapi.yaml"));
  if (process.argv.includes("--json")) console.log(JSON.stringify(inventory, null, 2));
  else process.stdout.write(renderOpenApiContractInventory(inventory));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
