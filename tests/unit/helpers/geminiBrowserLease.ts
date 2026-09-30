import { chromium } from "playwright";
import { acquireBrowserPageLease } from "../../../open-sse/services/browserPool.ts";

// Only used by tests that replace chromium.launch with an in-memory fake.
export const mockGeminiBrowserLease: typeof acquireBrowserPageLease = async (
  key,
  options,
  signal
) => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const cookies = (options.cookieString || "")
    .split("; ")
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf("=");
      return {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        domain: ".google.com",
        path: "/",
        secure: true,
      };
    });
  await context.addCookies(cookies);
  return acquireBrowserPageLease(key, options, signal, {
    acquire: async () => ({ id: key, context, warmupPage: null, lastUsed: 0, isStealth: false }),
  });
};
