from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import time
import urllib.request

from .actuator import ControlClient
from .rf_qualify import MediumRestarter, association_identity, qualification_passed, restore_actions
from .rf_validate import command, scan_for_roam, stop_process


def private_radio(text):
    selected = None
    for block in re.split(r"\bInterface ", text)[1:]:
        name = block.splitlines()[0].strip()
        address = re.search(r"\baddr ([0-9a-f:]{17})", block)
        frequency = re.search(r"\((\d+) MHz\)", block)
        if frequency and 2400 <= int(frequency[1]) < 2500 and re.search(r"\btype managed\s", block):
            raise RuntimeError("2.4 GHz backhaul is active; refusing to isolate that band")
        if (address and frequency and 2400 <= int(frequency[1]) < 2500
                and re.search(r"\bssid private_ssid\s", block)
                and re.search(r"\btype AP\s", block)):
            selected = {"interface": name, "bssid": address[1], "frequency": int(frequency[1])}
    if selected is not None:
        return selected
    raise RuntimeError("no private 2.4 GHz AP; refusing to change another band")


def fixture_links(radios, clients, hidden=False):
    if len(clients) != 2 or len(set(clients)) != 2 or len(radios) < 2:
        raise ValueError("two distinct clients and at least two APs are required")
    if len({radio["radio"] for radio in radios}) != len(radios):
        raise ValueError("AP identities must be distinct")
    frequency = radios[0]["frequency"]
    if any(radio["frequency"] != frequency for radio in radios):
        raise ValueError("APs must share one 2.4 GHz channel")
    values = {}
    for index, station in enumerate(clients):
        for radio in radios:
            strength = 40 if radio == radios[index] else -20
            values[station, radio["radio"]] = strength
            values[radio["radio"], station] = strength
    for left, right in ((clients[0], clients[1]), (radios[0]["radio"], radios[1]["radio"])):
        values[left, right] = values[right, left] = -20
    if hidden:
        values[clients[1], radios[0]["radio"]] = 10
    return [{"source": source, "destination": destination, "frequency_mhz": frequency,
             "value": value} for (source, destination), value in sorted(values.items())]


def compare_trials(trials):
    modes = ("global", "isolated", "hidden_receiver")
    groups = {mode: [trial["aggregate_bps"] for trial in trials if trial["mode"] == mode]
              for mode in modes}
    if any(len(values) != 2 or min(values) <= 0 for values in groups.values()):
        return {"state": "failed", "reason": "two positive trials per profile are required"}
    if not all(trial["same_associations"] and trial["rf_readback"] and trial["survey_valid"]
               and len(trial["received_bps"]) == 2 and min(trial["received_bps"]) > 0
               for trial in trials):
        return {"state": "failed", "reason": "link identity, RF readback or live survey failed"}
    medians = {mode: statistics.median(values) for mode, values in groups.items()}
    spread = {mode: (max(values) - min(values)) / medians[mode] for mode, values in groups.items()}
    reuse = medians["isolated"] / medians["global"]
    hidden = medians["hidden_receiver"] / medians["global"]
    passed = reuse >= 1.25 and .75 <= hidden <= 1.25
    return {"state": "inconclusive" if max(spread.values()) >= .05 else "passed" if passed else "failed",
            "median_aggregate_bps": medians, "range_fraction": spread,
            "isolated_to_global": reuse, "hidden_to_global": hidden,
            "gate": "isolated >=1.25x global; hidden receiver 0.75..1.25x global; spread <5%"}


def net_command(pid, *arguments, **options):
    return command("nsenter", "-t", str(pid), "-n", *arguments, **options)


def diagnostic_sample(processes, nodes, client_nodes, radios, station_macs, console_port, instance, generation):
    sample = {"sampled_at": time.time()}
    sample["clients"] = {node: net_command(processes[node], "iw", "dev", "wlan0", "station", "dump")
                         for node in client_nodes}
    sample["aps"] = {node: net_command(processes[node], "iw", "dev", radio["interface"],
                                      "station", "get", station_mac)
                     for node, radio, station_mac in zip(nodes, radios, station_macs)}
    sample["tcp"] = {node: net_command(processes[node], "ss", "-tin", "dport = :55203")
                     for node in client_nodes}
    with urllib.request.urlopen(f"http://127.0.0.1:{console_port}/api/v1/snapshot", timeout=3) as response:
        medium = json.load(response)
    sample["medium"] = {key: medium.get(key) for key in (
        "captured_at", "daemon", "packet_metrics", "radio_frequencies")}
    sample["medium_current"] = (medium.get("daemon", {}).get("instance_id") == instance
                                and medium.get("daemon", {}).get("generation") == generation)
    return sample


