import json
from pathlib import Path
import tempfile
import unittest

from wmdcfg.rf_load import load_status


class LoadViewTests(unittest.TestCase):
    def report(self, value=0, **changes):
        return {"schema": "easymesh.rf-survey-bridge.v1", "source": "wmediumd-modeled-airtime",
                "profile": "single-contention-domain-legacy20", "instance_id": "medium",
                "recorded_monotonic_ns": 2000000000, "channel_observations": [
                    {"frequency_mhz": 5180, "state": "valid", "value": value,
                     "observed_us": 2000000, "window_us": 100000}], **changes}

    def read(self, report, now=2050000000):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "status.json"
            path.write_text(json.dumps(report))
            return load_status(path, now)

    def test_measured_zero_and_window_are_preserved(self):
        result = self.read(self.report())
        self.assertEqual(result["state"], "valid")
        self.assertEqual(result["channels"][0]["value"], 0)
        self.assertEqual(result["channels"][0]["window_ms"], 100)
        self.assertEqual(result["channels"][0]["age_ms"], 50)
        self.assertFalse(result["physical_capacity_qualified"])

    def test_stale_future_or_missing_report_never_shows_zero(self):
        for report, now in ((self.report(), 3100000000), (self.report(), 1900000000), ({}, 2000000000)):
            result = self.read(report, now)
            self.assertNotEqual(result["state"], "valid")
            self.assertEqual(result["channels"], [])

    def test_synthetic_and_nonfinite_fields_are_not_measured(self):
        self.assertEqual(self.read(self.report(source="synthetic-field-test"))["state"], "synthetic")
        for value in (None, True, -1, 101, float("nan"), float("inf")):
            self.assertIsNone(self.read(self.report(value))["channels"][0]["value"])

    def test_invalid_identity_or_timestamp_cannot_emit_nonfinite_json(self):
        for field, value in (("observed_us", float("nan")), ("observed_us", True),
                             ("frequency_mhz", float("inf")), ("frequency_mhz", 100)):
            report = self.report()
            report["channel_observations"][0][field] = value
            result = self.read(report)
            self.assertEqual(result["state"], "unavailable")
            json.dumps(result, allow_nan=False)
        self.assertEqual(self.read(None)["state"], "unavailable")

    def test_unavailable_file_is_safe(self):
        self.assertEqual(load_status(Path("/nonexistent-rf-load"))["state"], "unavailable")
