import hashlib
import importlib.util
from pathlib import Path
import unittest

root = Path(__file__).resolve().parents[2]
file = root / "scripts/deploy/residential/runtime_launcher.py"
spec = importlib.util.spec_from_file_location("static_hosts_runtime", file)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class StaticHostsTest(unittest.TestCase):
    def test_asset_contains_only_reviewed_loopback_addresses(self):
        raw = (root / "scripts/deploy/residential/static-loopback-hosts").read_bytes()
        self.assertEqual(raw, b"127.0.0.1 localhost\n::1 localhost\n")
        runtime.validate_static_hosts(raw)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), runtime.STATIC_HOSTS_SHA256)
        with self.assertRaises(runtime.PolicyError):
            runtime.validate_static_hosts(raw + b"10.0.0.1 host-gateway\n")
        with self.assertRaises(runtime.PolicyError):
            runtime.validate_static_hosts(b"127.0.0.1 provider.example\n")

    def test_all_roles_keep_no_hosts_and_mount_fixed_readonly_file(self):
        policy = {"schema": 1, "activation": "approved-deployment", "profile": "kernel-residential-v1",
                  "images": {role: "sha256:" + "a" * 64 for role in runtime.ALL_ROLES},
                  "helpers": {"browser": True, "codex": True, "browserLogin": True},
                  "dashboardOrigin": "https://omni.example.test"}
        for role in runtime.ALL_ROLES:
            args = runtime.command(policy, role)
            self.assertIn("--no-hosts", args)
            self.assertIn("--dns=none", args)
            hosts = [arg for arg in args if "dst=/etc/hosts," in arg]
            self.assertEqual(len(hosts), 1)
            self.assertIn("src=/opt/omni-local-next/runtime/static-loopback-hosts", hosts[0])
            self.assertIn(",ro,", hosts[0])
            self.assertNotIn("host-gateway", " ".join(args))

    def test_canary_probe_requires_filehash_and_native_localhost_lookup(self):
        source = (root / "scripts/deploy/canary/boundary.py").read_text()
        self.assertIn(runtime.STATIC_HOSTS_SHA256, source)
        self.assertIn('dns.lookup("localhost",{all:true})', source)
        self.assertIn('x.address==="127.0.0.1"', source)
