# #15365 GET + POST structured Cloudflare error review

**Verdict:** Pass for the requested no-`[object Object]` and safe-rendering behavior, with a GET visibility test-coverage caveat.

## Findings

No source defect found in the inspected GET/POST error paths.

- **GET** (`EndpointPageClient.tsx:208-240`) parses JSON with a `null` fallback. Non-OK responses go through `extractApiErrorMessage(data, fallback)` and become an `Error` from the extracted message. The raw response body is not stringified or rendered.
- **POST** (`EndpointPageClient.tsx:698-741`) also parses JSON with a fallback and extracts a message before throwing. Its catch path stores `error.message` or a translated fallback in the notice, not the raw response object.
- **JSX** (`EndpointPageClient.tsx:1485-1516`) renders notice/error values as text children. React escapes text children; there is no raw-body HTML insertion.
- The Node tests (`cloudflared-object-error.node.test.ts:5-34`) cover a structured `{code, message}` error, a string error, missing-message fallback, and malformed values including `null`, number, boolean, array, and non-string message.
- The UI test (`cloudflared-object-error.test.tsx:53-145`) asserts the actionable POST message is displayed and checks both rendered text and captured `Error` arguments for `[object Object]`. It also checks a malformed GET error (`42`) uses the status fallback.

## Caveat

Every current `fetchCloudflaredStatus` call site uses `silent=true` (`EndpointPageClient.tsx:499, 585, 740`). The UI test verifies GET extraction through captured `Error` arguments, but does not verify a GET error notice is rendered. A non-silent invocation would place `error.message` in the Cloudflare notice, which JSX renders as text.

The shared extractor implementation was not inspected because it is outside the allowed file scope; its relevant behavior is exercised by the authorized direct tests. No tests, builds, installs, staging, commits, or deploys were run. No source files changed.
