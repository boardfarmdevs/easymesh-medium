from __future__ import annotations

import json
import copy
import unittest
from pathlib import Path

from wmdcfg.compiler import compile_scenario
from wmdcfg.model import ScenarioError
from wmdcfg.parser import parse


ROOT = Path(__file__).resolve().parents[1]
INVENTORY = json.loads((ROOT / "tests/fixtures/inventory.json").read_text())
BINDINGS = {"client": "wlan-client", "ap_a": "bpibroadband", "ap_b": "bpiap"}


class CompilerTests(unittest.TestCase):
    def compile(self, name: str = "two-ap-crossover.wmd"):
        source = (ROOT / "scenarios" / name).read_text()
        return compile_scenario(parse(source), source, INVENTORY, BINDINGS)

    def test_crossover_is_deterministic_and_complete(self):
        first = self.compile()
        second = self.compile()
        self.assertEqual(first, second)
        self.assertEqual(first["duration_ms"], 60_000)
        self.assertEqual(first["events"][0]["time_ms"], 0)
        self.assertEqual(len(first["events"][0]["updates"]), 4)
        final = next(event for event in first["events"] if event["time_ms"] == 40_000)
        values = {
            (item["source_role"], item["destination_role"]): item["value"]
            for item in final["updates"]
        }
        self.assertEqual(values[("client", "ap_a")], 10)
        self.assertEqual(values[("client", "ap_b")], 42)

    def test_health_expectation_covers_unbound_inventory(self):
        inventory = copy.deepcopy(INVENTORY)
        inventory["radios"].extend(
            [{"container": f"extra-ap-{index}", "kind": "mesh"} for index in range(3)]
            + [{"container": f"extra-sta-{index}", "kind": "station"} for index in range(9)]
        )
        source = (ROOT / "scenarios/two-ap-crossover.wmd").read_text()
        plan = compile_scenario(parse(source), source, inventory, BINDINGS)
        self.assertEqual(plan["expected_lab"], {"mesh_devices": 5, "clients": 10})

    def test_direction_expands_symmetrically(self):
        plan = self.compile("all-strong.wmd")
        pairs = {
            (item["source_role"], item["destination_role"])
            for item in plan["events"][0]["updates"]
        }
        self.assertEqual(
            pairs,
            {("client", "ap_a"), ("ap_a", "client"),
             ("client", "ap_b"), ("ap_b", "client")},
        )

    def test_rcpi_monitor_oscillates_one_live_link(self):
        source = (ROOT / "scenarios/client-rcpi-monitor.wmd").read_text()
        plan = compile_scenario(
            parse(source), source, INVENTORY,
            {"client": "wlan-client", "ap": "bpibroadband"},
        )
        self.assertEqual(plan["duration_ms"], 130_000)
        values = [
            update["value"]
            for event in plan["events"]
            for update in event["updates"]
            if update["source_role"] == "client"
        ]
        self.assertEqual(min(values), 25)
        self.assertEqual(max(values), 45)
        self.assertGreaterEqual(values.count(25), 6)
        self.assertGreaterEqual(values.count(45), 7)

    def test_missing_baseline_pair_is_rejected(self):
        source = """
scenario bad {
  protect backhaul
  restore captured
  role client : station
  role ap_a : fronthaul_ap
  role ap_b : fronthaul_ap
  phase baseline for 1s { link client <-> ap_a snr = 30dB }
}
"""
        with self.assertRaisesRegex(ScenarioError, "first phase"):
            compile_scenario(parse(source), source, INVENTORY, BINDINGS)

    def test_backhaul_protection_is_required(self):
        source = """
scenario bad {
  restore captured
  role client : station
  role ap_a : fronthaul_ap
  phase baseline for 1s { link client <-> ap_a snr = 30dB }
}
"""
        with self.assertRaisesRegex(ScenarioError, "protect backhaul"):
            compile_scenario(
                parse(source), source, INVENTORY,
                {"client": "wlan-client", "ap_a": "bpibroadband"},
            )

    def test_snr_range_and_units_are_strict(self):
        with self.assertRaisesRegex(ScenarioError, "outside"):
            parse("scenario bad { phase x for 1s { link a -> b snr = 80dB } }")
        with self.assertRaisesRegex(ScenarioError, "requires an integer dB"):
            parse("scenario bad { phase x for 1s { link a -> b snr = 10 } }")

    def test_binding_type_is_checked(self):
        source = (ROOT / "scenarios/two-ap-crossover.wmd").read_text()
        bindings = dict(BINDINGS, client="bpibroadband", ap_a="wlan-client")
        with self.assertRaisesRegex(ScenarioError, "expected"):
            compile_scenario(parse(source), source, INVENTORY, bindings)

    def test_band_qualified_link_resolves_target_ap_frequency(self):
        source = """
scenario band_specific {
  require frequency_qualified_snr
  protect backhaul
  restore captured
  role client : station
  role ap_a : fronthaul_ap
  phase baseline for 1s {
    link client <-> ap_a band 5GHz snr = 31dB
  }
}
"""
        plan = compile_scenario(
            parse(source), source, INVENTORY,
            {"client": "wlan-client", "ap_a": "bpibroadband"},
        )
        self.assertEqual(
            {item["frequency_mhz"] for item in plan["events"][0]["updates"]},
            {5180},
        )

    def test_unqualified_link_uses_station_band_physical_radio(self):
        inventory = copy.deepcopy(INVENTORY)
        station = next(item for item in inventory["radios"] if item["kind"] == "station")
        station["band"] = "6"
        mesh_index = 0
        for item in inventory["radios"]:
            if item["kind"] != "mesh":
                continue
            mesh_index += 1
            item["interfaces"].append(
                {
                    "name": "wifi2.1",
                    "mac": f"02:60:00:00:00:{mesh_index:02x}",
                    "ssid": "private_ssid",
                    "frequency_mhz": 5975,
                }
            )
            item["band_radios"] = {
                "2.4": {"tx_mac": f"42:24:00:00:00:{mesh_index:02x}"},
                "5": {"tx_mac": f"42:50:00:00:00:{mesh_index:02x}"},
                "6": {"tx_mac": f"42:60:00:00:00:{mesh_index:02x}"},
            }
        source = (ROOT / "scenarios/two-ap-crossover.wmd").read_text()
        plan = compile_scenario(parse(source), source, inventory, BINDINGS)
        ap_macs = {
            update["source"]
            for update in plan["events"][0]["updates"]
            if update["source_role"] in {"ap_a", "ap_b"}
        }
        self.assertEqual(
            ap_macs,
            {"42:60:00:00:00:01", "42:60:00:00:00:02"},
        )
        self.assertEqual(
            {update["frequency_mhz"] for update in plan["events"][0]["updates"]},
            {5975},
        )

    def test_band_qualified_link_requires_capability_and_cannot_mix(self):
        missing = """
scenario bad {
  protect backhaul
  restore captured
  role client : station
  role ap : fronthaul_ap
  phase x for 1s { link client <-> ap band 5GHz snr = 30dB }
}
"""
        with self.assertRaisesRegex(ScenarioError, "require frequency_qualified"):
            compile_scenario(
                parse(missing), missing, INVENTORY,
                {"client": "wlan-client", "ap": "bpibroadband"},
            )


if __name__ == "__main__":
    unittest.main()
