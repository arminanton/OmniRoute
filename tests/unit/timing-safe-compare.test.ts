import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { timingSafeCompare } from "../../src/shared/utils/timingSafeCompare.ts";
import { isOwnListenerSelfHop, ownListenerSelfHopToken } from "../../open-sse/utils/selfHop.ts";

// GHSA-7434-6q4c-33fh — the OIDC callback compared the CSRF `state` cookie with
// `!==` while every sibling callback already used a constant-time compare. Low
// severity on its own (single-use nonce), but the pattern gets copied, so the
// guards below pin OIDC to the shared helper and admission to its crypto validator.

test("timingSafeCompare accepts identical values", () => {
  assert.equal(timingSafeCompare("abc123", "abc123"), true);
  assert.equal(timingSafeCompare("", ""), true);
});

test("timingSafeCompare rejects different values, including same-length ones", () => {
  assert.equal(timingSafeCompare("abc123", "abc124"), false);
  assert.equal(timingSafeCompare("abc123", "xbc123"), false);
  assert.equal(timingSafeCompare("abc", "abcdef"), false);
  assert.equal(timingSafeCompare("abcdef", "abc"), false);
});

test("timingSafeCompare compares null/undefined by identity, never as a match", () => {
  assert.equal(timingSafeCompare(null, null), true);
  assert.equal(timingSafeCompare(undefined, undefined), true);
  assert.equal(timingSafeCompare(null, undefined), false);
  assert.equal(timingSafeCompare(null, "abc"), false);
  assert.equal(timingSafeCompare("abc", undefined), false);
  assert.equal(timingSafeCompare(undefined, ""), false);
});

test("timingSafeCompare is byte-exact, not unicode-normalizing", () => {
  // "é" precomposed vs decomposed — different bytes, must not match.
  assert.equal(timingSafeCompare("é", "é"), false);
});

function sourceOf(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relPath}`, import.meta.url)), "utf8");
}

test("the OIDC callback validates `state` with the constant-time helper", () => {
  const source = sourceOf("src/app/api/auth/oidc/callback/route.ts");
  assert.ok(
    source.includes("timingSafeCompare"),
    "oidc/callback must compare the state cookie in constant time (GHSA-7434-6q4c-33fh)"
  );
  assert.ok(
    !/storedState\s*!==\s*returnedState/.test(source),
    "the short-circuiting `!==` state comparison is back"
  );
});

test("the internal admission bypass delegates both proofs to the constant-time validator", () => {
  const source = sourceOf("src/shared/middleware/chatAdmissionIdentity.ts");
  assert.match(
    source,
    /import\s*\{[^}]*\bisOwnListenerSelfHop\b[^}]*\}\s*from\s*["']@omniroute\/open-sse\/utils\/selfHop\.ts["']/,
    "admission must use the shared self-hop validator"
  );
  assert.match(
    source,
    /isOwnListenerSelfHop\(request\.headers\.get\(SELF_HOP_HEADER\)\)/,
    "the self-hop header must pass through the constant-time validator"
  );
  assert.match(
    source,
    /return\s+!!match\s*&&\s*isOwnListenerSelfHop\(match\[1\]\)/,
    "the legacy admission bearer must pass through the same validator"
  );

  const helper = sourceOf("open-sse/utils/selfHop.ts");
  assert.match(
    helper,
    /import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*["']node:crypto["']/,
    "the self-hop validator must use the crypto constant-time primitive"
  );
  const validator = /export function isOwnListenerSelfHop\([^)]*\): boolean \{([\s\S]*?)\n\}/.exec(
    helper
  )?.[1];
  assert.ok(validator, "expected the self-hop validator implementation");
  assert.match(
    validator,
    /return\s+got\.length\s*===\s*expected\.length\s*&&\s*timingSafeEqual\(got,\s*expected\);/,
    "the token buffers must have equal lengths and be compared with timingSafeEqual"
  );
});

test("the self-hop validator rejects same-length first- and last-byte token mismatches", () => {
  const token = ownListenerSelfHopToken();
  const wrongFirst = `${token[0] === "0" ? "1" : "0"}${token.slice(1)}`;
  const wrongLast = `${token.slice(0, -1)}${token.at(-1) === "0" ? "1" : "0"}`;

  assert.equal(isOwnListenerSelfHop(token), true);
  for (const wrongToken of [wrongFirst, wrongLast]) {
    assert.equal(wrongToken.length, token.length);
    assert.equal(isOwnListenerSelfHop(wrongToken), false);
  }
});
