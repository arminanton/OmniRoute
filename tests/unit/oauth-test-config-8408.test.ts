// #8408: Guard against missing OAUTH_TEST_CONFIG entries for OAuth providers
import test from "node:test";
import assert from "node:assert/strict";
import { OAUTH_PROVIDERS } from "../../src/shared/constants/providers/oauth.ts";
import { OAUTH_TEST_CONFIG } from "../../src/app/api/providers/[id]/test/oauthTestConfig.ts";

// NOT a design decision — this is a grandfathered backlog. These four ids are simply the
// providers that still lack an OAUTH_TEST_CONFIG entry today, captured so this guard can be
// enforced from now on without a big-bang change. Each one is a candidate for the same
// treatment devin-cli and agy get here; removing an id from this list is the fix, not a
// regression. Do not add new ids to it — a provider added without a test config should fail
// this test at the time it is added, which is the entire point.
const GRANDFATHERED_WITHOUT_TEST_CONFIG = new Set(["qoder", "zed", "zed-hosted", "trae"]);

// Explicitly unsupported, unlike the grandfathered backlog above. Nous OAuth's
// refresh token is single-use, and there is no known safe, cheap auth-only probe.
// The test route must skip it without refreshing, inferring, or writing testStatus.
const INTENTIONALLY_UNSUPPORTED_TEST_CONFIG = new Set(["nous-oauth"]);

test("#8408: devin-cli and agy are present in OAUTH_TEST_CONFIG", () => {
  assert.ok(
    (OAUTH_TEST_CONFIG as Record<string, unknown>)["devin-cli"],
    "devin-cli must have an entry in OAUTH_TEST_CONFIG"
  );
  assert.ok(
    (OAUTH_TEST_CONFIG as Record<string, unknown>)["agy"],
    "agy must have an entry in OAUTH_TEST_CONFIG"
  );
});

test("devin-desktop connection test is import-only and not refreshable (#8228)", () => {
  const config = (OAUTH_TEST_CONFIG as Record<string, { refreshable?: boolean }>)["devin-desktop"];
  assert.ok(config, "devin-desktop must have an OAuth test config");
  assert.equal(config.refreshable, false);
});

test("#8408: every OAuth provider ID has a test config or an explicit exception", () => {
  const providerIds = Object.keys(OAUTH_PROVIDERS);
  const testConfigKeys = new Set(Object.keys(OAUTH_TEST_CONFIG));

  for (const providerId of INTENTIONALLY_UNSUPPORTED_TEST_CONFIG) {
    assert.ok(providerIds.includes(providerId), `${providerId} must be an OAuth provider`);
    assert.ok(
      !testConfigKeys.has(providerId),
      `${providerId} now has a probe; remove its exception`
    );
    assert.ok(
      !GRANDFATHERED_WITHOUT_TEST_CONFIG.has(providerId),
      `${providerId} is intentionally unsupported, not a grandfathered omission`
    );
  }

  for (const providerId of providerIds) {
    const isCovered =
      testConfigKeys.has(providerId) ||
      GRANDFATHERED_WITHOUT_TEST_CONFIG.has(providerId) ||
      INTENTIONALLY_UNSUPPORTED_TEST_CONFIG.has(providerId);
    assert.ok(
      isCovered,
      `OAuth provider '${providerId}' must have an entry in OAUTH_TEST_CONFIG or an explicit unsupported exception. ` +
        'Without one, Test Connection persists testStatus="error" on a healthy account (#8408).'
    );
  }
});
