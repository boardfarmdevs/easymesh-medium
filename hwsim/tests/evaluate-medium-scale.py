#!/usr/bin/env python3
"""Measure hwsim medium fan-out at the 20/50/100-client radio counts.

Run as root in the isolated Linux 7.0 VM with the EasyMesh lab stopped.  One
IBSS transmitter emits a paced broadcast stream while every other radio is an
active same-channel monitor.  Broadcast makes both medium backends process the
complete receiver roster instead of hiding scale behind a unicast fast path.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import subprocess
import tempfile
import time
from pathlib import Path


PROFILE_CLIENTS = {"small": 20, "medium": 50, "stress": 100}


def run(*args: str, check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=check, text=True, **kwargs)


def cleanup() -> None:
    run("pkill", "-x", "wmediumd.patched", check=False,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run("ip", "netns", "del", "scale-peer", check=False,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run("modprobe", "-r", "mac80211_hwsim", check=False,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cpu_snapshot() -> list[int]:
    values = [int(value) for value in Path("/proc/stat").read_text().splitlines()[0].split()[1:]]
    while len(values) < 10:
        values.append(0)
    return values


def cpu_delta(before: list[int], after: list[int]) -> dict[str, float]:
    values = [right - left for left, right in zip(before, after)]
    idle = values[3] + values[4]
    total = sum(values)
    guest_total = total - values[7]
    busy = guest_total - idle
    return {
        "capacity_percent": round(100 * busy / guest_total, 3) if guest_total else 0.0,
        "equivalent_core_percent": round(
            100 * busy / guest_total * os.cpu_count(), 3
        ) if guest_total else 0.0,
        "system_percent": round(100 * values[2] / guest_total, 3) if guest_total else 0.0,
        "softirq_percent": round(100 * values[6] / guest_total, 3) if guest_total else 0.0,
        "steal_percent": round(100 * values[7] / total, 3) if total else 0.0,
    }


def process_ticks(pid: int) -> int:
    fields = Path(f"/proc/{pid}/stat").read_text().split()
    return int(fields[13]) + int(fields[14])


def process_rss_kib(pid: int) -> int:
    match = re.search(r"^VmRSS:\s+(\d+)", Path(f"/proc/{pid}/status").read_text(), re.M)
    return int(match.group(1)) if match else 0


def memory_snapshot() -> dict[str, int]:
    wanted = {"MemAvailable", "Slab", "SReclaimable", "SUnreclaim"}
    result = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        name, value, *_ = line.replace(":", "").split()
        if name in wanted:
            result[name] = int(value)
    return result


def load_module(module: Path, radios: int, kernel_medium: bool) -> None:
    cleanup()
    run("modprobe", "mac80211")
    run(
        "insmod", str(module), f"radios={radios}", "channels=3", "regtest=5",
        f"kernel_medium={1 if kernel_medium else 0}", "kernel_medium_bank=0",
        "kernel_medium_loss_pct=0", "kernel_medium_cutoff=-95",
        "kernel_medium_rate_per=0", "kernel_medium_delay_us=0",
        "kernel_medium_jitter_us=0",
    )


def radio_identities() -> list[str]:
    result = []
    for path in Path("/sys/kernel/debug/ieee80211").glob("phy*/hwsim/kernel_medium_links"):
        match = re.match(r"radio ([0-9a-f:]{17}) ", path.read_text(), re.I)
        if match:
            result.append(match.group(1).lower())
    return sorted(result)


def start_wmediumd(binary: Path, identities: list[str], directory: Path) -> subprocess.Popen:
    config = directory / "scale.cfg"
    log = directory / "wmediumd.log"
    quoted = ",\n".join(f'  "{identity}"' for identity in identities)
    config.write_text(
        f"ifaces : {{ ids = [\n{quoted}\n]; }};\n"
        'model : { type = "snr"; default_snr = 41; };\n'
    )
    stream = log.open("w")
    process = subprocess.Popen(
        [str(binary), "-l", "3", "-c", str(config)],
        stdout=stream, stderr=subprocess.STDOUT, text=True,
    )
    time.sleep(1)
    if process.poll() is not None:
        stream.close()
        raise RuntimeError(f"wmediumd failed: {log.read_text()}")
    process._scale_log = stream  # type: ignore[attr-defined]
    return process


def interfaces() -> list[str]:
    output = run("iw", "dev", capture_output=True).stdout
    return sorted(re.findall(r"^\s*Interface\s+(\S+)", output, re.M),
                  key=lambda name: int(re.search(r"(\d+)$", name).group(1)))


def setup_radios(expected: int) -> None:
    names = interfaces()
    if len(names) != expected:
        raise RuntimeError(f"expected {expected} base interfaces, found {len(names)}")
    transmitter = names[0]
    run("ip", "link", "set", transmitter, "down")
    run("iw", "dev", transmitter, "set", "type", "ibss")
    run("ip", "link", "set", transmitter, "up")
    run(
        "iw", "dev", transmitter, "ibss", "join", "scale-test", "2412",
        "fixed-freq", "02:11:22:33:44:55",
    )
    run("ip", "addr", "replace", "10.99.0.1/24", "dev", transmitter)
    for _ in range(100):
        host_link = run(
            "iw", "dev", transmitter, "link", check=False, capture_output=True
        ).stdout
        if "Joined IBSS" in host_link:
            break
        time.sleep(0.1)
    else:
        raise RuntimeError(
            f"scale-test transmitter did not form IBSS: {host_link.strip()!r}"
        )
    peer = names[1]
    peer_phy = Path(f"/sys/class/net/{peer}/phy80211").resolve().name
    run("ip", "netns", "add", "scale-peer")
    run("iw", "phy", peer_phy, "set", "netns", "name", "scale-peer")
    run(
        "ip", "netns", "exec", "scale-peer", "bash", "-lc",
        f"ip link set lo up; ip link set {peer} down; "
        f"iw dev {peer} set type ibss; ip link set {peer} up; "
        f"iw dev {peer} ibss join scale-test 2412 fixed-freq 02:11:22:33:44:55; "
        f"ip addr replace 10.99.0.2/24 dev {peer}",
    )
    for _ in range(50):
        if run(
            "ping", "-I", "10.99.0.1", "-c", "1", "-W", "1", "10.99.0.2",
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ).returncode == 0:
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("scale-test IBSS peer did not become reachable")
    # Keep the offered 5 Mbit/s workload below a fixed and identical PHY rate;
    # otherwise the default 1 Mbit/s legacy rate backpressures userspace before
    # the medium fan-out is measured.
    run("iw", "dev", transmitter, "set", "bitrates", "legacy-2.4", "11")
    run(
        "ip", "netns", "exec", "scale-peer", "iw", "dev", peer, "set",
        "bitrates", "legacy-2.4", "11",
    )
    for name in names[2:]:
        run("ip", "link", "set", name, "down")
        run("iw", "dev", name, "set", "type", "monitor")
        run("ip", "link", "set", name, "up")
        run("iw", "dev", name, "set", "freq", "2412")


def send_broadcast(duration: int, rate_mbps: float) -> tuple[int, float]:
    payload = b"M" * 1200
    packets_per_second = rate_mbps * 1_000_000 / (len(payload) * 8)
    interval = 1.0 / packets_per_second
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, b"wlan0\0")
    target = ("10.99.0.255", 19050)
    started = time.monotonic()
    deadline = started + duration
    sequence = 0
    while True:
        due = started + sequence * interval
        now = time.monotonic()
        if now >= deadline:
            break
        if due > now:
            time.sleep(due - now)
        sock.sendto(payload, target)
        sequence += 1
    sock.close()
    return sequence, time.monotonic() - started


def counter_totals() -> dict[str, int]:
    result = {}
    for name in ("considered", "delivered", "dropped"):
        result[name] = sum(
            int(path.read_text())
            for path in Path("/sys/kernel/debug/ieee80211").glob(
                f"phy*/hwsim/kernel_medium_{name}"
            )
        )
    return result


def interface_tx_stats(interface: str = "wlan0") -> dict[str, int]:
    root = Path(f"/sys/class/net/{interface}/statistics")
    return {
        name: int((root / name).read_text())
        for name in ("tx_packets", "tx_bytes", "tx_dropped", "tx_errors")
    }


def evaluate_one(args: argparse.Namespace, profile: str, backend: str) -> dict:
    clients = PROFILE_CLIENTS[profile]
    radios = clients + 5
    before_memory = memory_snapshot()
    load_module(args.module, radios, backend == "kernel")
    after_module_memory = memory_snapshot()
    identities = radio_identities()
    if len(identities) != radios:
        raise RuntimeError(f"identity count {len(identities)} != {radios}")
    temporary = tempfile.TemporaryDirectory(prefix="hwsim-scale-")
    medium = None
    try:
        if backend == "userspace":
            medium = start_wmediumd(args.wmediumd, identities, Path(temporary.name))
        setup_radios(radios)
        time.sleep(1)
        cpu_before = cpu_snapshot()
        ticks_before = process_ticks(medium.pid) if medium else None
        packets, elapsed = send_broadcast(args.duration, args.rate_mbps)
        time.sleep(1)
        ticks_after = process_ticks(medium.pid) if medium else None
        cpu_after = cpu_snapshot()
        result = {
            "profile": profile,
            "backend": backend,
            "client_equivalent": clients,
            "active_radios": radios,
            "packets_sent": packets,
            "elapsed_seconds": round(elapsed, 3),
            "offered_mbps": args.rate_mbps,
            "submitted_mbps": round(
                packets * 1200 * 8 / elapsed / 1_000_000, 3
            ),
            "guest_cpu": cpu_delta(cpu_before, cpu_after),
            "transmitter": interface_tx_stats(),
            "memory_before_kib": before_memory,
            "memory_after_module_kib": after_module_memory,
            "module_memory_delta_kib": {
                name: after_module_memory[name] - before_memory[name]
                for name in before_memory
            },
        }
        if medium:
            result["wmediumd_core_percent"] = round(
                100 * (ticks_after - ticks_before) /
                os.sysconf("SC_CLK_TCK") / (elapsed + 1), 3
            )
            result["wmediumd_rss_kib"] = process_rss_kib(medium.pid)
        else:
            result["kernel_counters"] = counter_totals()
        return result
    finally:
        if medium:
            medium.send_signal(signal.SIGTERM)
            try:
                medium.wait(timeout=3)
            except subprocess.TimeoutExpired:
                medium.kill()
                medium.wait()
            medium._scale_log.close()  # type: ignore[attr-defined]
        cleanup()
        temporary.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--module", type=Path, required=True)
    parser.add_argument("--wmediumd", type=Path, required=True)
    parser.add_argument("--duration", type=int, default=5)
    parser.add_argument("--rate-mbps", type=float, default=5.0)
    parser.add_argument("--profile", action="append", choices=PROFILE_CLIENTS)
    parser.add_argument("--backend", action="append", choices=("userspace", "kernel"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run as root inside an isolated VM")
    profiles = args.profile or list(PROFILE_CLIENTS)
    backends = args.backend or ["userspace", "kernel"]
    report = {
        "schema": "hwsim-medium-scale.v1",
        "kernel": os.uname().release,
        "vcpus": os.cpu_count(),
        "duration_seconds": args.duration,
        "offered_mbps": args.rate_mbps,
        "measurements": [],
    }
    try:
        for profile in profiles:
            for backend in backends:
                measurement = evaluate_one(args, profile, backend)
                report["measurements"].append(measurement)
                print(json.dumps(measurement, sort_keys=True), flush=True)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        print(args.output)
        return 0
    finally:
        cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
