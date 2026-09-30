import { test } from "node:test";
import assert from "node:assert";
import {
  computeMaxaiDocId,
  maxaiDocType,
  parseInlineDataUrl,
  extractCurrentTurnDocs,
  buildUploadMultipart,
  sawUploadDone,
  uploadMaxaiDocument,
  resolveMaxaiDocList,
} from "../../open-sse/executors/maxai/documents.ts";
import { __setMaxaiConstantsForTest } from "../../open-sse/executors/maxai/constantsStore.ts";
import { MOCK_CONSTANTS, MOCK_DOC_ID_KEY } from "./helpers/maxaiMockConstants.ts";

// Doc uploads sign like any request, so seed the in-process constants memo with
// MOCK values instead of mocking the bundle fetch. Nothing real is committed.
const DOC_ID_KEY = MOCK_DOC_ID_KEY;
__setMaxaiConstantsForTest(MOCK_CONSTANTS);

const AUTH = {
  accessToken: "tok-abc",
  userId: "11111111-1111-4111-8111-111111111111",
  deviceId: "22222222-2222-4222-8222-222222222222",
};

// --- doc_id (content-addressed HMAC-SHA1) --------------------------------

test("computeMaxaiDocId is a stable HMAC-SHA1(bytes, key) hex digest", () => {
  // Cross-checked shape: HMAC-SHA1 hex is 40 chars; deterministic for same input.
  const id = computeMaxaiDocId(Buffer.from("hello world"), DOC_ID_KEY);
  assert.equal(id.length, 40);
  assert.match(id, /^[0-9a-f]{40}$/);
  assert.equal(computeMaxaiDocId(Buffer.from("hello world"), DOC_ID_KEY), id);
  // Different key or bytes → different id.
  assert.notEqual(id, computeMaxaiDocId(Buffer.from("hello world"), "different-key"));
  assert.notEqual(id, computeMaxaiDocId(Buffer.from("other"), DOC_ID_KEY));
});

test("computeMaxaiDocId requires a key (never hashes with a guess)", () => {
  assert.throws(() => computeMaxaiDocId(Buffer.from("x"), ""));
});

// --- doc_type classification --------------------------------------------

test("maxaiDocType classifies pdf / code / text", () => {
  assert.equal(maxaiDocType("report.pdf", "application/pdf"), "page_content__pdf");
  assert.equal(maxaiDocType("script.py", "text/x-python"), "chat_file_code");
  assert.equal(maxaiDocType("main.ts", "text/plain"), "chat_file_code");
  assert.equal(maxaiDocType("notes.txt", "text/plain"), "chat_file");
  assert.equal(maxaiDocType("data.csv", "text/csv"), "chat_file");
});

// --- data-url parsing ----------------------------------------------------

test("parseInlineDataUrl decodes base64 + plain data urls", () => {
  const b64 = parseInlineDataUrl("data:text/plain;base64,aGVsbG8="); // "hello"
  assert.equal(b64?.mimeType, "text/plain");
  assert.equal(b64?.bytes.toString("utf8"), "hello");

  const plain = parseInlineDataUrl("data:text/plain,hi%20there");
  assert.equal(plain?.bytes.toString("utf8"), "hi there");

  assert.equal(parseInlineDataUrl("https://example.com/x.pdf"), null);
  assert.equal(parseInlineDataUrl("data:text/plain;base64,"), null); // empty
  assert.equal(parseInlineDataUrl(42), null);
});

// --- extract inline docs from the current turn --------------------------

