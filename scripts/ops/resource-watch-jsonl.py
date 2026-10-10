#!/usr/bin/env python3
"""Write bounded, low-volume host and optional build-cgroup telemetry.

The sampler is observational only: it never signals a process. It avoids
command lines and environment values, keeping only process names and numeric
resource counters. The active JSONL file and one rotated file are byte-capped.
The target file contains ``PID STARTTIME_TICKS`` to prevent PID-reuse confusion.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import stat as stat_mode
import sys
import time
from pathlib import Path
from typing import Any


DEFAULT_INTERVAL_SECONDS = 15.0
DEFAULT_PROCESS_INTERVAL_SECONDS = 30.0
DEFAULT_MAX_BYTES = 4 * 1024 * 1024
PSI_FILES = ("cpu", "memory", "io")
PROCESS_SAMPLE_LIMIT = 5
DEVICE_SAMPLE_LIMIT = 4
CGROUP_IO_DEVICE_LIMIT = 16
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")


def default_state_root() -> Path:
    state_home = os.environ.get("XDG_STATE_HOME")
    return Path(state_home) if state_home else Path.home() / ".local" / "state"


def private_runtime_directory() -> Path:
    candidates = []
    configured = os.environ.get("XDG_RUNTIME_DIR")
    if configured:
        candidates.append(Path(configured))
    candidates.append(Path(f"/run/user/{os.getuid()}"))
    for candidate in candidates:
        try:
            metadata = candidate.stat()
        except OSError:
            continue
        if (
            stat_mode.S_ISDIR(metadata.st_mode)
            and metadata.st_uid == os.getuid()
            and metadata.st_mode & 0o022 == 0
        ):
            return candidate
    fallback = default_state_root() / "omni" / "runtime"
    fallback.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = fallback.stat()
    if (
        not stat_mode.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or metadata.st_mode & 0o022
    ):
        raise PermissionError("no private runtime directory available for resource watcher")
    return fallback


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except (OSError, PermissionError):
        return None


def read_integer_file(path: Path) -> int | None:
    value = read_text(path)
    if value is None:
        return None
    try:
        return int(value.strip())
    except ValueError:
        return None


def parse_meminfo() -> dict[str, int]:
    values: dict[str, int] = {}
    contents = read_text(Path("/proc/meminfo")) or ""
    for line in contents.splitlines():
        key, separator, rest = line.partition(":")
        if not separator:
            continue
        parts = rest.split()
        if not parts:
            continue
        try:
            amount = int(parts[0])
        except ValueError:
            continue
        values[key] = amount * 1024 if len(parts) > 1 and parts[1] == "kB" else amount
    return values


def parse_cpu_stat(contents: str | None = None) -> dict[str, int] | None:
    if contents is None:
        contents = read_text(Path("/proc/stat"))
    if not contents:
        return None
    line = contents.splitlines()[0]
    parts = line.split()
    if not parts or parts[0] != "cpu":
        return None
    try:
        counters = [int(value) for value in parts[1:9]]
    except ValueError:
        return None
    if len(counters) < 5:
        return None
    total = sum(counters)
    idle = counters[3]
    iowait = counters[4]
    return {"total": total, "idle": idle, "iowait": iowait, "busy": total - idle - iowait}


def parse_vmstat() -> dict[str, int]:
    contents = read_text(Path("/proc/vmstat")) or ""
    values: dict[str, int] = {}
    for line in contents.splitlines():
        parts = line.split()
        if len(parts) != 2 or parts[0] not in {"pswpin", "pswpout"}:
            continue
        try:
            values[parts[0]] = int(parts[1])
        except ValueError:
            continue
    return values


def parse_proc_stat(contents: str | None) -> dict[str, int] | None:
    if not contents:
        return None
    tail = contents.rsplit(")", 1)[-1].split()
    try:
        return {
            "cpu_ticks": int(tail[11]) + int(tail[12]),
            "starttime_ticks": int(tail[19]),
        }
    except (IndexError, ValueError):
        return None


def parse_psi(resource: str) -> dict[str, dict[str, float | int]]:
    contents = read_text(Path("/proc/pressure") / resource) or ""
    output: dict[str, dict[str, float | int]] = {}
    for line in contents.splitlines():
        parts = line.split()
        if not parts:
            continue
        kind = parts[0]
        metrics: dict[str, float | int] = {}
        for item in parts[1:]:
            key, separator, value = item.partition("=")
            if not separator:
                continue
            try:
                metrics[key] = int(value) if key == "total" else float(value)
            except ValueError:
                continue
        if metrics:
            output[kind] = metrics
    return output


def parse_key_value_file(path: Path) -> dict[str, int | str]:
    contents = read_text(path) or ""
    values: dict[str, int | str] = {}
    for line in contents.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            values[parts[0]] = int(parts[1])
        except ValueError:
            values[parts[0]] = parts[1]
    return values


def parse_io_stat(contents: str) -> dict[str, dict[str, int]]:
    values: dict[str, dict[str, int]] = {}
    for line in contents.splitlines()[:CGROUP_IO_DEVICE_LIMIT]:
        parts = line.split()
        if not parts:
            continue
        counters: dict[str, int] = {}
        for item in parts[1:]:
            key, separator, value = item.partition("=")
            if not separator:
                continue
            try:
                counters[key] = int(value)
            except ValueError:
                continue
        if counters:
            values[parts[0]] = counters
    return values


def process_snapshot() -> dict[str, dict[str, int | str]]:
    processes: dict[str, dict[str, int | str]] = {}
    ticks_per_second = os.sysconf("SC_CLK_TCK")
    proc_root = Path("/proc")
    try:
        entries = tuple(proc_root.iterdir())
    except OSError:
        return processes

    for entry in entries:
        if not entry.name.isdigit():
            continue
        pid = entry.name
        comm = read_text(entry / "comm")
        status = read_text(entry / "status")
        io = read_text(entry / "io")
        stat = parse_proc_stat(read_text(entry / "stat"))
        if comm is None:
            continue

        rss_bytes: int | None = None
        if status:
            for line in status.splitlines():
                if line.startswith("VmRSS:"):
                    fields = line.split()
                    if len(fields) >= 2:
                        try:
                            rss_bytes = int(fields[1]) * 1024
                        except ValueError:
                            pass
                    break

        read_bytes: int | None = None
        write_bytes: int | None = None
        if io:
            for line in io.splitlines():
                key, separator, value = line.partition(":")
                if not separator or key not in {"read_bytes", "write_bytes"}:
                    continue
                try:
                    if key == "read_bytes":
                        read_bytes = int(value.strip())
                    else:
                        write_bytes = int(value.strip())
                except ValueError:
                    continue

        processes[pid] = {
            "comm": comm.strip(),
            "rss_bytes": rss_bytes if rss_bytes is not None else 0,
            "read_bytes": read_bytes if read_bytes is not None else 0,
            "write_bytes": write_bytes if write_bytes is not None else 0,
            "cpu_ticks": stat["cpu_ticks"] if stat else 0,
            "starttime_ticks": stat["starttime_ticks"] if stat else 0,
            "ticks_per_second": ticks_per_second,
        }
    return processes


def block_snapshot() -> dict[str, dict[str, int]]:
    contents = read_text(Path("/proc/diskstats")) or ""
    devices: dict[str, dict[str, int]] = {}
    for line in contents.splitlines():
        fields = line.split()
        if len(fields) < 14:
            continue
        name = fields[2]
        if not name.startswith(("sd", "vd", "xvd", "nvme", "loop", "dm-")):
            continue
        if (Path("/sys/class/block") / name / "partition").exists():
            continue
        try:
            values = [int(value) for value in fields[3:14]]
        except ValueError:
            continue
        devices[name] = {
            "read_ios": values[0],
            "read_sectors": values[2],
            "read_ms": values[3],
            "write_ios": values[4],
            "write_sectors": values[6],
            "write_ms": values[7],
            "in_flight": values[8],
            "io_ms": values[9],
            "weighted_io_ms": values[10],
        }
    return devices


def cgroup_snapshot(target: dict[str, int] | None) -> dict[str, Any] | None:
    if target is None:
        return None
    pid = target["pid"]
    cgroup_contents = read_text(Path(f"/proc/{pid}/cgroup"))
    if not cgroup_contents:
        return {"pid": pid, "available": False}
    proc_stat = parse_proc_stat(read_text(Path(f"/proc/{pid}/stat")))
    if proc_stat is None:
        return {"pid": pid, "available": False}
    expected_starttime = target.get("starttime_ticks")
    if expected_starttime is not None and proc_stat["starttime_ticks"] != expected_starttime:
        return {
            "pid": pid,
            "available": False,
            "reason": "pid_starttime_mismatch",
            "expected_starttime_ticks": expected_starttime,
            "actual_starttime_ticks": proc_stat["starttime_ticks"],
        }
    relative = next(
        (line.split("::", 1)[1] for line in cgroup_contents.splitlines() if "::" in line),
        None,
    )
    if relative is None or ".." in Path(relative).parts:
        return {"pid": pid, "available": False}
    root = Path("/sys/fs/cgroup") / relative.lstrip("/")
    if not root.is_dir():
        return {"pid": pid, "cgroup": relative, "available": False}

    output: dict[str, Any] = {
        "pid": pid,
        "starttime_ticks": proc_stat["starttime_ticks"],
        "cgroup": relative,
        "available": True,
    }
    for name in ("memory.current", "memory.max", "memory.high", "memory.peak", "memory.swap.current", "memory.swap.max"):
        value = read_text(root / name)
        if value is not None:
            value = value.strip()
            try:
                output[name.replace(".", "_")] = int(value)
            except ValueError:
                output[name.replace(".", "_")] = value
    output["memory_events"] = parse_key_value_file(root / "memory.events")
    output["cpu_stat"] = parse_key_value_file(root / "cpu.stat")
    io_contents = read_text(root / "io.stat") or ""
    io_lines = io_contents.splitlines()
    output["io_stat"] = parse_io_stat(io_contents)
    if len(io_lines) > CGROUP_IO_DEVICE_LIMIT:
        output["io_stat_omitted_devices"] = len(io_lines) - CGROUP_IO_DEVICE_LIMIT
    output["psi"] = {resource: parse_psi_from_path(root / f"{resource}.pressure") for resource in PSI_FILES}
    return output


def cgroup_rates(current: dict[str, Any] | None, previous: dict[str, Any] | None, elapsed: float) -> dict[str, Any]:
    if not current or not current.get("available") or not previous or not previous.get("available"):
        return {}
    if current.get("cgroup") != previous.get("cgroup") or elapsed <= 0:
        return {}
    output: dict[str, Any] = {}

    current_cpu = current.get("cpu_stat", {})
    previous_cpu = previous.get("cpu_stat", {})
    usage_delta = int(current_cpu.get("usage_usec", 0)) - int(previous_cpu.get("usage_usec", 0))
    if usage_delta >= 0:
        output["cpu_usage_usec_per_second"] = round(usage_delta / elapsed, 1)
        output["cpu_percent_one_core"] = round(usage_delta / elapsed / 10000, 1)

    current_events = current.get("memory_events", {})
    previous_events = previous.get("memory_events", {})
    event_deltas = {
        key: max(0, int(current_events.get(key, 0)) - int(previous_events.get(key, 0)))
        for key in ("high", "max", "oom", "oom_kill", "oom_group_kill")
        if key in current_events and key in previous_events
    }
    if event_deltas:
        output["memory_event_deltas"] = event_deltas

    current_io = current.get("io_stat", {})
    previous_io = previous.get("io_stat", {})
    io_deltas: dict[str, dict[str, int]] = {}
    for device, counters in current_io.items():
        old = previous_io.get(device)
        if not isinstance(old, dict):
            continue
        delta = {
            key: max(0, int(value) - int(old.get(key, value)))
            for key, value in counters.items()
        }
        if any(delta.values()):
            io_deltas[device] = {
                "read_bytes_per_second": int(delta.get("rbytes", 0) / elapsed),
                "write_bytes_per_second": int(delta.get("wbytes", 0) / elapsed),
                "read_ops_per_second": int(delta.get("rios", 0) / elapsed),
                "write_ops_per_second": int(delta.get("wios", 0) / elapsed),
            }
    if io_deltas:
        output["io_rates"] = io_deltas
    return output


def parse_psi_from_path(path: Path) -> dict[str, dict[str, float | int]]:
    contents = read_text(path) or ""
    output: dict[str, dict[str, float | int]] = {}
    for line in contents.splitlines():
        parts = line.split()
        if not parts:
            continue
        metrics: dict[str, float | int] = {}
        for item in parts[1:]:
            key, separator, value = item.partition("=")
            if not separator:
                continue
            try:
                metrics[key] = int(value) if key == "total" else float(value)
            except ValueError:
                continue
        if metrics:
            output[parts[0]] = metrics
    return output


def read_target_pid(pid_file: Path) -> dict[str, int] | None:
    try:
        metadata = pid_file.lstat()
    except FileNotFoundError:
        return None
    if (
        not stat_mode.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or metadata.st_mode & 0o022
    ):
        return None
    value = read_text(pid_file)
    if value is None:
        return None
    parts = value.split()
    try:
        pid = int(parts[0])
        starttime = int(parts[1])
    except ValueError:
        return None
    except IndexError:
        return None
    if len(parts) != 2 or pid <= 0 or starttime < 0:
        return None
    return {"pid": pid, "starttime_ticks": starttime}


def add_rates(
    current: dict[str, dict[str, int | str]],
    previous: dict[str, dict[str, int | str]],
    elapsed: float,
) -> list[dict[str, Any]]:
    rates: list[dict[str, Any]] = []
    for pid, row in current.items():
        old = previous.get(pid)
        if (
            old is None
            or elapsed <= 0
            or int(row["starttime_ticks"]) != int(old["starttime_ticks"])
        ):
            continue
        read_rate = max(0, int(row["read_bytes"]) - int(old["read_bytes"])) / elapsed
        write_rate = max(0, int(row["write_bytes"]) - int(old["write_bytes"])) / elapsed
        tick_rate = max(0, int(row["cpu_ticks"]) - int(old["cpu_ticks"])) / elapsed
        cpu_percent = tick_rate * 100 / max(1, int(row["ticks_per_second"]))
        if read_rate or write_rate or cpu_percent:
            rates.append(
                {
                    "pid": int(pid),
                    "starttime_ticks": int(row["starttime_ticks"]),
                    "comm": row["comm"],
                    "rss_bytes": int(row["rss_bytes"]),
                    "cpu_percent_one_core": round(cpu_percent, 1),
                    "read_bytes_per_second": int(read_rate),
                    "write_bytes_per_second": int(write_rate),
                }
            )
    return rates


def add_device_rates(
    current: dict[str, dict[str, int]], previous: dict[str, dict[str, int]], elapsed: float
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for name, row in current.items():
        old = previous.get(name)
        if old is None or elapsed <= 0:
            continue
        read_ios = max(0, row["read_ios"] - old["read_ios"])
        write_ios = max(0, row["write_ios"] - old["write_ios"])
        read_ms = max(0, row["read_ms"] - old["read_ms"])
        write_ms = max(0, row["write_ms"] - old["write_ms"])
        read_bytes = max(0, row["read_sectors"] - old["read_sectors"]) * 512
        write_bytes = max(0, row["write_sectors"] - old["write_sectors"]) * 512
        io_ms = max(0, row["io_ms"] - old["io_ms"])
        weighted_ms = max(0, row["weighted_io_ms"] - old["weighted_io_ms"])
        completed = read_ios + write_ios
        output.append(
            {
                "device": name,
                "read_ops_per_second": round(read_ios / elapsed, 2),
                "write_ops_per_second": round(write_ios / elapsed, 2),
                "read_bytes_per_second": int(read_bytes / elapsed),
                "write_bytes_per_second": int(write_bytes / elapsed),
                "await_ms": round((read_ms + write_ms) / completed, 2) if completed else 0,
                "average_queue_depth": round(weighted_ms / (elapsed * 1000), 3),
                "util_percent": round(min(100.0, io_ms / (elapsed * 10)), 2),
                "in_flight": row["in_flight"],
            }
        )
    output.sort(
        key=lambda row: row["read_bytes_per_second"] + row["write_bytes_per_second"],
        reverse=True,
    )
    return output[:DEVICE_SAMPLE_LIMIT]


def top_rss(processes: dict[str, dict[str, int | str]]) -> list[dict[str, Any]]:
    rows = [
        {
            "pid": int(pid),
            "starttime_ticks": int(row["starttime_ticks"]),
            "comm": row["comm"],
            "rss_bytes": int(row["rss_bytes"]),
        }
        for pid, row in processes.items()
        if int(row["rss_bytes"]) > 0
    ]
    return sorted(rows, key=lambda row: row["rss_bytes"], reverse=True)[:PROCESS_SAMPLE_LIMIT]


def rate_totals(current: dict[str, int], previous: dict[str, int], elapsed: float) -> dict[str, float]:
    if elapsed <= 0:
        return {}
    return {
        "swap_in_bytes_per_second": round(max(0, current.get("pswpin", 0) - previous.get("pswpin", 0)) * PAGE_SIZE / elapsed, 1),
        "swap_out_bytes_per_second": round(max(0, current.get("pswpout", 0) - previous.get("pswpout", 0)) * PAGE_SIZE / elapsed, 1),
    }


def sample(
    previous: dict[str, Any] | None,
    pid_file: Path,
    process_interval: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    wall_now = time.time()
    monotonic_now = time.monotonic()
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(wall_now))
    cpu = parse_cpu_stat()
    mem = parse_meminfo()
    process_sample_due = (
        previous is None
        or monotonic_now - float(previous.get("process_sample_monotonic", 0)) >= process_interval
    )
    if process_sample_due:
        processes = process_snapshot()
        process_sample_monotonic = monotonic_now
    else:
        processes = previous["processes"]
        process_sample_monotonic = float(previous["process_sample_monotonic"])
    devices = block_snapshot()
    vmstat = parse_vmstat()
    target = cgroup_snapshot(read_target_pid(pid_file))
    elapsed = max(0.001, monotonic_now - float(previous["monotonic"])) if previous else 0.0
    process_elapsed = (
        max(0.001, monotonic_now - float(previous["process_sample_monotonic"]))
        if previous and process_sample_due
        else 0.0
    )

    current_state: dict[str, Any] = {
        "monotonic": monotonic_now,
        "process_sample_monotonic": process_sample_monotonic,
        "cpu": cpu,
        "vmstat": vmstat,
        "processes": processes,
        "devices": devices,
        "target": target,
    }
    cpu_rates: dict[str, float] = {}
    swap_rates: dict[str, float] = {}
    process_io: list[dict[str, Any]] = []
    process_cpu: list[dict[str, Any]] = []
    device_rates: list[dict[str, Any]] = []
    if previous:
        old_cpu = previous.get("cpu")
        if cpu and old_cpu:
            total_delta = cpu["total"] - old_cpu["total"]
            if total_delta > 0:
                cpu_rates = {
                    "busy_percent": round(100 * (cpu["busy"] - old_cpu["busy"]) / total_delta, 1),
                    "iowait_percent": round(100 * (cpu["iowait"] - old_cpu["iowait"]) / total_delta, 1),
                }
        swap_rates = rate_totals(vmstat, previous.get("vmstat", {}), elapsed)
        if process_sample_due:
            process_rates = add_rates(
                processes,
                previous.get("processes", {}),
                process_elapsed,
            )
            process_io = sorted(
                process_rates,
                key=lambda row: int(row["read_bytes_per_second"])
                + int(row["write_bytes_per_second"]),
                reverse=True,
            )[:PROCESS_SAMPLE_LIMIT]
            process_cpu = sorted(
                process_rates,
                key=lambda row: float(row["cpu_percent_one_core"]),
                reverse=True,
            )[:PROCESS_SAMPLE_LIMIT]
        device_rates = add_device_rates(devices, previous.get("devices", {}), elapsed)

    total_memory = mem.get("MemTotal", 0)
    available_memory = mem.get("MemAvailable", 0)
    swap_total = mem.get("SwapTotal", 0)
    swap_free = mem.get("SwapFree", 0)
    root_disk = shutil.disk_usage("/")
    row: dict[str, Any] = {
        "schema_version": 1,
        "timestamp": timestamp,
        "interval_seconds": round(elapsed, 2),
        "process_sampled": process_sample_due,
        "process_sample_interval_seconds": round(process_elapsed, 2),
        "host": {
            "cpu": cpu_rates,
            "memory_total_bytes": total_memory,
            "memory_available_bytes": available_memory,
            "memory_used_percent_from_available": round(100 * (total_memory - available_memory) / total_memory, 2) if total_memory else None,
            "swap_total_bytes": swap_total,
            "swap_free_bytes": swap_free,
            "swap_in_out": swap_rates,
            "root_disk_free_bytes": root_disk.free,
            "psi": {resource: parse_psi(resource) for resource in PSI_FILES},
            "block_devices": device_rates,
        },
        "processes": {
            "top_rss": top_rss(processes) if process_sample_due else [],
            "top_io": process_io,
            "top_cpu": process_cpu,
        },
        "target_cgroup": target,
        "target_cgroup_rates": cgroup_rates(target, previous.get("target") if previous else None, elapsed),
    }
    return row, current_state


def owned_regular_file(path: Path) -> os.stat_result | None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if not stat_mode.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise ValueError(f"refusing non-regular or non-owned telemetry path: {path}")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (
            not stat_mode.S_ISREG(opened.st_mode)
            or opened.st_uid != os.getuid()
            or (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino)
        ):
            raise ValueError(f"telemetry path changed during validation: {path}")
        if stat_mode.S_IMODE(opened.st_mode) != 0o600:
            os.fchmod(descriptor, 0o600)
        return os.fstat(descriptor)
    finally:
        os.close(descriptor)


def write_all(descriptor: int, contents: bytes) -> None:
    pending = memoryview(contents)
    while pending:
        written = os.write(descriptor, pending)
        if written <= 0:
            raise OSError("resource telemetry write made no progress")
        pending = pending[written:]


def trim_file_to_tail(path: Path, max_bytes: int) -> None:
    descriptor = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if not stat_mode.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise ValueError(f"refusing non-regular or non-owned telemetry path: {path}")
        if metadata.st_size <= max_bytes:
            return
        os.lseek(descriptor, -max_bytes, os.SEEK_END)
        tail = os.read(descriptor, max_bytes)
        first_newline = tail.find(b"\n")
        retained = tail[first_newline + 1 :] if first_newline >= 0 else b""
        os.ftruncate(descriptor, 0)
        os.lseek(descriptor, 0, os.SEEK_SET)
        write_all(descriptor, retained)
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)


def append_bounded(path: Path, max_bytes: int, row: dict[str, Any]) -> None:
    encoded = (json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    if len(encoded) > max_bytes:
        raise ValueError(f"one telemetry row is {len(encoded)} bytes, above the {max_bytes}-byte log cap")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = path.with_name(path.name + ".1")
    for candidate in (path, backup):
        metadata = owned_regular_file(candidate)
        if metadata and metadata.st_size > max_bytes:
            trim_file_to_tail(candidate, max_bytes)
    current = owned_regular_file(path)
    if current and current.st_size + len(encoded) > max_bytes:
        old_backup = owned_regular_file(backup)
        if old_backup:
            backup.unlink()
        os.replace(path, backup)
    flags = os.O_CREAT | os.O_WRONLY | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat_mode.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise ValueError(f"refusing non-regular or non-owned telemetry path: {path}")
        os.fchmod(descriptor, 0o600)
        write_all(descriptor, encoded)
    finally:
        os.close(descriptor)


def default_output_path() -> Path:
    return default_state_root() / "omni" / "resource-watch.jsonl"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL_SECONDS)
    parser.add_argument("--process-interval", type=float, default=DEFAULT_PROCESS_INTERVAL_SECONDS)
    parser.add_argument("--output", type=Path, default=default_output_path())
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    parser.add_argument(
        "--pid-file",
        type=Path,
        default=default_state_root() / "omni" / "build-target.pid",
    )
    parser.add_argument("--once", action="store_true", help="write one sample and exit")
    args = parser.parse_args()
    if args.interval <= 0:
        parser.error("--interval must be greater than zero")
    if args.process_interval <= 0:
        parser.error("--process-interval must be greater than zero")
    if args.max_bytes < 16 * 1024:
        parser.error("--max-bytes must be at least 16384 so each sample fits within the hard cap")
    return args


def main() -> int:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    runtime_directory = private_runtime_directory()
    output_identity = os.path.abspath(args.output)
    lock_id = hashlib.sha256(output_identity.encode("utf-8")).hexdigest()[:16]
    lock_path = runtime_directory / f"omni-resource-watch-{lock_id}.lock"
    lock_flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    lock_fd = os.open(lock_path, lock_flags, 0o600)
    try:
        lock_metadata = os.fstat(lock_fd)
        if not stat_mode.S_ISREG(lock_metadata.st_mode) or lock_metadata.st_uid != os.getuid():
            raise ValueError(f"refusing non-regular or non-owned lock path: {lock_path}")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(f"resource watcher already holds {lock_path}", file=sys.stderr)
            return 2
        os.fchmod(lock_fd, 0o600)
        previous_state: dict[str, Any] | None = None
        write_error_active = False
        while True:
            row, previous_state = sample(previous_state, args.pid_file, args.process_interval)
            try:
                append_bounded(args.output, args.max_bytes, row)
            except (OSError, ValueError) as error:
                if not write_error_active:
                    print(f"resource telemetry write unavailable: {type(error).__name__}", file=sys.stderr)
                    write_error_active = True
            else:
                if write_error_active:
                    print("resource telemetry writes recovered", file=sys.stderr)
                    write_error_active = False
            print(
                f"{row['timestamp']} RAM_avail={row['host']['memory_available_bytes']} "
                f"disk_free={row['host']['root_disk_free_bytes']} "
                f"target={'set' if row['target_cgroup'] else 'none'}",
                flush=True,
            )
            if args.once:
                return 1 if write_error_active else 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    raise SystemExit(main())
