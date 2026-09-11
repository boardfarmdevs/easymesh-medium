from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from wmdcfg.rf_audit import (
    STACKS, audit, classify_survey, command, daemon_identity,
    git_command, identity_errors, inspect_container, parse_interfaces, parse_survey, runtime_identity,
)
from wmdcfg.rf_contract import capability_manifest


IW = """phy#0
    Interface wifi1
        wdev 0x1
        addr 02:00:00:00:00:01
        type AP
        channel 36 (5180 MHz), width: 20 MHz, center1: 5180 MHz
    Interface wifi1.1
        wdev 0x2
        type AP
        channel 36 (5180 MHz), width: 20 MHz, center1: 5180 MHz
    Interface wifi1.sta1
        type AP/VLAN
        channel 36 (5180 MHz), width: 20 MHz, center1: 5180 MHz
    Interface wifi2
        wdev 0x3
        type AP
        channel 191 (5955 MHz), width: 20 MHz, center1: 5955 MHz
"""
SURVEY = """Survey data from wifi1
    frequency: 5955 MHz
    noise: -92 dBm
    channel active time: 120 ms
    channel busy time: 15 ms
"""
CONTEXT = {"frequency_mhz": 5180}
STATUS = SimpleNamespace(instance_id="medium", generation=5,
                         capabilities={"read_only", "atomic_generations", "frequency_qualified_snr"})


def response(stdout="", returncode=0):
    return {"stdout": stdout, "returncode": returncode, "stderr": "", "started_ns": 100, "finished_ns": 200}


def identity():
    return {
        "boot_id": "boot", "module": {
            "loaded_srcversion": "abcd", "disk_srcversion": "abcd",
            "parameters": {"kernel_medium": "N"},
        },
        "daemon": {"state": "valid", "pid": 22},
        "rf_contract": capability_manifest("userspace", STATUS),
    }


class SurveyAuditTests(unittest.TestCase):
    def test_ap_vaps_deduplicate_by_radio_frequency_and_width(self):
        contexts = parse_interfaces(IW)
        self.assertEqual(len(contexts), 2)
        self.assertEqual(contexts[0]["bss_interfaces"], ["wifi1", "wifi1.1"])
        self.assertEqual(contexts[1]["frequency_mhz"], 5955)

    def test_same_frequency_on_different_radios_stays_separate(self):
        self.assertEqual(len(parse_interfaces(IW + IW.replace("phy#0", "phy#1"))), 4)

    def test_empty_error_and_off_channel_never_become_idle(self):
        for result in (response(), response(returncode=1), response(SURVEY)):
            with self.subTest(result=result):
                normalized = classify_survey(CONTEXT, result)
                self.assertEqual(normalized["observation"]["state"], "missing")
                self.assertIsNone(normalized["observation"]["value"])

    def test_even_in_use_dummy_row_is_not_qualified(self):
        raw = SURVEY.replace("5955 MHz", "5180 MHz [in use]")
        parsed = parse_survey(raw)[0]
        self.assertTrue(parsed["in_use"])
        self.assertEqual(parsed["active_ms"], 120)
        self.assertEqual(parsed["busy_ms"], 15)
        result = classify_survey(CONTEXT, response(raw))
        self.assertEqual(result["observation"]["state"], "unsupported")
        self.assertIsNone(result["observation"]["value"])
        self.assertIsNone(result["observation"]["sampled_at_ns"])

    def test_unsupported_units_are_not_filled(self):
        parsed = parse_survey(SURVEY.replace("120 ms", "120 us"))[0]
        self.assertNotIn("active_ms", parsed["valid_fields"])

    def test_sampling_uses_only_read_only_commands_and_two_rounds(self):
        calls = []

        def fake_command(arguments):
            calls.append(arguments)
            return response(IW if arguments[-1] == "dev" else SURVEY)

        with patch("wmdcfg.rf_audit.command", side_effect=fake_command):
            result = inspect_container("fixture-ap", 0)
        self.assertEqual(len(result["samples"]), 2)
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(calls), 6)
        for arguments in calls:
            self.assertEqual(arguments[:5], ["lxc", "exec", "fixture-ap", "--", "iw"])
            self.assertNotIn("scan", arguments)
            self.assertNotIn("set", arguments)

    def test_context_change_requires_rerun(self):
        with patch("wmdcfg.rf_audit.command", side_effect=[
            response(IW), response(), response(), response(), response(),
            response(IW.replace("5180 MHz", "5200 MHz")),
        ]):
            result = inspect_container("fixture-ap", 0)
        self.assertIn("changed during audit", result["errors"][0])

    def test_timeout_is_not_empty_success(self):
        with patch("wmdcfg.rf_audit.subprocess.run", side_effect=subprocess.TimeoutExpired("iw", 8)):
            result = command(["iw", "dev"])
        self.assertIsNone(result["returncode"])
        self.assertTrue(result["stderr"])