test("extractCurrentTurnDocs handles OpenAI file, Responses input_file, Claude document", () => {
  const docs = extractCurrentTurnDocs([
    { role: "system", content: "sys" },
    {
      role: "user",
      content: [
        { type: "text", text: "review these" },
        {
          type: "file",
          file: { filename: "a.txt", file_data: "data:text/plain;base64,QQ==" }, // "A"
        },
        { type: "input_file", filename: "b.md", file_data: "data:text/markdown;base64,Qg==" }, // "B"
        {
          type: "document",
          title: "c.pdf",
          source: { type: "base64", media_type: "application/pdf", data: "Qw==" }, // "C"
        },
      ],
    },
  ]);
  assert.equal(docs.length, 3);
  assert.equal(docs[0].filename, "a.txt");
  assert.equal(docs[0].bytes.toString("utf8"), "A");
  assert.equal(docs[1].filename, "b.md");
  assert.equal(docs[2].filename, "c.pdf");
  assert.equal(docs[2].mimeType, "application/pdf");
});

test("extractCurrentTurnDocs returns [] for a plain-text turn", () => {
  assert.deepEqual(extractCurrentTurnDocs([{ role: "user", content: "just text" }]), []);
});

test("extractCurrentTurnDocs leaves image_url parts to the vision path", () => {
  assert.deepEqual(
    extractCurrentTurnDocs([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      },
    ]),
    []
  );
});

// --- multipart body ------------------------------------------------------

test("buildUploadMultipart includes all required fields + the file bytes", () => {
  const doc = { filename: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("secret data") };
  const body = buildUploadMultipart(doc, "docid123", "chat_file", "BOUND").toString("utf8");
  assert.ok(body.includes('name="doc_id"\r\n\r\ndocid123'));
  assert.ok(body.includes('name="doc_type"\r\n\r\nchat_file'));
  assert.ok(body.includes('name="pure_text"\r\n\r\nsecret data')); // textual -> pure_text filled
  assert.ok(body.includes('name="tokens"'));
  assert.ok(body.includes('name="doc_type_dependent_data"\r\n\r\n{}'));
  assert.ok(body.includes('name="file"; filename="notes.txt"'));
  assert.ok(body.includes("Content-Type: text/plain"));
  assert.ok(body.trimEnd().endsWith("--BOUND--"));
});

test("buildUploadMultipart leaves pure_text empty for binary (pdf)", () => {
  const doc = { filename: "r.pdf", mimeType: "application/pdf", bytes: Buffer.from([1, 2, 3, 4]) };
  const body = buildUploadMultipart(doc, "id", "page_content__pdf", "B").toString("latin1");
  assert.ok(body.includes('name="pure_text"\r\n\r\n\r\n')); // empty value
});

// --- SSE done detection --------------------------------------------------

test("sawUploadDone detects the terminal event", () => {
  assert.equal(sawUploadDone('data: {"event":"upload_done","data":{"doc_id":"x"}}'), true);
  assert.equal(sawUploadDone('data: {"event":"upload_to_s3"}'), false);
});

// --- upload (mocked fetch) ----------------------------------------------

test("uploadMaxaiDocument returns a doc_list entry on upload_done", async () => {
  let hitUrl = "";
  let hitContentType = "";
  const fetchImpl = (async (url: string, init: RequestInit) => {
    hitUrl = url;
    hitContentType = (init.headers as Record<string, string>)["Content-Type"];
    return {
      ok: true,
      status: 200,
      async text() {
        return 'data: {"event":"upload_done","data":{"doc_id":"srv"}}\n';
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const entry = await uploadMaxaiDocument(
    { filename: "a.txt", mimeType: "text/plain", bytes: Buffer.from("hi") },
    AUTH,
    { fetchImpl }
  );
  assert.ok(entry);
  assert.equal(entry!.doc_id, computeMaxaiDocId(Buffer.from("hi"), DOC_ID_KEY));
  assert.equal(entry!.doc_type, "chat_file");
  assert.equal(entry!.file_name, "a.txt");
  assert.match(hitUrl, /\/app\/upload_document$/);
  assert.match(hitContentType, /^multipart\/form-data; boundary=/);
});

test("uploadMaxaiDocument rejects HTTP failures with a redacted status-bearing error", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("private upstream body", { status: 429 });
  await assert.rejects(
    uploadMaxaiDocument(
      { filename: "a.txt", mimeType: "text/plain", bytes: Buffer.from("hi") },
      AUTH,
      { fetchImpl }
    ),
    (error: Error & { status?: number }) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /upload/i);
      assert.ok(!error.message.includes("private upstream body"));
      return true;
    }
  );
});

test("resolveMaxaiDocList stops at the first upload failure", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('data: {"event":"upload_done"}\n\n');
    return new Response("private upstream body", { status: 500 });
  };
  await assert.rejects(
    resolveMaxaiDocList(
      [
        {
          role: "user",
          content: ["a", "b", "c"].map((name) => ({
            type: "file",
            file: { filename: `${name}.txt`, file_data: "data:text/plain;base64,QQ==" },
          })),
        },
      ],
      AUTH,
      { fetchImpl }
    ),
    { status: 500 }
  );
  assert.equal(calls, 2);
});

