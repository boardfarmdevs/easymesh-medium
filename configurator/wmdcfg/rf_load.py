from __future__ import annotations

import json
import math
from pathlib import Path
import time


def load_status(path=Path("/run/wmdcfg-survey.json"), now_ns=None):
    now_ns = time.monotonic_ns() if now_ns is None else now_ns
    result = {"schema": "easymesh.rf-load-view.v1", "state": "unavailable",
              "source": "wmediumd-modeled-airtime", "physical_capacity_qualified": False,
              "scope": "frequency-wide modeled activity, not local receiver load",
              "channels": []}
    try:
        report = json.loads(path.read_text())
        age = (now_ns - report["recorded_monotonic_ns"]) / 1000000
        if report["schema"] != "easymesh.rf-survey-bridge.v1" or not 0 <= age <= 1000:
            result["state"] = "stale"
            return result
        if report["source"] != "wmediumd-modeled-airtime":
            result["state"] = "synthetic"
            return result
        result.update(profile=report["profile"], instance_id=report["instance_id"], state="valid")
        for sample in report.get("channel_observations", []):
            if (type(sample["observed_us"]) is not int or sample["observed_us"] < 0 or
                    type(sample["frequency_mhz"]) is not int or
                    not 2300 <= sample["frequency_mhz"] <= 7125):
                raise ValueError("invalid channel identity or monotonic timestamp")
            sample_age = (now_ns / 1000 - sample["observed_us"]) / 1000
            value = sample["value"]
            window = sample["window_us"]
            valid = (sample["state"] == "valid" and isinstance(value, (int, float))
                     and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 100
                     and isinstance(window, (int, float)) and not isinstance(window, bool)
                     and math.isfinite(window) and window > 0 and 0 <= sample_age <= 1000)
            result["channels"].append({
                "frequency_mhz": sample["frequency_mhz"], "state": "valid" if valid else "unavailable",
                "value": value if valid else None, "unit": "percent",
                "age_ms": sample_age, "window_ms": window / 1000 if valid else None,
            })
        if not any(row["state"] == "valid" for row in result["channels"]):
            result["state"] = "unavailable"
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        result["state"] = "unavailable"
        result["channels"] = []
    return result
