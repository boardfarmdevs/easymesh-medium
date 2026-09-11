from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import signal
import time

from .actuator import ActuatorError, ControlClient


def parse_contexts(text: str) -> tuple[bool, list[dict]]:
    lines = text.splitlines()
    header = lines[0].split() if lines else []
    if len(header) != 5 or header[0:2] != ["v1", "radio"] or header[3] != "available":
        raise ValueError("unsupported hwsim RF context ABI")
    records = []
    for line in lines[1:]:
        fields = line.split()
        if len(fields) != 9:
            raise ValueError("invalid hwsim RF context record")
        slot, epoch, frequency, width, provider, observed, active, busy, valid = map(int, fields)
        if (not 0 <= slot < 8 or min(epoch, provider, observed, active, busy) < 0
                or not 2300 <= frequency <= 7125 or busy > active or valid not in (0, 1)
                or any(record["slot"] == slot for record in records)):
            raise ValueError("invalid hwsim RF context fields")
        records.append({
            "slot": slot, "epoch": epoch, "frequency_mhz": frequency, "width_mhz": width,
            "radio": header[2], "provider": provider, "observed_us": observed,
            "active_us": active, "busy_us": busy, "valid": bool(valid),
        })
    if header[4] not in ("0", "1"):
        raise ValueError("invalid hwsim RF availability")
    return header[4] == "1", records


class SurveyBridge:
    def __init__(self, root: Path, fixed_utilization: int | None = None):
        if fixed_utilization is not None and not 0 <= fixed_utilization <= 255:
            raise ValueError("fixed utilization must be a byte")
        self.root = root
        self.fixed_utilization = fixed_utilization
        self.baselines = {}

    def convert(self, key: tuple, context: dict, sample: dict, instance: str) -> dict | None:
        identity = (context["epoch"], instance, sample["start_us"], self.fixed_utilization)
        if context["width_mhz"] != 20 or not sample["flags"] & 1:
            self.baselines.pop(key, None)
            return None
        if sample["busy_us"] > sample["observed_us"] - sample["start_us"]:
            raise ValueError("medium busy counter exceeds active time")
        baseline = self.baselines.get(key)
        if baseline is None or baseline["identity"] != identity:
            self.baselines[key] = {"identity": identity, "sample": sample.copy()}
            return None
        first = baseline["sample"]
        active = sample["observed_us"] - first["observed_us"]
        busy = sample["busy_us"] - first["busy_us"]
        if active <= 0 or busy < 0 or busy > active:
            self.baselines.pop(key, None)
            raise ValueError("non-monotonic or invalid medium counter delta")
        if self.fixed_utilization is not None:
            active = active // 255000 * 255000
            busy = active * self.fixed_utilization // 255
        token = repr((identity, first["observed_us"])).encode()
        provider = int.from_bytes(hashlib.sha256(token).digest()[:8], "big") or 1
        return {
            "epoch": context["epoch"], "provider": provider,
            "observed_us": sample["observed_us"], "active_us": active, "busy_us": busy,
        }

    def tick(self, client: ControlClient) -> dict:
        contexts = []
        errors = []
        paths = sorted(self.root.glob("*/hwsim/rf_survey"))
        if not paths:
            raise RuntimeError("hwsim RF survey ABI is absent; install the matching module")
        for path in paths:
            try:
                available, rows = parse_contexts(path.read_text())
                if available:
                    contexts.extend((path, row) for row in rows if row["width_mhz"] == 20)
            except (OSError, ValueError) as error:
                errors.append(f"{path}: {error}")
        frequencies = sorted({row["frequency_mhz"] for _, row in contexts})
        samples = {frequency: client.get_channel_survey(frequency) for frequency in frequencies}
        active_keys = {(str(path), context["slot"]) for path, context in contexts}
        self.baselines = {key: value for key, value in self.baselines.items() if key in active_keys}
        written = []
        for path, context in contexts:
            key = (str(path), context["slot"])
            sample = samples[context["frequency_mhz"]]
            try:
                record = self.convert(key, context, sample, client.instance_id)
                if record is None:
                    continue
                payload = (f"v1 {context['slot']} {record['epoch']} {record['provider']} "
                           f"{record['observed_us']} {record['active_us']} {record['busy_us']}\n")
                path.write_text(payload)
                written.append({"radio": context["radio"], "frequency_mhz": context["frequency_mhz"],
                                "slot": context["slot"], **record})
            except (OSError, ValueError) as error:
                self.baselines.pop(key, None)
                errors.append(f"{path}/{context['slot']}: {error}")
        return {
            "schema": "easymesh.rf-survey-bridge.v1",
            "source": "synthetic-field-test" if self.fixed_utilization is not None else "wmediumd-modeled-airtime",
            "profile": "single-contention-domain-legacy20",
            "physical_capacity_qualified": False,
            "fixed_utilization_byte": self.fixed_utilization,
            "instance_id": client.instance_id,
            "recorded_monotonic_ns": time.monotonic_ns(),
            "active_contexts": len(contexts), "written": written, "errors": errors,
            "channels": samples,
        }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Bounded wmediumd-to-hwsim survey cache bridge")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--kernel-root", type=Path, default=Path("/sys/kernel/debug/ieee80211"))
    parser.add_argument("--enable", action="store_true", help="explicitly select the hwsim survey cache")
    parser.add_argument("--interval", type=float, default=0.1)
    parser.add_argument("--fixed-utilization", type=int, choices=range(256), metavar="0..255")
    parser.add_argument("--status-file", type=Path)
    parser.add_argument("--iterations", type=int, default=0, help="zero runs until stopped")
    args = parser.parse_args(argv)
    if not 0.05 <= args.interval <= 0.5 or args.iterations < 0:
        parser.error("interval must be 0.05..0.5 seconds; iterations must be nonnegative")
    stopped = False

    def stop(signum, frame):
        nonlocal stopped
        stopped = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, stop)
    bridge = SurveyBridge(args.kernel_root, args.fixed_utilization)
    iterations = 0
    last_report = 0.0
    while not stopped and (not args.iterations or iterations < args.iterations):
        try:
            with ControlClient(args.socket) as client:
                required = {"read_only", "channel_survey"}
                if not required <= client.capabilities:
                    raise RuntimeError("matching read-only wmediumd channel survey API is required")
                if args.enable:
                    Path("/sys/module/mac80211_hwsim/parameters/survey_cache").write_text("Y\n")
                while not stopped and (not args.iterations or iterations < args.iterations):
                    started = time.monotonic()
                    report = bridge.tick(client)
                    iterations += 1
                    if args.status_file and (started - last_report >= 1 or args.iterations):
                        temporary = args.status_file.with_suffix(".tmp")
                        temporary.write_text(json.dumps(report, sort_keys=True) + "\n")
                        temporary.replace(args.status_file)
                        last_report = started
                    if args.iterations:
                        print(json.dumps({key: report[key] for key in
                                          ("active_contexts", "errors", "source")}), flush=True)
                    time.sleep(max(0, args.interval - (time.monotonic() - started)))
        except (OSError, ActuatorError, RuntimeError, ValueError) as error:
            bridge.baselines.clear()
            print(f"survey bridge unavailable: {error}", flush=True)
            if args.iterations:
                return 1
            time.sleep(1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