test("resolveMaxaiDocList returns [] when there are no inline docs", async () => {
  const list = await resolveMaxaiDocList([{ role: "user", content: "hi" }], AUTH, {
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        async text() {
          return "";
        },
      }) as unknown as Response) as unknown as typeof fetch,
  });
  assert.deepEqual(list, []);
});

// --- document input bounds and fail-closed behavior ----------------------

const DECODED_DOCUMENT_LIMIT = 64 * 1024 * 1024;
const DATA_URL = "data:text/plain;base64,QQ==";
const INLINE_DOC = { filename: "a.txt", mimeType: "text/plain", bytes: Buffer.from("A") };

function userDocs(parts: unknown[]) {
  return [{ role: "user", content: parts }];
}

function filePart(file_data: unknown, filename: unknown = "a.txt") {
  return { type: "file", file: { filename, file_data } };
}

test("strict base64 rejects invalid alphabet, padding, truncation and nonzero pad bits", () => {
  const invalid = [
    "A",
    "AAA",
    "A===",
    "AA=",
    "AA=A",
    "====",
    "QQ===",
    "QQ==!",
    "Q Q==",
    "QQ==\n",
    "_w==",
    "QR==",
    "QUJ=",
    "!!!!",
  ];
  for (const payload of invalid) {
    assert.equal(parseInlineDataUrl(`data:text/plain;base64,${payload}`), null, payload);
    for (const part of [
      filePart(`data:text/plain;base64,${payload}`),
      { type: "input_file", file_data: `data:text/plain;base64,${payload}` },
      { type: "document", source: { type: "base64", data: payload } },
    ]) {
      assert.throws(() => extractCurrentTurnDocs(userDocs([part])), { status: 400 }, payload);
    }
  }
});

test("strict base64 accepts all valid padding lengths and raw Claude base64", () => {
  for (const payload of ["QQ==", "QUI=", "QUJD", "/w==", "//8=", "////"]) {
    const docs = extractCurrentTurnDocs(
      userDocs([{ type: "document", source: { type: "base64", data: payload } }])
    );
    assert.deepEqual(docs[0].bytes, Buffer.from(payload, "base64"));
  }
});

test("document parts with missing, malformed or unsupported data are rejected", () => {
  for (const part of [
    { type: "file" },
    { type: "file", file: null },
    { type: "file", file: [] },
    { type: "file", file: {} },
    { type: "file", file: { file_id: "file-not-inline" } },
    filePart(null),
    filePart(42),
    filePart(""),
    filePart("data:text/plain;base64,"),
    filePart("data:text/plain,%ZZ"),
    filePart("data:text/plain;charset=utf-8;base64,QQ=="),
    { type: "input_file" },
    { type: "input_file", file_id: "file-not-inline" },
    { type: "document" },
    { type: "document", source: { type: "base64" } },
    { type: "document", source: { type: "base64", data: "" } },
    { type: "document", source: { type: "text", data: "not supported" } },
  ]) {
    assert.throws(() => extractCurrentTurnDocs(userDocs([part])), { status: 400 });
  }
});

