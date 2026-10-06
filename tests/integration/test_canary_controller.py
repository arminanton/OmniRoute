import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
c = importlib.import_module("scripts.deploy.canary.controller")
p = importlib.import_module("scripts.deploy.canary.proxy")


def generation(char, slot, address):
    return {"generation": char * 32, "slot": slot, "image": "sha256:" + char * 64,
            "revision": char * 40, "address": address, "namespace": "omni-app-" + char * 32,
            "stateOwner": "coordinated-live-v1", "helperSet": "d" * 64}


class Host:
    def __init__(self, selected):
        self.route = selected
        self.switches = 0
        self.config_ok = True
        self.ack_ok = True
        self.approved = True
        self.live_bodies = 1
        self.removed = False

    def verify_resources(self, old, candidate):
        pass

    def selected(self):
        return self.route

    def verify_approval(self, digest):
        if not self.approved:
            raise c.Refused("operator approval missing")

    def validate_config(self, generation):
        if not self.config_ok:
            raise c.Refused("invalid proxy config")
        return p.nginx_config(generation, {"dashboard": 30128, "api": 30129})

    def select(self, generation, config):
        self.switches += 1
        if self.ack_ok:
            self.route = generation["generation"]

    def retired(self, generation):
        return self.removed

    def retire(self, generation):
        if self.route == generation["generation"] or self.live_bodies:
            raise c.Refused("cannot retire active/undrained generation")
        self.removed = True

    def fence(self, generation):
        if self.route == generation["generation"]:
            raise c.Refused("cannot fence active generation")

    def drained(self, generation):
        return self.live_bodies == 0


class CanaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.journal = c.Journal(self.tmp.name)
        self.old = generation("a", "blue", "10.203.250.2")
        self.new = generation("b", "green", "10.203.251.2")
        self.host = Host(self.old["generation"])
        self.controller = c.Controller(self.journal, self.host, lambda: 100)
        self.evidence = {"old": c.digest(self.old), "candidate": c.digest(self.new), "expiresAt": 200,
                         "checks": {key: {"ok": True, "proof": "c" * 64} for key in c.REQUIRED_CHECKS}}

    def tearDown(self):
        self.journal.close()
        self.tmp.cleanup()

    def prepare(self):
        self.controller.prepare(self.old, self.new, self.evidence)

    def test_cutover_retains_active_body_then_switchback(self):
        self.prepare()
        self.controller.promote()
        self.assertFalse(self.controller.retain())
        self.host.live_bodies = 0
        self.assertTrue(self.controller.retain())
        self.assertEqual(self.journal.read()["phase"], "old-retained")
        self.controller.switch_back()
        self.assertEqual(self.host.route, self.old["generation"])
        self.assertEqual(self.journal.read()["phase"], "draining-candidate")

    def test_retirement_requires_complete_drain_and_approval(self):
        self.prepare()
        self.controller.promote()
        with self.assertRaises(c.Refused):
            self.controller.retire()
        self.host.live_bodies = 0
        self.controller.retain()
        self.host.approved = False
        with self.assertRaises(c.Refused):
            self.controller.retire()
        self.host.approved = True
        self.controller.retire()
        self.assertEqual(self.journal.read()["phase"], "retired")

    def test_crash_after_retirement_recovers_from_receipt_observation(self):
        self.prepare()
        self.controller.promote()
        self.host.live_bodies = 0
        self.controller.retain()
        original = self.host.retire
        def crash(generation):
            original(generation)
            raise RuntimeError("supervisor disappeared after stop")
        self.host.retire = crash
        with self.assertRaises(RuntimeError):
            self.controller.retire()
        self.assertEqual(self.journal.read()["phase"], "retirement-intent")
        self.assertEqual(self.controller.recover(), "retired")

    def test_no_approval_no_switch(self):
        self.prepare()
        self.host.approved = False
        with self.assertRaises(c.Refused):
            self.controller.promote()
        self.assertEqual(self.host.switches, 0)

    def test_failed_config_keeps_old(self):
        self.prepare()
        self.host.config_ok = False
        with self.assertRaises(c.Refused):
            self.controller.promote()
        self.assertEqual(self.journal.read()["phase"], "ready")
        self.assertEqual(self.host.switches, 0)

    def test_failed_ack_recovery_uses_observed_authority(self):
        self.prepare()
        self.host.ack_ok = False
        with self.assertRaises(c.Refused):
            self.controller.promote()
        self.assertEqual(self.journal.read()["phase"], "promotion-intent")
        self.assertEqual(self.controller.recover(), "ready")
        self.host.route = self.new["generation"]
        r = self.journal.read()
        self.controller.save(r, "promotion-intent")
        self.assertEqual(self.controller.recover(), "draining-old")
        self.host.route = "unknown"
        self.controller.save(self.journal.read(), "promotion-intent")
        with self.assertRaises(c.Refused):
            self.controller.recover()

    def test_crash_after_switch_recovers_without_replay_or_old_termination(self):
        self.prepare()
        original = self.host.select
        def crash(generation, config):
            original(generation, config)
            raise RuntimeError("supervisor disappeared after ACK")
        self.host.select = crash
        with self.assertRaises(RuntimeError):
            self.controller.promote()
        self.assertEqual(self.journal.read()["phase"], "promotion-intent")
        self.assertEqual(self.controller.recover(), "draining-old")
        self.assertEqual(self.host.switches, 1)
        self.assertFalse(self.controller.retain())

    def test_reject_stale_or_missing_coordination(self):
        self.evidence["expiresAt"] = 100
        with self.assertRaises(c.Refused):
            self.prepare()
        self.evidence["expiresAt"] = 200
        del self.evidence["checks"]["shared-capacity"]
        with self.assertRaises(c.Refused):
            self.prepare()

    def test_reject_helper_upgrade_or_resource_collision(self):
        self.new["helperSet"] = "e" * 64
        with self.assertRaises(c.Refused):
            self.prepare()
        self.new["helperSet"] = self.old["helperSet"]
        self.new["address"] = self.old["address"]
        with self.assertRaises(c.Refused):
            self.prepare()

    def test_symlinks_and_parallel_lock_refused(self):
        with self.assertRaises(BlockingIOError):
            c.Journal(self.tmp.name)
        link = Path(self.tmp.name) / "linked"
        link.symlink_to(self.tmp.name)
        with self.assertRaises(c.Refused):
            c.Journal(link)

    def test_proxy_disables_replay_and_buffering(self):
        config = p.nginx_config(self.new, {"dashboard": 30128, "api": 30129})
        for fragment in ("proxy_next_upstream off;", "proxy_request_buffering off;", "proxy_buffering off;", "proxy_http_version 1.1;", "proxy_set_header Upgrade $http_upgrade;"):
            self.assertIn(fragment, config)
        self.assertNotIn("worker_shutdown_timeout ", config)
        self.assertNotIn("mirror ", config)
        self.assertIn("pid /run/omni-local-next/canary/nginx.pid;", config)


if __name__ == "__main__":
    unittest.main()

class RuntimeTest(unittest.TestCase):
    def test_fixed_compiler_preserves_security_and_changes_generation_resources(self):
        runtime = importlib.import_module("scripts.deploy.canary.runtime")
        g = generation("b", "green", "10.203.251.2")
        policy = {"schema": 1, "activation": "approved-deployment", "profile": "kernel-residential-v1",
                  "images": {"app": g["image"], "browser": "sha256:" + "c" * 64, "codex": "sha256:" + "d" * 64},
                  "helpers": {"browser": True, "codex": True}}
        receipt = {"generation": c.digest(g), "namespace": g["namespace"], "address": g["address"],
                   "egressPolicy": "kernel-residential-v1", "stateProtocol": "coordinated-live-v1", "stableHelperSet": g["helperSet"]}
        argv = runtime.command(policy, g, receipt)
        for fragment in ("--cap-drop=all", "--security-opt=no-new-privileges", "--read-only", "--pull=never", "--dns=none", "--user=10001:10001", "--network=ns:/run/netns/" + g["namespace"]):
            self.assertIn(fragment, argv)
        self.assertNotIn("--network=ns:/run/netns/omni-app", argv)
        self.assertNotIn("--name=omni-local-next-app", argv)
        self.assertIn("--env=OMNI_SHARED_ADMISSION=true", argv)
        self.assertIn("--env=OMNI_COORDINATION_DB=/app/data/coordination.sqlite", argv)
        self.assertIn("--env=OMNI_COORDINATION_PROCESS_ROLE=generation", argv)
        receipt["stableHelperSet"] = "e" * 64
        with self.assertRaises(c.Refused):
            runtime.command(policy, g, receipt)

