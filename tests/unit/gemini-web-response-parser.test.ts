import test from "node:test";
import assert from "node:assert/strict";
import { parseGeminiWebResponse as parse } from "../../open-sse/executors/gemini-web/responseParser.ts";

// Synthetic protocol fixtures, not captured authenticated traffic.
const row = (text: string) => [
  "wrb.fr",
  null,
  JSON.stringify([null, null, null, null, [[null, [text]]]]),
];
const frame = (rows: unknown[], pretty = false) => {
  const json = JSON.stringify(rows, null, pretty ? 2 : undefined);
  return `${json.length}\n${json}\n`;
};
const body = (text: string) => `)]}'\n${frame([row(text)])}`;

test("reads anti-XSSI framing in UTF-16 units including pretty JSON and emoji", () => {
  const parsed = parse(`)]}'\n${frame([row("hi 😀 café")], true)}${frame([["di", 12]])}`);
  assert.deepEqual(parsed, { text: "hi 😀 café", error: null, malformed: false, truncated: false });
});

test("decodes fragmented UTF-8 at every boundary including prefix, length, emoji", () => {
  const bytes = new TextEncoder().encode(body("answer 🦊 東京"));
  for (let at = 0; at <= bytes.length; at++) {
    assert.deepEqual(parse([bytes.slice(0, at), bytes.slice(at)]), parse(bytes), `split ${at}`);
  }
  assert.deepEqual(parse(Array.from(bytes, (_, i) => bytes.slice(i, i + 1))), parse(bytes));
});

test("last cumulative snapshot wins, even shorter revisions; all rows processed", () => {
  const raw = `)]}'\n${frame([row("hello world"), row("hello")])}${frame([row("hi"), ["di", 1]])}`;
  assert.equal(parse(raw).text, "hi");
});

test("legacy unframed rows and thoughts-only/final metadata do not erase text", () => {
  const thoughts = ["wrb.fr", null, JSON.stringify([null, null, ["thoughts"]])];
  assert.equal(
    parse(`${JSON.stringify([row("answer")])}\n${JSON.stringify([thoughts, ["di", 1]])}`).text,
    "answer"
  );
  assert.equal(parse(JSON.stringify([thoughts])).text, null);
});

test("detects EOF inside length header or framed JSON after valid partial text", () => {
  assert.equal(parse(")]}'\n123").truncated, true);
  const raw = body("partial") + frame([row("unfinished")]);
  const parsed = parse(raw.slice(0, -8));
  assert.equal(parsed.text, "partial");
  assert.equal(parsed.truncated, true);
});

test("rejects malformed marker, lengths, outer JSON and embedded payload", () => {
  for (const raw of [
    ")]}'x\n2\n[]",
    "oops\n[]",
    "0\n",
    "999999999999999999999\n",
    "3\n[x]",
    frame([["wrb.fr", null, "{"]]),
  ]) {
    assert.equal(parse(raw).malformed, true, raw);
  }
  assert.equal(parse("123\n[]").truncated, true);
});

test("invalid or incomplete UTF-8 never silently substitutes characters", () => {
  assert.equal(parse(new Uint8Array([0xff])).malformed, true);
  assert.equal(parse([new Uint8Array([0xf0, 0x9f])]).malformed, true);
});

test("embedded errors survive HTTP-200-style answer and final metadata", () => {
  for (const code of [1037, 1050, 1052, 1060, 9999, "constructor"]) {
    const errorRow = ["wrb.fr", null, null, null, null, [null, null, [[null, [code]]]]];
    const parsed = parse(frame([row("partial"), errorRow, ["di", 1]]));
    assert.equal(parsed.text, "partial");
    assert.equal(parsed.error?.code, String(code));
    assert.equal(parsed.error?.retryable, code === 1037 || code === 1060);
  }
  assert.equal(parse(body("1037 is quoted answer text")).error, null);
});

test("bounds bodies and declared frame sizes", () => {
  assert.equal(parse("16777217\n").malformed, true);
  assert.equal(parse(" ".repeat(16 * 1024 * 1024 + 1)).malformed, true);
});
