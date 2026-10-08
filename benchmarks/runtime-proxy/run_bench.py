#!/usr/bin/env python3
"""Run one isolated gateway benchmark and sample the gateway process RSS."""

import argparse
import asyncio
import json
import os
import pathlib
import signal
import shutil
import subprocess
import sys
import threading
import time
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent
NODE_IMAGE = "docker.io/library/node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1"


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
            details = ""
            if process.stderr:
                try:
                    details = process.stderr.read()[-1000:]
                except Exception:
                    pass
            raise RuntimeError(
                f"server exited early with status {process.returncode}: {details}"
            )
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            await asyncio.sleep(0.1)
    raise TimeoutError(f"server did not become ready: {url}")


def sample_metrics(pid, stop):
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
        time.sleep(0.025)
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


def apply_cpu_affinity(command, cpu_list):
    if not cpu_list:
        return command
    taskset = shutil.which("taskset")
    if not taskset:
        raise RuntimeError("CPU affinity was requested but taskset is not installed")
    return [taskset, "-c", cpu_list] + command


def pin_process_cpu_affinity(pid, cpu_list):
    if not cpu_list:
        return
    taskset = shutil.which("taskset")
    if not taskset:
        raise RuntimeError("CPU affinity was requested but taskset is not installed")
    subprocess.run(
        [taskset, "-a", "-pc", cpu_list, str(pid)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )


def runtime_command(
    runtime, bun_bin, rust_bin, gateway_port, upstream_url, max_inflight, gateway_cpus=None
):
    if runtime == "node":
        return apply_cpu_affinity(["node", str(ROOT / "proxy-node.mjs")], gateway_cpus), None
    if runtime == "omni-admission-node":
        command = [
            "node",
            "--max-old-space-size=2048",
            "--import",
            "tsx/esm",
            str(ROOT / "omni-admission-proxy.ts"),
        ]
        return apply_cpu_affinity(command, gateway_cpus), None
    if runtime == "bun":
        return apply_cpu_affinity([bun_bin, str(ROOT / "proxy-bun.ts")], gateway_cpus), None
    if runtime == "bun-smol":
        return apply_cpu_affinity([bun_bin, "--smol", str(ROOT / "proxy-bun.ts")], gateway_cpus), None
    if runtime == "rust":
        return apply_cpu_affinity([rust_bin], gateway_cpus), None
    if runtime in {"node26-container", "bun140-container", "bun142-container", "bun142-smol-container"}:
        # Pin the live container PID with taskset after startup; rootless Podman may not have a
        # delegated cpuset controller.
        image, command = {
            "node26-container": (NODE_IMAGE, ["node", "/bench/proxy-node.mjs"]),
            "bun140-container": (
                "docker.io/oven/bun:1.4.0-slim",
                ["bun", "/bench/proxy-bun.ts"],
            ),
            "bun142-container": (
                "docker.io/oven/bun:1.4.2-slim",
                ["bun", "/bench/proxy-bun.ts"],
            ),
            "bun142-smol-container": (
                "docker.io/oven/bun:1.4.2-slim",
                ["bun", "--smol", "/bench/proxy-bun.ts"],
            ),
        }[runtime]
        container_name = "omni-proxy-bench-%s-%s" % (runtime, os.getpid())
        return [
            "podman",
            "run",
            "--rm",
            "--name",
            container_name,
            "--network=host",
            "--memory=512m",
            "-v",
            "%s:/bench:ro" % ROOT,
            "-w",
            "/bench",
            "-e",
            "PORT=%s" % gateway_port,
            "-e",
            "UPSTREAM_URL=%s" % upstream_url,
            "-e",
            "MAX_INFLIGHT=%s" % max_inflight,
            "-e",
            "MAX_BODY_BYTES=%s" % (4 * 1024 * 1024),
            image,
        ] + command, container_name
    raise ValueError(f"unknown runtime: {runtime}")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--runtime",
        choices=[
            "node",
            "omni-admission-node",
            "bun",
            "bun-smol",
            "rust",
            "node26-container",
            "bun140-container",
            "bun142-container",
            "bun142-smol-container",
        ],
        required=True,
    )
    parser.add_argument("--clients", type=int, default=100)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--round-gap-ms", type=int, default=5)
    parser.add_argument("--context-bytes", type=int, default=0)
    parser.add_argument("--chunks", type=int, default=50)
    parser.add_argument("--chunk-delay-ms", type=int, default=10)
    parser.add_argument("--chunk-bytes", type=int, default=128)
    parser.add_argument("--cancel-after-ms", type=int)
    parser.add_argument("--allow-non2xx", action="store_true")
    parser.add_argument("--max-inflight", type=int, default=128)
    parser.add_argument("--upstream-port", type=int, default=3900)
    parser.add_argument("--gateway-port", type=int, default=3901)
    parser.add_argument("--gateway-cpus", help="Optional Linux CPU affinity list, e.g. 0-3")
    parser.add_argument("--upstream-cpus", help="Optional CPU affinity for the mock upstream")
    parser.add_argument("--load-cpus", help="Optional CPU affinity for the concurrent load client")
    parser.add_argument("--upstream-runtime", choices=["node", "rust"], default="node")
    parser.add_argument(
        "--rust-upstream-bin",
        default=str(ROOT / "target" / "release" / "omniroute-runtime-mock-upstream-bench"),
    )
    parser.add_argument("--bun-bin", default=os.environ.get("BUN_BIN", "bun"))
    parser.add_argument(
        "--rust-bin",
        default=str(ROOT / "target" / "release" / "omniroute-runtime-proxy-bench"),
    )
    args = parser.parse_args()
    if any([args.gateway_cpus, args.upstream_cpus, args.load_cpus]) and not shutil.which("taskset"):
        parser.error("CPU affinity options require taskset on this Linux host")

    env = os.environ.copy()
    upstream_env = dict(env, **{
        "PORT": str(args.upstream_port),
        "CHUNKS": str(args.chunks),
        "CHUNK_DELAY_MS": str(args.chunk_delay_ms),
        "CHUNK_BYTES": str(args.chunk_bytes),
    })
    gateway_env = dict(env, **{
        "PORT": str(args.gateway_port),
        "UPSTREAM_URL": f"http://127.0.0.1:{args.upstream_port}",
        "MAX_INFLIGHT": str(args.max_inflight),
        "MAX_BODY_BYTES": str(4 * 1024 * 1024),
    })

    upstream = None
    if args.runtime != "omni-admission-node":
        upstream_command = ["node", str(ROOT / "mock-upstream.mjs")]
        if args.upstream_runtime == "rust":
            upstream_command = [args.rust_upstream_bin]
        upstream_command = apply_cpu_affinity(upstream_command, args.upstream_cpus)
        upstream = subprocess.Popen(
            upstream_command,
            cwd=ROOT,
            env=upstream_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )
    gateway = None
    gateway_container_name = None
    try:
        if upstream is not None:
            await wait_for_server(f"http://127.0.0.1:{args.upstream_port}/health", upstream)
        if args.runtime == "omni-admission-node":
            gateway_env["CHUNKS"] = str(args.chunks)
            gateway_env["CHUNK_DELAY_MS"] = str(args.chunk_delay_ms)
            gateway_env["CHUNK_BYTES"] = str(args.chunk_bytes)
        command, gateway_container_name = runtime_command(
            args.runtime,
            args.bun_bin,
            args.rust_bin,
            args.gateway_port,
            gateway_env["UPSTREAM_URL"],
            args.max_inflight,
            args.gateway_cpus,
        )
        gateway = subprocess.Popen(
            command,
            cwd=ROOT,
            env=gateway_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )
        await wait_for_server(f"http://127.0.0.1:{args.gateway_port}/health", gateway)

        metrics_pid = gateway.pid
        if gateway_container_name:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    raw_pid = subprocess.check_output(
                        [
                            "podman",
                            "inspect",
                            "--format",
                            "{{.State.Pid}}",
                            gateway_container_name,
                        ],
                        stderr=subprocess.DEVNULL,
                    ).strip()
                    metrics_pid = int(raw_pid)
                    if metrics_pid > 0:
                        break
                except Exception:
                    time.sleep(0.05)
            if metrics_pid > 0:
                pin_process_cpu_affinity(metrics_pid, args.gateway_cpus)

        stop = threading.Event()
        metrics = {}
        sampler = threading.Thread(
            target=lambda: metrics.update(sample_metrics(metrics_pid, stop)),
            daemon=True,
        )
        sampler.start()
        loader_command = [
            sys.executable,
            str(ROOT / "load.py"),
            "--port",
            str(args.gateway_port),
            "--clients",
            str(args.clients),
            "--rounds",
            str(args.rounds),
            "--round-gap-ms",
            str(args.round_gap_ms),
            "--context-bytes",
            str(args.context_bytes),
            "--label",
            args.runtime,
        ]
        loader_command = apply_cpu_affinity(loader_command, args.load_cpus)
        if args.cancel_after_ms is not None:
            loader_command.extend(["--cancel-after-ms", str(args.cancel_after_ms)])
        loader = subprocess.run(
            loader_command,
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=120,
            check=False,
        )
        stop.set()
        sampler.join(timeout=2)
        if loader.returncode != 0:
            raise RuntimeError(f"load generator failed: {loader.stderr[-1000:]}")
        result = json.loads(loader.stdout)
        result.update(metrics)
        result["runtime"] = args.runtime
        result["roundsPerSession"] = args.rounds
        result["contextBytesPerTurn"] = args.context_bytes
        result["chunksPerResponse"] = args.chunks
        result["chunkDelayMs"] = args.chunk_delay_ms
        result["chunkBytes"] = args.chunk_bytes
        if args.gateway_cpus:
            result["gatewayCpuAffinity"] = args.gateway_cpus
        if args.upstream_cpus:
            result["upstreamCpuAffinity"] = args.upstream_cpus
        if args.load_cpus:
            result["loadCpuAffinity"] = args.load_cpus
        if args.runtime == "omni-admission-node":
            with urllib.request.urlopen(
                "http://127.0.0.1:%d/health" % args.gateway_port, timeout=2
            ) as response:
                result["gatewayHealth"] = json.load(response)
        if args.cancel_after_ms is not None:
            deadline = time.monotonic() + 5
            active = None
            while time.monotonic() < deadline:
                try:
                    health_port = (
                        args.gateway_port
                        if args.runtime == "omni-admission-node"
                        else args.upstream_port
                    )
                    with urllib.request.urlopen(
                        "http://127.0.0.1:%d/health" % health_port, timeout=1
                    ) as response:
                        health = json.load(response)
                        active = (
                            health.get("admission", {}).get("activeHeavy")
                            if args.runtime == "omni-admission-node"
                            else health.get("activeStreams")
                        )
                    if active == 0:
                        break
                except Exception:
                    pass
                time.sleep(0.05)
            result[
                "admissionActiveAfterCancel"
                if args.runtime == "omni-admission-node"
                else "upstreamActiveAfterCancel"
            ] = active
        print(json.dumps(result, separators=(",", ":")))
        leaked_active = result.get(
            "admissionActiveAfterCancel", result.get("upstreamActiveAfterCancel", 0)
        )
        if (result["failed"] and not args.allow_non2xx) or (
            args.cancel_after_ms is not None and leaked_active != 0
        ):
            raise SystemExit(1)
    finally:
        if gateway_container_name:
            subprocess.run(
                ["podman", "stop", "--time", "3", gateway_container_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
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
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(main())
    finally:
        loop.close()
