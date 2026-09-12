from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import statistics
import subprocess
import time

from .actuator import ControlClient
from .rf_validate import command, stop_process


def association_identity(value):
    address = re.search(r"^Connected to ([0-9a-f:]{17}) ", value, re.MULTILINE)
    frequency = re.search(r"^\s*freq: (\d+)(?:\.0+)?$", value, re.MULTILINE)
    return (address[1], int(frequency[1])) if address and frequency else None


def restore_actions(actions):
    errors = []
    for name, action in actions:
        try:
            action()
        except Exception as error:
            errors.append(f"{name}: {type(error).__name__}: {error}")
    return errors


def comparison(trials):
    groups = {mode: [row["bits_per_second"] for row in trials if row["mode"] == mode]
              for mode in ("on", "off")}
    if any(len(values) < 2 or min(values) <= 0 for values in groups.values()):
        return {"state": "incomplete"}
    medians = {mode: statistics.median(values) for mode, values in groups.items()}
    variability = {mode: (max(values) - min(values)) / medians[mode] for mode, values in groups.items()}
    overhead = 100 * (medians["off"] - medians["on"]) / medians["off"]
    return {"state": "inconclusive" if max(variability.values()) >= .05 else
            "passed" if overhead < 5 else "failed",
            "median_bits_per_second": medians, "range_fraction": variability,
            "observed_overhead_percent": overhead}


def qualification_passed(report):
    return (bool(report.get("restored")) and not report.get("error")
            and report.get("comparison", {}).get("state") == "passed")


