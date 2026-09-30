"""Offline source fixtures. Do not execute until consolidated acceptance."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("runtime_launcher", Path(__file__).parents[1] / "runtime_launcher.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class KernelLauncherTests(unittest.TestCase):
    def policy(self):
        return {"schema": 1, "activation": "approved-deployment",
                "profile": "kernel-residential-v1",
                "images": {role: "sha256:" + "a" * 64 for role in launcher.ROLES},
                "helpers": {"browser": True, "codex": True}}

    def claim(self):
        return {"v": 1, "policyId": "omni-app-residential-direct-v1",
                "bootId": "00000000-0000-4000-8000-000000000001",
                "appNetnsInode": "123", "topologyGeneration": "a" * 32,
                "egressGeneration": "00000000-0000-4000-8000-000000000002",
                "issuedBootMs": 1000, "expiresBootMs": 15000}

    def validate(self, claim, **changes):
        args = dict(inode=123, boot_id=self.claim()["bootId"], now_ms=2000)
        args.update(changes)
        launcher.validate_kernel_claim(claim, **args)

    def test_each_role_has_exact_namespace_and_no_authority_grant(self):
        for role in launcher.ROLES:
            args = launcher.command(self.policy(), role)
            self.assertIn("--network=ns:/run/netns/omni-app", args)
            self.assertIn("--cap-drop=all", args)
            self.assertIn("--security-opt=no-new-privileges", args)
            self.assertIn("--read-only", args)
            self.assertIn("--user=10001:10001", args)
            self.assertIn("--pull=never", args)
            self.assertEqual(args[-2:], [role, "kernel-residential-v1"])
            self.assertFalse(any("omni-runtime-policy" in arg for arg in args))
            self.assertFalse(any("docker.sock" in arg or "network=host" in arg for arg in args))

    def test_kernel_uses_persistent_home_data_and_normal_onboarding(self):
        args = launcher.command(self.policy(), "app")
        self.assertTrue(any("src=/home/ubuntu/.omniroute,dst=/app/data," in arg for arg in args))
        self.assertFalse(any(arg.startswith("--env-file=") for arg in args))
        env = launcher.workload_environment(self.policy(), "app")
        for key in ("JWT_SECRET", "API_KEY_SECRET", "INITIAL_PASSWORD"):
            self.assertNotIn(key, env)

    def test_browser_pool_and_private_login_mounts(self):
        policy = self.policy()
        policy["browserPool"] = True
        policy["dashboardOrigin"] = "https://omni.example.test"
        policy["helpers"]["browserLogin"] = True
        policy["images"]["browser-login"] = "sha256:" + "b" * 64
        app = launcher.command(policy, "app")
        helper = launcher.command(policy, "browser-login")
        self.assertIn("--env=OMNIROUTE_PUBLIC_BASE_URL=https://omni.example.test", app)
        self.assertFalse(any("OMNIROUTE_PUBLIC_BASE_URL" in x for x in helper))
        self.assertIn("--env=OMNIROUTE_BROWSER_POOL=true", app)
        self.assertIn("--env=PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", app)
        self.assertTrue(any("dst=/run/omniroute-browser-login,ro," in x for x in app))
        self.assertTrue(any("dst=/run/omniroute-browser-login,rw," in x for x in helper))
        self.assertTrue(any("dst=/var/lib/omniroute-browser-login,rw," in x for x in helper))
        for role in ("browser", "codex"):
            self.assertFalse(any("dst=/run/omniroute-browser-login" in x for x in launcher.command(policy, role)))

    def test_codex_home_does_not_require_image_node_home_access(self):
        policy = self.policy()
        codex = launcher.command(policy, "codex")
        app = launcher.command(policy, "app")
        self.assertIn("--env=HOME=/codex-home", codex)
        for args in (codex, app):
            self.assertIn("--env=CODEX_HOME=/codex-home", args)
            self.assertTrue(any("dst=/codex-home,rw," in arg for arg in args))
            self.assertFalse(any("/home/node/.codex" in arg for arg in args))

    def test_browser_login_requires_explicit_secure_origin(self):
        policy = self.policy()
        policy["helpers"]["browserLogin"] = True
        policy["images"]["browser-login"] = "sha256:" + "b" * 64
        for origin in (None, "http://omni.example.test", "https://user:password@omni.example.test", "https://omni.example.test/path"):
            if origin is None:
                policy.pop("dashboardOrigin", None)
            else:
                policy["dashboardOrigin"] = origin
            with self.assertRaises(launcher.PolicyError):
                launcher.command(policy, "browser-login")

    def test_legacy_stays_locked(self):
        policy = self.policy()
        del policy["profile"]
        args = launcher.command(policy, "app")
        self.assertTrue(any("dst=/run/omni-runtime-policy" in arg for arg in args))
        self.assertEqual(args[-1], "locked-experimental-v1")

    def test_unknown_profile_and_disabled_helper_refused(self):
        policy = self.policy()
        policy["profile"] = "host"
        with self.assertRaises(launcher.PolicyError):
            launcher.command(policy, "app")
        policy = self.policy()
        policy["helpers"]["browser"] = False
        with self.assertRaises(launcher.PolicyError):
            launcher.command(policy, "browser")

    def test_valid_claim(self):
        self.validate(self.claim())

    def test_stale_wrong_namespace_boot_and_future_refused(self):
        for changes in ({"inode": 124}, {"boot_id": "other"}, {"now_ms": 15000}, {"now_ms": 999}):
            with self.assertRaises(launcher.PolicyError):
                self.validate(self.claim(), **changes)
        claim = self.claim()
        claim["expiresBootMs"] = 99999
        with self.assertRaises(launcher.PolicyError):
            self.validate(claim)

    def test_auth_env_cannot_supply_proxy_or_loader(self):
        auth = b"JWT_SECRET=a\nAPI_KEY_SECRET=b\nINITIAL_PASSWORD=c\n"
        launcher.check_auth(auth)
        for key in (b"HTTP_PROXY", b"NODE_OPTIONS", b"DOCKER_HOST"):
            with self.assertRaises(launcher.PolicyError):
                launcher.check_auth(auth + key + b"=value\n")


if __name__ == "__main__":
    unittest.main()
