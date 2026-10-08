#!/usr/bin/env python3
"""Small dependency-free concurrent HTTP/1.1 streaming load client."""

import argparse
import asyncio
from collections import Counter
import json
import time

MAX_ERROR_BODY_PREVIEW_BYTES = 512


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


async def read_chunked(reader, started, capture_preview=False):
    first_body_ms = None
    total_bytes = 0
    preview = bytearray()
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
            return total_bytes, first_body_ms, preview.decode("utf8", errors="replace") or None
        data = await reader.readexactly(size)
        await reader.readexactly(2)  # CRLF after the chunk body
        if capture_preview and len(preview) < MAX_ERROR_BODY_PREVIEW_BYTES:
            preview.extend(data[: MAX_ERROR_BODY_PREVIEW_BYTES - len(preview)])
        if first_body_ms is None:
            first_body_ms = (time.perf_counter() - started) * 1000
        total_bytes += len(data)


async def read_body(reader, headers, started, capture_preview=False):
    if "chunked" in headers.get("transfer-encoding", "").lower():
        return await read_chunked(reader, started, capture_preview)
    if "content-length" in headers:
        size = int(headers["content-length"])
        if size == 0:
            return 0, None, None
        data = await reader.readexactly(size)
        preview = (
            data[:MAX_ERROR_BODY_PREVIEW_BYTES].decode("utf8", errors="replace")
            if capture_preview
            else None
        )
        return size, (time.perf_counter() - started) * 1000, preview
    total = 0
    first_body_ms = None
    preview = bytearray()
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            break
        if capture_preview and len(preview) < MAX_ERROR_BODY_PREVIEW_BYTES:
            preview.extend(chunk[: MAX_ERROR_BODY_PREVIEW_BYTES - len(preview)])
        if first_body_ms is None:
            first_body_ms = (time.perf_counter() - started) * 1000
        total += len(chunk)
    return total, first_body_ms, preview.decode("utf8", errors="replace") or None


def request_body(session_index, turn, context_bytes):
    """Build a Responses-shaped transcript with prior synthetic tool turns."""
    history = []
    context = "x" * context_bytes
    for step in range(turn):
        history.append(
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "agent %d step %d %s" % (session_index, step, context)}],
            }
        )
        call_id = "tool-%d-%d" % (session_index, step)
        history.append(
            {
                "type": "function_call",
                "call_id": call_id,
                "name": "inspect_workspace",
                "arguments": "{}",
            }
        )
        history.append(
            {
                "type": "function_call_output",
                "call_id": call_id,
                "output": "synthetic tool result for step %d" % step,
            }
        )
    history.append(
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "agent %d step %d %s" % (session_index, turn, context)}],
        }
    )
    return json.dumps(
        {"model": "mock/model", "stream": True, "input": history},
        separators=(",", ":"),
    ).encode("utf8")


async def call_on_connection(reader, writer, request_id, body, timeout, cancel_after_ms):
    started = time.perf_counter()
    phase = "request_write"
    try:
        headers_started = time.perf_counter()
        request = (
            "POST /v1/responses HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"X-Request-ID: bench-{request_id}\r\n"
            "Connection: keep-alive\r\n\r\n"
        ).encode("ascii")
        writer.write(request + body)
        await writer.drain()
        phase = "response_headers"
        status, response_headers = await asyncio.wait_for(read_response(reader), timeout=timeout)
        headers_ms = (time.perf_counter() - headers_started) * 1000
        if cancel_after_ms is not None:
            await asyncio.sleep(cancel_after_ms / 1000.0)
            return {
                "ok": 200 <= status < 300,
                "status": status,
                "cancelled": True,
                "headersMs": round(headers_ms, 3),
                "firstBodyMs": None,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 3),
                "outputBytes": 0,
            }
        phase = "response_body"
        output_bytes, first_body_ms, error_body_preview = await asyncio.wait_for(
            read_body(reader, response_headers, started, capture_preview=status >= 400),
            timeout=timeout,
        )
        result = {
            "ok": 200 <= status < 300,
            "status": status,
            "cancelled": False,
            "headersMs": round(headers_ms, 3),
            "firstBodyMs": None if first_body_ms is None else round(first_body_ms, 3),
            "elapsedMs": round((time.perf_counter() - started) * 1000, 3),
            "outputBytes": output_bytes,
        }
        if error_body_preview:
            result["errorBodyPreview"] = error_body_preview
        return result
    except Exception as error:
        return {
            "ok": False,
            "phase": phase,
            "error": type(error).__name__ + ": " + str(error),
        }


