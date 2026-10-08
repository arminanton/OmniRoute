// @vitest-environment jsdom
import "../_setup/jsdomGlobal.ts";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const { default: RequestLoggerDetail } =
  await import("../../src/shared/components/RequestLoggerDetail.tsx");
const here = dirname(fileURLToPath(import.meta.url));
const enMessages = JSON.parse(
  readFileSync(resolve(here, "../../src/i18n/messages/en.json"), "utf8")
);

describe("RequestLoggerDetail diagnostic overflow attempts", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.matchMedia =
      window.matchMedia ||
      (() =>
        ({
          matches: false,
          media: "",
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList);
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads the private manifest and links each captured provider attempt file", async () => {
    const traceId = "11111111-1111-4111-8111-111111111111";
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi.fn(async () =>
      Response.json({
        attempts: [
          {
            attemptId,
            transport: "http",
            method: "POST",
            url: "https://chatgpt.com/backend-api/codex/responses",
            status: 429,
            request: { state: "complete", complete: true, rawBytes: 1024 },
            response: { state: "incomplete", complete: false, rawBytes: 512, reason: "abort" },
          },
          { attemptId: "../../not-a-uuid", request: { rawBytes: 1 } },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(
        <NextIntlClientProvider
          locale="en"
          timeZone="UTC"
          messages={{ requestLogger: enMessages.requestLogger }}
        >
          <RequestLoggerDetail
            log={{
              status: 429,
              method: "POST",
              path: "/v1/responses",
              timestamp: "2026-10-08T17:00:00.000Z",
              duration: 1000,
              provider: "codex",
              sourceFormat: "openai-responses",
              model: "gpt-6.1-sol",
              tokens: { in: 0, out: 0 },
            }}
            detail={{
              detailState: "ready",
              pipelinePayloads: {
                diagnosticOverflow: {
                  schema: "omni-diagnostic-overflow/v1",
                  traceId,
                  state: "incomplete",
                },
              },
            }}
            loading={false}
            debugEnabled={false}
            onClose={() => {}}
            onCopy={async () => true}
          />
        </NextIntlClientProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/usage/diagnostic-overflow/${traceId}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const links = container.querySelector('[data-testid="diagnostic-overflow-attempt-links"]');
    expect(links).toBeTruthy();
    expect(links?.textContent).toContain("HTTP 429");
    expect(
      container.querySelector(
        `a[href="/api/usage/diagnostic-overflow/${traceId}/${attemptId}/request"]`
      )
    ).toBeTruthy();
    const responseLink = container.querySelector(
      `a[href="/api/usage/diagnostic-overflow/${traceId}/${attemptId}/response"]`
    );
    expect(responseLink).toBeTruthy();
    expect(responseLink?.textContent).toContain("partial");
    expect(container.innerHTML).not.toContain("not-a-uuid");
  });
});
