import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock

from wmdcfg.rf_latency import first_delay, latency_status, live_loads, zero_baseline


class NativeLatencyTests(unittest.TestCase):
    def test_baseline_requires_fresh_zero_for_same_bssid(self):
        rows = [{"timestamp_seconds": 10, "timestamp_fraction": 0,
                 "utilization_byte": 0, "bssid": "ap"}]
        self.assertIsNone(zero_baseline(rows, 11, "ap"))
        self.assertIsNone(zero_baseline(rows, 9, "other"))
        self.assertIsNone(zero_baseline([], 9))
        self.assertEqual(zero_baseline(rows, 10, "ap"), rows[0])

    def test_later_nonzero_invalidates_earlier_zero_even_out_of_order(self):
        rows = [{"timestamp_seconds": 12, "timestamp_fraction": 0,
                 "utilization_byte": 255, "bssid": "ap"},
                {"timestamp_seconds": 11, "timestamp_fraction": 0,
                 "utilization_byte": 0, "bssid": "ap"}]
        self.assertIsNone(zero_baseline(rows, 10, "ap"))
        rows.append({"timestamp_seconds": 13, "timestamp_fraction": 0,
                     "utilization_byte": 0, "bssid": "other"})
        self.assertIsNone(zero_baseline(rows, 10, "ap"))
        self.assertEqual(zero_baseline(rows, 10)["bssid"], "other")

    def test_live_capture_retries_only_incomplete_writes(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "live.pcap"
            reader = Mock()
            self.assertEqual(live_loads(path, reader), [])
            path.write_bytes(bytes(23))
            self.assertEqual(live_loads(path, reader), [])
            reader.assert_not_called()
            path.write_bytes(bytes(24))
            reader.side_effect = ValueError("truncated packet")
            self.assertEqual(live_loads(path, reader), [])
            reader.side_effect = ValueError("classic pcap required")
            with self.assertRaisesRegex(ValueError, "classic pcap"):
                live_loads(path, reader)

    def test_longer_observation_does_not_relax_latency_budget(self):
        report = {"fixture_start_to_driver_seconds": .3,
                  "fixture_start_to_beacon_seconds": 2,
                  "fixture_start_to_1905_seconds": 18}
        self.assertEqual(latency_status(report), {
            "measurement_complete": True, "latency_budget_seconds": 15,
            "within_latency_budget": False, "passed": False})
        report["fixture_start_to_1905_seconds"] = 15
        self.assertTrue(latency_status(report)["passed"])
        report["fixture_start_to_1905_seconds"] = 0
        self.assertTrue(latency_status(report)["passed"])

    def test_missing_invalid_measurement_fails_without_successful_observation(self):
        for value in (None, -1, float("nan"), float("inf"), True, "1"):
            with self.subTest(value=value):
                report = {"fixture_start_to_driver_seconds": .3,
                          "fixture_start_to_beacon_seconds": 2,
                          "fixture_start_to_1905_seconds": value}
                self.assertFalse(latency_status(report)["measurement_complete"])
                self.assertFalse(latency_status(report)["passed"])

    def test_first_matching_fresh_value_uses_microsecond_precision(self):
        rows = [
            {"timestamp_seconds": 10, "timestamp_fraction": 100000,
             "utilization_byte": 255, "bssid": "ap"},
            {"timestamp_seconds": 10, "timestamp_fraction": 300000,
             "utilization_byte": 0, "bssid": "ap"},
            {"timestamp_seconds": 10, "timestamp_fraction": 400000,
             "utilization_byte": 255, "bssid": "other"},
            {"timestamp_seconds": 10, "timestamp_fraction": 500000,
             "utilization_byte": 255, "bssid": "ap"},
        ]
        self.assertAlmostEqual(first_delay(rows, 10.2, "ap"), .3)
        self.assertAlmostEqual(first_delay(rows, 10.2), .2)
        self.assertIsNone(first_delay(rows, 11))
        self.assertIsNone(first_delay([], 0))
