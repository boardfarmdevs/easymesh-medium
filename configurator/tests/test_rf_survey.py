from __future__ import annotations

import unittest

from wmdcfg.rf_survey import normalized, percentile


def context(**changes):
    return {
        "radio": "02:00:00:00:00:00", "frequency_mhz": 5180, "width_mhz": 20,
        "epoch": 3, "provider": 17, "active_us": 1234567, "busy_us": 123456,
        "observed_us": 9000001, "valid": True, **changes,
    }


class SurveyAuditTests(unittest.TestCase):
    def test_native_units_preserve_observation_time(self):
        result = normalized(context(), "medium")
        self.assertEqual(result["counter_unit"], "ms")
        self.assertEqual(result["active_ms"], 1234)
        self.assertEqual(result["busy_ms"], 123)
        self.assertEqual(result["sampled_at_ns"], 9000001000)
        self.assertEqual(result["valid_fields"], ["active_ms", "busy_ms"])

    def test_invalid_or_unsupported_context_has_no_supported_counters(self):
        for changes in ({"valid": False}, {"width_mhz": 40}, {"width_mhz": 80}):
            with self.subTest(changes=changes):
                self.assertEqual(normalized(context(**changes), "medium")["valid_fields"], [])

    def test_provider_restart_changes_context_identity(self):
        before = normalized(context(), "medium")
        after = normalized(context(provider=18), "medium")
        self.assertNotEqual(before["context_epoch"], after["context_epoch"])
        self.assertEqual(after["context_epoch"], [3, 18])
        self.assertEqual(after["instance_id"], "medium")

    def test_percentiles_handle_empty_single_and_unsorted_samples(self):
        self.assertIsNone(percentile([], .99))
        self.assertEqual(percentile([7], .99), 7)
        self.assertEqual(percentile([9, 1, 5], .5), 5)
        self.assertEqual(percentile([9, 1, 5], 1), 9)


if __name__ == "__main__":
    unittest.main()
