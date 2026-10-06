import copy
import unittest
import tempfile
from scripts.deploy.canary.bootstrap import validate, bridge_nft, legacy_nginx, check_transition, BootstrapJournal
from scripts.deploy.canary.controller import Refused, digest, Journal


def policy():
    return {"schema": "omni-initial-bootstrap/v1", "transaction": "a" * 32,
            "bootId": "01234567-89ab-cdef-0123-456789abcdef", "wanNamespaceInode": 123,
            "legacy": {"revision": "b" * 40, "image": "sha256:" + "c" * 64, "cid": "d" * 64,
                       "helperSet": "e" * 64, "stateOwner": "f" * 64},
            "guard": {"generation": "a" * 32, "policySha256": "b" * 64, "outputDeniedHandle": 71},
            "proxyBinarySha256": "c" * 64}


class InitialBootstrapTests(unittest.TestCase):
    def test_fixed_new_connection_bridge_preserves_existing_target_and_bypasses_nonroot_proxy(self):
        value = bridge_nft(policy())
        self.assertIn("type nat hook output priority dstnat", value)
        self.assertEqual(value.count("redirect to"), 2)
        self.assertEqual(value.count("meta skuid 0"), 2)
        self.assertIn('meta skuid 65534 oifname "app0" ip daddr 10.203.242.2 tcp dport { 20128, 20129 }', value)
        self.assertNotIn("flush", value)
        self.assertNotIn("20135", value)
        self.assertNotIn("9222", value)
        self.assertIn("output position 71", value)

    def test_no_arbitrary_runtime_args_or_public_names(self):
        for key, value in [("command", "nft flush ruleset"), ("proxyUid", 0), ("publicHostname", "new-host")]:
            p = policy(); p[key] = value
            with self.assertRaises(Refused): validate(p)

    def test_invalid_handle_or_provenance_refused(self):
        for value in [0, -1, True, "71; flush ruleset", 2 ** 40]:
            p = policy(); p["guard"]["outputDeniedHandle"] = value
            with self.assertRaises(Refused): bridge_nft(p)
        p = policy(); p["legacy"]["image"] = "latest"
        with self.assertRaises(Refused): legacy_nginx(p)

    def test_legacy_proxy_does_not_forge_new_app_generation_or_enable_replay(self):
        config = legacy_nginx(policy())
        self.assertIn("legacy-cccccccccccccccc", config)
        self.assertNotIn("X-Omni-App-Generation", config)
        self.assertEqual(config.count("proxy_next_upstream off"), 2)
        self.assertEqual(config.count("proxy_request_buffering off"), 2)
        self.assertIn("user nobody nogroup", config)
        self.assertNotIn("worker_shutdown_timeout", config)
        self.assertIn("X-Omniroute-Self-Hop ''", config)

    def test_pause_is_explicit_pre_dispatch_and_does_not_claim_legacy_drained(self):
        config = legacy_nginx(policy(), paused=True)
        self.assertEqual(config.count("return 503"), 2)
        self.assertIn("deployment_bootstrap_paused", config)
        self.assertIn("Retry-After 2 always", config)
        self.assertNotIn("kill", config)

    def test_first_ingress_only_receipt_does_not_assert_coordinated_overlap(self):
        names = {"legacyIdentity", "kernelBoundary", "privateAuth", "privateStreams", "proxyUidUnused", "nginxSyntax"}
        evidence = {"transactionDigest": digest(policy()), "checks": {name: {"ok": True, "proof": "d" * 64} for name in names}}
        receipt = check_transition(policy(), "bridge-ready", evidence)
        self.assertEqual(receipt["claim"], "ingress-only")
        with self.assertRaises(Refused): check_transition(policy(), "ordinary-canary", evidence)

    def test_unknown_longstreams_sessions_background_upstream_or_native_work_retain_legacy(self):
        names = {"newAdmissionsPaused", "directConnectionsZero", "proxiedBodiesZero", "webSocketsZero", "upstreamWorkZero", "legacyConversationsResolved", "legacyBackgroundStopped", "legacyContainerStopped"}
        valid = {"transactionDigest": digest(policy()), "checks": {name: {"ok": True, "proof": "d" * 64} for name in names}}
        self.assertEqual(check_transition(policy(), "legacy-stopped", valid)["claim"], "quiescent-baseline")
        for name in names:
            evidence = copy.deepcopy(valid); evidence["checks"][name]["ok"] = None
            with self.assertRaises(Refused): check_transition(policy(), "legacy-stopped", evidence)

    def test_durable_bootstrap_cannot_skip_phases_or_change_resources_after_crash(self):
        names = {"legacyIdentity", "kernelBoundary", "privateAuth", "privateStreams", "proxyUidUnused", "nginxSyntax"}
        evidence = {"transactionDigest": digest(policy()), "checks": {name: {"ok": True, "proof": "d" * 64} for name in names}}
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(directory)
            try:
                flow = BootstrapJournal(journal, policy())
                with self.assertRaises(Refused): flow.checkpoint("baseline-ready", evidence)
                flow.checkpoint("bridge-ready", evidence)
                resumed = BootstrapJournal(journal, policy())
                with self.assertRaises(Refused): resumed.checkpoint("bridge-ready", evidence)
                changed = policy(); changed["legacy"]["cid"] = "e" * 64
                with self.assertRaises(Refused): BootstrapJournal(journal, changed).checkpoint("bridge-selected", evidence)
                self.assertEqual(journal.read()["phase"], "bridge-ready")
            finally: journal.close()

    def test_wrong_transaction_or_unbound_boolean_is_not_proof(self):
        with self.assertRaises(Refused): check_transition(policy(), "bridge-ready", {"transactionDigest": "f" * 64})
        with self.assertRaises(Refused): check_transition(policy(), "bridge-ready", {"transactionDigest": digest(policy()), "checks": {}})


if __name__ == "__main__": unittest.main()
