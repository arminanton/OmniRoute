#!/usr/bin/env node
// scripts/check/check-openapi-routes.mjs
// Gate anti-alucinação (docs): toda `path` documentada em docs/openapi.yaml
// deve resolver para um route.ts real em src/app/api/. Pega endpoint INVENTADO/obsoleto
// na spec (a IA escreve docs descrevendo rota que não existe). Complementa
// check-openapi-coverage.mjs (que mede a direção inversa: % de rotas documentadas).
// Stale-enforcement (6A.3): entrada em KNOWN_STALE_SPEC que não suprime nenhum path
// órfão real → gate falha com instrução de remoção (evita furo de regressão silencioso).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import { reportStaleEntries } from "./lib/allowlist.mjs";
import { apiRoot, collectApiRouteDefinitions, collectApiRouteUrlPaths } from "./lib/apiRoutes.mjs";
import {
  findDuplicateOperationIds,
  findOperationsMissingOperationIds,
} from "./lib/openapiOperationIds.mjs";

const ROOT = process.cwd();
const OPENAPI_PATH = path.join(ROOT, "docs", "openapi.yaml");

// Entradas da spec sem rota real, congeladas para triagem (catraca: bloqueia NOVAS).
export const KNOWN_STALE_SPEC = new Set([
  // openapi.yaml documenta um state por-agente, mas a rota real é o state GLOBAL
  // (/api/tools/agent-bridge/state); por-agente só há /{id}, /{id}/detect, /mappings, /dns.
]);

/** Normaliza qualquer {param} para {} para casar independente do nome do parâmetro. */
export function normalizeParams(p) {
  return p.replace(/\{[^}]+\}/g, "{}");
}

