import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MockAgent, fetch as httpFetch, Headers as HttpHeaders } from "undici";

import { pollAdobeJob } from "../../open-sse/services/adobeFireflyPoll.ts";
import {
  extractAdobeResultLink,
  normalizeAdobePollUrl,
} from "../../open-sse/services/adobeFireflyResponses.ts";
import { RemoteMediaFetchError } from "../../src/shared/network/remoteImageFetch.ts";

const FIXED_ORIGIN = "https://firefly-3p.ff.adobe.io";
const EPO_ORIGIN = "https://firefly-epo855232.adobe.io";
const BKS_ORIGIN = "https://bks-epo8552.adobe.io";
const BKS_QUERY = "?host=firefly-epo855232.adobe.io";
const POLL = `${BKS_ORIGIN}/v2/jobs/result/job-42${BKS_QUERY}`;
const RAW_RESULT = `${EPO_ORIGIN}/jobs/result/job-42`;
const TOKEN = "synthetic-adobe-poll-token";
const IMAGE = "https://cdn.example.test/out.png";
const COMPLETE = { outputs: [{ image: { presignedUrl: IMAGE } }] };

const originalDataDir = process.env.DATA_DIR;
const testDataDir = mkdtempSync(join(tmpdir(), "adobe-poll-boundary-"));
process.env.DATA_DIR = testDataDir;
test.after(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

function isBoundaryFailure(error: unknown): boolean {
  assert.ok(error instanceof RemoteMediaFetchError);
  assert.equal(error.retryable, false);
  assert.equal(error.status, 400);
  assert.ok(!error.message.includes(TOKEN));
  assert.ok(!error.message.includes("attacker.example"));
  return true;
}

function poll(pollUrl: string, fetchImpl: typeof fetch) {
  return pollAdobeJob({
    pollUrl,
    accessToken: TOKEN,
    kind: "image",
    timeoutMs: 1000,
    pollIntervalMs: 1,
    fetchImpl,
  });
}

const deniedUrls = [
  "",
  "/jobs/result/job-42",
  "//firefly-3p.ff.adobe.io/jobs/result/job-42",
  "https:firefly-3p.ff.adobe.io/jobs/result/job-42",
  "https:////firefly-3p.ff.adobe.io/jobs/result/job-42",
  "http://firefly-3p.ff.adobe.io/jobs/result/job-42",
  "ftp://firefly-3p.ff.adobe.io/jobs/result/job-42",
  "file:///etc/passwd",
  "http://127.0.0.1/internal",
  "https://169.254.169.254/latest/meta-data",
  "https://[::1]/internal",
  "https://[::ffff:127.0.0.1]/internal",
  "https://attacker.example/steal",
  "https://poll.example/job/1",
  "https://firefly.adobe.com/jobs/result/job-42",
  "https://firefly.adobe.io/jobs/result/job-42",
  "https://other.adobe.io/jobs/result/job-42",
  "https://firefly-3p.ff.adobe.io.attacker.example/jobs/result/job-42",
  "https://extra.firefly-3p.ff.adobe.io/jobs/result/job-42",
  "https://firefly-3p.ff.adobe.io./jobs/result/job-42",
  "https://firefly-3p.ff.adobe.io:444/jobs/result/job-42",
  "https://user:pass@firefly-3p.ff.adobe.io/jobs/result/job-42",
  "https://@firefly-3p.ff.adobe.io/jobs/result/job-42",
  `${FIXED_ORIGIN}/jobs/result/job-42#fragment`,
  `${FIXED_ORIGIN}/jobs/result/job-42#`,
  ` ${FIXED_ORIGIN}/jobs/result/job-42`,
  `${FIXED_ORIGIN}/jobs/result/job-42\n`,
  `${FIXED_ORIGIN}/jobs/result/\\job-42`,
  `${FIXED_ORIGIN}/jobs/result/${"a".repeat(4096)}`,
  "https://firefly-epo999999.adobe.io/jobs/result/job-42",
  "https://firefly-epo855299.adobe.io/jobs/result/job-42",
  "https://firefly-epo855232.attacker.example/jobs/result/job-42",
  "https://firefly-epo855232.adobe.io.attacker.example/jobs/result/job-42",
  "https://user@firefly-epo855232.adobe.io/jobs/result/job-42",
  "http://firefly-epo855232.adobe.io/jobs/result/job-42",
  "https://firefly-epo855232.adobe.io:8443/jobs/result/job-42",
  `${EPO_ORIGIN}/v2/status/job-42`,
  `${EPO_ORIGIN}/status/job-42`,
  `${EPO_ORIGIN}/other/jobs/result/job-42`,
  `${EPO_ORIGIN}/jobs/result/`,
  `${RAW_RESULT}?host=attacker.example`,
  `${RAW_RESULT}?opaque=discarded`,
  `${RAW_RESULT}?`,
  `${EPO_ORIGIN}/jobs/result/../job-42`,
  `${EPO_ORIGIN}/jobs/result/%2e%2e/job-42`,
  `${EPO_ORIGIN}/jobs/result/job-42/../../admin`,
  `${EPO_ORIGIN}/jobs/result/job-42%5c..%5c..%5cadmin`,
  `${EPO_ORIGIN}/jobs/result/job-42#`,
  "https://bks-epo9999.adobe.io/v2/jobs/result/job-42?host=firefly-epo855232.adobe.io",
  `${BKS_ORIGIN}/v2/jobs/result/job-42`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=firefly-epo999999.adobe.io`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=attacker.example`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=https://firefly-epo855232.adobe.io`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=127.0.0.1`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=169.254.169.254`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=[::1]`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=firefly-epo855232.adobe.io:443`,
  `${POLL}&host=firefly-epo855232.adobe.io`,
  `${POLL}&host=attacker.example`,
  `${POLL}&Host=attacker.example`,
  `${POLL}&url=https://attacker.example`,
  `${POLL}&unknown=1`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?Host=firefly-epo855232.adobe.io`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?%68ost=firefly-epo855232.adobe.io`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=firefly-epo855232%2eadobe.io`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=FIREFLY-EPO855232.ADOBE.IO`,
  `${BKS_ORIGIN}/v2/jobs/result/job-42?host=firefly-epo855232.adobe.io;host=attacker.example`,
  `${EPO_ORIGIN}/jobs/result/%2e%2e%2fadmin`,
  `${EPO_ORIGIN}/jobs/result/%zz`,
  `${EPO_ORIGIN}/jobs/result/job-42%0a`,
  `${EPO_ORIGIN}/jobs/result/job-42%00`,
  `${EPO_ORIGIN}/jobs/result/job-42%C2%85`,
  `${EPO_ORIGIN}/jobs/result/${"a".repeat(4030)}`,
  `${FIXED_ORIGIN}/jobs/result/${"é".repeat(700)}`,
  `${FIXED_ORIGIN}/jobs/result/job-42?token=${"é".repeat(700)}`,
  "https://%66irefly-3p.ff.adobe.io/jobs/result/job-42",
  `${FIXED_ORIGIN}/jobs/result/job-42\u0000`,
  `${FIXED_ORIGIN}/jobs/result/job-42\u0085`,
];

for (const [index, url] of deniedUrls.entries()) {
  test(`Adobe rejects unapproved poll URL ${index} before Bearer send`, async () => {
    let sends = 0;
    await assert.rejects(
      () =>
        poll(url, async () => {
          sends++;
          return Response.json(COMPLETE);
        }),
      isBoundaryFailure
    );
    assert.equal(sends, 0);
    assert.throws(() => normalizeAdobePollUrl(url), isBoundaryFailure);
  });
}

test("Adobe poll checks its own input before it even reads the access token", async () => {
  let tokenReads = 0;
  await assert.rejects(
    () =>
      pollAdobeJob({
        pollUrl: "https://attacker.example/steal",
        get accessToken() {
          tokenReads++;
          return TOKEN;
        },
        kind: "image",
        timeoutMs: 1000,
        fetchImpl: async () => Response.json(COMPLETE),
      }),
    isBoundaryFailure
  );
  assert.equal(tokenReads, 0);
});

test("Adobe result extraction must not trim unsafe raw override values into trusted URLs", () => {
  const rawOverride = `${FIXED_ORIGIN}/jobs/result/job-42\n`;
  const result = extractAdobeResultLink({ "x-override-status-link": rawOverride }, {});
  assert.equal(result, rawOverride);
  assert.throws(() => normalizeAdobePollUrl(result), isBoundaryFailure);
});

test("Adobe preserves only the evidenced EPO mapping without a new job-ID grammar", async () => {
  for (const suffix of [
    "job-42",
    "4ae9fd2a-0864-46dd-9834-cfc16e91faa6",
    "opaque+_~%2F%3D/nested-token",
  ]) {
    const raw = `${EPO_ORIGIN}/jobs/result/${suffix}`;
    const expected = `${BKS_ORIGIN}/v2/jobs/result/${suffix}${BKS_QUERY}`;
    assert.equal(normalizeAdobePollUrl(raw), expected);
    assert.equal(normalizeAdobePollUrl(expected), expected);
    const calls: string[] = [];
    const result = await poll(raw, async (input, init) => {
      calls.push(String(input));
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      assert.equal(new Headers(init?.headers).get("x-api-key"), null);
      assert.equal(init?.redirect, "manual");
      return Response.json(COMPLETE);
    });
    assert.deepEqual(calls, [expected]);
    assert.equal(result.mediaUrl, IMAGE);
  }
});

test("Adobe fixed3p keeps same-origin paths and queries; default HTTPS ports remain valid", async () => {
  for (const url of [
    `${FIXED_ORIGIN}/opaque/result-path?token=Opaque%2F%2B%3D+%26&state=1&state=2`,
    "https://FIREFLY-3P.FF.ADOBE.IO:443/arbitrary/status/path?result=x",
    "https://bks-epo8552.adobe.io:443/v2/jobs/result/job-42?host=firefly-epo855232.adobe.io",
  ]) {
    assert.equal(normalizeAdobePollUrl(url), url);
    const result = await poll(url, async (input, init) => {
      assert.equal(String(input), url);
      assert.equal(init?.redirect, "manual");
      return Response.json(COMPLETE);
    });
    assert.equal(result.mediaUrl, IMAGE);
  }
  assert.equal(
    normalizeAdobePollUrl("https://firefly-epo855232.adobe.io:443/jobs/result/job-42"),
    POLL
  );
});

test("Adobe rejects every 3xx before reading JSON, auth headers, or transient retry text", async () => {
  for (let status = 300; status < 400; status++) {
    let sends = 0;
    let canceled = 0;
    const response = {
      status,
      body: new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
      get headers() {
        throw new Error("must reject before auth processing");
      },
      async text() {
        throw new Error("must not read try again / timeout_error body");
      },
      async json() {
        throw new Error("must not read redirect JSON");
      },
    } as unknown as Response;
    await assert.rejects(
      () =>
        poll(POLL, async () => {
          sends++;
          return response;
        }),
      isBoundaryFailure
    );
    assert.equal(sends, 1, `status ${status} must not retry`);
    assert.equal(canceled, 1, `status ${status} must cancel`);
  }
});

for (const status of [301, 302, 303, 307, 308]) {
  for (const location of [
    `${BKS_ORIGIN}/steal${BKS_QUERY}`,
    "https://attacker.example/steal",
    "http://169.254.169.254/latest/meta-data",
  ]) {
    test(`Adobe ${status} prevents real Undici onward requests: ${location}`, async (t) => {
      const http = new MockAgent();
      http.disableNetConnect();
      t.after(async () => {
        await http.close();
      });
      let polls = 0;
      let onwardSends = 0;
      http
        .get(BKS_ORIGIN)
        .intercept({ path: `/v2/jobs/result/job-42${BKS_QUERY}`, method: "GET" })
        .reply((options) => {
          polls++;
          assert.equal(new HttpHeaders(options.headers).get("authorization"), `Bearer ${TOKEN}`);
          return {
            statusCode: status,
            data: "try again timeout_error",
            responseOptions: { headers: { location } },
          };
        });
      const target = new URL(location);
      http
        .get(target.origin)
        .intercept({ path: target.pathname + target.search, method: "GET" })
        .reply(() => {
          onwardSends++;
          return { statusCode: 200, data: JSON.stringify(COMPLETE) };
        });
      const fetchImpl: typeof fetch = async (input, init) =>
        (await httpFetch(input as string | URL, {
          ...(init as Parameters<typeof httpFetch>[1]),
          dispatcher: http,
        })) as unknown as Response;
      await assert.rejects(() => poll(POLL, fetchImpl), isBoundaryFailure);
      assert.equal(polls, 1);
      assert.equal(onwardSends, 0);
    });
  }
}

for (const kind of ["image", "video"] as const) {
  for (const boundary of ["override", "body", "redirect"] as const) {
    test(`Adobe ${kind} ${boundary} boundary stops after one paid submit through real HTTP`, async (t) => {
      const { adobeFireflyGenerateImage, adobeFireflyGenerateVideo } =
        await import("../../open-sse/services/adobeFireflyClient.ts");
      const http = new MockAgent();
      http.disableNetConnect();
      t.after(async () => {
        await http.close();
      });
      let submits = 0;
      let polls = 0;
      let deniedSends = 0;
      http
        .get(FIXED_ORIGIN)
        .intercept({
          path: `/v2/3p-${kind === "image" ? "images" : "videos"}/generate-async`,
          method: "POST",
        })
        .reply((options) => {
          submits++;
          assert.equal(new HttpHeaders(options.headers).get("authorization"), `Bearer ${TOKEN}`);
          return {
            statusCode: 200,
            data: JSON.stringify({
              links: {
                result: boundary === "body" ? "https://attacker.example/steal" : RAW_RESULT,
              },
            }),
            responseOptions: {
              headers:
                boundary === "override"
                  ? { "x-override-status-link": "https://attacker.example/steal" }
                  : {},
            },
          };
        });
      if (boundary === "redirect") {
        http
          .get(BKS_ORIGIN)
          .intercept({ path: `/v2/jobs/result/job-42${BKS_QUERY}`, method: "GET" })
          .reply((options) => {
            polls++;
            assert.equal(new HttpHeaders(options.headers).get("authorization"), `Bearer ${TOKEN}`);
            return {
              statusCode: 302,
              data: "try again",
              responseOptions: { headers: { location: "https://attacker.example/steal" } },
            };
          });
      }
      http
        .get("https://attacker.example")
        .intercept({ path: "/steal", method: "GET" })
        .reply(() => {
          deniedSends++;
          return {
            statusCode: 200,
            data: JSON.stringify({ outputs: [{ [kind]: { presignedUrl: IMAGE } }] }),
          };
        });
      const fetchImpl: typeof fetch = async (input, init) =>
        (await httpFetch(input as string | URL, {
          ...(init as Parameters<typeof httpFetch>[1]),
          dispatcher: http,
        })) as unknown as Response;
      const generate = kind === "image" ? adobeFireflyGenerateImage : adobeFireflyGenerateVideo;
      await assert.rejects(
        () =>
          generate({
            accessToken: TOKEN,
            prompt: "local synthetic test only",
            model: kind === "image" ? "nano-banana" : "sora-2",
            arpSessionId: "synthetic-arp",
            sessionFingerprint: `synthetic-poll-boundary-${kind}-${boundary}`,
            timeoutMs: 1000,
            fetchImpl,
          }),
        isBoundaryFailure
      );
      assert.equal(submits, 1);
      assert.equal(polls, boundary === "redirect" ? 1 : 0);
      assert.equal(deniedSends, 0);
    });
  }
}

test("Adobe known EPO -> BKS poll keeps Bearer and exact routing through real HTTP", async (t) => {
  const http = new MockAgent();
  http.disableNetConnect();
  t.after(async () => {
    await http.close();
  });
  let bksSends = 0;
  let epoSends = 0;
  http
    .get(EPO_ORIGIN)
    .intercept({ path: "/jobs/result/job-42", method: "GET" })
    .reply(() => {
      epoSends++;
      return { statusCode: 200, data: JSON.stringify(COMPLETE) };
    });
  http
    .get(BKS_ORIGIN)
    .intercept({ path: `/v2/jobs/result/job-42${BKS_QUERY}`, method: "GET" })
    .reply((options) => {
      bksSends++;
      const headers = new HttpHeaders(options.headers);
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("x-api-key"), null);
      assert.equal(headers.get("referer"), "https://firefly.adobe.com/");
      return { statusCode: 200, data: JSON.stringify(COMPLETE) };
    });
  const fetchImpl: typeof fetch = async (input, init) =>
    (await httpFetch(input as string | URL, {
      ...(init as Parameters<typeof httpFetch>[1]),
      dispatcher: http,
    })) as unknown as Response;
  assert.equal((await poll(RAW_RESULT, fetchImpl)).mediaUrl, IMAGE);
  assert.equal(epoSends, 0);
  assert.equal(bksSends, 1);
});
