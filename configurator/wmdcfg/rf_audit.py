from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import time

from .actuator import ActuatorError, ControlClient
from .rf_contract import capability_manifest, measurement


STACKS = {
    "rdk": {
        "containers": ["bpibroadband", "bpiap", "bpiap-001", "bpiap-002", "bpiap-003"],
        "socket": "/run/meta-cmf-wmediumd/metrics/control.sock",
        "manifest": "/run/meta-cmf-wmediumd/wmediumd-binary.sha256",
        "patches": ("gen/hwsim/patches", "gen/wmediumd/patches"),
    },
    "prplmesh": {
        "containers": ["prpl-controller"] + [f"prpl-agent-{index:02d}" for index in range(1, 5)],
        "socket": "/run/prpl-wmediumd/metrics.sock",
        "manifest": "/run/prpl-wmediumd/wmediumd-binary.sha256",
        "patches": ("patches/hwsim", "patches/wmediumd", "patches/prplmesh"),
    },
}


def command(arguments: list[str], timeout: float = 8) -> dict:
    started = time.monotonic_ns()
    try:
        process = subprocess.run(
            arguments, capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "LC_ALL": "C", "GIT_OPTIONAL_LOCKS": "0"},
        )
        return {
            "argv": arguments, "returncode": process.returncode,
            "stdout": process.stdout, "stderr": process.stderr,
            "started_ns": started, "finished_ns": time.monotonic_ns(),
        }
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "argv": arguments, "returncode": None, "stdout": "", "stderr": str(error),
            "started_ns": started, "finished_ns": time.monotonic_ns(),
        }


