from __future__ import annotations

import copy
from contextlib import redirect_stdout
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from wmdcfg.actuator import ActuatorError, ControlClient, HEADER, OP_STATUS
from wmdcfg.cli import main
from wmdcfg.rf_contract import capability_manifest, measurement, survey_utilization


def sample(**changes):
    return {
        "instance_id": "boot-medium", "radio_id": "phy1", "frequency_mhz": 5180,
        "width_mhz": 20, "context_epoch": 1, "sampled_at_ns": 1_000_000_000,
        "counter_unit": "ms", "valid_fields": ["active_ms", "busy_ms"],
        "active_ms": 100, "busy_ms": 20, **changes,
    }


class MeasurementTests(unittest.TestCase):
    def measured(self, raw_value, **changes):
        arguments = {
            "source": "fixture-qualified-survey", "supported": True,
            "sampled_at_ns": 100, "now_ns": 150, "max_age_ns": 100, **changes,
        }
        return measurement("channel_utilization", raw_value, **arguments)

    def test_measured_idle_is_valid_zero(self):
        result = self.measured(0)
        self.assertEqual((result["state"], result["value"]), ("valid", 0))

    def test_unsupported_zero_stays_diagnostic(self):
        for attribute, raw_value, source in (
            ("channel_utilization", 0, "rdk-success-no-output"),
            ("channel_utilization", 0, "prpl-default-monitor-value"),
            ("channel_utilization", 12.5, "hwsim-dummy-scan"),
            ("noise", 0, "prpl-radio-noise-placeholder"),
            ("noise", -92, "hwsim-dummy-noise"),
            ("rx_rate", 1, "wmediumd-fixed-rx-rate-index"),
            ("bss_load_utilization", 10, "prpl-scan-zero-rewrite"),
        ):
            with self.subTest(source=source):
                result = measurement(attribute, raw_value, source=source)
                self.assertEqual(result["state"], "unsupported")
                self.assertIsNone(result["value"])
                self.assertEqual(result["raw_value"], raw_value)

    def test_missing_and_stale_are_not_zero(self):
        self.assertEqual(self.measured(None)["state"], "missing")
        stale = self.measured(0, now_ns=201)
        self.assertEqual(stale["state"], "stale")
        self.assertIsNone(stale["value"])
        self.assertEqual(stale["raw_value"], 0)

    def test_time_is_not_invented_at_receipt(self):
        for changes, state in (
            ({"sampled_at_ns": None}, "missing"),
            ({"max_age_ns": None}, "missing"),
            ({"sampled_at_ns": 151}, "invalid"),
            ({"max_age_ns": -1}, "invalid"),
        ):
            with self.subTest(changes=changes):
                self.assertEqual(self.measured(10, **changes)["state"], state)

    def test_invalid_numbers_and_units(self):
        for value in (True, "0", -1, 101, float("nan"), float("inf")):
            with self.subTest(value=value):
                result = self.measured(value)
                self.assertEqual(result["state"], "invalid")
                self.assertIsNone(result["value"])
                json.dumps(result, allow_nan=False)

    def test_validity_requires_qualified_provider(self):
        with self.assertRaisesRegex(ValueError, "unsupported provider"):
            measurement("noise", 0, source="placeholder", state="valid")

    def test_reserved_rcpi_and_raw_bss_load_encoding(self):
        for attribute, values, valid in (
            ("rcpi", (0, 220), True), ("rcpi", (221, 255, -1, 1.5), False),
            ("bss_load_utilization", (0, 128, 255), True),
            ("bss_load_utilization", (256, -1, 0.5), False),
        ):
            for value in values:
                with self.subTest(attribute=attribute, value=value):
                    result = measurement(
                        attribute, value, source="fixture", supported=True,
                        sampled_at_ns=100, now_ns=100, max_age_ns=100,
                    )
                    self.assertEqual(result["state"] == "valid", valid)

    def test_unknown_attribute_or_state_fails(self):
        with self.assertRaises(ValueError):
            measurement("made-up", 0, source="fixture")
        with self.assertRaises(ValueError):
            self.measured(0, state="good")