class AdapterTest(unittest.TestCase):
    def test_fixed_adapter_refuses_unapproved_launch_and_unknown_operation(self):
        a = importlib.import_module("scripts.deploy.canary.adapter")
        runtime = importlib.import_module("scripts.deploy.canary.runtime")
        g = generation("b", "green", "10.203.251.2")
        runtime_policy = {"schema": 1, "activation": "approved-deployment", "profile": "kernel-residential-v1",
                          "images": {"app": g["image"], "browser": "sha256:" + "c" * 64, "codex": "sha256:" + "d" * 64},
                          "helpers": {"browser": True, "codex": True}}
        def record(value):
            return {"generation": value, "runtime": {**runtime_policy, "images": {**runtime_policy["images"], "app": value["image"]}},
                    "boundaryReceipt": {"generation": c.digest(value), "namespace": value["namespace"], "address": value["address"], "egressPolicy": "kernel-residential-v1", "stateProtocol": "coordinated-live-v1", "stableHelperSet": value["helperSet"]}}
        old = generation("a", "blue", "10.203.250.2")
        layout = {"schema": 1, "activation": "approved-canary-host-v1", "generations": [record(old), record(g)],
                  "listeners": {"api": 30129, "dashboard": 30128}, "binaryHashes": {key: "c" * 64 for key in a.BINARIES},
                  "approvalDigest": "d" * 64, "coordinationProtocol": "omni-coordination/v1", "observationUrls": [], "implementationHashes": {}}
        called = []
        adapter = a.Adapter(layout, runner=lambda *args: called.append(args))
        with self.assertRaises(c.Refused):
            adapter.operate("arbitrary-shell", {})
        with self.assertRaises(c.Refused):
            adapter.operate("verify-approval", {"transactionDigest": "e" * 64})
        self.assertEqual(called, [])
        with self.assertRaises(c.Refused):
            a.Adapter({**layout, "activation": "disabled"})

    def test_checkout_adapter_cannot_execute_even_as_root(self):
        import subprocess
        path = Path(__file__).resolve().parents[2] / "scripts/deploy/canary/adapter"
        result = subprocess.run([str(path), "--protocol=1", "observe-admission"], input="{}", text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["category"], "canary-host-installation-refused")
        self.assertNotIn(str(path), result.stdout)

class BoundaryTest(unittest.TestCase):
    def test_stale_wrong_namespace_attestation_refused(self):
        b = importlib.import_module("scripts.deploy.canary.boundary")
        g = generation("b", "green", "10.203.251.2")
        claim = {"v": 1, "policyId": "omni-app-residential-direct-v1", "bootId": "boot",
                 "appNetnsInode": "123", "topologyGeneration": "b" * 32,
                 "egressGeneration": "11111111-1111-1111-1111-111111111111", "issuedBootMs": 1000, "expiresBootMs": 11000}
        b.validate_attestation(claim, g, boot="boot", inode=123, boot_ms=5000)
        with self.assertRaises(c.Refused):
            b.validate_attestation(claim, g, boot="boot", inode=124, boot_ms=5000)
        with self.assertRaises(c.Refused):
            b.validate_attestation(claim, g, boot="boot", inode=123, boot_ms=12000)
        with self.assertRaises(c.Refused):
            b.validate_attestation(claim, g, boot="other", inode=123, boot_ms=5000)


class RetirementObservationTest(unittest.TestCase):
    def test_missing_unknown_fields_are_not_success(self):
        a = importlib.import_module("scripts.deploy.canary.adapter")
        cid = "c" * 64
        self.assertTrue(a.retirement_observed([], cid))
        self.assertTrue(a.retirement_observed([{"Id": cid, "State": "exited"}], cid))
        self.assertFalse(a.retirement_observed([{"Id": cid, "State": "running"}], cid))
        self.assertFalse(a.retirement_observed([{"Id": cid, "State": "paused"}], cid))
        with self.assertRaises(c.Refused):
            a.retirement_observed([{"Id": cid}], cid)
        with self.assertRaises(c.Refused):
            a.retirement_observed([{"ID": cid, "State": "running"}], cid)
