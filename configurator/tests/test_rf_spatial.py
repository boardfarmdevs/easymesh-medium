import io
import json
import unittest
from unittest.mock import patch

from wmdcfg.rf_spatial import compare_trials, diagnostic_sample, fixture_links, private_channels, private_radio, registered_radio, roam_client


class SpatialQualificationTests(unittest.TestCase):
    def test_private_channel_snapshot_uses_frequency_not_old_iw_channel_labels(self):
        text = """Interface wifi2
    addr 02:00:00:00:02:00
    ssid private_ssid
    type AP
    channel 227 (6135 MHz), width: 20 MHz, center1: 6135 MHz
Interface wifi1
    addr 02:00:00:00:01:00
    ssid private_ssid
    type AP
    channel 36 (5180 MHz), width: 20 MHz, center1: 5180 MHz
"""
        radios = private_channels(text)
        self.assertEqual(radios['wifi2'], {'frequency': 6135, 'channel': 37, 'width': 20,
                                           'bssid': '02:00:00:00:02:00'})
        self.assertEqual(radios['wifi1']['channel'], 36)
        self.assertEqual(private_channels(text.replace('private_ssid', 'mesh_backhaul')), {})
        with self.assertRaisesRegex(RuntimeError, 'complete operating channel'):
            private_channels(text.replace('6135 MHz), width: 20 MHz', '6135 MHz)'))
        with self.assertRaisesRegex(RuntimeError, 'unsupported private AP frequency'):
            private_channels(text.replace('6135 MHz', '9999 MHz'))

    def test_diagnostics_read_native_rates_and_keep_console_capture_identity(self):
        snapshot = {"captured_at": "2026-09-12T00:00:00Z", "daemon": {"instance_id": "native", "generation": 3},
                    "packet_metrics": {"summary": {"queue_depth": 5}}, "radio_frequencies": []}
        with patch("wmdcfg.rf_spatial.net_command", return_value="tx bitrate: 13 MBit/s") as native, \
                patch("wmdcfg.rf_spatial.urllib.request.urlopen", return_value=io.StringIO(json.dumps(snapshot))) as console:
            sample = diagnostic_sample({"ap": 10, "client": 20}, ["ap"], ["client"],
                                       [{"interface": "wlan0"}], ["02:00:00:00:01:00"], 8090, "native", 3)
        self.assertEqual(sample["clients"]["client"], "tx bitrate: 13 MBit/s")
        self.assertEqual(sample["medium"], snapshot)
        self.assertTrue(sample["medium_current"])
        self.assertEqual(native.call_count, 3)
        console.assert_called_once_with("http://127.0.0.1:8090/api/v1/snapshot", timeout=3)
        native.assert_any_call(20, "ss", "-tin", "dport = :55203")
        for instance, generation in (("old", 3), ("native", 2)):
            with self.subTest(instance=instance, generation=generation), \
                    patch("wmdcfg.rf_spatial.net_command", return_value=""), \
                    patch("wmdcfg.rf_spatial.urllib.request.urlopen", return_value=io.StringIO(json.dumps(snapshot))):
                stale = diagnostic_sample({"ap": 10, "client": 20}, ["ap"], ["client"],
                                          [{"interface": "wlan0"}], ["02:00:00:00:01:00"], 8090, instance, generation)
                self.assertFalse(stale["medium_current"])

    def test_private_radio_does_not_select_a_backhaul_or_another_band(self):
        text = """phy#1
    Interface backhaul
        addr 02:00:00:00:01:02
        ssid mesh_backhaul
        type AP
        channel 6 (2437 MHz), width: 20 MHz
    Interface fast
        addr 02:00:00:00:01:01
        ssid private_ssid
        type AP
        channel 36 (5180 MHz), width: 20 MHz
    Interface slow
        addr 02:00:00:00:02:01
        ssid private_ssid
        type AP
        channel 6 (2437 MHz), width: 20 MHz
"""
        self.assertEqual(private_radio(text), {"interface": "slow", "bssid": "02:00:00:00:02:01", "frequency": 2437})
        with self.assertRaisesRegex(RuntimeError, "no private"):
            private_radio(text.replace("ssid private_ssid", "ssid iot_ssid"))
        with self.assertRaisesRegex(RuntimeError, "backhaul is active"):
            private_radio(text + "    Interface uplink\n        type managed\n        channel 6 (2437 MHz)\n")

    def test_isolation_and_directed_hidden_receiver_are_frequency_scoped(self):
        radios = [{"bssid": f"02:00:00:00:0{number}:01", "radio": f"42:00:00:00:0{number}:00",
                   "frequency": 2437} for number in range(1, 6)]
        clients = ["02:00:00:00:11:00", "02:00:00:00:12:00"]
        visible = fixture_links(radios, clients)
        hidden = fixture_links(radios, clients, hidden=True)
        self.assertTrue(all(item["frequency_mhz"] == 2437 for item in visible))
        self.assertTrue(all(-20 <= item["value"] <= 60 for item in visible + hidden))
        self.assertEqual(len({(item["source"], item["destination"]) for item in visible}), len(visible))
        differences = [(before, after) for before, after in zip(visible, hidden) if before != after]
        self.assertEqual(len(differences), 1)
        before, after = differences[0]
        self.assertEqual((after["source"], after["destination"], before["value"], after["value"]),
                         (clients[1], radios[0]["radio"], -20, 10))
        serving = [item for item in visible if item["value"] == 40]
        self.assertEqual(len(serving), 4)
        with self.assertRaisesRegex(ValueError, "one 2.4 GHz channel"):
            fixture_links([radios[0], {**radios[1], "frequency": 5180}], clients)
        with self.assertRaisesRegex(ValueError, "distinct clients"):
            fixture_links(radios, clients[:1])

    def trials(self, isolation=180, hidden=100):
        return [{"mode": mode, "aggregate_bps": value, "received_bps": [value / 2, value / 2],
                 "same_associations": True, "rf_readback": True, "survey_valid": True}
                for mode, value in (("global", 100), ("isolated", isolation), ("hidden_receiver", hidden))
                for repeat in range(2)]

    def test_model_gates_are_not_weakened_by_noise_or_missing_links(self):
        self.assertEqual(compare_trials(self.trials())["state"], "passed")
        self.assertEqual(compare_trials(self.trials(isolation=110))["state"], "failed")
        self.assertEqual(compare_trials(self.trials(hidden=180))["state"], "failed")
        self.assertEqual(compare_trials(self.trials()[:-1])["state"], "failed")
        noisy = self.trials()
        noisy[0]["aggregate_bps"] = 120
        self.assertEqual(compare_trials(noisy)["state"], "inconclusive")
        for field in ("same_associations", "rf_readback", "survey_valid"):
            invalid = self.trials()
            invalid[0][field] = False
            self.assertEqual(compare_trials(invalid)["state"], "failed")
        stalled = self.trials()
        stalled[0]["received_bps"] = [0, 100]
        self.assertEqual(compare_trials(stalled)["state"], "failed")

    def test_roam_requires_a_request_and_confirmed_frequency_not_just_a_scan(self):
        target = "02:00:00:00:01:01"
        connected = f"Connected to {target} (on wlan0)\n\tfreq: 2437\n"
        with patch("wmdcfg.rf_spatial.command", side_effect=["Not connected", "OK", connected]) as command, \
                patch("wmdcfg.rf_spatial.scan_for_roam") as scan:
            roam_client("client", target, 2437)
        scan.assert_called_once_with("client", target, 2437)
        self.assertEqual(command.call_args_list[1].args[-2:], ("roam", target))
        with patch("wmdcfg.rf_spatial.command", side_effect=["Not connected", "FAIL"]), \
                patch("wmdcfg.rf_spatial.scan_for_roam"):
            with self.assertRaisesRegex(RuntimeError, "roam rejected"):
                roam_client("client", target, 2437)

    def test_already_associated_client_is_not_disrupted(self):
        target = "02:00:00:00:01:01"
        with patch("wmdcfg.rf_spatial.command", return_value=f"Connected to {target} (on wlan0)\n\tfreq: 2437\n"), \
                patch("wmdcfg.rf_spatial.scan_for_roam") as scan:
            roam_client("client", target, 2437)
        scan.assert_not_called()

    def test_stable_radio_identity_survives_medium_vif_learning_reset(self):
        provisioned = "42:00:00:00:03:00"
        with patch("wmdcfg.rf_spatial.command", side_effect=["wiphy 7", "02:00:00:00:03:00\n" + provisioned]):
            self.assertEqual(registered_radio("node", "wifi0", {provisioned}), provisioned)
        with patch("wmdcfg.rf_spatial.command", side_effect=["wiphy 7", "02:00:00:00:03:00"]):
            with self.assertRaisesRegex(RuntimeError, "unique provisioned"):
                registered_radio("node", "wifi0", {provisioned})
