from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from .beacon import ap_metric_loads, beacon_loads
from .rf_validate import command, stop_process
from .rf_qualify import restore_actions
from .survey_bridge import parse_contexts


def first_delay(rows, step_seconds, bssid=None):
    matches = [row["timestamp_seconds"] + row["timestamp_fraction"] / 1000000 - step_seconds
               for row in rows if row["utilization_byte"] == 255 and
               (bssid is None or row["bssid"] == bssid)]
    matches = [delay for delay in matches if delay >= 0]
    return min(matches) if matches else None


def latency_status(report, budget_seconds=15):
    values = [report.get(key) for key in (
        "fixture_start_to_driver_seconds", "fixture_start_to_beacon_seconds", "fixture_start_to_1905_seconds")]
    complete = all(isinstance(value, (int, float)) and not isinstance(value, bool)
                   and math.isfinite(value) and value >= 0 for value in values)
    within_budget = complete and all(value <= budget_seconds for value in values)
    return {"measurement_complete": complete, "latency_budget_seconds": budget_seconds,
            "within_latency_budget": within_budget, "passed": within_budget}


def zero_baseline(rows, since_seconds, bssid=None):
    latest = {}
    for row in rows:
        timestamp = row["timestamp_seconds"] + row["timestamp_fraction"] / 1000000
        identity = row["bssid"]
        if timestamp < since_seconds or (bssid is not None and identity != bssid):
            continue
        if identity not in latest or timestamp >= latest[identity][0]:
            latest[identity] = (timestamp, row)
    return next((latest[identity][1] for identity in sorted(latest)
                 if latest[identity][1]["utilization_byte"] == 0), None)


