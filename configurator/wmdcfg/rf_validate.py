from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from .actuator import ControlClient
from .beacon import ap_metric_loads, beacon_loads
from .survey_bridge import parse_contexts


def command(*arguments, timeout=30):
    result = subprocess.run(arguments, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{arguments}: {result.stdout}")
    return result.stdout


def stop_process(process, stop_signal=signal.SIGTERM):
    if process is None or process.poll() is not None:
        return
    process.send_signal(stop_signal)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def scan_for_roam(client_node, bssid, frequency, timeout=15):
    started = time.monotonic()
    deadline = started + timeout
    accepted = False
    next_scan = started
    scan_requests = 0
    last_result = ""
    while (now := time.monotonic()) < deadline:
        if not accepted or now >= next_scan:
            last_result = command("lxc", "exec", client_node, "--", "wpa_cli", "-i", "wlan0",
                                  "scan", f"freq={frequency}").strip()
            scan_requests += 1
            next_scan = now + 1
            if last_result == "OK":
                accepted = True
            elif last_result != "FAIL-BUSY":
                raise RuntimeError(f"native directed scan rejected: {last_result}")
        if accepted:
            last_result = command("lxc", "exec", client_node, "--", "wpa_cli", "-i", "wlan0",
                                  "bss", bssid)
            fields = dict(line.split("=", 1) for line in last_result.splitlines() if "=" in line)
            if (fields.get("bssid", "").lower() == bssid.lower() and
                    fields.get("freq") == str(frequency) and fields.get("age", "").isdigit() and
                    int(fields["age"]) <= 1):
                return {**fields, "scan_requests": scan_requests,
                        "scan_elapsed_seconds": time.monotonic() - started}
        time.sleep(.2)
    raise RuntimeError(f"native directed scan did not refresh {bssid} on {frequency}: {last_result}")


def native_load_matches(rows, value):
    last_per_bss = {row["bssid"]: row for row in rows}
    return bool(last_per_bss) and all(
        row["utilization_byte"] == value for row in last_per_bss.values())


def main(argv=None):
    parser = argparse.ArgumentParser(description="Short, disruptive RF survey/BSS-load acceptance")
    parser.add_argument("--stack", choices=("rdk", "prplmesh"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--yes-change-survey", action="store_true")
    args = parser.parse_args(argv)
    if not args.yes_change_survey or os.geteuid():
        parser.error("requires root inside the lab VM and --yes-change-survey")
    rdk = args.stack == "rdk"
    lab = "easymesh-lab" if rdk else "prplmesh-lab"
    room = "easymesh-room-demo" if rdk else "prplmesh-room-demo"
    ap = "bpibroadband" if rdk else "prpl-controller"
    client_node = "wlan-client" if rdk else "prpl-client-01"
    interface = "wifi1" if rdk else "wlan2"
    socket = "/run/meta-cmf-wmediumd/metrics/control.sock" if rdk else "/run/prpl-wmediumd/metrics.sock"
    command("systemctl", "is-active", "--quiet", lab)
    command("systemctl", "is-active", "--quiet", "wmdcfg-survey-bridge")
    args.output.mkdir(parents=True, exist_ok=False)
    info = command("lxc", "exec", ap, "--", "iw", "dev", interface, "info")
    bssid = re.search(r"addr (\S+)", info)[1]
    frequency = int(re.search(r"\((\d+) MHz\)", info)[1])
    phy = re.search(r"wiphy (\d+)", info)[1]
    ap_pid = json.loads(command("lxc", "query", f"/1.0/instances/{ap}/state"))["pid"]
    context_path = Path(f"/sys/kernel/debug/ieee80211/phy{phy}/hwsim/rf_survey")
    room_active = subprocess.run(["systemctl", "is-active", "--quiet", room]).returncode == 0
    monitor_up = "UP" in json.loads(command("ip", "-j", "link", "show", "hwsim0"))[0]["flags"]
    report = {"stack": args.stack, "ap": ap, "bssid": bssid, "frequency_mhz": frequency,
              "profile": "single-contention-domain-legacy20", "physical_capacity_qualified": False,
              "checks": [], "fixtures": []}
    provider = None
    provider_log = None

    def check(name, passed, **details):
        report["checks"].append({"name": name, "passed": bool(passed), **details})
        print(json.dumps(report["checks"][-1]), flush=True)

    def stop_provider():
        nonlocal provider, provider_log
        if provider is not None:
            stop_process(provider)
            provider = None
            provider_log.close()
            provider_log = None

    def start_provider(value, name):
        nonlocal provider, provider_log
        stop_provider()
        provider_log = (args.output / f"{name}-bridge.log").open("w")
        arguments = [sys.executable, "-m", "wmdcfg.survey_bridge", "--socket", socket,
                     "--enable", "--status-file", str(args.output / f"{name}-bridge.json")]
        if value is not None:
            arguments += ["--fixed-utilization", str(value)]
        provider = subprocess.Popen(arguments, stdout=provider_log, stderr=subprocess.STDOUT)
        time.sleep(4)
        if provider.poll() is not None:
            raise RuntimeError("survey fixture exited")

    def capture(name, expected_native=None):
        path = args.output / f"{name}.pcap"
        native_path = args.output / f"{name}-ap-metrics.pcap"
        with (args.output / f"{name}-tcpdump.log").open("w") as log:
            native = subprocess.Popen(
                ["nsenter", "-t", str(ap_pid), "-n", "tcpdump", "-U", "-i", "any",
                 "-w", str(native_path), "ether proto 0x893a"], stdout=log, stderr=log)
            process = None
            try:
                process = subprocess.Popen(
                    ["tcpdump", "-U", "-i", "hwsim0", "-w", str(path), "type mgt subtype beacon"],
                    stdout=log, stderr=log)
                capture_started = time.monotonic()
                if expected_native is None:
                    time.sleep(2)
                else:
                    while time.monotonic() - capture_started < 24:
                        time.sleep(2)
                        try:
                            observed = [row for row in ap_metric_loads(native_path)
                                        if not rdk or row["bssid"] == bssid]
                        except (OSError, ValueError):
                            continue
                        if (time.monotonic() - capture_started >= 8 and
                                native_load_matches(observed, expected_native)):
                            break
                report.setdefault("capture_seconds", {})[name] = time.monotonic() - capture_started
            finally:
                try:
                    stop_process(process, signal.SIGINT)
                finally:
                    stop_process(native, signal.SIGINT)
        rows = [row for row in beacon_loads(path) if row["bssid"] == bssid]
        native_rows = [row for row in ap_metric_loads(native_path) if not rdk or row["bssid"] == bssid]
        (args.output / f"{name}-ap-metrics.json").write_text(json.dumps(native_rows) + "\n")
        return rows

    try:
        if room_active:
            command("systemctl", "stop", room, timeout=180)
        command("systemctl", "stop", "wmdcfg-survey-bridge")
        command("ip", "link", "set", "hwsim0", "up")
        for value in (0, 128, 255):
            name = f"fixed-{value}"
            start_provider(value, name)
            rows = capture(name, value)
            native_rows = json.loads((args.output / f"{name}-ap-metrics.json").read_text())
            counts = command("lxc", "exec", ap, "--", "iw", "dev", interface, "station", "dump")
            station_count = len(re.findall(r"^Station ", counts, re.MULTILINE))
            scan = command("lxc", "exec", client_node, "--", "iw", "dev", "wlan0",
                           "scan", "freq", str(frequency), "flush", timeout=20)
            (args.output / f"{name}-scan.txt").write_text(scan)
            block = next((block for block in re.split(r"(?m)^BSS ", scan)
                          if block.lower().startswith(bssid)), "")
            check(name + "-beacon", rows and all(row["utilization_byte"] == value for row in rows),
                  packets=len(rows), observed=sorted({str(row["utilization_byte"]) for row in rows}))
            check(name + "-station-count", rows and all(
                row["station_count"] == station_count for row in rows), expected=station_count)
            check(name + "-scan", f"channel utilisation: {value}/255" in block,
                  bss_present=bool(block))
            last_per_bss = {row["bssid"]: row for row in native_rows}
            check(name + "-native-ap-metrics", native_load_matches(native_rows, value),
                packets=len(native_rows),
                bssids=len(last_per_bss),
                scope="colocated-agent" if rdk else "remote-agents",
                observed=sorted({str(row["utilization_byte"]) for row in native_rows}))
            if not rdk:
                raw = command("lxc", "exec", ap, "--", "ubus", "call",
                              "Device.WiFi.DataElements.Network.Device.1", "_get",
                              '{"rel_path":"","depth":2}')
                objects = json.JSONDecoder().raw_decode(raw.lstrip())[0]
                (args.output / f"{name}-nbapi.json").write_text(json.dumps(objects) + "\n")
                radio_values = [data["Utilization"] for data in objects.values()
                                if data.get("ID") == bssid and "Utilization" in data]
                check(name + "-colocated-native-nbapi", radio_values == [value],
                      observed=radio_values)
            report["fixtures"].append({"value": value, "beacons": rows})

        start_provider(None, "modeled")
        available, contexts = parse_contexts(context_path.read_text())
        context = next(row for row in contexts if row["frequency_mhz"] == frequency)
        check("native-survey-fresh", available and context["valid"] and
              time.monotonic_ns() // 1000 - context["observed_us"] < 1000000)
        for name, epoch, observed, active, busy in (
            ("old-epoch", context["epoch"] - 1, time.monotonic_ns() // 1000, 1, 0),
            ("stale-provider", context["epoch"], time.monotonic_ns() // 1000 - 2000000, 1, 0),
            ("impossible-busy", context["epoch"], time.monotonic_ns() // 1000, 1, 2),
        ):
            rejected = False
            try:
                context_path.write_text(f"v1 {context['slot']} {epoch} 1 {observed} {active} {busy}\n")
            except OSError:
                rejected = True
            check(name + "-rejected", rejected)

        route = command("lxc", "exec", client_node, "--", "ip", "-4", "route", "show", "dev", "wlan0")
        gateway_match = re.search(r"default via (\S+)", route)
        gateway = gateway_match[1] if gateway_match else "192.168.77.1"
        client_info = command("lxc", "exec", client_node, "--", "iw", "dev", "wlan0", "info")
        traffic_frequency = int(re.search(r"\((\d+) MHz\)", client_info)[1])
        report["traffic_frequency_mhz"] = traffic_frequency
        with ControlClient(socket) as medium:
            idle_start = medium.get_channel_survey(traffic_frequency)
            time.sleep(3)
            idle_end = medium.get_channel_survey(traffic_frequency)
            quiet_start = medium.get_channel_survey(7025)
            with (args.output / "ping.txt").open("w") as output:
                traffic = subprocess.Popen(["lxc", "exec", client_node, "--", "ping",
                    "-I", "wlan0", "-q", "-i", "0.005", "-s", "1200", "-c", "800", gateway],
                    stdout=output, stderr=subprocess.STDOUT)
                try:
                    time.sleep(4)
                    loaded_end = medium.get_channel_survey(traffic_frequency)
                    quiet_end = medium.get_channel_survey(7025)
                    traffic.wait(timeout=15)
                finally:
                    stop_process(traffic)
            def utilization(first, last):
                return 100 * (last["busy_us"] - first["busy_us"]) / (
                    last["observed_us"] - first["observed_us"])
            idle = utilization(idle_start, idle_end)
            loaded = utilization(idle_end, loaded_end)
            check("offered-traffic-delivered", traffic.returncode == 0)
            check("busy-increases-under-load", loaded > idle + 1, idle_percent=idle,
                  loaded_percent=loaded)
            check("no-cross-frequency-leak", quiet_end["busy_us"] == quiet_start["busy_us"])
            check("bounded-qualified-counters", all(sample["flags"] & 1 and
                0 <= sample["busy_us"] <= sample["observed_us"] - sample["start_us"]
                for sample in (idle_start, idle_end, loaded_end)))
            report["medium_samples"] = [idle_start, idle_end, loaded_end]
        original_status = command("lxc", "exec", client_node, "--", "wpa_cli", "-i", "wlan0", "status")
        original_bssid = re.search(r"(?m)^bssid=(\S+)", original_status)[1]
        client_phy = re.search(r"wiphy (\d+)", client_info)[1]
        client_context_path = Path(f"/sys/kernel/debug/ieee80211/phy{client_phy}/hwsim/rf_survey")
        alternate_interface = ("wifi0" if rdk else "wlan0") if traffic_frequency >= 5000 else interface
        alternate_info = command("lxc", "exec", ap, "--", "iw", "dev", alternate_interface, "info")
        alternate_bssid = re.search(r"addr (\S+)", alternate_info)[1]
        alternate_frequency = int(re.search(r"\((\d+) MHz\)", alternate_info)[1])

        def roam(target_bssid, target_frequency):
            scan = scan_for_roam(client_node, target_bssid, target_frequency)
            report.setdefault("retune_scans", []).append(scan)
            result = command("lxc", "exec", client_node, "--", "wpa_cli", "-i", "wlan0",
                             "roam", target_bssid)
            if result.strip() != "OK":
                raise RuntimeError(f"native roam rejected: {result}")
            for attempt in range(40):
                state = command("lxc", "exec", client_node, "--", "wpa_cli", "-i", "wlan0", "status")
                if f"bssid={target_bssid}" in state and "wpa_state=COMPLETED" in state:
                    time.sleep(.3)
                    return parse_contexts(client_context_path.read_text())[1]
                time.sleep(.25)
            raise RuntimeError("native cross-band roam did not complete")

        before_retune = parse_contexts(client_context_path.read_text())[1]
        try:
            retuned = roam(alternate_bssid, alternate_frequency)
            check("native-client-retune-epoch", retuned and before_retune and
                  retuned[0]["epoch"] != before_retune[0]["epoch"] and
                  retuned[0]["frequency_mhz"] == alternate_frequency and retuned[0]["valid"],
                  before=before_retune, after=retuned)
        finally:
            restored = roam(original_bssid, traffic_frequency)
            check("native-client-retune-restored", restored and
                  restored[0]["frequency_mhz"] == traffic_frequency and restored[0]["valid"],
                  restored=restored)
        stop_provider()
        time.sleep(2.5)
        survey = command("lxc", "exec", ap, "--", "iw", "dev", interface, "survey", "dump")
        check("provider-loss-withdraws-survey", not survey.strip())
        rows = capture("provider-lost")
        check("provider-loss-withdraws-bss-load", rows and all(
            row["utilization_byte"] is None for row in rows))
        start_provider(None, "recovered")
        rows = capture("recovered")
        check("provider-recovers-without-ap-restart", rows and all(
            row["utilization_byte"] is not None for row in rows))
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        cleanup = [stop_provider, lambda: command("systemctl", "start", "wmdcfg-survey-bridge")]
        if not monitor_up:
            cleanup.append(lambda: command("ip", "link", "set", "hwsim0", "down"))
        if room_active:
            cleanup.append(lambda: command("systemctl", "start", room))
        for restore in cleanup:
            try:
                restore()
            except Exception as error:
                report.setdefault("cleanup_errors", []).append(str(error))
        report["passed"] = bool(report["checks"]) and not report.get("error") and all(
            check["passed"] for check in report["checks"]) and not report.get("cleanup_errors")
        (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