/** Paths da spec que não casam com nenhuma rota implementada (param-insensitive). */
export function findSpecPathsWithoutRoute(specPaths, implPaths) {
  const impl = new Set(implPaths.map(normalizeParams));
  return specPaths.filter((p) => !impl.has(normalizeParams(p)));
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

function resolveParameter(parameter, components) {
  if (!parameter || typeof parameter !== "object") return null;
  const ref = parameter.$ref;
  if (typeof ref === "string" && ref.startsWith("#/components/parameters/")) {
    const name = ref.slice("#/components/parameters/".length);
    return components?.parameters?.[name] ?? null;
  }
  return parameter;
}

function pathParameterNames(parameters, components) {
  const names = new Set();
  for (const parameter of Array.isArray(parameters) ? parameters : []) {
    const resolved = resolveParameter(parameter, components);
    if (resolved?.in === "path" && typeof resolved.name === "string") names.add(resolved.name);
  }
  return names;
}

/** Find operations that do not declare every path template variable. */
export function findOperationsMissingPathParameters(paths, components = {}) {
  const missing = [];
  for (const [pathTemplate, pathItem] of Object.entries(paths || {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    const requiredNames = [...pathTemplate.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    if (requiredNames.length === 0) continue;
    const inherited = pathParameterNames(pathItem.parameters, components);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation || typeof operation !== "object") {
        continue;
      }
      const declared = new Set([
        ...inherited,
        ...pathParameterNames(operation.parameters, components),
      ]);
      const absent = requiredNames.filter((name) => !declared.has(name));
      if (absent.length) missing.push({ method: method.toUpperCase(), path: pathTemplate, missing: absent });
    }
  }
  return missing;
}

/** Compare explicitly exported route methods with methods in the OpenAPI path inventory. */
export function findRouteMethodMismatches(paths, routeDefinitions) {
  const specByNormalizedPath = new Map(
    Object.keys(paths || {}).map((pathTemplate) => [normalizeParams(pathTemplate), pathTemplate])
  );
  const mismatches = [];
  for (const [routePath, routeMethods] of routeDefinitions) {
    const specPath = specByNormalizedPath.get(normalizeParams(routePath));
    if (!specPath) continue;
    const operationMethods = new Set(
      Object.keys(paths[specPath] || {})
        .filter((method) => HTTP_METHODS.has(method.toLowerCase()))
        .map((method) => method.toUpperCase())
    );
    const expectedMethods = new Set(routeMethods);
    const missing = [...expectedMethods].filter((method) => !operationMethods.has(method));
    const extra = [...operationMethods].filter((method) => !expectedMethods.has(method));
    if (missing.length || extra.length) {
      mismatches.push({ path: specPath, missing: missing.sort(), extra: extra.sort() });
    }
  }
  return mismatches;
}

/**
 * @param {{ root?: string, openapiPath?: string, implPaths?: string[] }} [opts]
 * @returns {{ ok: boolean, exitCode: number, message: string }}
 */
export function runOpenapiRoutesCheck(opts = {}) {
  const root = opts.root || ROOT;
  const openapiPath = opts.openapiPath || path.join(root, "docs", "openapi.yaml");
  if (!fs.existsSync(openapiPath)) {
    return {
      ok: false,
      exitCode: 1,
      message: `[openapi-routes] FAIL — openapi.yaml não encontrado: ${openapiPath}`,
    };
  }
  if (!fs.existsSync(apiRoot(root))) {
    return {
      ok: false,
      exitCode: 1,
      message: `[openapi-routes] FAIL — API root not found: ${apiRoot(root)}`,
    };
  }

  const raw = yaml.load(fs.readFileSync(openapiPath, "utf-8"));
  const specPaths = Object.keys(raw.paths || {}).filter((p) => p.startsWith("/api"));
  const routeDefinitions = opts.routeDefinitions || collectApiRouteDefinitions(root);
  const implPaths = opts.implPaths || collectApiRouteUrlPaths(root);

  const liveOrphans = findSpecPathsWithoutRoute(specPaths, implPaths);
  const stale = reportStaleEntries(KNOWN_STALE_SPEC, liveOrphans, "openapi-routes");
  const orphans = liveOrphans.filter((p) => !KNOWN_STALE_SPEC.has(p));

  const parts = [];
  if (stale.length) {
    parts.push(
      `[openapi-routes] ${stale.length} entrada(s) obsoleta(s) na allowlist ` +
        `— a violação foi corrigida; REMOVA a entrada para travar a correção:\n` +
        stale.map((e) => `  ✗ ${e}`).join("\n")
    );
  }
  if (orphans.length) {
    parts.push(
      `[openapi-routes] ${orphans.length} path(s) documentado(s) sem rota real:\n` +
        orphans.map((p) => "  ✗ " + p).join("\n") +
        `\n  → crie a rota, corrija/remova a entrada na spec, ou adicione a KNOWN_STALE_SPEC com justificativa.`
    );
  }
  const missingParameters = findOperationsMissingPathParameters(raw.paths, raw.components);
  if (missingParameters.length) {
    parts.push(
      `[openapi-routes] ${missingParameters.length} operation(s) omit path parameter declarations:\n` +
        missingParameters
          .map(({ method, path: route, missing: names }) => `  ✗ ${method} ${route}: ${names.join(", ")}`)
          .join("\n")
    );
  }
  const methodMismatches = findRouteMethodMismatches(raw.paths, routeDefinitions);
  if (methodMismatches.length) {
    parts.push(
      `[openapi-routes] ${methodMismatches.length} path(s) have methods that differ from their route handlers:\n` +
        methodMismatches
          .map(({ path: route, missing, extra }) =>
            `  ✗ ${route}: missing [${missing.join(", ")}]; undocumented [${extra.join(", ")}]`
          )
          .join("\n")
    );
  }
  const missingOperationIds = findOperationsMissingOperationIds(raw.paths);
  if (missingOperationIds.length) {
    parts.push(
      `[openapi-routes] ${missingOperationIds.length} operation(s) omit operationId:\n` +
        missingOperationIds
          .map(({ method, path: route }) => `  ✗ ${method} ${route}`)
          .join("\n")
    );
  }
  const duplicateOperationIds = findDuplicateOperationIds(raw.paths);
  if (duplicateOperationIds.length) {
    parts.push(
      `[openapi-routes] ${duplicateOperationIds.length} duplicate operationId value(s):\n` +
        duplicateOperationIds
          .map(({ operationId, locations }) =>
            `  ✗ ${operationId}: ${locations.map(({ method, path }) => `${method} ${path}`).join(", ")}`
          )
          .join("\n")
    );
  }
  if (parts.length) {
    return { ok: false, exitCode: 1, message: parts.join("\n") };
  }
  return {
    ok: true,
    exitCode: 0,
    message: `[openapi-routes] OK — ${specPaths.length} paths na spec, todos com rota real (${implPaths.length} rotas)`,
  };
}

function main() {
  // Keep assertNoStale side-effect path for CLI parity with other gates when
  // runOpenapiRoutesCheck is not used alone — here we print structured result.
  const result = runOpenapiRoutesCheck();
  if (result.ok) console.log(result.message);
  else console.error(result.message);
  process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
