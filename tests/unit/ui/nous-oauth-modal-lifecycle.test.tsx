// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { translate } = vi.hoisted(() => ({ translate: (key: string) => key }));
vi.mock("next-intl", () => ({ useTranslations: () => translate }));
vi.mock("@/shared/components/Modal", () => ({
  default: ({
    isOpen,
    onClose,
    children,
  }: {
    isOpen: boolean;
    onClose: () => void;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div>
        <button onClick={onClose}>close-modal</button>
        {children}
      </div>
    ) : null,
}));
const { default: OAuthModal } = await import("@/shared/components/OAuthModal");
const { OAUTH_PROVIDERS } = await import("@/shared/constants/providers/oauth");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
const device = (id = "one") => ({
  device_code: `device-${id}`,
  flowId: `flow-${id}`,
  user_code: "ABCD",
  verification_uri: "https://portal.nousresearch.com/device",
  interval: 1,
  expires_in: 60,
});
let root: ReturnType<typeof createRoot> | null;
let element: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let success: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}
function render(isOpen = true, provider = "nous-oauth") {
  act(() =>
    root!.render(
      <OAuthModal
        isOpen={isOpen}
        provider={provider}
        providerInfo={{ name: "Nous OAuth" }}
        reauthConnection={{ id: "connection" }}
        onClose={close}
        onSuccess={success}
      />
    )
  );
}
function click(label: string, times = 1) {
  const button = [...element.querySelectorAll("button")].find((el) => el.textContent === label)!;
  expect(button).toBeTruthy();
  act(() => {
    for (let i = 0; i < times; i++) button.click();
  });
}
const calls = (suffix: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes(suffix));

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  success = vi.fn();
  close = vi.fn();
  fetchMock = vi.fn(async (url: string) =>
    response(String(url).includes("device-code") ? device() : { pending: true })
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(async () => {
  if (root) act(() => root!.unmount());
  root = null;
  await flush();
  element.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Nous OAuth lifecycle", () => {
  it("cancels once on close and unmount with the original bound payload", async () => {
    render();
    await flush();
    click("close-modal");
    render(false);
    act(() => root!.unmount());
    root = null;
    await flush();
    expect(calls("/cancel")).toHaveLength(1);
    expect(JSON.parse(calls("/cancel")[0][1].body)).toEqual({
      deviceCode: "device-one",
      extraData: { flowId: "flow-one" },
      connectionId: "connection",
    });
    expect(calls("/cancel")[0][1].keepalive).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(calls("/poll")).toHaveLength(0);
  });

  it("cancels on unmount alone", async () => {
    render();
    await flush();
    act(() => root!.unmount());
    root = null;
    await flush();
    expect(calls("/cancel")).toHaveLength(1);
  });

  it("cancels stale device-code responses without opening or polling them", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    render();
    render(false);
    pending.resolve(response(device()));
    await flush();
    expect(calls("/cancel")).toHaveLength(1);
    expect(window.open).not.toHaveBeenCalled();
    expect(calls("/poll")).toHaveLength(0);
  });

  it("keeps reopened flow intact when an older device response arrives", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    render();
    render(false);
    render();
    await flush();
    pending.resolve(response(device("old")));
    await flush();
    expect(calls("/cancel")).toHaveLength(1);
    expect(JSON.parse(calls("/cancel")[0][1].body).deviceCode).toBe("device-old");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(JSON.parse(calls("/poll")[0][1].body).deviceCode).toBe("device-one");
  });

  it("cancels on provider changes", async () => {
    render();
    await flush();
    render(true, "devin-cli");
    await flush();
    expect(calls("/cancel")).toHaveLength(1);
  });

  it("cancels the failed flow on retry and deduplicates rapid retry clicks", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      response(String(url).includes("device-code") ? device() : { error: "denied" })
    );
    render();
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("device-code")
        ? pending.promise
        : Promise.resolve(response({ success: true }))
    );
    click("tryAgain", 2);
    await flush();
    expect(calls("/cancel")).toHaveLength(1);
    expect(calls("/device-code")).toHaveLength(2);
    pending.resolve(response(device("retry")));
    await flush();
  });

  it("never cancels a known committed success, including onSuccess unmount", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      response(String(url).includes("device-code") ? device() : { success: true })
    );
    success.mockImplementation(() => {
      root!.unmount();
      root = null;
    });
    render();
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(success).toHaveBeenCalledTimes(1);
    expect(calls("/cancel")).toHaveLength(0);
  });

  it("cancels in-flight polls and ignores their late results", async () => {
    const pending = deferred<Response>();
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("/poll")
        ? pending.promise
        : Promise.resolve(
            response(String(url).includes("device-code") ? device() : { success: true })
          )
    );
    render();
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    click("close-modal");
    await flush();
    expect(calls("/cancel")).toHaveLength(1);
    pending.resolve(response({ success: true }));
    await flush();
    expect(success).not.toHaveBeenCalled();
  });

  it("restarts safely after StrictMode effect cleanup", async () => {
    act(() =>
      root!.render(
        <React.StrictMode>
          <OAuthModal
            isOpen
            provider="nous-oauth"
            providerInfo={{ name: "Nous OAuth" }}
            onClose={close}
            onSuccess={success}
          />
        </React.StrictMode>
      )
    );
    await flush();
    expect(calls("/device-code")).toHaveLength(2);
    expect(calls("/cancel")).toHaveLength(1);
    expect(window.open).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls("/poll")).toHaveLength(1);
  });

  it("does not show a stale experimental label", async () => {
    render();
    await flush();
    expect(element.textContent).not.toMatch(/experimental/i);
    expect(OAUTH_PROVIDERS["nous-oauth"].name).toBe("Nous OAuth");
    expect(OAUTH_PROVIDERS["nous-oauth"].authHint).not.toMatch(/experimental/i);
  });
});