async def run_session(port, session_index, rounds, timeout, cancel_after_ms, round_gap_ms, context_bytes):
    results = []
    writer = None
    phase = "connect"
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection("127.0.0.1", port), timeout=timeout
        )
        for turn in range(rounds):
            phase = "request_build"
            body = request_body(session_index, turn, context_bytes)
            result = await call_on_connection(
                reader,
                writer,
                "%s-%s" % (session_index, turn),
                body,
                timeout,
                cancel_after_ms,
            )
            phase = result.get("phase", "response_body")
            result["turn"] = turn
            result["requestBytes"] = len(body)
            results.append(result)
            if not result.get("ok") or cancel_after_ms is not None:
                break
            if turn + 1 < rounds and round_gap_ms:
                await asyncio.sleep(round_gap_ms / 1000.0)
    except Exception as error:
        results.append({
            "ok": False,
            "phase": phase,
            "error": type(error).__name__ + ": " + str(error),
        })
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
    return {
        "ok": len(results) == rounds and all(result.get("ok") for result in results),
        "roundsCompleted": sum(
            1 for result in results if result.get("ok") and not result.get("cancelled")
        ),
        "requests": results,
    }


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3901)
    parser.add_argument("--clients", type=int, default=100)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--label", default="unspecified")
    parser.add_argument("--cancel-after-ms", type=int)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--round-gap-ms", type=int, default=5)
    parser.add_argument("--context-bytes", type=int, default=0)
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("--rounds must be at least 1")
    if args.round_gap_ms < 0 or args.context_bytes < 0:
        parser.error("round gap and context bytes must be non-negative")
    if args.cancel_after_ms is not None and args.rounds != 1:
        parser.error("--cancel-after-ms is only valid with --rounds 1")

    started = time.perf_counter()
    sessions = await asyncio.gather(
        *[
            run_session(
                args.port,
                index,
                args.rounds,
                args.timeout,
                args.cancel_after_ms,
                args.round_gap_ms,
                args.context_bytes,
            )
            for index in range(args.clients)
        ]
    )
    elapsed = time.perf_counter() - started
    results = [request for session in sessions for request in session["requests"]]
    accepted = [result for result in results if result.get("ok")]
    completed = [result for result in accepted if not result.get("cancelled")]
    first_body_times = [result["firstBodyMs"] for result in accepted if result["firstBodyMs"] is not None]
    successful_sessions = sum(1 for session in sessions if session["ok"])
    print(
        json.dumps(
            {
                "label": args.label,
                "clients": args.clients,
                "maxConcurrentSessions": args.clients,
                "roundsPerSession": args.rounds,
                "contextBytesPerTurn": args.context_bytes,
                "sessionsCompleted": successful_sessions,
                "roundsCompleted": sum(session["roundsCompleted"] for session in sessions),
                "requestsAttempted": len(results),
                "requestBytesMax": max((result.get("requestBytes", 0) for result in results), default=0),
                "wallMs": round(elapsed * 1000, 3),
                "throughputPerSecond": round(len(accepted) / elapsed, 3) if elapsed else 0,
                "sessionsPerSecond": round(successful_sessions / elapsed, 3) if elapsed else 0,
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
