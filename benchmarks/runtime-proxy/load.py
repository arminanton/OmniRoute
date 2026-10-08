#!/usr/bin/env python3
"""Small dependency-free concurrent HTTP/1.1 streaming load client."""

import argparse
import asyncio
from collections import Counter
import json
import time


def percentile(values, percent):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((percent / 100) * (len(ordered) - 1))))
    return round(ordered[index], 3)


async def read_response(reader):
    status_line = await reader.readline()
    if not status_line:
        raise ConnectionError("upstream closed before status line")
    parts = status_line.decode("latin1").strip().split(" ", 2)
    if len(parts) < 2:
        raise ConnectionError("invalid HTTP status line")
    status = int(parts[1])
    headers = {}
    while True:
        line = await reader.readline()
        if line in (b"\r\n", b"\n", b""):
            break
        name, _, value = line.decode("latin1").partition(":")
        headers[name.strip().lower()] = value.strip()
    return status, headers


async def read_chunked(reader, started):
    first_body_ms = None
    total_bytes = 0
    while True:
        size_line = await reader.readline()
        if not size_line:
            raise ConnectionError("EOF while reading chunk length")
        size = int(size_line.split(b";", 1)[0].strip(), 16)
        if size == 0:
            while True:
                trailer = await reader.readline()
                if trailer in (b"\r\n", b"\n", b""):
                    break
            return total_bytes, first_body_ms
        data = await reader.readexactly(size)
        await reader.readexactly(2)  # CRLF after the chunk body
        if first_body_ms is None:
            first_body_ms = (time.perf_counter() - started) * 1000
        total_bytes += len(data)


async def read_body(reader, headers, started):
    if "chunked" in headers.get("transfer-encoding", "").lower():
        return await read_chunked(reader, started)
    if "content-length" in headers:
        size = int(headers["content-length"])
        if size == 0:
            return 0, None
        await reader.readexactly(size)
        return size, (time.perf_counter() - started) * 1000
    total = 0
    first_body_ms = None
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            break
        if first_body_ms is None:
            first_body_ms = (time.perf_counter() - started) * 1000
        total += len(chunk)
    return total, first_body_ms


async def call_one(port, index, body, timeout, cancel_after_ms):
    started = time.perf_counter()
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", port), timeout=timeout
        )
        headers_started = time.perf_counter()
        request = (
            f"POST /v1/responses HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"X-Request-ID: bench-{index}\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        writer.write(request + body)
        await writer.drain()
        status, response_headers = await asyncio.wait_for(
            read_response(reader), timeout=timeout
        )
        headers_ms = (time.perf_counter() - headers_started) * 1000
        if cancel_after_ms is not None:
            await asyncio.sleep(cancel_after_ms / 1000.0)
            elapsed_ms = (time.perf_counter() - started) * 1000
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return {
                "ok": 200 <= status < 300,
                "status": status,
                "cancelled": True,
                "headersMs": round(headers_ms, 3),
                "firstBodyMs": None,
                "elapsedMs": round(elapsed_ms, 3),
                "outputBytes": 0,
            }
        output_bytes, first_body_ms = await asyncio.wait_for(
            read_body(reader, response_headers, started), timeout=timeout
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        return {
            "ok": 200 <= status < 300,
            "status": status,
            "cancelled": False,
            "headersMs": round(headers_ms, 3),
            "firstBodyMs": None if first_body_ms is None else round(first_body_ms, 3),
            "elapsedMs": round(elapsed_ms, 3),
            "outputBytes": output_bytes,
        }
    except Exception as error:
        return {"ok": False, "error": type(error).__name__ + ": " + str(error)}
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3901)
    parser.add_argument("--clients", type=int, default=100)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--label", default="unspecified")
    parser.add_argument("--cancel-after-ms", type=int)
    args = parser.parse_args()
    body = json.dumps(
        {
            "model": "mock/model",
            "stream": True,
            "input": [{"type": "message", "role": "user", "content": "benchmark"}],
        },
        separators=(",", ":"),
    ).encode("utf8")
    started = time.perf_counter()
    results = await asyncio.gather(
        *[
            call_one(args.port, index, body, args.timeout, args.cancel_after_ms)
            for index in range(args.clients)
        ]
    )
    elapsed = time.perf_counter() - started
    accepted = [result for result in results if result.get("ok")]
    completed = [result for result in accepted if not result.get("cancelled")]
    first_body_times = [
        result["firstBodyMs"]
        for result in accepted
        if result["firstBodyMs"] is not None
    ]
    print(
        json.dumps(
            {
                "label": args.label,
                "clients": args.clients,
                "requestBytes": len(body),
                "wallMs": round(elapsed * 1000, 3),
                "throughputPerSecond": round(len(accepted) / elapsed, 3) if elapsed else 0,
                "accepted": len(accepted),
                "completed": len(completed),
                "failed": len(results) - len(accepted),
                "cancelled": sum(1 for result in results if result.get("cancelled")),
                "statusCounts": dict(Counter(str(result["status"]) for result in results if "status" in result)),
                "headersP50Ms": percentile([r["headersMs"] for r in accepted], 50),
                "headersP95Ms": percentile([r["headersMs"] for r in accepted], 95),
                "firstBodyP50Ms": percentile(first_body_times, 50),
                "firstBodyP95Ms": percentile(first_body_times, 95),
                "completionP50Ms": percentile([r["elapsedMs"] for r in completed], 50),
                "completionP95Ms": percentile([r["elapsedMs"] for r in completed], 95),
                "bytesP50": percentile([r["outputBytes"] for r in completed], 50),
                "sampleFailures": [r for r in results if not r.get("ok")][:3],
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    loop = asyncio.get_event_loop()
    try:
        loop.run_until_complete(main())
    finally:
        loop.close()
