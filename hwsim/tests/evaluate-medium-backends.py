#!/usr/bin/env python3
"""Compare hwsim medium data paths with one repeatable QEMU workload.

Run as root in the isolated Linux 7.0 lab VM.  The script owns two temporary
hwsim radios and one network namespace; do not run it over an active lab.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONFIGURATOR = ROOT / "wmediumd" / "configurator"
sys.path.insert(0, str(CONFIGURATOR))

from wmdcfg.kernel_actuator import KernelMediumClient  # noqa: E402


RADIO_A = "42:00:00:00:00:00"
RADIO_B = "42:00:00:00:01:00"


def run(*args: str, check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=check, text=True, **kwargs)


def cpu_snapshot() -> dict[str, int]:
    fields = Path("/proc/stat").read_text().splitlines()[0].split()
    values = [int(value) for value in fields[1:]]
    while len(values) < 10:
        values.append(0)
    return {
        "user": values[0],
        "nice": values[1],
        "system": values[2],
        "idle": values[3],
        "iowait": values[4],
        "irq": values[5],
        "softirq": values[6],
        "steal": values[7],
    }


def process_ticks(process: subprocess.Popen | None) -> int | None:
    if process is None or process.poll() is not None:
        return None
    fields = Path(f"/proc/{process.pid}/stat").read_text().split()
    return int(fields[13]) + int(fields[14])


def cpu_delta(before: dict[str, int], after: dict[str, int]) -> dict[str, float]:
    delta = {key: after[key] - before[key] for key in before}
    idle = delta["idle"] + delta["iowait"]
    total = sum(delta.values())
    # In a nested QEMU/LXD VM, steal time is outer-host scheduling delay, not
    # guest packet-processing CPU. Exclude it from both numerator and the
    # guest-capacity denominator and report it independently.
    guest_total = total - delta["steal"]
    busy = guest_total - idle
    return {
        "capacity_percent": round(100 * busy / guest_total, 3) if guest_total else 0.0,
        "equivalent_core_percent": round(
            100 * busy / guest_total * os.cpu_count(), 3
        ) if guest_total else 0.0,
        "system_percent": round(
            100 * delta["system"] / guest_total, 3
        ) if guest_total else 0.0,
        "softirq_percent": round(
            100 * delta["softirq"] / guest_total, 3
        ) if guest_total else 0.0,
        "steal_percent": round(100 * delta["steal"] / total, 3) if total else 0.0,
    }


def cleanup() -> None:
    run("pkill", "-x", "iperf3", check=False, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL)
    run("pkill", "-x", "wmediumd.patched", check=False,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run("ip", "netns", "del", "kmsta", check=False,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run("modprobe", "-r", "mac80211_hwsim", check=False,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def phy_for(interface: str) -> str:
    return Path(f"/sys/class/net/{interface}/phy80211").resolve().name


def load_module(
    module: Path,
    kernel_medium: bool,
    rate_per: bool = False,
    delay_us: int = 0,
    jitter_us: int = 0,
) -> None:
    cleanup()
    run("modprobe", "mac80211")
    arguments = [
        "insmod", str(module), "radios=2", "channels=3", "regtest=5",
        f"kernel_medium={1 if kernel_medium else 0}", "kernel_medium_bank=0",
        "kernel_medium_loss_pct=0", "kernel_medium_cutoff=-95",
        f"kernel_medium_rate_per={1 if rate_per else 0}",
        "kernel_medium_noise_floor=-91",
        f"kernel_medium_delay_us={delay_us}",
        f"kernel_medium_jitter_us={jitter_us}",
    ]
    run(*arguments)


def start_wmediumd(binary: Path, directory: Path) -> subprocess.Popen:
    config = directory / "two-radio.cfg"
    control = directory / "control.sock"
    log = directory / "wmediumd.log"
    config.write_text(
        'ifaces : { ids = [\n'
        f'  "{RADIO_A}",\n  "{RADIO_B}"\n'
        ']; };\nmodel : { type = "snr"; default_snr = 41; };\n'
    )
    stream = log.open("w")
    process = subprocess.Popen(
        [str(binary), "-l", "3", "-c", str(config), "-C", str(control)],
        stdout=stream, stderr=subprocess.STDOUT, text=True,
    )
    for _ in range(50):
        if process.poll() is not None:
            stream.close()
            raise RuntimeError(f"wmediumd exited during registration: {log.read_text()}")
        if control.exists():
            process._benchmark_log = stream  # type: ignore[attr-defined]
            return process
        time.sleep(0.05)
    process.terminate()
    process.wait(timeout=3)
    stream.close()
    raise RuntimeError("wmediumd control socket did not appear")


def setup_ibss() -> None:
    station_phy = phy_for("wlan1")
    run("ip", "link", "set", "wlan0", "down")
    run("iw", "wlan0", "set", "type", "ibss")
    run("ip", "link", "set", "wlan0", "up")
    run("iw", "wlan0", "ibss", "join", "kmtest", "2412", "fixed-freq")
    host_deadline = time.monotonic() + 10
    while time.monotonic() < host_deadline:
        state = run("iw", "dev", "wlan0", "link", check=False,
                    capture_output=True).stdout
        if "Joined IBSS" in state:
            break
        time.sleep(0.2)
    else:
        raise RuntimeError("host IBSS did not form")
    run("ip", "netns", "add", "kmsta")
    run("iw", "phy", station_phy, "set", "netns", "name", "kmsta")
    run(
        "ip", "netns", "exec", "kmsta", "bash", "-lc",
        "ip link set lo up; ip link set wlan1 down; "
        "iw wlan1 set type ibss; ip link set wlan1 up; "
        "iw wlan1 ibss join kmtest 2412 fixed-freq; "
        "ip addr replace 10.99.0.2/24 dev wlan1",
    )
    run("ip", "addr", "replace", "10.99.0.1/24", "dev", "wlan0")
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        run("ip", "addr", "replace", "10.99.0.1/24", "dev", "wlan0")
        run("ip", "netns", "exec", "kmsta", "ip", "addr", "replace",
            "10.99.0.2/24", "dev", "wlan1")
        probe = run(
            "ping", "-I", "10.99.0.1", "-c", "1", "-W", "1", "10.99.0.2",
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if probe.returncode == 0:
            return
        time.sleep(0.25)
    raise RuntimeError("two-radio IBSS did not become reachable")


def apply_matrix(snr_db: int = 41) -> None:
    with KernelMediumClient() as client:
        generation = client.status().generation + 1
        updates = [
            {
                "source": source,
                "destination": destination,
                "frequency_mhz": 2437,
                "value": snr_db,
                "override": True,
            }
            for source, destination in ((RADIO_A, RADIO_B), (RADIO_B, RADIO_A))
        ]
        client.apply_frequency(generation, updates)


def force_legacy_rate(rate_mbps: int) -> None:
    rate = str(rate_mbps)
    run("iw", "dev", "wlan0", "set", "bitrates", "legacy-2.4", rate)
    run(
        "ip", "netns", "exec", "kmsta", "iw", "dev", "wlan1", "set",
        "bitrates", "legacy-2.4", rate,
    )


def ping_metrics(count: int) -> dict[str, float]:
    result = run(
        "ping", "-I", "10.99.0.1", "-c", str(count), "-i", "0.01", "-W", "1",
        "10.99.0.2", check=False, capture_output=True,
    )
    loss = re.search(r"([0-9.]+)% packet loss", result.stdout)
    rtt = re.search(r"= ([0-9.]+)/([0-9.]+)/([0-9.]+)/([0-9.]+) ms", result.stdout)
    return {
        "loss_percent": float(loss.group(1)) if loss else 100.0,
        "rtt_avg_ms": float(rtt.group(2)) if rtt else -1.0,
        "rtt_pseudo_max_ms": float(rtt.group(3)) if rtt else -1.0,
    }


def traffic_metrics(duration: int, rate: str, medium: subprocess.Popen | None) -> dict:
    run("ip", "addr", "replace", "10.99.0.1/24", "dev", "wlan0")
    run("ip", "netns", "exec", "kmsta", "ip", "addr", "replace",
        "10.99.0.2/24", "dev", "wlan1")
    server = subprocess.Popen(
        ["ip", "netns", "exec", "kmsta", "iperf3", "-s", "-1", "-J"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    time.sleep(0.25)
    cpu_before = cpu_snapshot()
    ticks_before = process_ticks(medium)
    started = time.monotonic()
    client = run(
        "iperf3", "-c", "10.99.0.2", "-u", "-b", rate,
        "-l", "1200", "-t", str(duration), "-J", capture_output=True,
        check=False,
    )
    elapsed = time.monotonic() - started
    ticks_after = process_ticks(medium)
    cpu_after = cpu_snapshot()
    if client.returncode or not client.stdout.strip():
        server.terminate()
        try:
            server.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            server.kill()
            server.communicate()
        return {
            "requested_rate": rate,
            "duration_seconds": round(elapsed, 3),
            "error": client.stderr.strip() or f"iperf3 exited {client.returncode}",
            "guest_cpu": cpu_delta(cpu_before, cpu_after),
        }
    server.communicate(timeout=5)
    report = json.loads(client.stdout)
    received = report["end"]["sum"]
    result = {
        "requested_rate": rate,
        "duration_seconds": round(elapsed, 3),
        "received_mbps": round(received["bits_per_second"] / 1_000_000, 3),
        "lost_percent": round(received["lost_percent"], 3),
        "packets": received["packets"],
        "lost_packets": received["lost_packets"],
        "jitter_ms": round(received["jitter_ms"], 4),
        "guest_cpu": cpu_delta(cpu_before, cpu_after),
    }
    if ticks_before is not None and ticks_after is not None:
        result["wmediumd_core_percent"] = round(
            100 * (ticks_after - ticks_before) / os.sysconf("SC_CLK_TCK") / elapsed,
            3,
        )
    return result


def evaluate(args: argparse.Namespace) -> dict:
    configurations = [
        ("stock-built-in", False, False, None, False, None, 0, 0),
        ("userspace-wmediumd-default", False, True, None, False, None, 0, 0),
        ("kernel-medium-default", True, False, None, False, None, 0, 0),
        ("kernel-medium-matrix", True, False, 41, False, None, 0, 0),
        ("kernel-rate-per-strong", True, False, 41, True, 11, 0, 0),
        ("kernel-rate-per-margin", True, False, 7, True, 11, 0, 0),
        ("kernel-delay-jitter", True, False, 41, False, None, 2000, 500),
        ("kernel-enabled-userspace-precedence", True, True, None, True, None, 2000, 500),
    ]
    if args.only:
        selected = set(args.only)
        configurations = [item for item in configurations if item[0] in selected]
        missing = selected - {item[0] for item in configurations}
        if missing:
            raise ValueError(f"unknown configuration(s): {', '.join(sorted(missing))}")
    result = {
        "schema": "hwsim-medium-evaluation.v2",
        "kernel": os.uname().release,
        "vcpus": os.cpu_count(),
        "duration_seconds": args.duration,
        "rate": args.rate,
        "configurations": [],
    }
    for (name, kernel_enabled, use_userspace, matrix_snr, rate_per,
         fixed_legacy_rate, delay_us, jitter_us) in configurations:
        temporary = tempfile.TemporaryDirectory(prefix="hwsim-medium-")
        medium = None
        try:
            load_module(args.module, kernel_enabled, rate_per, delay_us, jitter_us)
            if use_userspace:
                medium = start_wmediumd(args.wmediumd, Path(temporary.name))
            setup_ibss()
            if fixed_legacy_rate is not None:
                force_legacy_rate(fixed_legacy_rate)
            if matrix_snr is not None:
                apply_matrix(matrix_snr)
            measurement = {
                "name": name,
                "kernel_medium_enabled": kernel_enabled,
                "userspace_wmediumd_registered": use_userspace,
                "matrix_override": matrix_snr is not None,
                "matrix_snr_db": matrix_snr,
                "rate_per_enabled": rate_per,
                "fixed_legacy_rate_mbps": fixed_legacy_rate,
                "delay_us": delay_us,
                "jitter_us": jitter_us,
                "ping": ping_metrics(args.ping_count),
                "traffic": traffic_metrics(args.duration, args.rate, medium),
            }
            if kernel_enabled:
                # Let the bounded receive-delay queues drain before recording
                # their final depth and delivered counters.
                time.sleep(0.2)
                measurement["kernel_generation"] = int(
                    Path(
                        "/sys/module/mac80211_hwsim/parameters/"
                        "kernel_medium_generation"
                    ).read_text()
                )
                measurement["kernel_counters"] = {
                    path.parent.parent.name: {
                        counter: int(
                            (path.parent / f"kernel_medium_{counter}").read_text()
                        )
                        for counter in ("considered", "delivered", "dropped")
                    }
                    for path in Path("/sys/kernel/debug/ieee80211").glob(
                        "phy*/hwsim/kernel_medium_considered"
                    )
                }
                measurement["kernel_link_state"] = {
                    path.parts[-3]: path.read_text().splitlines()[-5:]
                    for path in Path("/sys/kernel/debug/ieee80211").glob(
                        "phy*/hwsim/kernel_medium_links"
                    )
                }
            result["configurations"].append(measurement)
            print(json.dumps(measurement, sort_keys=True), flush=True)
        finally:
            if medium is not None:
                medium.send_signal(signal.SIGTERM)
                try:
                    medium.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    medium.kill()
                    medium.wait()
                stream = getattr(medium, "_benchmark_log", None)
                if stream is not None:
                    stream.close()
            cleanup()
            temporary.cleanup()
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--module", type=Path,
        default=ROOT / "hwsim" / "build" / "mac80211_hwsim.ko",
    )
    parser.add_argument(
        "--wmediumd", type=Path,
        default=ROOT / "wmediumd" / "wmediumd.patched",
    )
    parser.add_argument("--duration", type=int, default=10)
    parser.add_argument("--rate", default="20M")
    parser.add_argument("--ping-count", type=int, default=100)
    parser.add_argument(
        "--only", action="append",
        help="run only the named configuration; may be supplied repeatedly",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run as root inside an isolated VM")
    if not args.module.is_file() or not args.wmediumd.is_file():
        parser.error("the patched hwsim module and wmediumd binary must exist")
    try:
        report = evaluate(args)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        print(args.output)
        return 0
    finally:
        cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
