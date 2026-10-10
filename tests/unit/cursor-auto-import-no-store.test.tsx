import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireManagementAuth: vi.fn(),
  tryIdeAuth: vi.fn(),
  tryAgentAuth: vi.fn(),
}));

vi.mock("@/lib/api/requireManagementAuth", () => ({
  requireManagementAuth: mocks.requireManagementAuth,
}));

vi.mock("@/lib/cursor/tokenExtractor", () => ({
  tryIdeAuth: mocks.tryIdeAuth,
  tryAgentAuth: mocks.tryAgentAuth,
}));

import { GET } from "../../src/app/api/oauth/cursor/auto-import/route.ts";

describe("Cursor auto-import credential cache policy", () => {
  beforeEach(() => {
    mocks.requireManagementAuth.mockReset().mockResolvedValue(null);
    mocks.tryIdeAuth.mockReset();
    mocks.tryAgentAuth.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks IDE token results as no-store", async () => {
    mocks.tryIdeAuth.mockResolvedValue({
      found: true,
      accessToken: "cursor-access-secret",
      refreshToken: "cursor-refresh-secret",
      machineId: "cursor-machine",
      source: "cursor-ide",
    });

    const response = await GET(new Request("http://localhost/api/oauth/cursor/auto-import"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      found: true,
      accessToken: "cursor-access-secret",
      refreshToken: "cursor-refresh-secret",
    });
    expect(mocks.tryAgentAuth).not.toHaveBeenCalled();
  });

  it("marks cursor-agent token results as no-store", async () => {
    mocks.tryIdeAuth.mockResolvedValue({ found: false, error: "IDE credentials not found" });
    mocks.tryAgentAuth.mockResolvedValue({
      found: true,
      accessToken: "cursor-agent-access-secret",
      source: "cursor-agent",
    });

    const response = await GET(new Request("http://localhost/api/oauth/cursor/auto-import"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      found: true,
      accessToken: "cursor-agent-access-secret",
      source: "cursor-agent",
    });
  });
});