def live_loads(path, reader):
    if not path.exists() or path.stat().st_size < 24:
        return []
    try:
        return reader(path)
    except ValueError as error:
        if str(error).startswith("truncated"):
            return []
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description="Short native survey/beacon/AP report latency fixture")
    parser.add_argument("--stack", choices=("rdk", "prplmesh"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--observation-seconds", type=float, default=30)
    parser.add_argument("--yes-change-lab", action="store_true")
    args = parser.parse_args(argv)
    if not math.isfinite(args.observation_seconds) or not 15 <= args.observation_seconds <= 60:
        parser.error("--observation-seconds must be between 15 and 60")
    if os.geteuid() or not args.yes_change_lab:
        parser.error("requires root inside the VM and --yes-change-lab")
    rdk = args.stack == "rdk"
    ap = "bpibroadband" if rdk else "prpl-controller"
    interface = "wifi1" if rdk else "wlan2"
    room = "easymesh-room-demo" if rdk else "prplmesh-room-demo"
    socket = "/run/meta-cmf-wmediumd/metrics/control.sock" if rdk else "/run/prpl-wmediumd/metrics.sock"
    args.output.mkdir(parents=True, exist_ok=False)
    command("systemctl", "is-active", "--quiet", "wmdcfg-survey-bridge")
    room_active = subprocess.run(["systemctl", "is-active", "--quiet", room]).returncode == 0
    monitor_up = "UP" in json.loads(command("ip", "-j", "link", "show", "hwsim0"))[0]["flags"]
    info = command("lxc", "exec", ap, "--", "iw", "dev", interface, "info")
    bssid = re.search(r"addr (\S+)", info)[1]
    frequency = int(re.search(r"\((\d+) MHz\)", info)[1])
    phy = re.search(r"wiphy (\d+)", info)[1]
    cache = Path(f"/sys/kernel/debug/ieee80211/phy{phy}/hwsim/rf_survey")
    ap_pid = json.loads(command("lxc", "query", f"/1.0/instances/{ap}/state"))["pid"]
    provider = None
    captures = []
    report = {"stack": args.stack, "source": "synthetic-field-test",
              "physical_capacity_qualified": False, "bssid": bssid, "frequency_mhz": frequency,
              "observation_seconds": args.observation_seconds, "passed": False}

    def fixture(value):
        return subprocess.Popen(
            [sys.executable, "-m", "wmdcfg.survey_bridge", "--socket", socket,
             "--enable", "--fixed-utilization", str(value)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        if room_active:
            command("systemctl", "stop", room, timeout=180)
        command("systemctl", "stop", "wmdcfg-survey-bridge")
        command("ip", "link", "set", "hwsim0", "up")
        for name, prefix, device, expression in (
            ("beacon", [], "hwsim0", "type mgt subtype beacon"),
            ("ap-metrics", ["nsenter", "-t", str(ap_pid), "-n"], "any", "ether proto 0x893a"),
        ):
            captures.append(subprocess.Popen(prefix + [
                "tcpdump", "-U", "--time-stamp-precision=micro", "-i", device,
                "-w", str(args.output / f"{name}.pcap"), expression],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(.3)
        baseline_mono = time.monotonic()
        baseline_wall = time.time()
        provider = fixture(0)
        while time.monotonic() - baseline_mono < args.observation_seconds:
            if provider.poll() is not None or any(process.poll() is not None for process in captures):
                raise RuntimeError("baseline provider or packet capture failed")
            available, contexts = parse_contexts(cache.read_text())
            driver_zero = available and any(
                row["frequency_mhz"] == frequency and row["valid"] and
                row["active_us"] > 0 and row["busy_us"] == 0 for row in contexts)
            beacon_zero = zero_baseline(
                live_loads(args.output / "beacon.pcap", beacon_loads), baseline_wall, bssid)
            native_zero = zero_baseline(
                live_loads(args.output / "ap-metrics.pcap", ap_metric_loads),
                baseline_wall, bssid if rdk else None)
            if driver_zero and beacon_zero is not None and native_zero is not None:
                report["baseline"] = {"verified": True, "started_wall_seconds": baseline_wall,
                                      "duration_seconds": time.monotonic() - baseline_mono,
                                      "beacon": beacon_zero, "native": native_zero}
                break
            time.sleep(.25)
        else:
            raise RuntimeError("zero baseline not verified in driver, beacon and native AP metrics")
        stop_process(provider)
        step_mono = time.monotonic()
        report["step_wall_seconds"] = time.time()
        provider = fixture(255)
        first_native = None
        while time.monotonic() - step_mono < args.observation_seconds:
            if provider.poll() is not None or any(process.poll() is not None for process in captures):
                raise RuntimeError("step provider or packet capture failed")
            available, contexts = parse_contexts(cache.read_text())
            if first_native is None and available and any(
                    row["frequency_mhz"] == frequency and row["valid"] and
                    row["active_us"] > 0 and row["busy_us"] == row["active_us"] for row in contexts):
                first_native = time.monotonic() - step_mono
            time.sleep(.02)
        report["fixture_start_to_driver_seconds"] = first_native
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        actions = [("fixture provider", lambda: stop_process(provider))]
        for process in captures:
            actions.append(("packet capture", lambda process=process: stop_process(process, signal.SIGINT)))
        actions.append(("normal bridge", lambda: command("systemctl", "start", "wmdcfg-survey-bridge")))
        if not monitor_up:
            actions.append(("monitor state", lambda: command("ip", "link", "set", "hwsim0", "down")))
        if room_active:
            actions.append(("normal room", lambda: command("systemctl", "start", room)))
        report["cleanup_errors"] = restore_actions(actions)
        report["restored"] = not report["cleanup_errors"]
        if not report.get("error"):
            try:
                beacon = beacon_loads(args.output / "beacon.pcap")
                native = ap_metric_loads(args.output / "ap-metrics.pcap")
                report["fixture_start_to_beacon_seconds"] = first_delay(beacon, report["step_wall_seconds"], bssid)
                report["fixture_start_to_1905_seconds"] = first_delay(
                    native, report["step_wall_seconds"], report["baseline"]["native"]["bssid"])
                report["native_report_scope"] = "colocated AP" if rdk else "remote AP"
                report.update(latency_status(report))
            except (OSError, ValueError) as error:
                report["error"] = f"{type(error).__name__}: {error}"
        report["passed"] = report["passed"] and report["restored"]
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    return 0 if report.get("passed") and report["restored"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
