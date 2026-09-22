import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


HERE = Path(__file__).resolve().parent
GEN = HERE.parent.parent
sys.path[:0] = [str(GEN / "demo"), str(GEN / "optimizer"), str(GEN / "wmediumd/configurator")]


def run(*command, timeout=300, **kwargs):
    return subprocess.run(command, check=True, timeout=timeout, **kwargs)


def service_state(unit, operation):
    return subprocess.run(["systemctl", operation, "--quiet", unit], timeout=10).returncode == 0


def main():
    parser = argparse.ArgumentParser(description="Activate updated NG/room/medium sources inside an existing RDK VM; interrupts RF, never rebuilds containers")
    parser.add_argument("--restart-medium", action="store_true", help="required acknowledgement: restart medium and reload the default room")
    parser.add_argument("--reset-room", action="store_true", help="explicitly archive a failed/contaminated room journal after replacing the medium and reconnecting its clients")
    args = parser.parse_args()
    if not args.restart_medium:
        parser.error("--restart-medium is required; this is a maintenance operation")
    if os.geteuid() != 0:
        parser.error("run inside the lab VM as root")
    from room_demo.client_wifi import parallel_reconnections, reconnect_client
    from room_demo.recovery import load_recovery
    from wmdcfg.actuator import ControlClient

    for binary in (HERE / "wmediumd-console", HERE.parent / "wmediumd.patched"):
        if not os.access(binary, os.X_OK):
            raise RuntimeError(f"missing executable: {binary}")
    pid = int(Path("/run/meta-cmf-wmediumd/wmediumd.pid").read_text())
    argv = Path(f"/proc/{pid}/cmdline").read_bytes().decode().strip("\0").split("\0")
    if Path(argv[0]).resolve() != HERE.parent / "wmediumd.patched":
        raise RuntimeError("activate from the running lab checkout; refusing to replace another medium")
    expected_paths = {"-c": "/run/meta-cmf-wmediumd/wmediumd.cfg", "-C": "/run/wmediumd-control.sock",
                      "-R": "/run/meta-cmf-wmediumd/metrics/control.sock", "-O": "/run/meta-cmf-wmediumd/observer/telemetry.sock"}
    flags = iter(argv[1:])
    for flag in flags:
        if flag in ("-F", "-Q"):
            continue
        if flag not in expected_paths or next(flags, None) != expected_paths[flag]:
            raise RuntimeError(f"nonstandard daemon option {flag}; preserve it using a manual maintenance upgrade")
    recovery = Path("/run/easymesh-room-demo/recovery.json")

    def journal():
        record = load_recovery(recovery) if recovery.exists() else {}
        if record.get("client_networks"):
            raise RuntimeError("restore the room's saved client band profiles before activating NG")
        if record.get("state") in ("contaminated", "failed") and not args.reset_room:
            raise RuntimeError("room recovery needs operator review; --reset-room explicitly replaces this RF session, preserving evidence")
        return record

    journal()
    with open("/run/easymesh-lab-runtime.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = Path("/var/lib/wmediumd-console/upgrades") / f"{stamp}-{os.getpid()}"
        backup.mkdir(parents=True, mode=0o700)
        shutil.copy2(f"/proc/{pid}/exe", backup / "wmediumd.previous")
        for source, name in ((Path("/usr/local/bin/wmediumd-console"), "console-binary.before"),
                             (Path("/etc/default/wmediumd-console"), "console-default.before"),
                             (Path("/run/meta-cmf-wmediumd/wmediumd.cfg"), "wmediumd.cfg.before"),
                             (recovery, "recovery.before.json")):
            if source.exists():
                shutil.copy2(source, backup / name)
        room_enabled = service_state("easymesh-room-demo.service", "is-enabled")
        room_active = service_state("easymesh-room-demo.service", "is-active")
        environment = dict(os.environ, WMEDIUMD_PRIORITY_QUEUES="1" if "-Q" in argv else "0",
                           WMEDIUMD_VISIBILITY_CONTENTION="1" if "-F" in argv else "0",
                           WMEDIUMD_CPU_AFFINITY=",".join(map(str, sorted(os.sched_getaffinity(pid)))))
        with ControlClient("/run/meta-cmf-wmediumd/metrics/control.sock") as client:
            old_instance = client.instance_id
        receipt = {"old_instance": old_instance, "old_argv": argv, "reset_room": args.reset_room,
                   "room_enabled": room_enabled, "room_active": room_active, "complete": False}
        (backup / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(f"Maintenance backup: {backup}", flush=True)
        try:
            run("systemctl", "stop", "easymesh-room-demo.service")
            record = journal()
            if recovery.exists():
                shutil.copy2(recovery, backup / "recovery.after-stop.json")
            run("systemctl", "stop", "wmediumd-console.service", "wmdcfg-survey-bridge.service")
            run("bash", str(HERE / "install.sh"))
            run("bash", str(HERE.parent / "wmediumd-up.sh"), "up", env=environment)
            with ControlClient("/run/meta-cmf-wmediumd/metrics/control.sock") as client:
                new_instance = client.instance_id
            if new_instance == old_instance:
                raise RuntimeError("medium instance did not change; leaving recovery evidence untouched")
            inventory = json.loads(Path("/run/meta-cmf-wmediumd/identity-inventory.json").read_text())
            owners = {row["owner"] for row in inventory["stations"] if row.get("role") in ("wlan-client", "iot-client")}
            paused = record.get("paused_clients", [])
            if not set(paused).issubset(owners):
                raise RuntimeError("recovery clients do not match the new radio inventory")
            parallel_reconnections(reconnect_client, paused)
            if recovery.exists():
                shutil.move(str(recovery), str(backup / "recovery.archived.json"))
            run("systemctl", "enable", "wmediumd-console.service")
            run("systemctl", "restart", "wmdcfg-survey-bridge.service", "wmediumd-console.service")
            if room_enabled or room_active:
                run("systemctl", "reset-failed", "easymesh-room-demo.service")
                run("systemctl", "start", "easymesh-room-demo.service")
            checks = [sys.executable, str(HERE / "check-ready.py"), "--require-survey", "--timeout", "180"]
            if room_enabled or room_active:
                checks.append("--require-room")
            run(*checks, timeout=190)
            receipt.update(new_instance=new_instance, complete=True)
            (backup / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print("Console NG, medium telemetry and configured sources are ready. No VM/container rebuild was performed.")
        except BaseException:
            print(f"Activation incomplete; recovery and previous binaries are preserved at {backup}. Do not discard the journal or bypass its ownership checks.", file=sys.stderr)
            raise


if __name__ == "__main__":
    main()
