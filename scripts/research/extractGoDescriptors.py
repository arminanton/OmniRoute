"""Bounded read-only protobuf descriptor extraction from native Go binaries.

No code execution, credentials, disassembly claims or upstream calls. A serialized
FileDescriptorProto proves schema inclusion, not account entitlement or live use.
"""
import argparse
import hashlib
import json
from pathlib import Path


def varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ValueError("truncated varint")
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError("oversized varint")


def wire(data, *, max_field=536870911):
    offset = 0
    output = {}
    while offset < len(data):
        tag, offset = varint(data, offset)
        field, kind = tag >> 3, tag & 7
        if not 1 <= field <= max_field:
            raise ValueError("invalid field")
        if kind == 0:
            value, offset = varint(data, offset)
        elif kind in (1, 5):
            size = 8 if kind == 1 else 4
            value = data[offset:offset + size]
            if len(value) != size:
                raise ValueError("truncated fixed field")
            offset += size
        elif kind == 2:
            size, offset = varint(data, offset)
            if size > 8 * 1024 * 1024 or offset + size > len(data):
                raise ValueError("invalid bounded field length")
            value = data[offset:offset + size]
            offset += size
        else:
            raise ValueError("unsupported wire kind")
        output.setdefault(field, []).append(value)
    return output


def text(fields, number, default=""):
    values = fields.get(number, [])
    return values[0].decode("utf8") if values and isinstance(values[0], bytes) else default


def descriptor(data):
    value = wire(data, max_field=14)
    name = text(value, 1)
    if not name.endswith(".proto") or not text(value, 2):
        raise ValueError("not a file descriptor")
    def message(raw, prefix=""):
        msg = wire(raw)
        fullname = prefix + text(msg, 1)
        fields = []
        for raw_field in msg.get(2, []):
            field = wire(raw_field)
            fields.append({"name": text(field, 1), "jsonName": text(field, 10), "number": field.get(3, [None])[0], "type": field.get(5, [None])[0], "typeName": text(field, 6)})
        nested = [message(part, fullname + ".") for part in msg.get(3, [])]
        return {"name": fullname, "fields": fields, "nested": nested}
    services = []
    for raw in value.get(6, []):
        svc = wire(raw)
        methods = []
        for raw_method in svc.get(2, []):
            method = wire(raw_method)
            item = {"name": text(method, 1), "input": text(method, 2), "output": text(method, 3), "clientStreaming": method.get(5, [0])[0] == 1, "serverStreaming": method.get(6, [0])[0] == 1}
            options = wire(method.get(4, [b""])[0])
            if 72295728 in options:
                rule = wire(options[72295728][0])
                item["http"] = {"get": text(rule, 2), "post": text(rule, 4), "body": text(rule, 7)}
            methods.append(item)
        services.append({"name": text(svc, 1), "methods": methods})
    return {"file": name, "package": text(value, 2), "messages": [message(raw) for raw in value.get(4, [])], "services": services}


def extract(data, filename):
    encoded = filename.encode()
    offset = data.find(encoded)
    while offset >= 0:
        for prefix in range(max(0, offset - 8), offset):
            if data[prefix] != 10:
                continue
            try:
                size, name_start = varint(data, prefix + 1)
                if size != len(encoded) or name_start != offset:
                    continue
                position = offset + len(encoded)
                last = position
                # Find serialized descriptor boundary by complete top-level fields.
                # Padding/next allocation generally starts with invalid tag 0.
                while position < min(len(data), prefix + 8 * 1024 * 1024):
                    start = position
                    tag, position = varint(data, position)
                    number, kind = tag >> 3, tag & 7
                    if number not in {2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14}:
                        break
                    if kind == 2:
                        count, position = varint(data, position)
                        position += count
                    elif kind == 0:
                        _, position = varint(data, position)
                    else:
                        break
                    if position > len(data):
                        break
                    last = position
                parsed = descriptor(data[prefix:last])
                parsed["offset"] = prefix
                parsed["descriptorSha256"] = hashlib.sha256(data[prefix:last]).hexdigest()
                return parsed
            except (ValueError, UnicodeError, IndexError):
                continue
        offset = data.find(encoded, offset + 1)
    raise ValueError("complete descriptor not found")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    data = args.binary.read_bytes()
    result = {"binarySha256": hashlib.sha256(data).hexdigest(), "descriptors": []}
    for filename in args.files:
        try:
            result["descriptors"].append(extract(data, filename))
        except ValueError:
            result["descriptors"].append({"file": filename, "found": False})
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
