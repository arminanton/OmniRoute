import importlib
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
x = importlib.import_module("scripts.deploy.canary.conversation")
c = importlib.import_module("scripts.deploy.canary.controller")


class ExchangeTest(unittest.TestCase):
    def setUp(self):
        self.old = {"generation": "a" * 32, "namespace": "old"}
        self.candidate = {"generation": "b" * 32, "namespace": "candidate"}
        self.calls = []
        self.ids = {"a" * 32: "11111111-1111-4111-8111-111111111111", "b" * 32: "22222222-2222-4222-8222-222222222222"}
    def collect(self, g, peer):
        self.calls.append((g["generation"], peer))
        if peer is None:
            return {"protocol": x.PROTOCOL, "generation": g["generation"], "namespace": g["namespace"], "challengeId": self.ids[g["generation"]], "expiresAt": 130000}
        other = self.candidate if g == self.old else self.old
        return {"protocol": x.PROTOCOL, "generation": g["generation"], "peerGeneration": other["generation"], "peerChallengeId": peer, "completed": True}
    def test_pair_collects_both_before_bound_exchange(self):
        x.exchange(self.old, self.candidate, self.collect, clock=lambda: 100)
        self.assertEqual([v[1] for v in self.calls], [None, None, self.ids[self.candidate["generation"]], self.ids[self.old["generation"]]])
    def test_same_generation_and_stale_or_forged_binding_refused(self):
        with self.assertRaises(c.Refused): x.exchange(self.old, self.old, self.collect, clock=lambda: 100)
        for field, replacement in (("generation", "unknown"), ("namespace", "other"), ("expiresAt", 90000), ("protocol", "legacy")):
            def bad(g, peer):
                result = self.collect(g, peer)
                if peer is None: result[field] = replacement
                return result
            with self.assertRaises(c.Refused): x.exchange(self.old, self.candidate, bad, clock=lambda: 100)
    def test_post_must_acknowledge_exact_other_generation_and_nonce(self):
        for field, replacement in (("peerGeneration", "c" * 32), ("peerChallengeId", "33333333-3333-4333-8333-333333333333"), ("completed", False)):
            def bad(g, peer):
                result = self.collect(g, peer)
                if peer is not None: result[field] = replacement
                return result
            with self.assertRaises(c.Refused): x.exchange(self.old, self.candidate, bad, clock=lambda: 100)