class SystemdMedium:
    def __init__(self, unit, pid):
        self.unit = unit
        self.pid = pid

    def poll(self):
        try:
            state = Path(f"/proc/{self.pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
            return 0 if state == "Z" else None
        except FileNotFoundError:
            return 0

    def send_signal(self, stop_signal):
        command("systemctl", "kill", "--kill-whom=main",
                f"--signal={int(stop_signal)}", self.unit)

    def kill(self):
        self.send_signal(signal.SIGKILL)

    def wait(self, timeout):
        deadline = time.monotonic() + timeout
        while self.poll() is None:
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(self.unit, timeout)
            time.sleep(.05)
        return 0


def launch_medium(arguments, log, affinity, priority, working_directory):
    unit = f"wmdcfg-medium-{os.getpid()}-{time.monotonic_ns()}.service"
    command("systemd-run", "--quiet", "--collect", "--service-type=exec", "--unit", unit,
            f"--property=StandardOutput=append:{log}", "--property=StandardError=inherit",
            f"--property=CPUAffinity={' '.join(map(str, sorted(affinity)))}",
            f"--property=Nice={priority}", f"--property=WorkingDirectory={working_directory}",
            "--", *arguments)
    pid = int(command("systemctl", "show", "--property=MainPID", "--value", unit))
    if pid <= 0:
        raise RuntimeError(f"managed medium failed to start: {unit}")
    return SystemdMedium(unit, pid)


class MediumRestarter:
    def __init__(self, stack, replacement=None):
        rdk = stack == "rdk"
        self.directory = Path("/run/meta-cmf-wmediumd" if rdk else "/run/prpl-wmediumd")
        self.manifest = self.directory / "wmediumd-binary.sha256"
        self.pidfile = self.directory / "wmediumd.pid"
        self.socket = "/run/wmediumd-control.sock" if rdk else "/run/prpl-wmediumd/control.sock"
        pid, expected_hash, expected_path = self.manifest.read_text().strip().split(maxsplit=2)
        self.pid = int(pid)
        self.original_args = Path(f"/proc/{self.pid}/cmdline").read_bytes().decode().strip("\0").split("\0")
        running_hash = hashlib.sha256(Path(f"/proc/{self.pid}/exe").read_bytes()).hexdigest()
        if (int(self.pidfile.read_text()) != self.pid or
                self.original_args[0] != expected_path or running_hash != expected_hash):
            raise RuntimeError("running medium does not match its PID/binary manifest; refusing to stop it")
        self.affinity = os.sched_getaffinity(self.pid)
        self.priority = os.getpriority(os.PRIO_PROCESS, self.pid)
        self.working_directory = Path(f"/proc/{self.pid}/cwd").resolve()
        self.args = self.original_args.copy()
        if replacement:
            self.args[0] = str(replacement)
        self.permissions = {}
        for option in ("-C", "-R", "-O"):
            path = Path(self.args[self.args.index(option) + 1])
            info = path.stat()
            self.permissions[path] = (info.st_mode & 0o777, info.st_uid, info.st_gid)
        self.process = None
        self.log = None
        with ControlClient(self.socket) as client:
            self.links = client.dump_links()[1]
            self.frequencies = client.dump_frequency_links()[1]

    def restart(self, directory, flags=(), original=False):
        snapshot = directory / "original-medium.json"
        if not snapshot.exists():
            snapshot.write_text(json.dumps({
                "arguments": self.original_args, "links": self.links,
                "frequencies": self.frequencies,
                "cpu_affinity": sorted(self.affinity), "nice": self.priority,
                "working_directory": str(self.working_directory),
            }, indent=2) + "\n")
        if self.process:
            stop_process(self.process)
            self.process = None
        else:
            os.kill(self.pid, signal.SIGTERM)
            for attempt in range(100):
                try:
                    if Path(f"/proc/{self.pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z":
                        break
                except FileNotFoundError:
                    break
                time.sleep(.05)
            else:
                raise RuntimeError("old medium did not exit")
        if self.log:
            self.log.close()
        self.log = (directory / f"medium-{time.monotonic_ns()}.log").open("w")
        arguments = list(self.original_args if original else self.args) + list(flags)
        self.process = launch_medium(arguments, self.log.name, self.affinity,
                                     self.priority, self.working_directory)
        self.pid = self.process.pid
        last_error = None
        for attempt in range(100):
            if self.process.poll() is not None:
                raise RuntimeError("replacement medium exited")
            try:
                with ControlClient(self.socket) as client:
                    client.apply(client.status().generation + 1, self.links)
                    if self.frequencies:
                        client.apply_frequency(client.status().generation + 1, self.frequencies)
                    if client.dump_links()[1] != self.links or client.dump_frequency_links()[1] != self.frequencies:
                        raise RuntimeError("medium RF restoration differs from captured state")
                break
            except (OSError, RuntimeError) as error:
                last_error = error
                time.sleep(.1)
        else:
            raise RuntimeError(f"medium socket/RF restoration deadline exceeded: {last_error}")
        for path, (mode, owner, group) in self.permissions.items():
            os.chmod(path, mode)
            os.chown(path, owner, group)
        digest = hashlib.sha256(Path(arguments[0]).read_bytes()).hexdigest()
        self.pidfile.write_text(str(self.pid) + "\n")
        self.manifest.write_text(f"{self.pid}\t{digest}\t{arguments[0]}\n")
        time.sleep(3)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Short disruptive native WLAN observer A/B qualification")
    parser.add_argument("--stack", choices=("rdk", "prplmesh"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=int, default=8)
    parser.add_argument("--medium", type=Path)
    parser.add_argument("--visibility", action="store_true")
    parser.add_argument("--yes-change-lab", action="store_true")
    args = parser.parse_args(argv)
    if os.geteuid() or not args.yes_change_lab or not 3 <= args.seconds <= 30:
        parser.error("requires root, --yes-change-lab, and 3..30 seconds")
    if args.visibility and not args.medium:
        parser.error("--visibility requires --medium")
    rdk = args.stack == "rdk"
    client = "wlan-client" if rdk else "prpl-client-01"
    ap = "bpibroadband" if rdk else "prpl-controller"
    room = "easymesh-room-demo" if rdk else "prplmesh-room-demo"
    bridge = "wmdcfg-survey-bridge"
    args.output.mkdir(parents=True, exist_ok=False)
    room_active = subprocess.run(["systemctl", "is-active", "--quiet", room]).returncode == 0
    command("systemctl", "is-active", "--quiet", bridge)
    processes = {}
    for role, container in (("ap", ap), ("client", client)):
        processes[role] = json.loads(command("lxc", "query", f"/1.0/instances/{container}/state"))["pid"]
    route = command("nsenter", "-t", str(processes["client"]), "-n",
                    "ip", "-j", "-4", "address", "show", "dev", "wlan0")
    addresses = json.loads(route)[0]["addr_info"]
    client_ip = next(address["local"] for address in addresses if address["family"] == "inet")
    gateway = "10.0.0.1" if rdk else "192.168.77.1"
    report = {"stack": args.stack, "seconds_per_trial": args.seconds,
              "scope": "full modeled survey path" if args.medium else "bridge only; medium counters remain enabled",
              "profile": "visibility-reservation-legacy20" if args.visibility else "single-contention-domain-legacy20",
              "trials": [], "physical_capacity_qualified": False}
    medium = None
    server = None
    try:
        if room_active:
            command("systemctl", "stop", room, timeout=180)
        if args.medium:
            medium = MediumRestarter(args.stack, args.medium)
        for mode in ("on", "off", "off", "on"):
            command("systemctl", "stop", bridge)
            if medium:
                medium.restart(args.output, (["-F"] if args.visibility else []) + (["-S"] if mode == "off" else []))
            if mode == "on":
                command("systemctl", "start", bridge)
            else:
                Path("/sys/module/mac80211_hwsim/parameters/survey_cache").write_text("N\n")
            time.sleep(3)
            association = command("lxc", "exec", client, "--", "iw", "dev", "wlan0", "link")
            with (args.output / f"server-{len(report['trials'])}.json").open("w") as output:
                server = subprocess.Popen(
                    ["nsenter", "-t", str(processes["ap"]), "-n", "iperf3", "-s", "-1",
                     "-B", gateway, "-p", "55201", "-J"], stdin=subprocess.DEVNULL,
                    stdout=output, stderr=subprocess.STDOUT)
                time.sleep(.3)
                raw = command("nsenter", "-t", str(processes["client"]), "-n", "iperf3",
                              "-c", gateway, "-B", client_ip, "-p", "55201", "-t", str(args.seconds),
                              "-O", "1", "-J", timeout=args.seconds + 15)
                server.wait(timeout=5)
                server = None
            result = json.loads(raw)
            final_association = command("lxc", "exec", client, "--", "iw", "dev", "wlan0", "link")
            identity = association_identity(association)
            same_link = identity is not None and identity == association_identity(final_association)
            trial = {"mode": mode, "bits_per_second": result["end"]["sum_received"]["bits_per_second"],
                     "same_association": same_link, "association": association,
                     "final_association": final_association, "iperf": result}
            report["trials"].append(trial)
            print(json.dumps({key: value for key, value in trial.items() if key != "iperf"}), flush=True)
        report["comparison"] = comparison(report["trials"])
        identities = {association_identity(trial["association"]) for trial in report["trials"]}
        if not all(trial["same_association"] for trial in report["trials"]) or len(identities) != 1:
            report["comparison"]["state"] = "inconclusive"
            report["comparison"]["reason"] = "association or frequency changed during qualification"
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        actions = [("traffic server", lambda: stop_process(server))]
        if medium:
            actions.extend([
                ("stop bridge", lambda: command("systemctl", "stop", bridge)),
                ("original medium", lambda: medium.restart(args.output, original=True)),
            ])
        actions.append(("normal bridge", lambda: command("systemctl", "start", bridge)))
        if room_active:
            actions.append(("normal room", lambda: command("systemctl", "start", room)))
        report["cleanup_errors"] = restore_actions(actions)
        report["restored"] = not report["cleanup_errors"]
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "trials"}))
    return 0 if qualification_passed(report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
