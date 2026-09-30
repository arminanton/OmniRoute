/**
 * Regression for issue #12569: the webhook outbound-URL guard
 * (`parseAndValidateWebhookUrl`, `isPrivateHost`, `isCloudMetadataHost`) classified only the
 * literal hostname STRING in the configured webhook URL. It never resolved DNS before
 * deciding a target was public, so a domain an attacker controls (DNS A record pointed at
 * 169.254.169.254 / an RFC1918 address) passed the guard, and the real `fetch()` that
 * followed resolved DNS itself and reached the internal target (DNS rebinding).
 *
 * Fixed by `fetchWebhookUrl` (`src/shared/network/webhookFetch.ts`), which resolves DNS
 * up-front, rejects any resolved answer that is cloud-metadata/private, and pins the
 * connection to the validated address (so a *second*, real DNS lookup at connect time cannot
 * rebind to a different address either).
 *
 * Run with:
 *   node --import tsx/esm --test tests/unit/webhook-dns-rebinding-ssrf-12569.test.ts
 */

import { describe, it, mock, after } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";

import { deliverWebhook } from "../../src/lib/webhookDispatcher.ts";
import { fetchWebhookUrl } from "../../src/shared/network/webhookFetch.ts";
import { OutboundUrlGuardError } from "../../src/shared/network/outboundUrlGuard.ts";

const REBOUND_HOSTNAME = "evil.example.com";
const IMDS_ADDRESS = "169.254.169.254";

const originalLookup = dns.promises.lookup;
mock.method(dns.promises, "lookup", async (hostname: string): Promise<dns.LookupAddress[]> => {
  if (hostname === REBOUND_HOSTNAME) {
    return [{ address: IMDS_ADDRESS, family: 4 }];
  }
  return originalLookup(hostname, { all: true });
});

after(() => {
  mock.restoreAll();
});