def registered_radio(node, interface, registered):
    info = command("lxc", "exec", node, "--", "iw", "dev", interface, "info")
    phy = re.search(r"\bwiphy (\d+)", info)
    if phy is None:
        raise RuntimeError("interface has no physical radio identity")
    aliases = command("lxc", "exec", node, "--", "cat",
                      f"/sys/class/ieee80211/phy{phy[1]}/addresses").split()
    matches = set(aliases) & registered
    if len(matches) != 1:
        raise RuntimeError(f"{node}/{interface} has no unique provisioned medium radio")
    return matches.pop()


def roam_client(node, bssid, frequency):
    def identity():
        return association_identity(command("lxc", "exec", node, "--", "iw", "dev", "wlan0", "link"))
    if identity() == (bssid, frequency):
        return
    scan_for_roam(node, bssid, frequency)
    result = command("lxc", "exec", node, "--", "wpa_cli", "-i", "wlan0", "roam", bssid).strip()
    if result != "OK":
        raise RuntimeError(f"native roam rejected: {result}")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if identity() == (bssid, frequency):
            return
        time.sleep(.2)
    raise RuntimeError(f"{node} did not associate with {bssid} on {frequency}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Bounded two-flow native WLAN spatial-reservation qualification")
    parser.add_argument("--stack", choices=("rdk", "prplmesh"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=12)
    parser.add_argument("--diagnostics", action="store_true")
    parser.add_argument("--daemon", type=Path)
    parser.add_argument("--yes-change-lab", action="store_true")
    args = parser.parse_args(argv)
    if os.geteuid() or not args.yes_change_lab or not 8 <= args.seconds <= 20:
        parser.error("requires root, --yes-change-lab and 8..20 seconds per trial")
    with urllib.request.urlopen("http://127.0.0.1:8891/api/demo/interactions", timeout=5) as response:
        interaction = json.load(response)
    if interaction["lease"]["held"] or interaction["recording"]["active"]:
        raise RuntimeError("room is leased or recording; refusing maintenance")
    if interaction["playback"]["status"] != "paused" or interaction["playback"]["time_ms"] != 0:
        raise RuntimeError("reset and pause the room before qualification")
    if (interaction["selected_world"] != "home-five-agent--private-client-room-walk"
            or interaction["expected_online_clients"] != 20 or interaction["playback"]["manual_roles"]):
        raise RuntimeError("load the untouched default 20-client room before qualification")
    rdk = args.stack == "rdk"
    nodes = ["bpibroadband", "bpiap", "bpiap-001", "bpiap-002", "bpiap-003"] if rdk else [
        "prpl-controller", "prpl-agent-01", "prpl-agent-02", "prpl-agent-03", "prpl-agent-04"]
    client_nodes = ["wlan-client", "wlan-client-001"] if rdk else ["prpl-client-01", "prpl-client-03"]
    targets = ["10.0.0.1" if rdk else "192.168.77.1", "10.254.91.2"]
    room = "easymesh-room-demo" if rdk else "prplmesh-room-demo"
    bridge = "wmdcfg-survey-bridge"
    command("systemctl", "is-active", "--quiet", room, bridge)
    command("iperf3", "--version")
    medium = MediumRestarter(args.stack, args.daemon.resolve() if args.daemon else None)
    if "-F" in medium.original_args or "-S" in medium.original_args:
        raise RuntimeError("qualification requires the normal global survey-enabled profile")
    registered = {item[field] for item in medium.links + medium.frequencies for field in ("source", "destination")}
    radios = [private_radio(command("lxc", "exec", node, "--", "iw", "dev")) for node in nodes]
    for node, radio in zip(nodes, radios):
        radio["radio"] = registered_radio(node, radio["interface"], registered)
    processes = {node: json.loads(command("lxc", "query", f"/1.0/instances/{node}/state"))["pid"]
                 for node in nodes[:2] + client_nodes}
    clients = []
    originals = []
    addresses = []
    station_macs = []
    for node in client_nodes:
        link = command("lxc", "exec", node, "--", "iw", "dev", "wlan0", "link")
        identity = association_identity(link)
        if identity is None or not re.search(r"\bSSID: private_ssid\s", link):
            raise RuntimeError(f"{node} is not an associated private client")
        originals.append(identity)
        station_macs.append(json.loads(net_command(processes[node], "ip", "-j", "link", "show", "wlan0"))[0]["address"])
        clients.append(registered_radio(node, "wlan0", registered))
        addresses.append(next(item["local"] for item in json.loads(net_command(
            processes[node], "ip", "-j", "-4", "addr", "show", "wlan0"))[0]["addr_info"]
            if item["scope"] == "global"))
    fixture_links(radios, clients)
    args.output.mkdir(parents=True, exist_ok=False)
    report = {"stack": args.stack, "seconds_per_trial": args.seconds, "started_at": time.time(),
              "driver_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "medium_sha256": hashlib.sha256(Path(medium.args[0]).read_bytes()).hexdigest(),
              "original_medium_sha256": hashlib.sha256(Path(medium.original_args[0]).read_bytes()).hexdigest(),
              "scope": "legacy20 conservative reservations, not hidden-node collisions or calibrated capacity",
              "physical_capacity_qualified": False, "interference_model_qualified": False,
              "diagnostics_enabled": args.diagnostics,
              "trials": [], "radios": radios, "clients": clients, "station_macs": station_macs,
              "original_associations": originals, "traffic_targets": targets}
    cleanup = []
    servers = []
    traffic = []
    stopped = False
    restarted = False

    def current_identities():
        return [association_identity(command("lxc", "exec", node, "--", "iw", "dev", "wlan0", "link"))
                for node in client_nodes]

    def restore_associations():
        for node, (bssid, frequency) in zip(client_nodes, originals):
            roam_client(node, bssid, frequency)
        if current_identities() != originals:
            raise RuntimeError("original client associations were not restored")

    try:
        stopped = True
        command("systemctl", "stop", room, timeout=180)
        for index, node in enumerate(nodes[:2]):
            target = targets[index]
            client_node = client_nodes[index]
            ap_pid, client_pid = processes[node], processes[client_node]
            existing = net_command(ap_pid, "ip", "-j", "addr")
            if (index != 0 and target in existing) or net_command(client_pid, "ip", "route", "show", "exact", target + "/32").strip():
                raise RuntimeError("qualification address or route already exists")
            interface = radios[index]["interface"]
            master = json.loads(net_command(ap_pid, "ip", "-j", "link", "show", interface))[0].get("master", interface)
            if index == 0:
                local = json.loads(net_command(ap_pid, "ip", "-j", "-4", "addr", "show", master))[0]["addr_info"]
                if not any(item["local"] == target and item["prefixlen"] < 32 for item in local):
                    raise RuntimeError("gateway LAN address is absent from the private bridge")
            else:
                net_command(ap_pid, "ip", "addr", "add", target + "/32", "dev", master)
                cleanup.append(("AP test address", lambda pid=ap_pid, address=target, device=master:
                                net_command(pid, "ip", "addr", "del", address + "/32", "dev", device)))
            net_command(client_pid, "ip", "route", "add", target + "/32", "dev", "wlan0", "src", addresses[index])
            cleanup.append(("client test route", lambda pid=client_pid, address=target:
                            net_command(pid, "ip", "route", "del", address + "/32", "dev", "wlan0")))
            if net_command(ap_pid, "ip", "route", "show", "exact", addresses[index] + "/32").strip():
                raise RuntimeError("AP already has a client host route; refusing to replace it")
            net_command(ap_pid, "ip", "route", "add", addresses[index] + "/32", "dev", master, "src", target)
            cleanup.append(("AP client route", lambda pid=ap_pid, address=addresses[index], device=master:
                            net_command(pid, "ip", "route", "del", address + "/32", "dev", device)))
            if rdk and index == 0:
                rule = ["-i", master, "-s", addresses[index] + "/32", "-d", target + "/32",
                        "-p", "tcp", "--dport", "55203", "-j", "ACCEPT"]
                command("lxc", "exec", node, "--", "iptables", "-I", "INPUT", *rule)
                cleanup.append(("gateway traffic rule", lambda owner=node, specification=rule:
                                command("lxc", "exec", owner, "--", "iptables", "-D", "INPUT", *specification)))
        expected = [(radio["bssid"], radio["frequency"]) for radio in radios[:2]]
        for mode in ("global", "isolated", "hidden_receiver", "hidden_receiver", "isolated", "global"):
            trial_index = len(report["trials"])
            command("systemctl", "stop", bridge)
            restarted = True
            medium.restart(args.output, [] if mode == "global" else ["-F"])
            updates = fixture_links(radios, clients, hidden=mode == "hidden_receiver")
            with ControlClient(medium.socket) as control:
                status = control.status()
                generation = status.generation + 1
                control.apply_frequency(generation, updates)
                readback = all(control.get_frequency_link(item["source"], item["destination"],
                               item["frequency_mhz"])[1] == item["value"] for item in updates)
            command("systemctl", "start", bridge)
            for node, (bssid, frequency) in zip(client_nodes, expected):
                roam_client(node, bssid, frequency)
            before = current_identities()
            if before != expected:
                raise RuntimeError("clients did not reach the two intended APs")
            logs = []
            try:
                diagnostic_log = (args.output / f"{trial_index}-diagnostics.jsonl").open("w") if args.diagnostics else None
                if diagnostic_log is not None:
                    logs.append(diagnostic_log)
                for index, node in enumerate(nodes[:2]):
                    output = (args.output / f"{trial_index}-server-{index}.json").open("w")
                    logs.append(output)
                    servers.append(subprocess.Popen(["nsenter", "-t", str(processes[node]), "-n",
                        "iperf3", "-s", "-1", "-B", targets[index], "-p", "55203", "-J"],
                        stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT))
                time.sleep(.3)
                for index, node in enumerate(client_nodes):
                    output = (args.output / f"{trial_index}-client-{index}.json").open("w")
                    logs.append(output)
                    traffic.append(subprocess.Popen(["nsenter", "-t", str(processes[node]), "-n",
                        "iperf3", "-c", targets[index], "-B", addresses[index],
                        "-p", "55203", "-t", str(args.seconds), "-O", "1", "-J", "--connect-timeout", "3000"],
                        stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT))
                samples = []
                diagnostics = []
                next_diagnostic = 0
                contexts = [(radio["radio"], radio["frequency"]) for radio in radios[:2]]
                deadline = time.monotonic() + args.seconds + 15
                with ControlClient(medium.socket) as control:
                    while any(process.poll() is None for process in traffic) and time.monotonic() < deadline:
                        surveys = control.get_observer_surveys(contexts)
                        samples.append({str(key): value for key, value in surveys.items()})
                        if args.diagnostics and time.monotonic() >= next_diagnostic:
                            detail = diagnostic_sample(processes, nodes[:2], client_nodes, radios[:2], station_macs,
                                                       8890 if rdk else 8090, status.instance_id, generation)
                            diagnostics.append(detail)
                            diagnostic_log.write(json.dumps(detail) + "\n")
                            diagnostic_log.flush()
                            next_diagnostic = time.monotonic() + 1
                        time.sleep(.5)
                for process in traffic + servers:
                    if process.wait(timeout=5) != 0:
                        raise RuntimeError("native traffic process failed; raw output retained")
            finally:
                for process in traffic + servers:
                    stop_process(process)
                traffic.clear()
                servers.clear()
                for output in logs:
                    output.close()
            received = [json.loads((args.output / f"{trial_index}-client-{index}.json").read_text())
                        ["end"]["sum_received"]["bits_per_second"] for index in range(2)]
            trial = {"mode": mode, "received_bps": received, "aggregate_bps": sum(received),
                     "instance_id": status.instance_id, "generation": generation,
                     "same_associations": before == current_identities() == expected, "rf_readback": readback,
                     "survey_valid": all(any((sample[str(context)]["flags"] & 1) and
                         sample[str(context)]["busy_us"] > 0 and sample[str(context)]["overruns"] == 0
                         for sample in samples) for context in contexts), "surveys": samples,
                     "diagnostics": diagnostics}
            report["trials"].append(trial)
            print(json.dumps({key: value for key, value in trial.items()
                              if key not in ("surveys", "diagnostics")}), flush=True)
        report["comparison"] = compare_trials(report["trials"])
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        actions = [("traffic", lambda: [stop_process(process) for process in traffic + servers])]
        actions.extend(reversed(cleanup))
        if restarted:
            actions.extend([("stop bridge", lambda: command("systemctl", "stop", bridge)),
                            ("original medium", lambda: medium.restart(args.output, original=True)),
                            ("original associations", restore_associations)])
        if stopped:
            actions.extend([("normal bridge", lambda: command("systemctl", "start", bridge)),
                            ("normal room", lambda: command("systemctl", "start", room))])
        report["cleanup_errors"] = restore_actions(actions)
        report["restored"] = not report["cleanup_errors"]
        report["finished_at"] = time.time()
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "trials"}))
    return 0 if qualification_passed(report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
