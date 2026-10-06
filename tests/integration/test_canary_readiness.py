import importlib
import json
from pathlib import Path
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
r = importlib.import_module("scripts.deploy.canary.readiness")


class ReadinessTest(unittest.TestCase):
    def setUp(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if self.headers.get("Authorization") != "Bearer fixture-private-key":
                    self.send_response(401)
                    self.end_headers()
                    return
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/cold")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("X-Omni-App-Generation", "wrong" if self.path == "/wrong" else "a" * 32)
                self.end_headers()
                if self.path == "/invalid":
                    self.wfile.write(b"secret-request-body invalid json")
                elif self.path == "/trickle":
                    import time
                    for _ in range(20):
                        try:
                            self.wfile.write(b" ")
                            self.wfile.flush()
                            time.sleep(0.02)
                        except OSError:
                            break
                elif self.path == "/duplicates":
                    self.wfile.write(json.dumps({"data": [{"id": "cx/m"}, {"id": "cx/m"}]}).encode())
                else:
                    self.wfile.write(json.dumps({"data": [{"id": "cx/m"}]}).encode())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def probe(self, path, key="fixture-private-key"):
        return r.probe_json(self.url + path, key, "a" * 32, r.catalog_valid)

    def test_cold_and_warm_and_actual_generation(self):
        self.assertTrue(self.probe("/cold")["ok"])
        self.assertTrue(self.probe("/warm")["ok"])
        self.assertEqual(self.probe("/wrong")["category"], "generation-mismatch")

    def test_redacted_invalid_body_and_semantic_failures(self):
        result = self.probe("/invalid")
        self.assertEqual(result["stage"], "json")
        self.assertEqual(result["category"], "invalid-json")
        self.assertNotIn("secret-request-body", json.dumps(result))
        self.assertNotIn("fixture-private-key", json.dumps(result))
        self.assertEqual(self.probe("/duplicates")["category"], "semantic-validation")

    def test_auth_fail_is_distinct_from_json_error(self):
        result = self.probe("/", "bad-private-key")
        self.assertEqual(result["status"], 401)
        self.assertEqual(result["category"], "http-status")
        self.assertNotIn("bad-private-key", json.dumps(result))

    def test_authenticated_redirect_is_not_followed(self):
        result = self.probe("/redirect")
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], 302)

    def test_total_deadline_survives_trickled_body(self):
        result = r.probe_json(self.url + "/trickle", "fixture-private-key", "a" * 32, r.catalog_valid, timeout=0.08)
        self.assertFalse(result["ok"])
        self.assertEqual(result["stage"], "body")
        self.assertEqual(result["category"], "transport-timeout-or-io")
        self.assertLess(result["elapsedMs"], 250)
