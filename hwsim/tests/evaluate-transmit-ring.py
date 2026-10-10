#!/usr/bin/env python3
"""The transmit ring (hwsim 0012) against the stock pending queue, two radios, one load.

Run as root in an isolated Linux 7.0 VM: the script owns two temporary hwsim radios, one
network namespace and the wmediumd it starts; never over an active lab. Each module (the
stock series, --stock-module, then 0012's, --module, with a small ring) carries a UDP load
(eight streams, 32 Mbit/s) far above a link forced to 6 Mbit/s, pings alongside, in three
phases:

  overload  the ring full for its duration: 0012 stops and wakes the queues and drops
            nothing at the ring (d_tx_dropped), the stock queue drops 101 at a time
  killed    wmediumd killed under the load: the radio on the perfect medium again, the
            first ping through within a quarter of the timeout and a margin (0012: the
            frames sent to the dead medium expired)
  frozen    (0012) wmediumd stopped (SIGSTOP) under the load for three timeouts: its frames
            expire, then SIGCONT, a ping through within a few seconds

and neither module may warn in the kernel log, both unload. The result is JSON; the exit
status is 0 when every check of 0012 passed.
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


RADIO_A = "42:00:00:00:00:00"
RADIO_B = "42:00:00:00:01:00"
MEDIUM_NAME = "wmediumd"    # cleanup stops only processes of this name (--wmediumd's)


def run(*args: str, check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=check, text=True, **kwargs)


def quiet(*args: str) -> None:
    run(*args, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cleanup() -> None:
    quiet("pkill", "-CONT", "-x", MEDIUM_NAME)
    quiet("pkill", "-x", "iperf3")
    quiet("pkill", "-x", MEDIUM_NAME)
    quiet("ip", "netns", "del", "ringsta")
    quiet("modprobe", "-r", "mac80211_hwsim")


def load_module(module: Path, limit: int, timeout_ms: int) -> None:
    cleanup()
    run("modprobe", "mac80211")
    arguments = ["insmod", str(module), "radios=2", "channels=3", "regtest=5"]
    if limit:
        arguments += [f"pending_limit={limit}", f"pending_timeout_ms={timeout_ms}"]
    run(*arguments)


def start_wmediumd(binary: Path, directory: Path, name: str) -> tuple[subprocess.Popen, Path]:
    config = directory / "two-radio.cfg"
    control = directory / f"{name}.sock"
    log = directory / f"{name}.log"
    config.write_text(
        'ifaces : { ids = [\n'
        f'  "{RADIO_A}",\n  "{RADIO_B}"\n'
        ']; };\nmodel : { type = "snr"; default_snr = 41; };\n'
    )
    stream = log.open("w")
    process = subprocess.Popen(
        [str(binary), "-l", "5", "-c", str(config), "-C", str(control)],
        stdout=stream, stderr=subprocess.STDOUT, text=True,
    )
    for _ in range(100):
        if process.poll() is not None:
            stream.close()
            raise RuntimeError(f"wmediumd exited during registration: {log.read_text()}")
        if control.exists():
            return process, log
        time.sleep(0.05)
    process.kill()
    process.wait(timeout=3)
    stream.close()
    raise RuntimeError("wmediumd control socket did not appear")


def setup_ibss() -> None:
    station_phy = Path("/sys/class/net/wlan1/phy80211").resolve().name
    run("ip", "link", "set", "wlan0", "down")
    run("iw", "wlan0", "set", "type", "ibss")
    run("ip", "link", "set", "wlan0", "up")
    # an OFDM basic rate set: the link forced to 6 Mbit/s below keeps a basic rate
    run("iw", "wlan0", "ibss", "join", "ringtest", "2412", "fixed-freq",
        "basic-rates", "6", "mcast-rate", "6")
    # the host's IBSS formed first: the station's scan finds it and joins (two radios
    # scanning at once each create their own, and mac80211 merges them 30 s later)
    deadline = time.monotonic() + 20
    while "Joined IBSS" not in run("iw", "dev", "wlan0", "link", check=False,
                                   capture_output=True).stdout:
        if time.monotonic() > deadline:
            raise RuntimeError("host IBSS did not form")
        time.sleep(0.2)
    run("ip", "netns", "add", "ringsta")
    run("iw", "phy", station_phy, "set", "netns", "name", "ringsta")
    run("ip", "netns", "exec", "ringsta", "bash", "-c",
        "ip link set lo up; ip link set wlan1 down; iw wlan1 set type ibss; "
        "ip link set wlan1 up; "
        "iw wlan1 ibss join ringtest 2412 fixed-freq basic-rates 6 mcast-rate 6; "
        "ip addr replace 10.98.0.2/24 dev wlan1")
    run("ip", "addr", "replace", "10.98.0.1/24", "dev", "wlan0")
    if first_ping(12.0) is None:
        raise RuntimeError("two-radio IBSS did not become reachable")
    rate = "6"
    run("iw", "dev", "wlan0", "set", "bitrates", "legacy-2.4", rate)
    run("ip", "netns", "exec", "ringsta", "iw", "dev", "wlan1", "set", "bitrates",
        "legacy-2.4", rate)


def first_ping(within: float) -> float | None:
    """Seconds to the first ping answered, None if none within the time given."""
    start = time.monotonic()
    while time.monotonic() - start < within:
        probe = run("ping", "-I", "10.98.0.1", "-c", "1", "-W", "1", "10.98.0.2",
                    check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            return round(time.monotonic() - start, 2)
    return None


def stats() -> dict[str, int]:
    output = run("ethtool", "-S", "wlan0", capture_output=True).stdout
    values = {}
    for line in output.splitlines():
        match = re.match(r"\s*(\S+):\s*(\d+)$", line)
        if match:
            values[match.group(1)] = int(match.group(2))
    return values


def delta(before: dict[str, int], after: dict[str, int], name: str) -> int | None:
    if name not in after:
        return None
    return after[name] - before.get(name, 0)


def load(duration: int) -> tuple[subprocess.Popen, subprocess.Popen]:
    """A UDP load of 32 Mbit/s for the duration, from wlan0 to the station: eight streams,
    as one socket's send buffer (about 150 frames in flight) would hold one back below
    the stock queue's 200, where the lab's forwarded traffic has no socket to hold it."""
    server = subprocess.Popen(
        ["ip", "netns", "exec", "ringsta", "iperf3", "-s", "-1"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 5
    while ":5201 " not in run("ip", "netns", "exec", "ringsta", "ss", "-ltnH",
                              capture_output=True).stdout:
        if time.monotonic() > deadline:
            raise RuntimeError("iperf3 server did not listen")
        time.sleep(0.1)
    client = subprocess.Popen(
        ["iperf3", "-c", "10.98.0.2", "-B", "10.98.0.1", "-u", "-b", "4M", "-P", "8", "-l", "1400",
         "-t", str(duration), "-J"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    return server, client


def stop_load(server: subprocess.Popen, client: subprocess.Popen) -> dict:
    """The load ended (killed if still running): what iperf3 reports of it, if it ended."""
    if client.poll() is None:
        client.kill()
    output = client.communicate(timeout=10)[0]
    if server.poll() is None:
        server.kill()
    server.wait(timeout=5)
    try:
        end = json.loads(output)["end"]
    except (ValueError, KeyError):
        return {"iperf3": "no report"}
    total = end.get("sum") or end.get("sum_sent") or {}
    return {"offered_packets": total.get("packets"),
            "lost_percent": total.get("lost_percent"),
            "received_mbps": round((end.get("sum_received") or total).get(
                "bits_per_second", 0) / 1e6, 2)}


def watch(seconds: float) -> dict[str, int]:
    """The ring's peak while the load runs (ethtool every 0.2 s), the stats at the end."""
    peak = 0
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        now = stats()
        peak = max(peak, now.get("d_tx_pending", 0))
        time.sleep(0.2)
    final = stats()
    final["observed_pending_peak"] = peak
    return final