describe("#12569 — webhook outbound guard is hostname-string-only (DNS rebinding)", () => {
  it("does NOT let a hostname that resolves to the cloud-metadata IP reach fetch()", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    // @ts-expect-error - stubbing global fetch for the probe
    globalThis.fetch = async (input: string) => {
      fetchCalls.push(String(input));
      return new Response("ok", { status: 200 });
    };

    try {
      const res = await deliverWebhook(
        `http://${REBOUND_HOSTNAME}/hook`,
        { event: "test.ping", timestamp: new Date().toISOString(), data: {} },
        "secret"
      );

      assert.equal(
        fetchCalls.length,
        0,
        `guard should have blocked dispatch to a hostname resolving to ${IMDS_ADDRESS}, ` +
          `but fetch() was called with: ${JSON.stringify(fetchCalls)}`
      );
      assert.equal(res.success, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("blocks a hostname that resolves to an RFC1918 address, without retrying", async () => {
    let lookups = 0;
    const res = await deliverWebhook(
      "http://rebind-to-lan.example.com/hook",
      { event: "test.ping", timestamp: new Date().toISOString(), data: {} },
      null,
      3,
      {
        lookup: async () => {
          lookups++;
          return [{ address: "10.1.2.3", family: 4 }];
        },
      }
    );

    assert.equal(res.success, false);
    assert.ok(
      typeof res.error === "string" && /private|blocked|local/i.test(res.error),
      `expected guard error, got: ${res.error}`
    );
    // Guard-blocked attempts must not repeat DNS or enter the backoff retry loop.
    // A wall-clock assertion is flaky when typechecks run in parallel with this suite.
    assert.equal(lookups, 1);
  });

  it("blocks when any of several resolved addresses is private (multi-A trick)", async () => {
    const fetchCalls: string[] = [];
    const res = await deliverWebhook(
      "http://multi-answer.example.com/hook",
      { event: "test.ping", timestamp: new Date().toISOString(), data: {} },
      null,
      0,
      {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
        fetchImpl: async (input: string | URL) => {
          fetchCalls.push(String(input));
          return new Response("ok", { status: 200 });
        },
      }
    );

    assert.equal(res.success, false);
    assert.equal(fetchCalls.length, 0, "fetch must never fire when any resolved IP is blocked");
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    const fetchCalls: string[] = [];
    const res = await deliverWebhook(
      "http://public-looking.example.com/hook",
      { event: "test.ping", timestamp: new Date().toISOString(), data: {} },
      null,
      0,
      {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async (input: string | URL) => {
          fetchCalls.push(String(input));
          return new Response("ok", { status: 200 });
        },
      }
    );

    assert.equal(res.success, true);
    assert.equal(fetchCalls.length, 1);
  });
});

// All transport and DNS interactions below are fake; no external DNS or HTTP requests.
const PRIVATE_OPT_IN = "OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS";
const APPROVED_HOSTS = "OMNIROUTE_ALLOWED_PRIVATE_WEBHOOK_HOSTS";
const savedPrivateOptIn = process.env[PRIVATE_OPT_IN];
const savedApprovedHosts = process.env[APPROVED_HOSTS];
after(() => {
  if (savedPrivateOptIn === undefined) delete process.env[PRIVATE_OPT_IN];
  else process.env[PRIVATE_OPT_IN] = savedPrivateOptIn;
  if (savedApprovedHosts === undefined) delete process.env[APPROVED_HOSTS];
  else process.env[APPROVED_HOSTS] = savedApprovedHosts;
});

function publicResponse() {
  return new Response("ok", { status: 200 });
}

describe("webhook DNS/pin policy — fake DNS and transport only", () => {
  it("rejects both IPv4 and IPv6 private answers, including a mixed public + private set", async () => {
    delete process.env[PRIVATE_OPT_IN];
    delete process.env[APPROVED_HOSTS];
    let calls = 0;
    for (const addresses of [
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "::1", family: 6 }],
      [
        { address: "93.184.216.34", family: 4 },
        { address: "fd00::1", family: 6 },
      ],
      [{ address: "93.184.216.34", family: 6 }], // malformed family, fail closed
    ]) {
      await assert.rejects(
        fetchWebhookUrl(
          "http://not-private.example/hook",
          { method: "POST" },
          {
            lookup: async () => addresses,
            fetchImpl: async () => {
              calls++;
              return publicResponse();
            },
          }
        ),
        OutboundUrlGuardError
      );
    }
    assert.equal(calls, 0);
  });

  it("blocks metadata hostnames even if DNS says public and full IPv6 link-local even with opt-in", async () => {
    process.env[PRIVATE_OPT_IN] = "true";
    process.env[APPROVED_HOSTS] = "metadata.google.internal,link.example";
    let lookups = 0;
    let fetches = 0;
    for (const url of [
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://metadata.goog/latest/",
      "http://link.example/hook",
      "http://[fe90::1]/hook",
    ]) {
      await assert.rejects(
        fetchWebhookUrl(
          url,
          { method: "POST" },
          {
            lookup: async () => {
              lookups++;
              return [
                {
                  address: url.includes("link.example") ? "feb0::1" : "8.8.8.8",
                  family: url.includes("link.example") ? 6 : 4,
                },
              ];
            },
            fetchImpl: async () => {
              fetches++;
              return publicResponse();
            },
          }
        ),
        OutboundUrlGuardError
      );
    }
    assert.equal(lookups, 1, "literal metadata and IPv6 link-local must be blocked before DNS");
    assert.equal(fetches, 0);
  });

  it("keeps explicit LAN opt-in, but does not let provider-wide opt-in approve arbitrary rebinding", async () => {
    process.env[PRIVATE_OPT_IN] = "true";
    delete process.env[APPROVED_HOSTS];
    const addresses = async () => [{ address: "192.168.1.10", family: 4 }];
    let fetches = 0;
    const fakeFetch = async () => {
      fetches++;
      return publicResponse();
    };
    const lan = await fetchWebhookUrl(
      "http://homeassistant.local/hook",
      { method: "POST" },
      {
        lookup: addresses,
        fetchImpl: fakeFetch,
      }
    );
    assert.equal(lan.redactBody, true);
    await lan.response.body?.cancel();
    assert.equal(fetches, 1);
    await assert.rejects(
      fetchWebhookUrl(
        "http://attacker.example/hook",
        { method: "POST" },
        {
          lookup: addresses,
          fetchImpl: fakeFetch,
        }
      ),
      OutboundUrlGuardError
    );
    assert.equal(fetches, 1);
  });

  it("allows exactly approved tailnet hostname to resolve private and requires response redaction", async () => {
    delete process.env[PRIVATE_OPT_IN];
    process.env[APPROVED_HOSTS] = "hooks.tailnet.ts.net";
    const addresses = async () => [{ address: "100.101.102.103", family: 4 }];
    let fetches = 0;
    const fakeFetch = async () => {
      fetches++;
      return publicResponse();
    };
    const result = await fetchWebhookUrl(
      "https://hooks.tailnet.ts.net/hook",
      { method: "POST" },
      {
        lookup: addresses,
        fetchImpl: fakeFetch,
      }
    );
    assert.equal(result.redactBody, true);
    await result.response.body?.cancel();
    await assert.rejects(
      fetchWebhookUrl(
        "https://evil.hooks.tailnet.ts.net/hook",
        { method: "POST" },
        {
          lookup: addresses,
          fetchImpl: fakeFetch,
        }
      ),
      OutboundUrlGuardError
    );
    assert.equal(fetches, 1);
    await assert.rejects(
      fetchWebhookUrl(
        "https://hooks.tailnet.ts.net/hook",
        { method: "POST" },
        {
          lookup: async () => [{ address: "100.100.100.200", family: 4 }],
          fetchImpl: fakeFetch,
        }
      ),
      OutboundUrlGuardError
    );
    assert.equal(fetches, 1);
  });

  it("revalidates redirect DNS before second fetch and cancels redirect body", async () => {
    delete process.env[PRIVATE_OPT_IN];
    delete process.env[APPROVED_HOSTS];
    let fetches = 0;
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      {
        status: 302,
        headers: { location: "http://second.example/internal" },
      }
    );
    await assert.rejects(
      fetchWebhookUrl(
        "http://first.example/hook",
        { method: "POST" },
        {
          lookup: async (host) => [
            { address: host === "first.example" ? "93.184.216.34" : "10.0.0.1", family: 4 },
          ],
          fetchImpl: async () => {
            fetches++;
            return response;
          },
        }
      ),
      OutboundUrlGuardError
    );
    assert.equal(fetches, 1);
    assert.equal(canceled, true);
  });

  it("blocks altered origin before body, HMAC, or arbitrary auth headers can leave", async () => {
    delete process.env[PRIVATE_OPT_IN];
    delete process.env[APPROVED_HOSTS];
    let sends = 0;
    for (const status of [301, 302, 303, 307, 308]) {
      await assert.rejects(
        fetchWebhookUrl(
          "https://first.example/hook",
          {
            method: "POST",
            body: "private-payload",
            headers: { "X-Webhook-Signature": "sha256=secret", "X-API-Key": "secret" },
          },
          {
            lookup: async () => [{ address: "93.184.216.34", family: 4 }],
            fetchImpl: async () => {
              sends++;
              return new Response(null, {
                status,
                headers: { location: "https://other.example/hook" },
              });
            },
          }
        ),
        /cross-origin.*blocked/i
      );
    }
    assert.equal(sends, 5);
  });

  it("re-resolves a same-origin redirect and blocks a rebound DNS answer", async () => {
    let resolutions = 0;
    let sends = 0;
    await assert.rejects(
      fetchWebhookUrl(
        "https://first.example/hook",
        { method: "POST", body: "data" },
        {
          lookup: async () => [
            { address: ++resolutions === 1 ? "93.184.216.34" : "169.254.169.254", family: 4 },
          ],
          fetchImpl: async () => {
            sends++;
            return new Response(null, { status: 307, headers: { location: "/next" } });
          },
        }
      ),
      /blocked/i
    );
    assert.equal(resolutions, 2);
    assert.equal(sends, 1);
  });

  it("stops waiting for a hung resolver after the caller aborts, without transport calls", async () => {
    delete process.env[PRIVATE_OPT_IN];
    delete process.env[APPROVED_HOSTS];
    const controller = new AbortController();
    let fetches = 0;
    const pending = fetchWebhookUrl(
      "https://hung.example/hook",
      { method: "POST" },
      {
        lookup: async () => new Promise<never>(() => {}),
        fetchImpl: async () => {
          fetches++;
          return publicResponse();
        },
        signal: controller.signal,
      }
    );
    controller.abort(new DOMException("Aborted", "AbortError"));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(fetches, 0);
  });
});
