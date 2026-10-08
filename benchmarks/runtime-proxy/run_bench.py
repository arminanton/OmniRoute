#!/usr/bin/env python3
"""Run one isolated gateway benchmark and sample the gateway process RSS."""

import argparse
import asyncio
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent


def read_process_metrics(pid):
    rss_bytes = None
    cpu_ticks = None
    try:
        with open(f"/proc/{pid}/status", encoding="utf8") as status_file:
            for line in status_file:
                if line.startswith("VmRSS:"):
                    rss_bytes = int(line.split()[1]) * 1024
                    break
        with open(f"/proc/{pid}/stat", encoding="utf8") as stat_file:
            fields = stat_file.read().split()
        cpu_ticks = int(fields[13]) + int(fields[14])
    except (OSError, ValueError, IndexError):
        pass
    return rss_bytes, cpu_ticks


async def wait_for_server(url, process, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"server exited early with status {process.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            await asyncio.sleep(0.1)
    raise TimeoutError(f"server did not become ready: {url}")


async def sample_metrics(pid, stop):
    peak_rss = 0
    cpu_start = None
    cpu_end = None
    ticks_per_second = os.sysconf("SC_CLK_TCK")
    while not stop.is_set():
        rss, ticks = read_process_metrics(pid)
        if rss is not None:
            peak_rss = max(peak_rss, rss)
        if ticks is not None:
            cpu_start = ticks if cpu_start is None else cpu_start
            cpu_end = ticks
        await asyncio.sleep(0.025)
    rss, ticks = read_process_metrics(pid)
    if rss is not None:
        peak_rss = max(peak_rss, rss)
    if ticks is not None:
        cpu_start = ticks if cpu_start is None else cpu_start
        cpu_end = ticks
    cpu_seconds = (
        (cpu_end - cpu_start) / ticks_per_second
        if cpu_start is not None and cpu_end is not None
        else None
    )
    return {
        "gatewayPeakRssMiB": round(peak_rss / (1024 * 1024), 3),
        "gatewayCpuSeconds": None if cpu_seconds is None else round(cpu_seconds, 3),
    }


def runtime_command(runtime, bun_bin, rust_bin):
    if runtime == "node":
        return ["node", str(ROOT / "proxy-node.mjs")]
    if runtime == "bun":
        return [bun_bin, str(ROOT / "proxy-bun.ts")]
    if runtime == "bun-smol":
        return [bun_bin, "--smol", str(ROOT / "proxy-bun.ts")]
    if runtime == "rust":
        return [rust_bin]
    raise ValueError(f"unknown runtime: {runtime}")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", choices=["node", "bun", "bun-smol", "rust"], required=True)
    parser.add_argument("--clients", type=int, default=100)
    parser.add_argument("--chunks", type=int, default=50)
    parser.add_argument("--chunk-delay-ms", type=int, default=10)
    parser.add_argument("--chunk-bytes", type=int, default=128)
    parser.add_argument("--max-inflight", type=int, default=128)
    parser.add_argument("--upstream-port", type=int, default=3900)
    parser.add_argument("--gateway-port", type=int, default=3901)
    parser.add_argument("--bun-bin", default=os.environ.get("BUN_BIN", "bun"))
    parser.add_argument(
        "--rust-bin",
        default=str(ROOT / "target" / "release" / "omniroute-runtime-proxy-bench"),
    )
    args = parser.parse_args()

    env = os.environ.copy()
    upstream_env = env | {
        "PORT": str(args.upstream_port),
        "CHUNKS": str(args.chunks),
        "CHUNK_DELAY_MS": str(args.chunk_delay_ms),
        "CHUNK_BYTES": str(args.chunk_bytes),
    }
    gateway_env = env | {
        "PORT": str(args.gateway_port),
        "UPSTREAM_URL": f"http://127.0.0.1:{args.upstream_port}",
        "MAX_INFLIGHT": str(args.max_inflight),
        "MAX_BODY_BYTES": str(4 * 1024 * 1024),
    }

    upstream = subprocess.Popen(
        ["node", str(ROOT / "mock-upstream.mjs")],
        cwd=ROOT,
        env=upstream_env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    gateway = None
    try:
        await wait_for_server(f"http://127.0.0.1:{args.upstream_port}/health", upstream)
        gateway = subprocess.Popen(
            runtime_command(args.runtime, args.bun_bin, args.rust_bin),
            cwd=ROOT,
            env=gateway_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        await wait_for_server(f"http://127.0.0.1:{args.gateway_port}/health", gateway)

        stop = asyncio.Event()
        metrics_task = asyncio.create_task(sample_metrics(gateway.pid, stop))
        loader = subprocess.run(
            [
                sys.executable,
                str(ROOT / "load.py"),
                "--port",
                str(args.gateway_port),
                "--clients",
                str(args.clients),
                "--label",
                args.runtime,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        stop.set()
        metrics = await metrics_task
        if loader.returncode != 0:
            raise RuntimeError(f"load generator failed: {loader.stderr[-1000:]}")
        result = json.loads(loader.stdout)
        result.update(metrics)
        result["runtime"] = args.runtime
        result["chunksPerResponse"] = args.chunks
        result["chunkDelayMs"] = args.chunk_delay_ms
        result["chunkBytes"] = args.chunk_bytes
        print(json.dumps(result, separators=(",", ":")))
        if result["failed"]:
            raise SystemExit(1)
    finally:
        for process in (gateway, upstream):
            if process is None:
                continue
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)


if __name__ == "__main__":
    asyncio.run(main())