class ProvenanceTests(unittest.TestCase):
    def test_git_trust_is_scoped_to_the_explicit_audit_repo(self):
        with patch("wmdcfg.rf_audit.command", return_value=response()) as execute:
            git_command(Path("/fixture/repo"), "rev-parse", "HEAD")
        self.assertEqual(execute.call_args.args[0], [
            "git", "-c", "safe.directory=/fixture/repo", "-C", "/fixture/repo", "rev-parse", "HEAD",
        ])

    def test_backend_module_and_capability_mismatch_fail(self):
        self.assertEqual(identity_errors(identity()), [])
        for path, value in (
            (("module", "disk_srcversion"), "different"),
            (("module", "loaded_srcversion"), None),
            (("module", "parameters", "kernel_medium"), "Y"),
            (("daemon", "state"), "invalid"),
            (("rf_contract", "wire", "capabilities"), []),
        ):
            changed = identity()
            target = changed
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path):
                self.assertTrue(identity_errors(changed))

    def test_launcher_running_and_disk_hashes_must_all_match(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "binary.sha256"
            manifest.write_text("22 abc /fixture/wmediumd\n")
            with patch("wmdcfg.rf_audit.digest", return_value="abc"):
                self.assertEqual(daemon_identity(manifest)["state"], "valid")
            with patch("wmdcfg.rf_audit.digest", side_effect=["abc", "replaced"]):
                self.assertEqual(daemon_identity(manifest)["state"], "invalid")

    def test_control_endpoint_is_rejected_without_any_writes(self):
        with patch("wmdcfg.rf_audit.ControlClient") as factory, \
                patch("wmdcfg.rf_audit.read_text", return_value="fixture"), \
                patch("wmdcfg.rf_audit.command", return_value=response("abcd")), \
                patch("wmdcfg.rf_audit.daemon_identity", return_value={"state": "valid"}):
            client = factory.return_value.__enter__.return_value
            client.status.return_value = SimpleNamespace(capabilities={"atomic_generations"})
            result = runtime_identity(STACKS["rdk"], "/fixture/control")
            self.assertIn("read-only", result["error"])
            client.apply.assert_not_called()
            client.apply_frequency.assert_not_called()

    def test_audit_detects_provider_restart_and_keeps_errors(self):
        changed = copy.deepcopy(identity())
        changed["rf_contract"]["wire"]["instance_id"] = "restarted"
        with tempfile.TemporaryDirectory() as directory, \
                patch("wmdcfg.rf_audit.runtime_identity", side_effect=[identity(), changed]), \
                patch("wmdcfg.rf_audit.inspect_container", return_value={
                    "samples": [[], []], "errors": ["fixture: survey command failed"],
                }), \
                patch("wmdcfg.rf_audit.command", return_value=response("revision")):
            report = audit("rdk", Path(directory), "/metrics", 0)
        self.assertEqual(report["summary"]["outcome"], "failed")
        self.assertIn("RF provider restarted or changed during audit", report["summary"]["errors"])
        self.assertIn("fixture: survey command failed", report["summary"]["errors"])
        json.dumps(report, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
