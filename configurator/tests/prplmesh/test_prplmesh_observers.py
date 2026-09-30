from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from wmdcfg.observers import mesh_health, snapshot


def topology() -> dict:
    devices = []
    for device_index, name in enumerate(("controller", "agent-1")):
        radios = []
        for radio_index, band in enumerate(("2.4 GHz", "5 GHz", "6 GHz")):
            clients = []
            if device_index == 1 and radio_index == 1:
                clients = [{"id": "02:00:00:10:01:00", "signal_raw": 88}]
            radios.append(
                {
                    "bsses": [
                        {
                            "bssid": f"02:00:00:00:{device_index * 3 + radio_index:02x}:00",
                            "clients": clients,
                        },
                        {"bssid": "02:00:00:00:ff:01", "clients": []},
                        {"bssid": "02:00:00:00:ff:02", "clients": []},
                    ],
                    "band": band,
                }
            )
        devices.append({"name": name, "radios": radios})
    return {"source": "prplMesh NBAPI", "devices": devices}


class ObserverTests(unittest.TestCase):
    @patch("wmdcfg.observers._run")
    def test_snapshot_reads_station_from_prplmesh_topology(self, run):
        run.return_value = json.dumps(topology())
        result = snapshot(
            {
                "bindings": {
                    "client": {
                        "role_type": "station",
                        "container": "prpl-client-01",
                        "radio_permanent_mac": "02:00:00:00:0f:00",
                        "station_mac": "02:00:00:10:01:00",
                    },
                    "ap": {"role_type": "fronthaul_ap"},
                }
            }
        )
        self.assertEqual(result["stations"][0]["mac"], "02:00:00:10:01:00")
        self.assertEqual(result["stations"][0]["bssid"], "02:00:00:00:04:00")
        self.assertEqual(result["stations"][0]["rcpi"], 88)
        self.assertEqual(result["stations"][0]["device"], "agent-1")
        self.assertEqual(run.call_count, 1)

    @patch("wmdcfg.observers._run")
    def test_mesh_health_counts_complete_devices_and_clients(self, run):
        run.return_value = json.dumps(topology())
        health = mesh_health(expected_agents=2, expected_clients=1)
        self.assertEqual(health["api_active"], 1)
        self.assertEqual(health["api_total"], 1)
        self.assertEqual(health["topology_nodes"], 2)
        self.assertEqual(health["complete_nodes"], 2)
        self.assertEqual(health["expected_topology_nodes"], 2)


if __name__ == "__main__":
    unittest.main()