test("remote document URLs are rejected without fetching", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response('data: {"event":"upload_done"}\n\n');
  };
  for (const part of [
    filePart("https://example.com/x.pdf"),
    filePart("http://127.0.0.1/private"),
    { type: "input_file", file_url: "https://example.com/x.pdf" },
    { type: "document", source: { type: "url", url: "https://example.com/x.pdf" } },
  ]) {
    await assert.rejects(resolveMaxaiDocList(userDocs([part]), AUTH, { fetchImpl }), {
      status: 400,
    });
  }
  assert.equal(calls, 0);
});

test("an invalid later document prevents every upload", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response('data: {"event":"upload_done"}\n\n');
  };
  await assert.rejects(
    resolveMaxaiDocList(userDocs([filePart(DATA_URL), { type: "input_file" }]), AUTH, {
      fetchImpl,
    }),
    { status: 400 }
  );
  assert.equal(calls, 0);
});

test("only the last user turn is inspected for document data", () => {
  assert.deepEqual(
    extractCurrentTurnDocs([
      { role: "user", content: [{ type: "input_file" }] },
      { role: "assistant", content: [{ type: "input_file" }] },
      { role: "user", content: "no attachment on this turn" },
    ]),
    []
  );
});

test("filenames are bounded by UTF-8 bytes and cannot inject multipart headers", () => {
  for (const filename of [
    "",
    42,
    "a\r\nX-Injected: yes.txt",
    "a\nb.txt",
    "a\u0000.txt",
    'a".txt',
    "a\\b.txt",
    "a".repeat(256),
    "é".repeat(128),
  ]) {
    assert.throws(() => extractCurrentTurnDocs(userDocs([filePart(DATA_URL, filename)])), {
      status: 400,
    });
  }
  const filename = `${"é".repeat(125)}a.txt`;
  assert.equal(Buffer.byteLength(filename), 255);
  assert.equal(
    extractCurrentTurnDocs(userDocs([filePart(DATA_URL, filename)]))[0].filename,
    filename
  );
});

test("malformed MIME types cannot inject multipart headers", () => {
  for (const mimeType of [
    "text/plain\r\nX-Injected: yes",
    "text/plain\n",
    "text/plain\r",
    "text/plain\u2028",
    "not-a-mime",
    "x/" + "a".repeat(256),
  ]) {
    assert.throws(
      () =>
        extractCurrentTurnDocs(
          userDocs([
            { type: "document", source: { type: "base64", media_type: mimeType, data: "QQ==" } },
          ])
        ),
      { status: 400 }
    );
    assert.equal(parseInlineDataUrl(`data:${mimeType};base64,QQ==`), null);
  }
});

test("the public multipart builder also rejects unsafe document metadata", () => {
  for (const doc of [
    { ...INLINE_DOC, filename: "bad\r\nX-Injected: yes" },
    { ...INLINE_DOC, filename: "a".repeat(256) },
    { ...INLINE_DOC, mimeType: "text/plain\r\nX-Injected: yes" },
    { ...INLINE_DOC, bytes: Buffer.alloc(0) },
  ]) {
    assert.throws(() => buildUploadMultipart(doc, "id", "chat_file", "B"), { status: 400 });
  }
});

test("a single document over 64 MiB is rejected before base64 decoding", (t) => {
  const payload = "AAAA".repeat(Math.floor(DECODED_DOCUMENT_LIMIT / 3)) + "AAA=";
  const originalFrom = Buffer.from;
  let decodes = 0;
  t.mock.method(Buffer, "from", (...args: unknown[]) => {
    if (args[1] === "base64") decodes += 1;
    return Reflect.apply(originalFrom, Buffer, args);
  });
  assert.throws(
    () => extractCurrentTurnDocs(userDocs([filePart(`data:application/pdf;base64,${payload}`)])),
    { status: 413 }
  );
  assert.equal(decodes, 0);
});

