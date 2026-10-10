import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { createDeviceFlowTicket } from "../../src/lib/oauth/deviceFlowTickets.ts";
import * as route from "../../src/app/api/codex/connect/[token]/route.ts";

const ROUTE_SOURCE = fs.readFileSync(
  new URL("../../src/app/api/codex/connect/[token]/route.ts", import.meta.url),
  "utf8",
);

const params = (token: string) => ({ params: Promise.resolve({ token }) });

async function post(token: string, body: string) {
  return route.POST(
    new Request(`http://localhost/api/codex/connect/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    params(token),
  );
}

function assertNoStore(response: Response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
}

test("public Codex connect GET responses are no-store for valid and invalid tickets", async () => {
  const pending = createDeviceFlowTicket("codex");
  const valid = await route.GET(
    new Request(`http://localhost/api/codex/connect/${pending.token}`),
    params(pending.token),
  );
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).valid, true);
  assertNoStore(valid);

  const invalid = await route.GET(
    new Request("http://localhost/api/codex/connect/not-a-ticket"),
    params("not-a-ticket"),
  );
  assert.equal(invalid.status, 404);
  assertNoStore(invalid);
});

test("public Codex connect POST rejection branches are no-store", async () => {
  const malformed = await post("not-a-ticket", "{");
  assert.equal(malformed.status, 400);
  assertNoStore(malformed);

  const invalidPayload = await post("not-a-ticket", JSON.stringify({ access_token: " " }));
  assert.equal(invalidPayload.status, 400);
  assertNoStore(invalidPayload);

  const invalidTicket = await post(
    "not-a-ticket",
    JSON.stringify({ access_token: "access-token" }),
  );
  assert.equal(invalidTicket.status, 410);
  assertNoStore(invalidTicket);
});

test("every explicit Codex connect response goes through the no-store JSON helper", () => {
  assert.equal((ROUTE_SOURCE.match(/return jsonNoStore\(/g) ?? []).length, 7);
  assert.equal((ROUTE_SOURCE.match(/NextResponse\.json\(/g) ?? []).length, 1);
  assert.match(ROUTE_SOURCE, /headers\.set\("Cache-Control", "no-store"\)/);
});
