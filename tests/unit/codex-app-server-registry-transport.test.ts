import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("first-class Codex app-server executor receives the native WebSocket transport", () => {
  const source = fs.readFileSync("open-sse/executors/index.ts", "utf8");
  assert.match(
    source,
    /CodexAppServerExecutor\(\s*\{ websocketFn: codex\.getCodexAppServerWebsocketTransport\(\) \}/
  );
  assert.doesNotMatch(source, /new m\.CodexAppServerExecutor\(\{\}, "codex-app-server"\)/);
});
