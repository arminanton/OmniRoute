import test from "node:test";
import assert from "node:assert/strict";
import { resolveStandaloneAppRuntime } from "../../scripts/perf/bench-standalone-antigravity-tool-roundtrip.mjs";

test("standalone E2E app runtime defaults to the harness Node executable", () => {
  const runtime = resolveStandaloneAppRuntime({
    env: {},
    defaultExecutable: "/usr/bin/node",
    inheritedPath: "/usr/local/bin:/usr/bin:/bin",
  });

  assert.deepEqual(runtime, {
    executable: "/usr/bin/node",
    searchPath: "/usr/bin:/usr/local/bin:/usr/bin:/bin",
  });
});

test("standalone E2E app runtime override selects only an absolute app executable", () => {
  const runtime = resolveStandaloneAppRuntime({
    env: { OMNIROUTE_STANDALONE_APP_EXECUTABLE: "/opt/bun/bin/bun" },
    defaultExecutable: "/usr/bin/node",
    inheritedPath: "/usr/local/bin:/usr/bin:/bin",
  });

  assert.deepEqual(runtime, {
    executable: "/opt/bun/bin/bun",
    searchPath: "/opt/bun/bin:/usr/local/bin:/usr/bin:/bin",
  });
});

test("standalone E2E rejects relative app runtime overrides", () => {
  assert.throws(
    () =>
      resolveStandaloneAppRuntime({
        env: { OMNIROUTE_STANDALONE_APP_EXECUTABLE: "bun" },
        defaultExecutable: "/usr/bin/node",
        inheritedPath: "/usr/bin:/bin",
      }),
    /must be an absolute executable path/
  );
});

test("standalone E2E rejects an explicitly empty app runtime override", () => {
  assert.throws(
    () =>
      resolveStandaloneAppRuntime({
        env: { OMNIROUTE_STANDALONE_APP_EXECUTABLE: " " },
        defaultExecutable: "/usr/bin/node",
        inheritedPath: "/usr/bin:/bin",
      }),
    /must not be empty/
  );
});
