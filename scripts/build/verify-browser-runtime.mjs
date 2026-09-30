import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("/app/server.js");
const { chromium } = require("playwright");
assert.notEqual(process.getuid(), 0, "verify browser as non-root");
assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright");
fs.accessSync(chromium.executablePath(), fs.constants.X_OK);
for (const executable of ["/usr/bin/Xvfb", "/usr/bin/x11vnc", "/usr/bin/websockify"])
  fs.accessSync(executable, fs.constants.X_OK);
fs.accessSync("/usr/share/novnc/core/rfb.js", fs.constants.R_OK);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.goto("about:blank");
  assert.equal(await page.evaluate(() => 6 * 7), 42);
  console.log(`Offline Chromium readiness passed: ${browser.version()} uid=${process.getuid()}`);
} finally {
  await browser.close();
}
