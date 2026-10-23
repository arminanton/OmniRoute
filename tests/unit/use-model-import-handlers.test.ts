import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  useModelImportHandlers,
  type UseModelImportHandlersParams,
  type UseModelImportHandlersReturn,
} from "../../src/app/(dashboard)/dashboard/providers/[id]/hooks/useModelImportHandlers";

let dom: JSDOM;
let root: Root;
let handlers: UseModelImportHandlersReturn;
const originalFetch = globalThis.fetch;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function setGlobal(name: string, value: unknown) {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function restoreGlobals() {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  savedGlobals.clear();
}

const params: UseModelImportHandlersParams = {
  providerId: "test-provider",
  models: [{ id: "known-model" }],
  modelMeta: { customModels: [] },
  modelAliases: {},
  connections: [{ id: "test-connection", isActive: true }],
  isFreeNoAuth: false,
  handleSetAlias: async () => {},
  fetchAliases: async () => {},
  fetchProviderModelMeta: async () => {},
  fetchConnections: async () => {},
  notify: { success: () => 0, error: () => 0, warning: () => 0, info: () => 0 },
  t: (() => "") as UseModelImportHandlersParams["t"],
  providerStorageAlias: "test-provider",
};

function HookHarness() {
  handlers = useModelImportHandlers(params);
  return null;
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>');
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("HTMLElement", dom.window.HTMLElement);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(dom.window.document.getElementById("root")!);
});

afterEach(() => {
  act(() => root.unmount());
  globalThis.fetch = originalFetch;
  dom.window.close();
  restoreGlobals();
});

async function importKnownModel(response: Record<string, unknown>, ok = true) {
  globalThis.fetch = (async () => ({ ok, json: async () => response })) as typeof fetch;
  await act(async () => {
    root.render(React.createElement(HookHarness));
  });
  await act(async () => {
    await handlers.handleImportModels();
  });
  return handlers.importProgress;
}

describe("useModelImportHandlers no-new-model result", () => {
  it("warns when all-known models came from the fallback local catalog", async () => {
    const progress = await importKnownModel({
      models: [{ id: "known-model" }],
      source: "api",
      catalogFallback: true,
      warning: "API unavailable — using local catalog",
    });

    assert.equal(progress.phase, "warning");
    assert.equal(
      progress.status,
      "Couldn't reach the provider's model list — showing the built-in catalog"
    );
    assert.deepEqual(progress.logs, [
      "API unavailable — using local catalog",
      "No new models to import",
    ]);
    assert.equal(progress.importedCount, 0);
    assert.equal(progress.total, 0);
    assert.equal(progress.current, 0);
  });

  it("warns when the fallback local catalog is empty", async () => {
    const progress = await importKnownModel({
      models: [],
      catalogFallback: true,
      warning: "API unavailable — using local catalog",
    });

    assert.equal(progress.phase, "warning");
    assert.equal(
      progress.status,
      "Couldn't reach the provider's model list — showing the built-in catalog"
    );
    assert.equal(progress.logs[0], "API unavailable — using local catalog");
  });

  it("keeps a fetched remote catalog with all-known models as success", async () => {
    const progress = await importKnownModel({
      models: [{ id: "known-model" }],
      source: "api",
      catalogFallback: false,
    });

    assert.equal(progress.phase, "done");
    assert.equal(progress.status, "All models already imported");
    assert.deepEqual(progress.logs, ["No new models to import"]);
    assert.equal(progress.importedCount, 0);
    assert.equal(progress.total, 0);
    assert.equal(progress.current, 0);
  });

  it("does not infer fallback from source or warning without route provenance", async () => {
    const progress = await importKnownModel({
      models: [{ id: "known-model" }],
      source: "local_catalog",
      warning: "API unavailable — using local catalog",
    });

    assert.equal(progress.phase, "done");
    assert.equal(progress.status, "All models already imported");
  });

  it("reports a failed model fetch as an error", async () => {
    const progress = await importKnownModel({ error: "Provider unavailable" }, false);

    assert.equal(progress.phase, "error");
    assert.equal(progress.error, "Provider unavailable");
  });
});