def read_text(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except (OSError, UnicodeError):
        return None


def git_command(root: Path, *arguments: str) -> dict:
    return command(["git", "-c", f"safe.directory={root.resolve()}", "-C", str(root), *arguments])


def digest(path: Path) -> str | None:
    try:
        checksum = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(chunk)
        return checksum.hexdigest()
    except OSError:
        return None


def parse_interfaces(output: str) -> list[dict]:
    interfaces = []
    radio = None
    current = None
    for line in output.splitlines():
        stripped = line.strip()
        if stripped.startswith("phy#"):
            radio = stripped
        elif stripped.startswith("Interface "):
            current = {"radio_id": radio, "interface": stripped.split()[1]}
            interfaces.append(current)
        elif current is not None:
            if stripped.startswith("type "):
                current["type"] = stripped[5:]
            elif stripped.startswith("addr "):
                current["mac"] = stripped[5:]
            elif stripped.startswith("wdev "):
                current["wdev"] = stripped[5:]
            elif stripped.startswith("channel "):
                match = re.search(r"\((\d+) MHz\), width: (\d+) MHz", stripped)
                if match:
                    current.update(frequency_mhz=int(match[1]), width_mhz=int(match[2]))
    contexts = {}
    for interface in sorted(interfaces, key=lambda item: item["interface"]):
        if interface.get("type") != "AP" or "frequency_mhz" not in interface:
            continue
        key = (interface["radio_id"], interface["frequency_mhz"], interface["width_mhz"])
        contexts.setdefault(key, {**interface, "bss_interfaces": []})["bss_interfaces"].append(
            interface["interface"]
        )
    return list(contexts.values())


def parse_survey(output: str) -> list[dict]:
    records = []
    current = None
    fields = {
        "channel active time": "active_ms", "channel busy time": "busy_ms",
        "channel receive time": "rx_ms", "channel transmit time": "tx_ms",
        "noise": "noise_dbm",
    }
    for line in output.splitlines():
        match = re.search(r"frequency:\s*(\d+) MHz", line)
        if match:
            current = {
                "frequency_mhz": int(match[1]), "in_use": "[in use]" in line,
                "counter_unit": "ms", "valid_fields": [],
            }
            records.append(current)
        elif current is not None:
            for label, field in fields.items():
                unit = "dBm" if field == "noise_dbm" else "ms"
                match = re.fullmatch(r"\s*" + label + r":\s*(-?\d+) " + unit + r"\s*", line)
                if match:
                    current[field] = int(match[1])
                    current["valid_fields"].append(field)
    return records


def classify_survey(context: dict, response: dict) -> dict:
    records = parse_survey(response["stdout"])
    matching = [record for record in records
                if record["frequency_mhz"] == context["frequency_mhz"]]
    if response["returncode"] != 0:
        state, reason = "missing", "Survey command failed; failure is not measured idle."
    elif not records:
        state, reason = "missing", "No survey rows; empty output is not measured idle."
    elif not matching:
        state, reason = "missing", "No operating-frequency row; scan data belongs to another channel."
    else:
        state, reason = "unsupported", "hwsim scan counters are not qualified live channel occupancy."
    observation = measurement(
        "channel_utilization", None, source="hwsim-scan-survey",
        supported=True, state=state, reason=reason,
        sampled_at_ns=None,
    )
    return {"observation": observation, "records": records, "command": response}


def inspect_container(container: str, interval: float) -> dict:
    inventory = command(["lxc", "exec", container, "--", "iw", "dev"])
    contexts = parse_interfaces(inventory["stdout"])
    errors = []
    if inventory["returncode"] != 0 or not contexts:
        errors.append(f"{container}: no readable active AP contexts")
    samples = []
    for sample_index in range(2):
        if sample_index:
            time.sleep(interval)
        sample = []
        for context in contexts:
            response = command(
                ["lxc", "exec", container, "--", "iw", "dev",
                 context["interface"], "survey", "dump"]
            )
            if response["returncode"] != 0:
                errors.append(f"{container}/{context['interface']}: survey command failed")
            sample.append({**context, **classify_survey(context, response)})
        samples.append(sample)
    after = command(["lxc", "exec", container, "--", "iw", "dev"])
    if after["returncode"] != 0 or parse_interfaces(after["stdout"]) != contexts:
        errors.append(f"{container}: AP context changed during audit; rerun while stationary")
    return {
        "container": container, "before": inventory, "after": after,
        "samples": samples, "errors": errors,
    }


def daemon_identity(manifest_path: Path) -> dict:
    text = read_text(manifest_path)
    fields = text.split() if text else []
    if len(fields) != 3 or not fields[0].isdigit():
        return {"state": "missing", "reason": "Missing or invalid launcher binary manifest."}
    process_id, expected, executable = fields
    running = digest(Path("/proc") / process_id / "exe")
    disk = digest(Path(executable))
    return {
        "state": "valid" if running and running == disk == expected else "invalid",
        "pid": int(process_id), "executable": executable,
        "startup_sha256": expected, "running_sha256": running, "disk_sha256": disk,
        "build_provenance": read_text(Path(executable).with_name("wmediumd.provenance.env")),
    }


def runtime_identity(settings: dict, socket_path: str) -> dict:
    module = Path("/sys/module/mac80211_hwsim")
    disk = command(["modinfo", "-F", "srcversion", "mac80211_hwsim"])
    loaded = read_text(module / "srcversion")
    parameters = {
        name: read_text(module / "parameters" / name)
        for name in ("kernel_medium", "radios", "channels", "regtest", "kernel_medium_rate_per")
    }
    result = {
        "boot_id": read_text(Path("/proc/sys/kernel/random/boot_id")),
        "kernel": platform.release(),
        "module": {
            "loaded_srcversion": loaded,
            "disk_srcversion": disk["stdout"].strip() if disk["returncode"] == 0 else None,
            "parameters": parameters, "modinfo": disk,
        },
        "daemon": daemon_identity(Path(settings["manifest"])),
    }
    try:
        with ControlClient(socket_path) as client:
            status = client.status()
            if "read_only" not in status.capabilities:
                raise ActuatorError("RF audit requires a read-only metrics endpoint")
            result["rf_contract"] = capability_manifest("userspace", status)
    except (OSError, ActuatorError) as error:
        result["rf_contract"] = capability_manifest("userspace")
        result["error"] = str(error)
    return result


def identity_errors(identity: dict) -> list[str]:
    errors = []
    module = identity["module"]
    if not identity["boot_id"]:
        errors.append("VM boot identity unavailable")
    if not module["loaded_srcversion"] or module["loaded_srcversion"] != module["disk_srcversion"]:
        errors.append("Loaded/on-disk hwsim identity missing or mismatched")
    if module["parameters"]["kernel_medium"] != "N":
        errors.append("Backend mismatch: phase-0 live audit expects userspace wmediumd")
    if identity["daemon"]["state"] != "valid":
        errors.append("Running/disk/startup wmediumd binary identity missing or mismatched")
    wire = identity["rf_contract"]["wire"]
    if not {"read_only", "frequency_qualified_snr", "atomic_generations"} <= set(wire["capabilities"]):
        errors.append("Missing compatible read-only frequency-qualified medium API")
    if identity.get("error"):
        errors.append(identity["error"])
    return errors


def audit(stack: str, repo: Path, socket_path: str, interval: float) -> dict:
    settings = STACKS[stack]
    started = time.monotonic_ns()
    before = runtime_identity(settings, socket_path)
    with ThreadPoolExecutor(max_workers=5) as executor:
        containers = list(executor.map(
            lambda container: inspect_container(container, interval), settings["containers"]
        ))
    after = runtime_identity(settings, socket_path)
    errors = identity_errors(before) + identity_errors(after)
    for container in containers:
        errors.extend(container["errors"])
    if (before["boot_id"] != after["boot_id"]
            or before["daemon"] != after["daemon"]
            or before["module"]["loaded_srcversion"] != after["module"]["loaded_srcversion"]
            or before["rf_contract"]["wire"]["instance_id"] != after["rf_contract"]["wire"]["instance_id"]):
        errors.append("RF provider restarted or changed during audit")
    patches = {}
    for directory in settings["patches"]:
        patches[directory] = {
            str(path.relative_to(repo)): digest(path) for path in sorted((repo / directory).glob("*.patch"))
        }
        if not patches[directory]:
            errors.append(f"Missing patch provenance: {directory}")
    git_revision = git_command(repo, "rev-parse", "HEAD")
    if git_revision["returncode"] != 0:
        errors.append("Repository revision unavailable")
    observations = [
        row["observation"] for container in containers
        for sample in container["samples"] for row in sample
    ]
    return {
        "schema": "easymesh.rf-audit.v1", "stack": stack,
        "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "read_only": True, "duration_ms": (time.monotonic_ns() - started) / 1e6,
        "repo": {
            "path": str(repo), "revision": git_revision["stdout"].strip(),
            "status": git_command(repo, "status", "--short"),
            "patches": patches,
            "audit_sha256": digest(Path(__file__)),
            "contract_sha256": digest(Path(__file__).with_name("rf_contract.py")),
        },
        "before": before, "after": after, "containers": containers,
        "summary": {
            "outcome": "passed" if not errors else "failed",
            "qualification": "phase-0-truthfulness-only",
            "contexts": sum(len(container["samples"][0]) for container in containers),
            "observations": len(observations),
            "states": {state: sum(item["state"] == state for item in observations)
                       for state in sorted({item["state"] for item in observations})},
            "valid_utilization_values": sum(item["value"] is not None for item in observations),
            "errors": sorted(set(errors)),
        },
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Phase 0 virtual RF audit; no scans or traffic.")
    parser.add_argument("--stack", required=True, choices=sorted(STACKS))
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--socket", help="Read-only medium metrics socket; never the control socket")
    parser.add_argument("--interval", type=float, default=0.25)
    parser.add_argument("-o", "--output", type=Path)
    args = parser.parse_args(argv)
    if not 0 <= args.interval <= 5:
        parser.error("--interval must be between 0 and 5 seconds")
    report = audit(
        args.stack, args.repo_root.resolve(),
        args.socket or STACKS[args.stack]["socket"], args.interval,
    )
    rendered = json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")
    return 0 if report["summary"]["outcome"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
