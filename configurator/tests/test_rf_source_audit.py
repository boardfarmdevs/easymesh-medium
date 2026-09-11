from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from wmdcfg.rf_source_audit import COMMON_CHECKS, NATIVE_CHECKS, inspect_source


class SourceAuditTests(unittest.TestCase):
    def check(self, component, identifier, source):
        checks = next(item for item in component if item[0] == identifier)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / checks[1]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source)
            result = inspect_source(root, [checks])
        return result["findings"][0]

    def test_pinned_rdk_success_without_output_is_identified(self):
        finding = self.check(NATIVE_CHECKS["rdk"], "rdk-channel-stats-stub",
                             "INT wifi_getRadioChannelStats(int radio, void *output) { return RETURN_OK; }")
        self.assertEqual(finding["state"], "baseline_confirmed")
        self.assertEqual(len(finding["sha256"]), 64)

    def test_a_fixed_provider_forces_a_new_baseline_review(self):
        finding = self.check(NATIVE_CHECKS["rdk"], "rdk-channel-stats-stub",
                             "INT wifi_getRadioChannelStats(int radio, void *output) { collect(output); return RETURN_OK; }")
        self.assertEqual(finding["state"], "review_required")

    def test_prpl_zero_rewrite_is_a_known_gap_not_valid_load(self):
        finding = self.check(NATIVE_CHECKS["prplmesh"], "prpl-scan-zero-rewrite",
                             "if (scan_result->utilization() == 0) { scan_result->utilization() = 10; }")
        self.assertEqual(finding["state"], "baseline_confirmed")
        self.assertIn("not a genuine", finding["reason"])

    def test_rx_rate_placeholder_is_detected(self):
        finding = self.check(COMMON_CHECKS["wmediumd"], "fixed-rx-rate",
                             "nla_put_u32(msg, HWSIM_ATTR_RX_RATE, 1)")
        self.assertEqual(finding["state"], "baseline_confirmed")

    def test_missing_source_is_not_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            result = inspect_source(Path(directory), COMMON_CHECKS["hwsim"])
        self.assertTrue(all(item["state"] == "missing" for item in result["findings"]))


if __name__ == "__main__":
    unittest.main()
