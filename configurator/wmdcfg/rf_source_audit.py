from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

from .rf_audit import git_command


COMMON_CHECKS = {
    "hwsim": [
        ("scan-survey-placeholder", "mac80211_hwsim.c",
         r"survey->time_busy\s*=\s*survey->time\s*/\s*8\s*;",
         "Dummy scan busy ratio is not measured channel utilization."),
        ("scan-noise-placeholder", "mac80211_hwsim.c",
         r"survey->noise\s*=\s*-92\s*;", "Dummy scan noise is not measured noise."),
    ],
    "wmediumd": [
        ("fixed-rx-rate", "wmediumd/wmediumd.c",
         r"nla_put_u32\(msg,\s*HWSIM_ATTR_RX_RATE,\s*1\)",
         "RX injection reports a fixed rate index, not the transmitted PHY rate."),
        ("legacy-airtime-mapping", "wmediumd/wmediumd.c",
         r"per_rate_idx\s*=\s*frame_model_rate_idx\(",
         "Modern PHY rates use the legacy approximation; capacity remains unqualified."),
    ],
}
NATIVE_CHECKS = {
    "rdk": [
        ("rdk-channel-stats-stub", "platform/banana-pi/platform.c",
         r"wifi_getRadioChannelStats\([^{};]+\)\s*\{\s*return RETURN_OK;\s*\}",
         "Success without populated output is not measured zero utilization."),
        ("rdk-survey-stub", "src/wifi_hal_nl80211.c",
         r"wifi_drv_get_survey\([^{};]+\).*?\{\s*wifi_hal_dbg_print\([^;]+;\s*return 0;\s*\}",
         "Successful no-op hostapd survey callback supplies no measurement."),
    ],
    "prplmesh": [
        ("prpl-survey-consumer", "common/beerocks/bwl/nl80211/base_wlan_hal_nl80211.cpp",
         r"!survey_info\.get_channel_utilization\(channel_utilization\)",
         "Native consumer exists; this does not qualify its hwsim input."),
        ("prpl-noise-placeholder", "common/beerocks/bwl/nl80211/mon_wlan_hal_nl80211.cpp",
         r"radio_stats\.noise\s*=\s*0\s*;",
         "Zero radio noise is a placeholder, not a measured noise floor."),
        ("prpl-esp-stub", "common/beerocks/bwl/nl80211/mon_wlan_hal_nl80211.cpp",
         r"set_estimated_service_parameters\([^{};]+\)\s*\{\s*(?://[^\n]*\n\s*)*return true;\s*\}",
         "ESP setter returns success without implementing an estimate."),
        ("prpl-scan-zero-rewrite", "agent/src/beerocks/slave/tasks/channel_scan_task.cpp",
         r"if\s*\(scan_result->utilization\(\) == 0\)\s*\{\s*scan_result->utilization\(\) = 10;",
         "A scan report rewrites zero to 10; not a genuine load measurement."),
    ],
}


def inspect_source(root: Path, checks: list) -> dict:
    findings = []
    for identifier, relative, pattern, reason in checks:
        path = root / relative
        try:
            raw = path.read_bytes()
            source = raw.decode()
            match = re.search(pattern, source, re.DOTALL)
            findings.append({
                "id": identifier, "path": str(path), "sha256": hashlib.sha256(raw).hexdigest(),
                "line": source.count("\n", 0, match.start()) + 1 if match else None,
                "state": "baseline_confirmed" if match else "review_required",
                "reason": reason,
            })
        except (OSError, UnicodeError) as error:
            findings.append({
                "id": identifier, "path": str(path), "state": "missing", "reason": str(error),
            })
    top = git_command(root, "rev-parse", "--show-toplevel")
    revision = git_command(root, "rev-parse", "HEAD")
    if top["returncode"] == 0 and Path(top["stdout"].strip()).resolve() != root.resolve():
        revision = {"stdout": "", "stderr": "Source snapshot is not a Git root.", "returncode": 1}
    return {
        "root": str(root), "revision": revision["stdout"].strip() or None,
        "revision_error": revision["stderr"] if revision["returncode"] != 0 else None,
        "findings": findings,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Pin known Phase 0 source gaps; does not build or mutate sources.")
    parser.add_argument("--stack", required=True, choices=sorted(NATIVE_CHECKS))
    parser.add_argument("--native-source", required=True, type=Path)
    parser.add_argument("--hwsim-source", type=Path)
    parser.add_argument("--wmediumd-source", type=Path)
    parser.add_argument("-o", "--output", type=Path)
    args = parser.parse_args(argv)
    components = {"native": inspect_source(args.native_source, NATIVE_CHECKS[args.stack])}
    for name, checks in COMMON_CHECKS.items():
        root = getattr(args, name + "_source")
        if root is not None:
            components[name] = inspect_source(root, checks)
    findings = [item for component in components.values() for item in component["findings"]]
    passed = all(item["state"] == "baseline_confirmed" for item in findings)
    report = {
        "schema": "easymesh.rf-source-audit.v1", "stack": args.stack,
        "outcome": "passed" if passed else "review_required", "components": components,
        "meaning": "Pinned known limitations, not proof of fidelity or installed native binary equivalence.",
    }
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
