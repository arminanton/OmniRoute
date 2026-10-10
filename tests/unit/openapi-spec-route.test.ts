import test from "node:test";
import assert from "node:assert/strict";

const { GET } = await import("../../src/app/api/openapi/spec/route.ts");

test("openapi spec route resolves the repository spec file and returns a parsed catalog", async () => {
  const response = await GET();
  assert.equal(response.status, 200);

  const payload = (await response.json()) as any;
  assert.equal(typeof payload.info, "object");
  assert.ok(Array.isArray(payload.endpoints));
  assert.ok(Array.isArray(payload.schemas));
  assert.ok(payload.endpoints.length > 0);
});

test("catalog separates routeGuard localOnly, strict loopback, and the legacy alias", async () => {
  const response = await GET();
  const payload = (await response.json()) as { endpoints: any[] };
  const endpoint = (method: string, pathname: string) =>
    payload.endpoints.find((entry) => entry.method === method && entry.path === pathname);

  const generalLocal = endpoint("GET", "/api/services/bifrost/status");
  assert.ok(generalLocal);
  assert.equal(generalLocal.localOnly, true);
  assert.equal(generalLocal.strictLoopbackOnly, false);
  assert.equal(generalLocal.loopbackOnly, true, "legacy loopbackOnly keeps the old broad value");

  const strictVideo = endpoint("GET", "/api/modality-bridge/video/runtime");
  assert.ok(strictVideo);
  assert.equal(strictVideo.localOnly, true);
  assert.equal(strictVideo.strictLoopbackOnly, true);
  assert.equal(strictVideo.loopbackOnly, true);

  const ordinaryProvider = endpoint("GET", "/api/providers");
  assert.ok(ordinaryProvider);
  assert.equal(ordinaryProvider.localOnly, false);
  assert.equal(ordinaryProvider.strictLoopbackOnly, false);
  assert.equal(ordinaryProvider.loopbackOnly, false);

  const safeVersionRead = endpoint("GET", "/api/system/version");
  const guardedVersionWrite = endpoint("POST", "/api/system/version");
  assert.ok(safeVersionRead);
  assert.ok(guardedVersionWrite);
  assert.equal(safeVersionRead.localOnly, false, "the method-aware routeGuard exempts GET");
  assert.equal(safeVersionRead.strictLoopbackOnly, false);
  assert.equal(safeVersionRead.loopbackOnly, false);
  assert.equal(guardedVersionWrite.localOnly, true);
  assert.equal(guardedVersionWrite.strictLoopbackOnly, false);
  assert.equal(guardedVersionWrite.loopbackOnly, true);
});
