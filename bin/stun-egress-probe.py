#!/usr/bin/env python3
"""Dependency-free STUN client — proves what public IP UDP traffic egresses from.

Mirrors the camoufox residential-egress verification: a STUN binding request is
raw UDP, so the XOR-MAPPED-ADDRESS it returns is the public IP as seen over the
*UDP* path. If that equals the NUC residential IP, UDP/QUIC egresses residential
(not the AWS datacenter IP) — the thing SOCKS5 can never prove because it can't
carry UDP at all.

Usage: stun-egress-probe.py            # tries several public STUN servers
Exit 0 + prints 'UDP_EGRESS_IP: <ip>' on success; exit 1 on total failure.
"""
import os
import socket
import struct
import sys

MAGIC = 0x2112A442
SERVERS = [
    ("stun.l.google.com", 19302),
    ("stun.cloudflare.com", 3478),
    ("stun.nextcloud.com", 443),
    ("stun1.l.google.com", 19302),
]


def probe(host, port, timeout=5):
    # Binding Request: type=0x0001, len=0, magic cookie, 12-byte txid.
    txid = os.urandom(12)
    msg = struct.pack(">HHI", 0x0001, 0, MAGIC) + txid
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(msg, (host, port))
        data, _ = s.recvfrom(2048)
    finally:
        s.close()
    if len(data) < 20:
        raise ValueError("short STUN reply")
    mtype, mlen, magic = struct.unpack(">HHI", data[:8])
    if mtype != 0x0101:  # Binding Success Response
        raise ValueError("not a success response: 0x%04x" % mtype)
    body = data[20 : 20 + mlen]
    off = 0
    while off + 4 <= len(body):
        atype, alen = struct.unpack(">HH", body[off : off + 4])
        val = body[off + 4 : off + 4 + alen]
        off += 4 + alen + ((4 - alen % 4) % 4)  # 4-byte alignment
        # XOR-MAPPED-ADDRESS (0x0020) — the modern, NAT-safe one.
        if atype == 0x0020 and len(val) >= 8 and val[1] == 0x01:  # IPv4
            xport = struct.unpack(">H", val[2:4])[0] ^ (MAGIC >> 16)
            xip = struct.unpack(">I", val[4:8])[0] ^ MAGIC
            ip = socket.inet_ntoa(struct.pack(">I", xip))
            return ip, xport
    raise ValueError("no XOR-MAPPED-ADDRESS in reply")


def main():
    for host, port in SERVERS:
        try:
            ip, port_ = probe(host, port)
            print("UDP_EGRESS_IP:", ip, "(via %s:%d, srflx port %d)" % (host, port, port_))
            return 0
        except Exception as e:
            print("  [miss] %s:%d -> %s" % (host, port, e), file=sys.stderr)
    print("UDP_EGRESS_IP: FAIL (all STUN servers unreachable)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
