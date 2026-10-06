import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2] / "scripts/research/extractGoDescriptors.py"
spec = importlib.util.spec_from_file_location("descriptor_extractor", path)
x = importlib.util.module_from_spec(spec)
spec.loader.exec_module(x)


def v(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def field(number, value):
    return v(number << 3 | 2) + v(len(value)) + value


class DescriptorTest(unittest.TestCase):
    def test_complete_schema_is_distinct_from_textual_symbols(self):
        filename = "native/fixture.proto"
        model = field(1, b"Request") + field(2, field(1, b"model") + v(3 << 3) + v(1) + v(5 << 3) + v(9))
        method = field(1, b"Generate") + field(2, b".native.Request") + field(3, b".native.Response") + v(6 << 3) + v(1)
        service = field(1, b"Prediction") + field(2, method)
        raw = field(1, filename.encode()) + field(2, b"native") + field(4, model) + field(6, service) + field(12, b"proto3")
        parsed = x.extract(b"prefix-scope" + raw + b"\0padding", filename)
        self.assertEqual(parsed["package"], "native")
        self.assertEqual(parsed["messages"][0]["fields"][0]["name"], "model")
        self.assertTrue(parsed["services"][0]["methods"][0]["serverStreaming"])
        self.assertEqual(len(parsed["descriptorSha256"]), 64)
        with self.assertRaises(ValueError):
            x.extract(b"text native/fixture.proto symbol only", filename)

    def test_malformed_and_unbounded_wire_fields_refused(self):
        for raw in (b"\x00", b"\x0a\xff", b"\x0a" + v(9 * 1024 * 1024), b"\xff" * 20):
            with self.assertRaises(ValueError):
                x.wire(raw)


if __name__ == "__main__":
    unittest.main()