def kernel_warnings(since: str) -> list[str]:
    output = run("journalctl", "-k", "-q", "--no-pager", "--since", since,
                 check=False, capture_output=True).stdout
    return [line for line in output.splitlines()
            if re.search(r"WARNING:|BUG:|Oops|refcount_t|list_add corruption", line)]


def refused_status(log: Path) -> int:
    return sum(1 for line in log.read_text(errors="replace").splitlines()
               if re.search(r"\bcmd 3\b", line))


def evaluate_module(module: Path, limit: int, timeout_ms: int, wmediumd: Path,
                    directory: Path, label: str) -> dict:
    since = time.strftime("%Y-%m-%d %H:%M:%S")
    result: dict = {"module": str(module), "pending_limit": limit,
                    "pending_timeout_ms": timeout_ms if limit else None}
    load_module(module, limit, timeout_ms)
    medium, log = start_wmediumd(wmediumd, directory, f"{label}-overload")
    setup_ibss()

    # overload: 10 s of the load, pings alongside
    before = stats()
    server, client = load(10)
    pings = subprocess.Popen(
        ["ping", "-I", "10.98.0.1", "-i", "0.2", "-c", "40", "-W", "2", "10.98.0.2"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    after = watch(10.5)
    udp = stop_load(server, client)
    ping_output = pings.communicate(timeout=15)[0]
    loss = re.search(r"([0-9.]+)% packet loss", ping_output)
    result["overload"] = {
        "dropped": delta(before, after, "d_tx_dropped"),
        "failed": delta(before, after, "d_tx_failed"),
        "flow_stops": delta(before, after, "d_tx_flow_stops"),
        "expired": delta(before, after, "d_tx_pending_expired"),
        "pending_max": after.get("d_tx_pending_max"),
        "observed_pending_peak": after["observed_pending_peak"],
        "ping_loss_percent": float(loss.group(1)) if loss else 100.0,
        "refused_status_lines": refused_status(log),
        "frames_to_medium": delta(before, after, "tx_pkts_nic"),
        "udp": udp,
    }

    # killed: wmediumd killed under the load, the first ping through after it
    time.sleep(2)
    before = stats()
    server, client = load(8)
    time.sleep(2)
    medium.kill()
    medium.wait(timeout=5)
    recovery = first_ping(15.0)
    after = stats()
    stop_load(server, client)
    result["killed"] = {
        "first_ping_s": recovery,
        "expired": delta(before, after, "d_tx_pending_expired"),
        "pending_after": after.get("d_tx_pending"),
    }

    if limit:
        # frozen: a medium registered but not answering for three timeouts
        medium, log = start_wmediumd(wmediumd, directory, f"{label}-frozen")
        time.sleep(1)
        if first_ping(10.0) is None:
            raise RuntimeError("no ping through the restarted medium")
        before = stats()
        server, client = load(6 + 3 * timeout_ms // 1000)
        time.sleep(2)
        os.kill(medium.pid, signal.SIGSTOP)
        time.sleep(3 * timeout_ms / 1000)
        during = stats()
        os.kill(medium.pid, signal.SIGCONT)
        stop_load(server, client)
        recovery = first_ping(15.0)
        after = stats()
        result["frozen"] = {
            "expired": delta(before, during, "d_tx_pending_expired"),
            "pending_while_frozen": during.get("d_tx_pending"),
            "first_ping_after_resume_s": recovery,
            "pending_after": after.get("d_tx_pending"),
        }
        medium.kill()
        medium.wait(timeout=5)

    cleanup()
    unloaded = not Path("/sys/module/mac80211_hwsim").exists()
    result["unloaded"] = unloaded
    result["kernel_warnings"] = kernel_warnings(since)
    return result


def checks(ring: dict, limit: int, timeout_ms: int) -> dict[str, bool]:
    overload, killed = ring["overload"], ring["killed"]
    frozen = ring.get("frozen", {})
    margin = timeout_ms / 4000 + 3.0
    return {
        "overload: the queues stopped": (overload["flow_stops"] or 0) > 0,
        "overload: nothing dropped at the ring": overload["dropped"] == 0,
        "overload: the ring within twice the limit":
            (overload["pending_max"] or 0) <= 2 * limit,
        "overload: pings through": overload["ping_loss_percent"] < 100.0,
        "killed: a ping through in time":
            killed["first_ping_s"] is not None and killed["first_ping_s"] <= margin,
        "frozen: unanswered frames expired": (frozen.get("expired") or 0) > 0,
        "frozen: a ping through after the resume":
            frozen.get("first_ping_after_resume_s") is not None
            and frozen["first_ping_after_resume_s"] <= margin,
        "unloaded": ring["unloaded"],
        "no kernel warnings": not ring["kernel_warnings"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--module", type=Path, required=True,
                        help="mac80211_hwsim.ko with 0012")
    parser.add_argument("--stock-module", type=Path,
                        help="mac80211_hwsim.ko of the series without 0012, for comparison")
    parser.add_argument("--wmediumd", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=64)
    parser.add_argument("--timeout-ms", type=int, default=1000)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run as root, in an isolated VM")
    global MEDIUM_NAME
    MEDIUM_NAME = args.wmediumd.name

    report: dict = {"kernel": os.uname().release}
    try:
        with tempfile.TemporaryDirectory(prefix="transmit-ring-") as temporary:
            directory = Path(temporary)
            if args.stock_module:
                report["stock"] = evaluate_module(args.stock_module, 0, args.timeout_ms,
                                                  args.wmediumd, directory, "stock")
            report["ring"] = evaluate_module(args.module, args.limit, args.timeout_ms,
                                             args.wmediumd, directory, "ring")
            for log in sorted(directory.glob("*.log")):
                report.setdefault("wmediumd_log_tails", {})[log.name] = \
                    log.read_text(errors="replace").splitlines()[-20:]
    finally:
        cleanup()
    report["checks"] = checks(report["ring"], args.limit, args.timeout_ms)
    report["passed"] = all(report["checks"].values())
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    for name, passed in report["checks"].items():
        print(f"{'ok  ' if passed else 'FAIL'} {name}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
