import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const base = new URL("../../scripts/deploy/residential/", import.meta.url);
test("host API forward listens on loopback only and retains isolated backend", () => {
  const socket = fs.readFileSync(new URL("omni-api-local.socket", base), "utf8");
  const service = fs.readFileSync(new URL("omni-api-local.service", base), "utf8");
  assert.deepEqual(socket.split("\n").filter(x => x.startsWith("ListenStream=")),
    ["ListenStream=127.0.0.1:20129", "ListenStream=[::1]:20129"]);
  assert.match(service, /NetworkNamespacePath=\/run\/netns\/omni-wan/);
  assert.match(service, /systemd-socket-proxyd .*10\.203\.242\.2:20129/);
  assert.match(service, /CapabilityBoundingSet=\n/);
  assert.doesNotMatch(socket + service, /Authorization|Bearer|API_KEY|iptables|nft /);
});
