import test from "node:test";
import assert from "node:assert/strict";

// Regression guard for the per-mode behavior of the OpenAI→Gemini translator
// (#3414/#3560/#3569). History of the standard-Gemini path:
//   - #3560 set the registered FORMATS.GEMINI translator to mode "text" on the
//     assumption that thinking Gemini models reject signature-less native tool
//     parts (400 "missing thought_signature").
//   - #3569 changed the registered default to mode "native" after a live test
//     against the real Gemini API (gemini-2.5-flash returns 200 for a
//     signatureless historical functionCall, even with tools + thinkingConfig),
//     which also removes the text-serialization leak (#3358).
// These tests still pin the *per-mode* output shape: "text" mode keeps history as
// inert text (no native parts, no sentinel — still available as an explicit mode),
// and "native" mode emits a native functionCall with no fake signature. The
// Antigravity/CLI bypass path is the only one that injects the
// skip_thought_signature_validator sentinel.
const { openaiToGeminiRequest } = await import(
  "../../open-sse/translator/request/openai-to-gemini.ts"
);

const MESSAGES = [
  { role: "user", content: "list files" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "file_a\nfile_b" },
  { role: "user", content: "thanks" },
];
const TOOLS = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }];

type GP = {
  functionCall?: unknown;
  functionResponse?: { id: string; name: string; response: { result: unknown } };
  text?: string;
  thoughtSignature?: unknown;
};
type GContent = { role?: string; parts?: GP[] };

function translate(
  mode: "native" | "text" | "context",
  messages: Array<Record<string, unknown>> = MESSAGES
) {
  return openaiToGeminiRequest(
    "gemini-2.5-flash",
    { model: "gemini-2.5-flash", messages, tools: TOOLS, stream: false },
    false,
    null,
    { signaturelessToolCallMode: mode }
  );
}

test('standard Gemini "text" mode: signature-less tool call/response stay as text (no native parts, no sentinel)', () => {
  const result = translate("text");
  const allParts = (result.contents as GContent[]).flatMap((c) => c.parts ?? []);

  assert.equal(
    allParts.some((p) => p.functionCall),
    false,
    "no native functionCall on the text-mode standard-Gemini path"
  );
  assert.equal(
    allParts.some((p) => p.functionResponse),
    false,
    "no native functionResponse on the text-mode standard-Gemini path"
  );
  assert.equal(
    allParts.some((p) => p.thoughtSignature === "skip_thought_signature_validator"),
    false,
    "the bypass sentinel must never be injected on the standard-Gemini path"
  );
});

test('standard Gemini "native" mode: native functionCall with no fake signature', () => {
  const result = translate("native");
  const modelTurn = (result.contents as GContent[]).find(
    (c) => c.role === "model" && (c.parts ?? []).some((p) => p.functionCall)
  );
  assert.ok(modelTurn, "native mode emits a native functionCall");
  const fc = (modelTurn.parts ?? []).find((p) => p.functionCall);
  assert.equal(fc?.thoughtSignature, undefined, "no fake signature injected in native mode");
});

// Empty output is still an actual tool response. The following user message must
// not make the translator silently skip that prior paired tool result.
function toolHistory(content: unknown, includeToolMessage = true): Array<Record<string, unknown>> {
  return [
    { role: "user", content: "run bash" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    ...(includeToolMessage ? [{ role: "tool", tool_call_id: "call_1", content }] : []),
    { role: "user", content: "continue" },
  ];
}

for (const output of ["", null, "done"] as const) {
  const normalized = output ?? "";
  test(`Gemini native mode preserves a paired bash tool response (${JSON.stringify(output)})`, () => {
    const parts = (translate("native", toolHistory(output)).contents as GContent[]).flatMap(
      (entry) => entry.parts ?? []
    );
    const responses = parts.flatMap((part) =>
      part.functionResponse ? [part.functionResponse] : []
    );
    assert.deepEqual(responses, [{ id: "call_1", name: "bash", response: { result: normalized } }]);
    assert.equal(parts.filter((part) => part.functionCall).length, 1, "the response is paired");
  });

  for (const mode of ["text", "context"] as const) {
    test(`Gemini ${mode} mode keeps a paired bash result as inert/contextual text (${JSON.stringify(output)})`, () => {
      const parts = (translate(mode, toolHistory(output)).contents as GContent[]).flatMap(
        (entry) => entry.parts ?? []
      );
      const text = parts.flatMap((part) => (typeof part.text === "string" ? [part.text] : []));
      const resultText =
        mode === "text"
          ? `[tool_history_result: bash] ${normalized}`
          : `<previous_tool_result_context source="bash">\n${normalized}\n</previous_tool_result_context>`;
      assert.equal(text.filter((part) => part === resultText).length, 1);
      assert.equal(parts.filter((part) => part.functionResponse).length, 0);
      assert.equal(parts.filter((part) => part.functionCall).length, 0);
      assert.ok(text.includes("continue"), "next user message is retained");
    });
  }
}

test("Gemini modes do not invent a response when the tool message is absent", () => {
  for (const mode of ["native", "text", "context"] as const) {
    const parts = (translate(mode, toolHistory(undefined, false)).contents as GContent[]).flatMap(
      (entry) => entry.parts ?? []
    );
    assert.equal(parts.filter((part) => part.functionResponse).length, 0, mode);
    assert.equal(
      parts.filter(
        (part) =>
          part.text?.includes("tool_history_result: bash") ||
          part.text?.includes('previous_tool_result_context source="bash"')
      ).length,
      0,
      mode
    );
  }
});