test("64 MiB is a total decoded limit, checked before allocating document buffers", (t) => {
  const payload = "AAAA".repeat((33 * 1024 * 1024) / 3);
  const originalFrom = Buffer.from;
  let decodes = 0;
  t.mock.method(Buffer, "from", (...args: unknown[]) => {
    if (args[1] === "base64") decodes += 1;
    return Reflect.apply(originalFrom, Buffer, args);
  });
  assert.throws(
    () =>
      extractCurrentTurnDocs(
        userDocs([
          filePart(`data:application/pdf;base64,${payload}`),
          { type: "document", source: { type: "base64", data: payload } },
        ])
      ),
    { status: 413 }
  );
  assert.equal(decodes, 0);
});

test("the total document limit includes decoded plain data URLs", () => {
  const plain = "a".repeat(32 * 1024 * 1024);
  assert.throws(
    () =>
      extractCurrentTurnDocs(
        userDocs([
          filePart(`data:text/plain,${plain}`),
          filePart(`data:text/plain,${plain}`),
          { type: "document", source: { type: "base64", data: "QQ==" } },
        ])
      ),
    { status: 413 }
  );
});

test("the exact 64 MiB decoded limit remains accepted", () => {
  const payload = "AAAA".repeat(Math.floor(DECODED_DOCUMENT_LIMIT / 3)) + "AA==";
  const docs = extractCurrentTurnDocs(
    userDocs([filePart(`data:application/pdf;base64,${payload}`)])
  );
  assert.equal(docs[0].bytes.length, DECODED_DOCUMENT_LIMIT);
});

test("uploads are serial and preserve input order", async () => {
  let inflight = 0;
  let maximumInflight = 0;
  const fetchImpl: typeof fetch = async () => {
    inflight += 1;
    maximumInflight = Math.max(maximumInflight, inflight);
    await new Promise<void>((resolve) => setImmediate(resolve));
    inflight -= 1;
    return new Response('data: {"event":"upload_done"}\n\n');
  };
  const docs = await resolveMaxaiDocList(
    userDocs([filePart(DATA_URL, "first.txt"), filePart(DATA_URL, "second.txt")]),
    AUTH,
    { fetchImpl }
  );
  assert.equal(maximumInflight, 1);
  assert.deepEqual(
    docs.map((doc) => doc.file_name),
    ["first.txt", "second.txt"]
  );
});

test("upload rejects missing or fake completion events", async () => {
  for (const body of [
    'data: {"event":"upload_to_s3"}\n\n',
    'data: {"event":"error","message":"upload_done failed"}\n\n',
    'data: {"message":"upload_done"}\n\n',
    "upload_done",
    "",
  ]) {
    await assert.rejects(
      uploadMaxaiDocument(INLINE_DOC, AUTH, { fetchImpl: async () => new Response(body) }),
      { status: 502 }
    );
  }
});

test("upload network and response-read failures are not swallowed or exposed", async () => {
  const privateMessage = "private proxy URL and credential";
  for (const fetchImpl of [
    async () => {
      throw new Error(privateMessage);
    },
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(privateMessage));
          },
        })
      ),
  ]) {
    await assert.rejects(
      uploadMaxaiDocument(INLINE_DOC, AUTH, { fetchImpl }),
      (error: Error & { status?: number }) => {
        assert.equal(error.status, 502);
        assert.ok(!error.message.includes(privateMessage));
        return true;
      }
    );
  }
});

test("signed upload forbids redirect following and forwards the caller signal", async () => {
  const controller = new AbortController();
  let requestUrl: RequestInfo | URL | undefined;
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return new Response('data: {"event":"upload_done"}\n\n');
  };
  const entry = await uploadMaxaiDocument(INLINE_DOC, AUTH, {
    fetchImpl,
    signal: controller.signal,
  });
  assert.ok(entry);
  assert.equal(requestUrl, "https://api.maxai.me/app/upload_document");
  assert.equal(requestInit?.redirect, "error");
  assert.equal(requestInit?.signal, controller.signal);
  assert.match((requestInit?.headers as Record<string, string>).Authorization, /^Bearer /);
});

