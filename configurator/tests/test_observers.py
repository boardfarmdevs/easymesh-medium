from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from wmdcfg.observers import mesh_health, snapshot


class ObserverTests(unittest.TestCase):
    @patch("wmdcfg.observers._run")
    def test_snapshot_reads_all_associations_in_one_controller_query(self, run):
        run.return_value = "02:00:00:00:05:00 02:00:00:00:09:00 88"
        result = snapshot(
            {
                "bindings": {
                    "client": {
                        "role_type": "station",
                        "container": "wlan-client",
                        "radio_permanent_mac": "02:00:00:00:05:00",
                    },
                    "ap": {"role_type": "fronthaul_ap"},
                }
            }
        )
        self.assertEqual(
            result["stations"],
            [{
                "role": "client",
                "container": "wlan-client",
                "mac": "02:00:00:00:05:00",
                "bssid": "02:00:00:00:09:00",
                "rcpi": 88,
            }],
        )
        self.assertEqual(run.call_count, 1)

    @patch("wmdcfg.observers._run")
    def test_mesh_health_accepts_null_optional_lists(self, run):
        run.return_value = json.dumps(
            {
                "nodes": [
                    {"name": "Controller", "STAList": None, "haulTypes": None},
                    {
                        "name": "Agent-1",
                        "STAList": [{"staMAC": "02:00:00:00:05:00"}],
                        "haulTypes": [
                            {"BSSList": [{} for _ in range(10)]},
                            {"BSSList": None},
                        ],
                    },
                ]
            }
        )

        self.assertEqual(
            mesh_health(),
            {
                "api_active": 1,
                "api_total": 1,
                "topology_nodes": 2,
                "complete_nodes": 2,
            },
        )

    @patch("wmdcfg.observers._run")
    def test_expected_health_uses_authoritative_model_not_webui_bss_projection(self, run):
        topology = json.dumps(
            {
                "nodes": [
                    {"name": "Controller", "STAList": [], "haulTypes": []},
                    {
                        "name": "Agent-1",
                        "STAList": [{"staMAC": "02:00:00:00:05:00"}],
                        "haulTypes": [],
                    },
                ]
            }
        )
        run.side_effect = [topology, "1 3 10 1"]
        health = mesh_health(expected_agents=1, expected_clients=1)
        self.assertEqual(health["complete_nodes"], 2)
        self.assertEqual(health["model_bsses"], 10)
        self.assertEqual(health["expected_model_associated"], 1)


if __name__ == "__main__":
    unittest.main()
