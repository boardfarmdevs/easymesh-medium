from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import time

from .actuator import ControlClient
from .rf_contract import survey_utilization
from .survey_bridge import parse_contexts


def normalized(context, instance):
    return {
        "instance_id": instance, "radio_id": context["radio"],
        "frequency_mhz": context["frequency_mhz"], "width_mhz": context["width_mhz"],
        "context_epoch": [context["epoch"], context["provider"]],
        "counter_unit": "ms", "active_ms": context["active_us"] // 1000,
        "busy_ms": context["busy_us"] // 1000,
        "sampled_at_ns": context["observed_us"] * 1000,
        "valid_fields": ["active_ms", "busy_ms"] if context["valid"] and context["width_mhz"] == 20 else [],
        "source": "hwsim-modeled-survey-cache",
    }


def percentile(values, fraction):
    values = sorted(values)
    return values[min(len(values) - 1, int((len(values) - 1) * fraction))] if values else None


def cpu_ticks(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return int(fields[11]) + int(fields[12])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only context-qualified RF survey and publication audit")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--status-file", type=Path, default=Path("/run/wmdcfg-survey.json"))
    parser.add_argument("--kernel-root", type=Path, default=Path("/sys/kernel/debug/ieee80211"))
    parser.add_argument("--seconds", type=float, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if not 0.5 <= args.seconds <= 60:
        parser.error("seconds must be 0.5..60")
    enabled = Path("/sys/module/mac80211_hwsim/parameters/survey_cache").read_text().strip()
    if enabled not in ("Y", "1"):
        raise RuntimeError("native survey cache is disabled")
    bridge_pid = int(subprocess.check_output(
        ["systemctl", "show", "--property=MainPID", "--value", "wmdcfg-survey-bridge"], text=True))
    ticks_start = cpu_ticks(bridge_pid)
    started = time.monotonic()
    previous = {}
    latest = {}
    ages = []
    latencies = []
    errors = []
    with ControlClient(args.socket) as client:
        if not {"read_only", "channel_survey"} <= client.capabilities:
            raise RuntimeError("read-only modeled channel survey API required")
        while time.monotonic() - started < args.seconds:
            status = json.loads(args.status_file.read_text())
            if status["source"] != "wmediumd-modeled-airtime" or status["instance_id"] != client.instance_id:
                raise RuntimeError("a fixed fixture or mismatched provider cannot qualify modeled observations")
            providers = {(row["radio"], row["frequency_mhz"], row["slot"]): row["provider"]
                         for row in status["written"]}
            rows = []
            for path in sorted(args.kernel_root.glob("*/hwsim/rf_survey")):
                available, contexts = parse_contexts(path.read_text())
                if available:
                    rows.extend(contexts)
            current_keys = set()
            for context in rows:
                key = (context["radio"], context["frequency_mhz"], context["slot"])
                current_keys.add(key)
                if providers.get(key) != context["provider"]:
                    previous.pop(key, None)
                    latest.pop(key, None)
                    continue
                sample = normalized(context, client.instance_id)
                now = time.monotonic_ns()
                result = survey_utilization(previous.get(key), sample, now_ns=now,
                                            max_age_ns=1000000000, qualified=True)
                if context["valid"] and context["width_mhz"] == 20:
                    ages.append((now - sample["sampled_at_ns"]) / 1e6)
                if result["state"] not in ("warming_up", "valid") and (
                        not previous.get(key) or sample["sampled_at_ns"] != previous[key]["sampled_at_ns"]):
                    errors.append({"radio": context["radio"], "state": result["state"], "reason": result["reason"]})
                if result["state"] == "valid":
                    latest[key] = {"context": context, "observation": result}
                elif (result["state"] == "stale" or not context["valid"] or
                      not previous.get(key) or sample["sampled_at_ns"] != previous[key]["sampled_at_ns"]):
                    latest.pop(key, None)
                previous[key] = sample
            previous = {key: value for key, value in previous.items() if key in current_keys}
            latest = {key: value for key, value in latest.items() if key in current_keys}
            for frequency in sorted({row["frequency_mhz"] for row in rows}):
                query_started = time.monotonic_ns()
                client.get_channel_survey(frequency)
                latencies.append((time.monotonic_ns() - query_started) / 1e6)
            time.sleep(0.02)
        instance = client.instance_id
    duration = time.monotonic() - started
    cpu_percent = (cpu_ticks(bridge_pid) - ticks_start) / os.sysconf("SC_CLK_TCK") / duration * 100
    report = {
        "schema": "easymesh.rf-survey-audit.v1", "read_only": True,
        "profile": status["profile"], "physical_capacity_qualified": False,
        "instance_id": instance, "duration_seconds": duration, "contexts": len(latest),
        "bridge_cpu_percent_one_core": cpu_percent, "errors": errors,
        "cache_age_ms": {name: percentile(ages, quantile) for name, quantile in
                         (("p50", .5), ("p95", .95), ("p99", .99), ("max", 1))},
        "control_round_trip_ms": {name: percentile(latencies, quantile) for name, quantile in
                                 (("p50", .5), ("p95", .95), ("p99", .99), ("max", 1))},
        "observations": list(latest.values()),
    }
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered)
    print(json.dumps({key: value for key, value in report.items() if key != "observations"}))
    return 0 if latest and not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
