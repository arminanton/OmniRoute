/**
 * QA P0 (security) — provider-validation SSRF guard.
 *
 * `directHttpsRequest` (used by web-cookie / NVIDIA / Z.AI validation, all of
 * which accept a caller-controllable baseUrl) previously ran with
 * `guard: "none"` + `allowRedirect: true`, i.e. an open relay to cloud-metadata
 * endpoints. It now runs with `getProviderValidationGuard()` (default
 * "block-metadata") + `allowRedirect: false`. These tests assert the guard
 * rejects IMDS / link-local targets BEFORE any network call, while ordinary
 * public hosts still pass the guard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installPinnedTransport } from "../helpers/pinnedTransport.ts";

const { directHttpsRequest } = await import("../../src/lib/providers/validation/headers.ts");

const METADATA_TARGETS = [
  "http://169.254.169.254/latest/meta-data/", // AWS/GCP IMDS
  "http://[fd00:ec2::254]/latest/meta-data/", // AWS IMDSv6
  "http://metadata.google.internal/computeMetadata/v1/", // GCP metadata host
];

for (const url of METADATA_TARGETS) {
  test(`SSRF: directHttpsRequest blocks cloud-metadata target ${url}`, async (t) => {
    const transport = installPinnedTransport(t.mock, {
      reply() {
        assert.fail("blocked metadata target must not open a native socket");
      },
    });
    t.after(transport.restore);
    await assert.rejects(
      () => directHttpsRequest(url, { method: "GET" }, 2000),
      (err: unknown) => {
        const msg = String((err as Error)?.message ?? err);
        // Must be a guard rejection, not a network timeout/connect error — i.e.
        // the request was refused before any socket was opened.
        assert.match(msg, /guard|metadata|blocked|not allowed|URL/i, `expected guard block, got: ${msg}`);
        return true;
      }
    );
    assert.equal(transport.resolutions.length, 0);
    assert.equal(transport.dials.length, 0);
  });
}

test("SSRF: directHttpsRequest rejects reserved documentation addresses before transport", async (t) => {
  const transport = installPinnedTransport(t.mock, {
    reply() {
      assert.fail("reserved target must not open a native socket");
    },
  });
  t.after(transport.restore);
  await assert.rejects(
    () => directHttpsRequest("http://192.0.2.1:9/models", { method: "GET" }, 1500),
    (err: unknown) => {
      const msg = String((err as Error)?.message ?? err);
      assert.match(msg, /guard|metadata|blocked|not allowed|URL/i, `expected guard block, got: ${msg}`);
      return true;
    }
  );
  assert.equal(transport.resolutions.length, 0);
  assert.equal(transport.dials.length, 0);
});

test("SSRF: a normal public provider host is NOT blocked by the guard", async (t) => {
  // Unlike TEST-NET-1, this is a public literal. The strict native socket fixture
  // returns the response in memory, so this test cannot send real network traffic.
  const transport = installPinnedTransport(t.mock, {
    reply(socket, dial) {
      assert.equal(dial.protocol, "http:");
      assert.equal(dial.options.host, "93.184.216.34");
      assert.equal(Number(dial.options.port), 8080);
      assert.match(socket.request, /^GET \/models HTTP\/1\.1\r\n/);
      socket.respond({
        headers: { "content-type": "application/json" },
        body: '{"data":[]}',
      });
    },
  });
  t.after(transport.restore);
  let patchedFetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    patchedFetchCalls++;
    assert.fail("direct provider validation must use native transport");
  });
  const response = await directHttpsRequest("http://93.184.216.34:8080/models", { method: "GET" }, 1500);
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"data":[]}');
  assert.equal(patchedFetchCalls, 0);
  assert.equal(transport.resolutions.length, 0);
  assert.equal(transport.dials.length, 1);
  transport.restore();
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[0].destroyed, true);
});
