from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from wmdcfg.survey_bridge import SurveyBridge, parse_contexts


class SurveyBridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = SurveyBridge(Path("/unused"))
        self.context = {"slot": 0, "epoch": 1, "width_mhz": 20}
        self.first = {"flags": 3, "start_us": 1000000, "observed_us": 2000000, "busy_us": 100}
        self.second = {**self.first, "observed_us": 3000000, "busy_us": 500100}
        self.key = ("phy0", 0)

    def warm(self, bridge=None):
        bridge = bridge or self.bridge
        self.assertIsNone(bridge.convert(self.key, self.context, self.first, "daemon"))

    def test_delta_and_units(self):
        self.warm()
        result = self.bridge.convert(self.key, self.context, self.second, "daemon")
        self.assertEqual((result["active_us"], result["busy_us"]), (1000000, 500000))

    def test_idle_and_fully_busy_are_valid(self):
        for busy in (100, 1000100):
            with self.subTest(busy=busy):
                self.bridge.baselines.clear()
                self.warm()
                result = self.bridge.convert(self.key, self.context,
                                             {**self.second, "busy_us": busy}, "daemon")
                self.assertEqual(result["busy_us"], busy - 100)

    def test_epoch_and_daemon_restart_rebaseline(self):
        for context, instance, sample in (
            ({**self.context, "epoch": 2}, "daemon", self.second),
            (self.context, "restarted", self.second),
            (self.context, "daemon", {**self.second, "start_us": 1100000}),
        ):
            self.bridge.baselines.clear()
            self.warm()
            self.assertIsNone(self.bridge.convert(self.key, context, sample, instance))

    def test_partial_width_and_overrun_invalidate(self):
        for width, flags in ((80, 3), (20, 2)):
            self.warm()
            self.assertIsNone(self.bridge.convert(
                self.key, {**self.context, "width_mhz": width},
                {**self.second, "flags": flags}, "daemon"))
            self.assertNotIn(self.key, self.bridge.baselines)

    def test_invalid_busy_and_counter_reset(self):
        for sample in ({**self.second, "busy_us": 3000000},
                       {**self.second, "busy_us": 0},
                       {**self.second, "observed_us": 1500000}):
            self.bridge.baselines.clear()
            self.warm()
            with self.assertRaises(ValueError):
                self.bridge.convert(self.key, self.context, sample, "daemon")

    def test_fixed_fixture_exact_byte_in_millisecond_deltas(self):
        for utilization in (0, 1, 128, 254, 255):
            bridge = SurveyBridge(Path("/unused"), utilization)
            self.warm(bridge)
            result = bridge.convert(self.key, self.context, self.second, "daemon")
            self.assertEqual((result["busy_us"] // 1000) * 255 // (result["active_us"] // 1000),
                             utilization)

    def test_bridge_restart_changes_provider(self):
        self.warm()
        first = self.bridge.convert(self.key, self.context, self.second, "daemon")
        self.bridge.baselines.clear()
        self.assertIsNone(self.bridge.convert(self.key, self.context, self.second, "daemon"))
        next_sample = {**self.second, "observed_us": 4000000, "busy_us": 600100}
        second = self.bridge.convert(self.key, self.context, next_sample, "daemon")
        self.assertNotEqual(first["provider"], second["provider"])

    def test_context_abi(self):
        available, rows = parse_contexts(
            "v1 radio 02:00:00:00:00:00 available 1\n0 9 5180 20 0 0 0 0 0\n")
        self.assertTrue(available)
        self.assertEqual(rows[0]["frequency_mhz"], 5180)
        for invalid in ("", "v2 radio aa available 1", "v1 radio aa available 2",
                        "v1 radio aa available 1\n8 9 5180 20 0 0 0 0 0",
                        "v1 radio aa available 1\n0 9 5180 20 0 0 0 -1 0"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                parse_contexts(invalid)

    def test_one_query_per_frequency_and_unavailable_rebaseline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(2):
                path = root / f"phy{index}/hwsim/rf_survey"
                path.parent.mkdir(parents=True)
                path.write_text("v1 radio aa available 1\n0 1 5180 20 0 0 0 0 0\n")
            bridge = SurveyBridge(root)
            client = Mock(instance_id="daemon")
            client.get_channel_survey.return_value = self.first
            self.assertEqual(bridge.tick(client)["active_contexts"], 2)
            client.get_channel_survey.assert_called_once_with(5180)
            client.get_channel_survey.return_value = self.second
            with patch.object(Path, "write_text") as write:
                report = bridge.tick(client)
                self.assertEqual(write.call_count, 2)
                self.assertEqual(len(report["written"]), 2)
                self.assertFalse(report["physical_capacity_qualified"])
            for path in root.glob("*/hwsim/rf_survey"):
                path.write_text("v1 radio aa available 0\n")
            bridge.tick(client)
            self.assertFalse(bridge.baselines)


if __name__ == "__main__":
    unittest.main()
