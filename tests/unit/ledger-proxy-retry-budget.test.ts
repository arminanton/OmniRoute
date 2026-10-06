import { isUncertainGenerationAcceptance } from "../../open-sse/services/generationReplay.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyFetch } from "../../open-sse/utils/proxyFetch.ts";
import {
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
  runGenerationDispatch,
} from "../../open-sse/services/logicalRetryBudget.ts";

test("uncertain generation dispatch never replays on fresh socket or native fallback", async () => {
  const names = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "PROXY_AUTO_SELECT_ENABLED",
  ];
  const old = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  for (const k of names) delete process.env[k];
  process.env.PROXY_AUTO_SELECT_ENABLED = "false";
  let dispatched = 0,
    native = 0;
  const b = new LogicalRetryBudget(2, Date.now() + 10000);
  try {
    await assert.rejects(
      runWithLogicalRetryBudget(b, () =>
        runGenerationDispatch(() =>
          proxyFetch(
            "https://generation.example/v1/responses",
            { method: "POST", body: "{}" },
            {
              undiciFetch: async () => {
                dispatched++;
                throw Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" });
              },
              nativeFetch: async () => {
                native++;
                return new Response("unexpected");
              },
            }
          )
        )
      ),
      isUncertainGenerationAcceptance
    );
    assert.equal(dispatched, 1);
    assert.equal(native, 0);
    assert.equal(b.snapshot().attempts, 1);
  } finally {
    for (const k of names) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
});
