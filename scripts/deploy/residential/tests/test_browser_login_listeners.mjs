// Offline argument regression only; real AF_UNIX/no-TCP acceptance runs in the image.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../browser-login/server.mjs", import.meta.url), "utf8");

test("browser login x11vnc disables both TCP families while preserving AF_UNIX", () => {
  const calls = [];
  const statement = source.match(/child\(s, "\/usr\/bin\/x11vnc", \[[\s\S]*?\]\);/g);
  assert.equal(statement?.length, 1, "exactly one fixed x11vnc launch");
  vm.runInNewContext(statement[0], {
    s: { display: ":90", rfbSocket: "/fixture/rfb.sock" },
    child: (_session, command, args) => calls.push({ command, args: Array.from(args) }),
  }, { timeout: 1000 });
  const [{ command, args }] = calls;
  assert.equal(command, "/usr/bin/x11vnc");
  const value = (flag) => {
    assert.equal(args.filter((arg) => arg === flag).length, 1, `one ${flag}`);
    return args[args.indexOf(flag) + 1];
  };
  assert.equal(value("-rfbport"), "0", "disable LibVNCServer IPv4 listener");
  assert.equal(value("-rfbportv6"), "0", "disable independent LibVNCServer IPv6 listener");
  assert.ok(args.includes("-no6"), "disable x11vnc IPv6 listen default");
  assert.equal(value("-unixsock"), "/fixture/rfb.sock");
  assert.equal(value("-display"), ":90");
});