test("HTTP upload failure cancels the response body", async () => {
  let cancelled = false;
  await assert.rejects(
    uploadMaxaiDocument(INLINE_DOC, AUTH, {
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 }
        ),
    }),
    { status: 503 }
  );
  assert.equal(cancelled, true);
});

test("a pre-aborted upload performs no requests", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response('data: {"event":"upload_done"}\n\n');
  };
  await assert.rejects(
    uploadMaxaiDocument(INLINE_DOC, AUTH, {
      fetchImpl,
      signal: controller.signal,
    }),
    { name: "AbortError" }
  );
  await assert.rejects(
    resolveMaxaiDocList(userDocs([filePart(DATA_URL)]), AUTH, {
      fetchImpl,
      signal: controller.signal,
    }),
    { name: "AbortError" }
  );
  assert.equal(calls, 0);
});

test("fetch aborts propagate instead of dropping attachments", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Cancelled", "AbortError");
  await assert.rejects(
    uploadMaxaiDocument(INLINE_DOC, AUTH, {
      signal: controller.signal,
      fetchImpl: async () => {
        controller.abort(reason);
        throw reason;
      },
    }),
    (error) => error === reason
  );
});

test("abort after the first upload prevents starting another upload", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    controller.abort();
    return new Response('data: {"event":"upload_done"}\n\n');
  };
  await assert.rejects(
    resolveMaxaiDocList(userDocs([filePart(DATA_URL), filePart(DATA_URL, "b.txt")]), AUTH, {
      fetchImpl,
      signal: controller.signal,
    }),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
});

test("abort stops waiting for a fetch that ignores its signal and cancels a late body", async () => {
  const controller = new AbortController();
  let finishFetch!: (response: Response) => void;
  let cancelled = false;
  let outcome: unknown;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    })
  );
  const result = uploadMaxaiDocument(INLINE_DOC, AUTH, {
    signal: controller.signal,
    fetchImpl: () =>
      new Promise<Response>((resolve) => {
        finishFetch = resolve;
      }),
  }).then(
    (entry) => {
      outcome = entry;
    },
    (error: unknown) => {
      outcome = error;
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const abortedBeforeResponse = outcome instanceof Error && outcome.name === "AbortError";
  // Always unblock the old implementation too, so a red test cannot hang.
  finishFetch(response);
  if (!abortedBeforeResponse) await response.body?.cancel().catch(() => {});
  await result;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(abortedBeforeResponse, true);
  assert.equal(cancelled, true);
});

test("abort while reading upload acknowledgement cancels and releases the reader", async () => {
  const controller = new AbortController();
  let responseController!: ReadableStreamDefaultController;
  let cancelled = false;
  let outcome: unknown;
  const response = new Response(
    new ReadableStream({
      start(streamController) {
        responseController = streamController;
      },
      cancel() {
        cancelled = true;
      },
    })
  );
  const result = uploadMaxaiDocument(INLINE_DOC, AUTH, {
    signal: controller.signal,
    fetchImpl: async () => response,
  }).then(
    (entry) => {
      outcome = entry;
    },
    (error: unknown) => {
      outcome = error;
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const abortedWhileReading = outcome instanceof Error && outcome.name === "AbortError";
  if (!cancelled) responseController.close();
  await result;
  assert.equal(abortedWhileReading, true);
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});

test("default document transport fails closed without using ambient fetch", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    throw new Error("ambient fetch must not be used");
  });
  await assert.rejects(uploadMaxaiDocument(INLINE_DOC, AUTH), { status: 502 });
  assert.equal(calls, 0);
});

test("unsafe direct upload metadata fails before any request", async () => {
  let calls = 0;
  await assert.rejects(
    uploadMaxaiDocument({ ...INLINE_DOC, filename: "a\r\nb.txt" }, AUTH, {
      fetchImpl: async () => {
        calls += 1;
        return new Response('data: {"event":"upload_done"}\n\n');
      },
    }),
    { status: 400 }
  );
  assert.equal(calls, 0);
});
