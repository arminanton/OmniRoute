import importlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
assets = importlib.import_module('scripts.deploy.canary.static_assets')
frontdoor = importlib.import_module('scripts.deploy.canary.frontdoor')
Refused = importlib.import_module('scripts.deploy.canary.controller').Refused


class AssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o755)
        self.old = self.root / 'old' / '.next' / 'static'
        self.new = self.root / 'new' / '.next' / 'static'
        for directory, name in [(self.old, 'old-abc.js'), (self.new, 'new-def.js')]:
            (directory / 'chunks').mkdir(parents=True)
            (directory / 'chunks' / name).write_text(name)
        self.owner = mock.patch.object(assets, 'OWNER_UID', os.geteuid())
        self.owner.start()

    def tearDown(self):
        self.owner.stop()
        for directory, _, files in os.walk(self.root):
            os.chmod(directory, 0o700)
            for name in files:
                os.chmod(Path(directory) / name, 0o600)
        self.temp.cleanup()

    def test_immutable_union_retains_prior_chunks_after_old_artifacts_retire(self):
        first = assets.merge_static_assets(self.old, self.new, self.root / 'store')
        shutil.rmtree(self.old.parent)
        fresh = self.root / 'fresh' / '.next' / 'static'
        fresh.mkdir(parents=True)
        (fresh / 'newer-ghi.js').write_text('newer')
        second = assets.merge_static_assets(self.new, fresh, self.root / 'store')
        self.assertEqual(second['fileCount'], 3)
        snapshot = Path(second['path'])
        self.assertEqual((snapshot / 'files/chunks/old-abc.js').read_text(), 'old-abc.js')
        self.assertEqual(assets.verify_asset_snapshot(snapshot), second)
        self.assertEqual((snapshot / 'files/chunks/old-abc.js').stat().st_mode & 0o777, 0o444)
        self.assertEqual(snapshot.stat().st_mode & 0o777, 0o555)
        location = assets.nginx_location(snapshot)
        self.assertIn('limit_except GET HEAD', location)
        self.assertNotIn('proxy_pass', location)

    def test_owner_and_untraversable_ancestry_cannot_be_served(self):
        snapshot = assets.merge_static_assets(self.old, self.new, self.root / 'store')
        with mock.patch.object(assets, 'OWNER_UID', os.geteuid() + 1):
            with self.assertRaises(Refused):
                assets.verify_asset_snapshot(snapshot['path'])
        self.root.chmod(0o700)
        with self.assertRaises(Refused):
            assets.nginx_location(snapshot['path'])

    def test_same_url_different_content_refuses_without_corrupting_existing_snapshot(self):
        first = assets.merge_static_assets(self.old, self.new, self.root / 'store')
        (self.new / 'chunks/old-abc.js').write_text('different')
        with self.assertRaisesRegex(Refused, 'content hashes'):
            assets.merge_static_assets(self.old, self.new, self.root / 'store')
        self.assertEqual(assets.verify_asset_snapshot(first['path']), first)
        self.assertFalse(list((self.root / 'store').glob('.stage-*')))

    def test_symlink_hardlink_nonstatic_input_and_changed_manifest_refused(self):
        (self.new / 'escape').symlink_to(self.old / 'chunks/old-abc.js')
        with self.assertRaises(Refused):
            assets.merge_static_assets(self.old, self.new, self.root / 'store')
        (self.new / 'escape').unlink()
        os.link(self.old / 'chunks/old-abc.js', self.new / 'hardlinked')
        with self.assertRaises(Refused):
            assets.merge_static_assets(self.old, self.new, self.root / 'store')
        (self.new / 'hardlinked').unlink()
        with self.assertRaises(Refused):
            assets.merge_static_assets(self.root, self.new, self.root / 'store')
        snapshot = assets.merge_static_assets(self.old, self.new, self.root / 'store')
        manifest = Path(snapshot['path']) / '.manifest.json'
        manifest.chmod(0o644)
        with self.assertRaises(Refused):
            assets.verify_asset_snapshot(snapshot['path'])


class FrontdoorTests(unittest.TestCase):
    def setUp(self):
        self.generation = 'a' * 32
        self.api_generation = self.generation
        self.bad_auth = False
        self.requests = []
        case = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                credential = self.headers.get('Authorization')
                status = 200
                if self.path.startswith('/api/canary-readiness'):
                    body = {'schema': 'omni-canary-readiness/v1', 'generation': case.generation, 'ready': True}
                    if credential != 'Bearer private-read-key':
                        status, body = 401, {'error': 'unauthorized'}
                    generation = case.generation
                elif self.path.startswith('/v1/models'):
                    body = {'object': 'list', 'data': [{'id': 'cx/fixture'}]}
                    generation = case.api_generation
                else:
                    body = case.generation
                    generation = case.generation
                self.send_response(status)
                self.send_header('X-Omni-App-Generation', generation)
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                case.requests.append(body)
                if body != {'action': 'status', 'generation': 1} or self.path != '/v1/session-leases':
                    status, code = 400, 'NOT_READ_ONLY'
                elif not self.headers.get('Authorization'):
                    status, code = 401, 'LEASE_AUTHENTICATION_REQUIRED'
                elif self.headers.get('Authorization') != 'Bearer private-read-key':
                    status, code = 401, 'LEASE_API_KEY_INVALID'
                else:
                    status, code = 403, 'LEASE_SCOPE_REQUIRED'
                if case.bad_auth:
                    status, code = 200, 'public'
                self.send_response(status)
                self.send_header('X-Omni-App-Generation', case.api_generation)
                self.end_headers()
                self.wfile.write(json.dumps({'error': {'code': code}}).encode())
        self.servers = [ThreadingHTTPServer(('127.0.0.1', 0), Handler) for _ in range(2)]
        self.threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in self.servers]
        for thread in self.threads:
            thread.start()
        self.targets = {'dashboard': f'http://127.0.0.1:{self.servers[0].server_port}/api/canary-readiness',
                        'api': f'http://127.0.0.1:{self.servers[1].server_port}/v1/models?prefix=alias&configuredOnly=true'}

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join()

    def test_public_catalog_plus_protected_readonly_auth_proves_both_actual_upstreams(self):
        result = frontdoor.observe_frontdoors(self.targets, 'private-read-key', self.generation)
        self.assertTrue(result['ok'])
        self.assertEqual(result['apiGeneration'], self.generation)
        self.assertEqual(self.requests, [{'action': 'status', 'generation': 1}] * 3)

    def test_config_marker_new_with_actual_api_old_refuses(self):
        self.api_generation = 'b' * 32
        with self.assertRaisesRegex(Refused, 'actual forwarded app generation'):
            frontdoor.observe_frontdoors(self.targets, 'private-read-key', self.generation)

    def test_bearer_sent_to_public_status_is_not_authentication_proof(self):
        self.bad_auth = True
        with self.assertRaisesRegex(Refused, 'authentication/scope'):
            frontdoor.observe_frontdoors(self.targets, 'private-read-key', self.generation)

if __name__ == '__main__':
    unittest.main()
