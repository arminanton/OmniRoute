import test from "node:test";
import assert from "node:assert/strict";
import { parseGeminiWebAccountModels as parse } from "../../open-sse/executors/gemini-web/accountModels.ts";

// Synthetic protocol fixtures only. No authenticated captures or copied upstream code.
const payload = (entries: unknown = [["opaque-A", "Pro", "More reasoning"]], status = 1000) => {
  const body = Array(17).fill(null);
  body[14] = status;
  body[15] = entries;
  return body;
};
const row = (body: unknown = payload(), rpc = "uqlm3e") => ["wrb.fr", rpc, JSON.stringify(body)];
const frame = (rows: unknown[], pretty = false) => {
  const json = JSON.stringify(rows, null, pretty ? 2 : undefined);
  return `${json.length}\n${json}\n`;
};
const response = (body: unknown = payload()) => `)]}'\n${frame([row(body)])}`;

test("reads only account-status RPC, retaining opaque IDs without version guesses", () => {
  const raw = `)]}'\n${frame([row(payload(), "other"), row()], true)}${frame([["di", 1]])}`;
  assert.deepEqual(parse(raw), [
    { id: "opaque-A", displayName: "Pro", description: "More reasoning" },
  ]);
});

test("catalogs stay account-specific and preserve Unicode and duplicate display names", () => {
  assert.deepEqual(
    parse(
      response(
        payload([
          ["B", "Pro 🦊", "東京"],
          ["C", "Pro 🦊", ""],
        ])
      )
    ),
    [
      { id: "B", displayName: "Pro 🦊", description: "東京" },
      { id: "C", displayName: "Pro 🦊", description: "" },
    ]
  );
  assert.equal(parse(response())[0].id, "opaque-A");
});

test("rejects missing, unauthenticated, restricted, and unknown account status", () => {
  for (const status of [0, 1014, 1016, 1021, 1033, 9999]) {
    assert.throws(() => parse(response(payload(undefined, status))), /catalog unavailable/);
  }
  assert.throws(() => parse(response([])), /catalog unavailable/);
  assert.throws(() => parse(frame([row(payload(), "other")])), /Invalid/);
});

test("rejects incomplete, malformed, oversized, and ambiguous catalogs", () => {
  for (const entries of [
    null,
    [],
    [null],
    [["A", "Pro"]],
    [["", "Pro", ""]],
    [["A", "", ""]],
    [[1, "Pro", ""]],
    [["A", "Pro", 1]],
    [
      ["A", "Pro", ""],
      ["A", "Fast", ""],
    ],
    Array(129).fill(["A", "Pro", ""]),
    [["x".repeat(257), "Pro", ""]],
    [["A", "x".repeat(513), ""]],
    [["A", "Pro", "x".repeat(8193)]],
  ]) {
    assert.throws(() => parse(response(payload(entries))), /Invalid/);
  }
  const valid = response();
  for (const raw of [
    "",
    "garbage",
    "0\n",
    "9999999\n[]",
    "2\n{}",
    "1\n[",
    valid.slice(0, -3),
    valid + "4\n[",
    "x".repeat(2 * 1024 * 1024 + 1),
    frame([["wrb.fr", "uqlm3e", "bad-json"]]),
    frame([row(), row()]),
  ]) {
    assert.throws(() => parse(raw), /Invalid/);
  }
});

test("errors never include raw upstream data", () => {
  const secret = "synthetic-token-never-echo";
  assert.throws(
    () => parse(frame([["wrb.fr", "uqlm3e", secret]])),
    (error: Error) => {
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
});
