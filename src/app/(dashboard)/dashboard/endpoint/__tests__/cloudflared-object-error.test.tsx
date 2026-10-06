// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EndpointPageClient from "../EndpointPageClient";

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as Response;
}

function getRequestPath(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
}

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("Cloudflare tunnel structured errors", () => {
  const fetchMock = vi.fn();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    fetchMock.mockReset();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("shows the message from a structured Cloudflare error", async () => {
    const actionableMessage = "Check the Cloudflare tunnel token and try again.";
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = getRequestPath(input);
      if (path === "/api/settings") {
        return Promise.resolve(
          jsonResponse({
            cloudEnabled: false,
            cloudConfigured: false,
            hideEndpointCloudflaredTunnel: false,
            hideEndpointTailscaleFunnel: true,
            hideEndpointNgrokTunnel: true,
          })
        );
      }
      if (path === "/api/tunnels/cloudflared" && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "TUNNEL_START_FAILED", message: actionableMessage } },
            false
          )
        );
      }
      if (path === "/api/tunnels/cloudflared") {
        return Promise.resolve(
          jsonResponse({ supported: true, installed: true, running: false, phase: "stopped" })
        );
      }
      if (path === "/v1/models") return Promise.resolve(jsonResponse({ data: [] }));
      if (path === "/api/mcp/status") return Promise.resolve(jsonResponse({ online: false }));
      if (path === "/api/a2a/status") {
        return Promise.resolve(jsonResponse({ status: "ok", tasks: { activeStreams: 0 } }));
      }
      if (path === "/api/search/providers") return Promise.resolve(jsonResponse({ providers: [] }));
      if (path === "/api/cli-tools/keys") return Promise.resolve(jsonResponse({ keys: [] }));
      if (path === "/api/network/info") {
        return Promise.resolve(
          jsonResponse({ localUrl: "http://localhost:20131/v1", lanUrls: [] })
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<EndpointPageClient machineId="" />));

    const startedAt = Date.now();
    while (!container.textContent?.includes("Enable Tunnel")) {
      if (Date.now() - startedAt > 1000) throw new Error("Timed out waiting for Cloudflare action");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Enable Tunnel")
    );
    expect(button).toBeTruthy();
    fireEvent.click(button!);
    await waitFor(() => expect(container.textContent).toContain(actionableMessage), {
      timeout: 3000,
    });
    expect(container.textContent).not.toContain("[object Object]");
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          getRequestPath(input) === "/api/tunnels/cloudflared" && init?.method === "POST"
      )
    ).toBe(true);
  });
});
