import copy
import unittest
from scripts.deploy.canary import maintenanceRuntime as m
from scripts.deploy.canary.controller import Refused, digest


def fixture():
    g = {"generation": "a" * 32, "slot": "green", "revision": "b" * 40, "image": "sha256:" + "c" * 64,
         "namespace": "omni-app-" + "a" * 32, "address": "10.203.250.2", "stateOwner": "coordinated-live-v1", "helperSet": "d" * 64}
    p = {"schema": 1, "activation": "approved-deployment", "profile": "kernel-residential-v1",
         "images": {role: g["image"] for role in ["app", "browser", "codex"]}, "helpers": {"browser": True, "codex": True}}
    boundary = {"generation": digest(g), "namespace": g["namespace"], "address": g["address"], "egressPolicy": "kernel-residential-v1", "stateProtocol": "coordinated-live-v1", "stableHelperSet": g["helperSet"]}
    bundle = {"schema": "omni-maintenance-entry/v1", "imageRevision": g["revision"], "entrySha256": "e" * 64, "loaderSha256": "f" * 64}
    return p, g, boundary, bundle


class MaintenanceRuntimeTests(unittest.TestCase):
    def test_fixed_role_and_readonly_overlays_keep_existing_boundary_wrapper(self):
        p, g, proof, bundle = fixture(); argv = m.command(p, g, proof, bundle)
        self.assertIn("--name=omni-maintenance-" + g["generation"], argv)
        self.assertIn("--env=OMNI_COORDINATION_PROCESS_ROLE=maintenance", argv)
        self.assertNotIn("--env=OMNI_COORDINATION_PROCESS_ROLE=generation", argv)
        self.assertIn("--env=OMNI_SHARED_ADMISSION=true", argv)
        self.assertIn("--env=OMNI_COORDINATION_DB=/app/data/coordination.sqlite", argv)
        self.assertIn("--network=ns:/run/netns/" + g["namespace"], argv)
        self.assertIn("--cap-drop=all", argv); self.assertIn("--read-only", argv); self.assertIn("--no-hosts", argv)
        self.assertIn("/opt/omni-runtime/workload-entrypoint.mjs", argv)
        self.assertEqual(argv[-2:], ["app", "kernel-residential-v1"])
        for path in (str(m.ENTRY), str(m.LOADER)):
            self.assertTrue(any(path in value and ",readonly," in value for value in argv))
        self.assertTrue(any("/maintenance/" in value and "maintenance.cid" in value for value in argv))

    def test_no_extra_argv_paths_or_foreign_image_bundle(self):
        p, g, proof, bundle = fixture()
        for key, value in [("command", "shell"), ("entryPath", "/tmp/untrusted.cjs")]:
            foreign = copy.deepcopy(bundle); foreign[key] = value
            with self.assertRaises(Refused): m.command(p, g, proof, foreign)
        bundle["imageRevision"] = "f" * 40
        with self.assertRaises(Refused): m.command(p, g, proof, bundle)

    def test_missing_real_boundary_or_helper_ownership_refused(self):
        p, g, proof, bundle = fixture(); proof["stableHelperSet"] = "a" * 64
        with self.assertRaises(Refused): m.command(p, g, proof, bundle)


if __name__ == "__main__": unittest.main()
