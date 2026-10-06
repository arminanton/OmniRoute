import unittest
from scripts.deploy.canary.host import InstalledHost


class CaptureDrainTests(unittest.TestCase):
    def fixture(self, value=None, absent=False):
        drain={"fenced":True,"pendingBodies":0,"pendingUploads":0,"webSockets":0,"conversationPins":0,"upstreamLeases":0}
        if not absent:drain["diagnosticCaptureWork"]=value
        host=InstalledHost("a"*64)
        host.call=lambda *_:drain
        return host

    def test_missing_unknown_or_active_capture_prevents_retirement_drain(self):
        self.assertFalse(self.fixture(absent=True).drained({}))
        for value in (None,True,-1,1):self.assertFalse(self.fixture(value).drained({}))

    def test_known_actual_capture_zero_permits_drain(self):
        self.assertTrue(self.fixture(0).drained({}))


if __name__=="__main__":unittest.main()
