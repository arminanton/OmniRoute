export const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

export function operationIdFor(method, pathTemplate) {
  const pascalCase = (value) =>
    value
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("");
  const segments = pathTemplate
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const parameter = /^\{(.+)\}$/.exec(segment);
      if (parameter) return `By${pascalCase(parameter[1].replace(/^\.\.\./, ""))}`;
      return pascalCase(segment);
    });
  return `${method.toLowerCase()}${segments.join("")}`;
}

function operationEntries(paths) {
  const operations = [];
  for (const [pathTemplate, pathItem] of Object.entries(paths || {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation || typeof operation !== "object")
        continue;
      operations.push({ path: pathTemplate, method: method.toUpperCase(), operation });
    }
  }
  return operations;
}

export function findOperationsMissingOperationIds(paths) {
  return operationEntries(paths)
    .filter(({ operation }) => typeof operation.operationId !== "string" || !operation.operationId.trim())
    .map(({ method, path }) => ({ method, path }));
}

export function findDuplicateOperationIds(paths) {
  const byId = new Map();
  for (const { method, path, operation } of operationEntries(paths)) {
    if (typeof operation.operationId !== "string" || !operation.operationId.trim()) continue;
    const locations = byId.get(operation.operationId) ?? [];
    locations.push({ method, path });
    byId.set(operation.operationId, locations);
  }
  return [...byId.entries()]
    .filter(([, locations]) => locations.length > 1)
    .map(([operationId, locations]) => ({ operationId, locations }));
}
