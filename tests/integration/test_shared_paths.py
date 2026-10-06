"""Fixed clean-install paths; root permission acceptance also has a private OS proof."""
import unittest
from unittest.mock import patch
from scripts.deploy.canary import sharedPaths, adapter
from tests.integration.test_shared_app_profile import fixture


class SharedPathsTests(unittest.TestCase):
    def test_exact_paths_and_worker_permissions(self):
        layout={'generations':[{'generation':fixture(slot)[1]} for slot in ('blue','green')],
                'maintenance':{'generation':fixture('maintenance')[1]}}
        with patch.object(sharedPaths,'private_directory') as create:
            sharedPaths.provision(layout)
        calls=[(call.args[0],call.kwargs) for call in create.call_args_list]
        self.assertIn(('/run/omni-local-next/generations/'+'a'*32,{}),calls)
        self.assertIn(('/run/omni-local-next/generations/'+'b'*32,{}),calls)
        self.assertIn(('/run/omni-local-next/maintenance/'+'c'*32,{}),calls)
        self.assertIn(('/var/lib/omni-local-next/deployments/canary',{}),calls)
        self.assertIn(('/run/omni-canary-worker',{'mode':0o711}),calls)
        for name in ('body','proxy','fastcgi','uwsgi','scgi'):
            self.assertIn(('/run/omni-canary-worker/'+name,{'owner':65534}),calls)
        self.assertEqual(len(calls),16)

    def test_invalid_identifier_does_not_create_identifier_directory(self):
        g=fixture()[1];g['generation']='../escape'
        with patch.object(sharedPaths,'private_directory') as create:
            with self.assertRaises(Exception):
                sharedPaths.provision({'generations':[{'generation':g}],
                                      'maintenance':{'generation':fixture('maintenance')[1]}})
        self.assertFalse(any('escape' in call.args[0] for call in create.call_args_list))

    def test_canonical_ip_binary(self):
        self.assertEqual(adapter.BINARIES['ip'],'/usr/bin/ip')


if __name__=='__main__':unittest.main()