class SurveyTests(unittest.TestCase):
    def delta(self, previous=None, current=None, **changes):
        arguments = {"now_ns": 2_000_000_000, "max_age_ns": 1_000_000, "qualified": True, **changes}
        return survey_utilization(
            sample() if previous is None else previous,
            sample(active_ms=200, busy_ms=20, sampled_at_ns=2_000_000_000) if current is None else current,
            **arguments,
        )

    def test_zero_midpoint_and_full_byte_boundaries(self):
        for busy, percent, encoded in ((20, 0, 0), (70, 50, 128), (120, 100, 255)):
            with self.subTest(busy=busy):
                result = self.delta(current=sample(active_ms=200, busy_ms=busy, sampled_at_ns=2_000_000_000))
                self.assertEqual((result["state"], result["value"], result["bss_load_byte"]), ("valid", percent, encoded))

    def test_current_backend_cannot_qualify_dummy_counters(self):
        result = self.delta(qualified=False)
        self.assertEqual(result["state"], "unsupported")
        self.assertIsNone(result["value"])

    def test_first_sample_and_zero_window_are_warming_up(self):
        first = survey_utilization(None, sample(), now_ns=1_000_000_000, max_age_ns=10, qualified=True)
        self.assertEqual(first["state"], "warming_up")
        result = self.delta(current=sample(sampled_at_ns=2_000_000_000))
        self.assertEqual(result["state"], "warming_up")
        self.assertIsNone(result["value"])

    def test_epoch_radio_frequency_width_or_instance_change_resets_window(self):
        for field, value in (
            ("context_epoch", 2), ("radio_id", "phy2"), ("frequency_mhz", 2437),
            ("width_mhz", 40), ("instance_id", "restarted"),
        ):
            with self.subTest(field=field):
                current = sample(active_ms=200, busy_ms=20, sampled_at_ns=2_000_000_000, **{field: value})
                self.assertEqual(self.delta(current=current)["state"], "warming_up")

    def test_missing_identity_and_valid_flags(self):
        for changes, state in (
            ({"context_epoch": None}, "missing"),
            ({"valid_fields": ["active_ms"]}, "partial"),
            ({"counter_unit": "us"}, "invalid"),
            ({"active_ms": -1}, "invalid"),
            ({"active_ms": True}, "invalid"),
            ({"sampled_at_ns": 500}, "invalid"),
        ):
            with self.subTest(changes=changes):
                current = sample(**{**sample(active_ms=200, sampled_at_ns=2_000_000_000), **changes})
                self.assertEqual(self.delta(current=current)["state"], state)

    def test_counter_reset_or_busy_overflow_not_accepted(self):
        for active, busy in ((99, 21), (200, 19), (101, 25), (200, 201)):
            with self.subTest(active=active, busy=busy):
                current = sample(active_ms=active, busy_ms=busy, sampled_at_ns=2_000_000_000)
                self.assertEqual(self.delta(current=current)["state"], "invalid")

    def test_large_64_bit_counters_difference_before_conversion(self):
        base = 2 ** 60
        result = self.delta(
            previous=sample(active_ms=base, busy_ms=base // 2),
            current=sample(active_ms=base + 100, busy_ms=base // 2 + 50, sampled_at_ns=2_000_000_000),
        )
        self.assertEqual(result["value"], 50)

    def test_stale_interval_cannot_publish_a_byte(self):
        result = self.delta(now_ns=2_002_000_000)
        self.assertEqual(result["state"], "stale")
        self.assertIsNone(result["value"])
        self.assertIsNone(result["bss_load_byte"])


class CapabilityTests(unittest.TestCase):
    def test_cli_exposes_the_offline_contract_without_contacting_a_daemon(self):
        output = io.StringIO()
        with patch("wmdcfg.cli.ControlClient") as client, redirect_stdout(output):
            self.assertEqual(main(["rf-capabilities"]), 0)
        client.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())["schema"], "easymesh.rf-capabilities.v1")

    def test_protocol_version_mismatch_is_not_silently_accepted(self):
        client = ControlClient("/fixture/socket")
        client.socket = Mock()
        client.socket.recv.return_value = HEADER.pack(0x574D4443, 2, OP_STATUS, 0, 0, 0)
        with self.assertRaisesRegex(ActuatorError, "protocol mismatch"):
            client.status()

    def test_no_live_endpoint_means_unknown_configured_signal(self):
        for backend in ("userspace", "kernel"):
            manifest = capability_manifest(backend)
            self.assertEqual(manifest["wire"]["state"], "missing")
            self.assertEqual(manifest["capabilities"]["configured_snr"]["state"], "missing")
            self.assertEqual(manifest["capabilities"]["channel_utilization"]["state"], "unsupported")
            self.assertFalse(any(manifest["qualification"].values()))

    def test_actual_capabilities_and_model_provenance_are_preserved(self):
        status = SimpleNamespace(instance_id="medium", generation=12,
                                 capabilities={"read_only", "frequency_qualified_snr"})
        manifest = capability_manifest("userspace", status)
        self.assertEqual(manifest["wire"]["generation"], 12)
        self.assertEqual(manifest["capabilities"]["frequency_qualified_snr"]["state"], "valid")
        self.assertEqual(manifest["capabilities"]["candidate_rcpi"]["source_kind"], "hal_matrix")
        changed = copy.deepcopy(manifest)
        changed["qualification"]["measured_airtime"] = True
        self.assertFalse(capability_manifest("userspace", status)["qualification"]["measured_airtime"])

    def test_modeled_capability_is_not_a_qualified_native_measurement(self):
        status = SimpleNamespace(instance_id="medium", generation=12,
                                 capabilities={"read_only", "channel_survey"})
        manifest = capability_manifest("userspace", status)
        self.assertEqual(manifest["profile"], "single-contention-domain-legacy20")
        self.assertTrue(manifest["qualification"]["modeled_airtime_api"])
        self.assertFalse(manifest["qualification"]["physical_capacity"])
        self.assertFalse(manifest["qualification"]["measured_airtime"])
        self.assertEqual(manifest["capabilities"]["modeled_channel_survey"]["state"], "available")
        for attribute in ("channel_utilization", "bss_load_utilization"):
            self.assertEqual(manifest["capabilities"][attribute]["state"], "missing")

    def test_userspace_capability_does_not_qualify_the_kernel_backend(self):
        status = SimpleNamespace(instance_id="medium", generation=12,
                                 capabilities={"read_only", "channel_survey"})
        manifest = capability_manifest("kernel", status)
        self.assertFalse(manifest["qualification"]["modeled_airtime_api"])
        self.assertEqual(manifest["capabilities"]["channel_utilization"]["state"], "unsupported")

    def test_unknown_backend_rejected(self):
        with self.assertRaisesRegex(ValueError, "backend"):
            capability_manifest("invented")


if __name__ == "__main__":
    unittest.main()
