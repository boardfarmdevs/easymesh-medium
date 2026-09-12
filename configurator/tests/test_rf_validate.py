import unittest
import itertools
from unittest import mock

from wmdcfg.rf_validate import native_load_matches, scan_for_roam


class RetuneScanTests(unittest.TestCase):
    def test_waits_for_busy_scan_and_recent_target(self):
        target = "bssid=02:00:00:00:01:00\nfreq=2437\nage="
        with mock.patch("wmdcfg.rf_validate.command", side_effect=[
                "FAIL-BUSY", "OK", "FAIL", target + "9", target + "0"]) as command, \
                mock.patch("wmdcfg.rf_validate.time.sleep"), \
                mock.patch("wmdcfg.rf_validate.time.monotonic", return_value=0):
            result = scan_for_roam("client", "02:00:00:00:01:00", 2437)
        self.assertEqual(result["age"], "0")
        self.assertEqual(command.call_count, 5)

    def test_scan_rejection_is_not_silently_ignored(self):
        with mock.patch("wmdcfg.rf_validate.command", return_value="FAIL"):
            with self.assertRaisesRegex(RuntimeError, "directed scan rejected"):
                scan_for_roam("client", "02:00:00:00:01:00", 2437)

    def test_completed_scan_without_target_is_repeated_within_deadline(self):
        target = "bssid=02:00:00:00:01:00\nfreq=2437\nage=0"
        with mock.patch("wmdcfg.rf_validate.command", side_effect=[
                "OK", "", "", "OK", target]), \
                mock.patch("wmdcfg.rf_validate.time.sleep"), \
                mock.patch("wmdcfg.rf_validate.time.monotonic", side_effect=itertools.count(0, .6)):
            result = scan_for_roam("client", "02:00:00:00:01:00", 2437)
        self.assertEqual(result["scan_requests"], 2)
        self.assertLess(result["scan_elapsed_seconds"], 15)

    def test_busy_scan_has_a_bounded_deadline(self):
        with mock.patch("wmdcfg.rf_validate.command", return_value="FAIL-BUSY"), \
                mock.patch("wmdcfg.rf_validate.time.sleep"), \
                mock.patch("wmdcfg.rf_validate.time.monotonic", side_effect=[0, 0, 16]):
            with self.assertRaisesRegex(RuntimeError, "did not refresh"):
                scan_for_roam("client", "02:00:00:00:01:00", 2437)


class NativeLoadTests(unittest.TestCase):
    def test_requires_latest_value_from_every_observed_bss(self):
        self.assertFalse(native_load_matches([], 128))
        rows = [{"bssid": "first", "utilization_byte": 0},
                {"bssid": "second", "utilization_byte": 0}]
        self.assertFalse(native_load_matches(rows, 128))
        rows.append({"bssid": "first", "utilization_byte": 128})
        self.assertFalse(native_load_matches(rows, 128))
        rows.append({"bssid": "second", "utilization_byte": 128})
        self.assertTrue(native_load_matches(rows, 128))
        rows.append({"bssid": "first", "utilization_byte": 0})
        self.assertFalse(native_load_matches(rows, 128))
