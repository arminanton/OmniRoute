import assert from "node:assert/strict";
import test from "node:test";
import * as cert from "../../src/mitm/cert/install.stub.ts";
import * as installer from "../../src/lib/services/installers/ninerouter.stub.ts";

test("minimal certificate API remains present and every mutation is disabled", async () => {
  assert.equal(await cert.checkCertInstalled("fixture"), false);
  for (const fn of [
    cert.installCert,
    cert.installCertResult,
    cert.installCaCert,
    cert.uninstallCert,
  ])
    await assert.rejects(fn("", "fixture"), {
      name: "FeatureDisabledError",
      featureName: "mitm-cert-install",
    });
});

test("minimal installer exposes safe reads and rejects installation/update/spawn", async () => {
  assert.equal(await installer.getInstalledVersion(), null);
  assert.equal(await installer.getLatestVersion(), null);
  for (const fn of [
    () => installer.install(),
    () => installer.update(),
    () => installer.uninstall(),
  ])
    await assert.rejects(fn(), { name: "FeatureDisabledError", featureName: "9router-installer" });
  assert.throws(() => installer.resolveSpawnArgs("", 1234), { name: "FeatureDisabledError" });
});
