from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from wmdcfg.observers import foreign_devices, mesh_health, snapshot


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
        run.side_effect = [topology, "1 3 10 1 1"]
        health = mesh_health(expected_agents=1, expected_clients=1)
        self.assertEqual(health["complete_nodes"], 2)
        self.assertEqual(health["model_bsses"], 10)
        self.assertEqual(health["expected_model_associated"], 1)


    @patch("wmdcfg.observers._run")
    def test_adapter_devices_add_their_own_model_shape(self, run):
        # the gateway's agent plus two OpenSync pods (one radio, five BSSes,
        # no backhaul station in the controller's model)
        nodes = [{"name": "Controller", "STAList": [], "haulTypes": []},
                 {"name": "Agent-1", "STAList": [{"staMAC": "02:00:00:00:05:00"}], "haulTypes": []},
                 {"name": "Pod-1", "STAList": [], "haulTypes": []},
                 {"name": "Pod-2", "STAList": [], "haulTypes": []}]
        run.side_effect = [json.dumps({"nodes": nodes}), "3 5 20 1 1"]
        pods = [{"container": "pod-1", "radios": 1, "bsses": 5},
                {"container": "pod-2", "radios": 1, "bsses": 5}]
        health = mesh_health(expected_agents=1, expected_clients=1, adapters=pods)
        self.assertEqual((health["expected_topology_nodes"], health["expected_model_devices"],
                          health["expected_model_radios"], health["expected_model_bsses"],
                          health["expected_model_associated"]), (4, 3, 5, 20, 1))
        self.assertEqual(health["complete_nodes"], 4)

    @patch("wmdcfg.observers._run")
    def test_an_adapter_on_wifi_backhaul_adds_its_backhaul_station(self, run):
        # pod-2 joined the gateway's backhaul BSS: its backhaul STA row and its
        # association there are in the model; pod-1 stays on its wired path
        nodes = [{"name": "Controller", "STAList": [], "haulTypes": []},
                 {"name": "Agent-1", "STAList": [{"staMAC": "02:00:00:00:05:00"}], "haulTypes": []},
                 {"name": "Pod-1", "kind": "opensync-pod", "backhaulMedia": "Ethernet",
                  "STAList": [], "haulTypes": []},
                 {"name": "Pod-2", "kind": "opensync-pod", "backhaulMedia": "Wireless LAN",
                  "STAList": [], "haulTypes": []}]
        run.side_effect = [json.dumps({"nodes": nodes}), "3 5 21 2 2"]
        pods = [{"container": "pod-1", "radios": 1, "bsses": 5},
                {"container": "pod-2", "radios": 1, "bsses": 5}]
        health = mesh_health(expected_agents=1, expected_clients=1, adapters=pods)
        self.assertEqual((health["expected_model_bsses"], health["expected_model_associated"]), (21, 2))
        self.assertEqual(health["complete_nodes"], 4)

    @patch("wmdcfg.observers._run")
    def test_the_model_counts_its_access_point_bsses_apart_from_its_link_rows(self, run):
        # a link row: a device's row whose BSSID is its own upstream (DeviceList's
        # BackhaulMACAddress, zero when wired): one per agent of the lab, one per adapter node
        # on a Wi-Fi backhaul; every other row an access point's BSS (an agent's nine, an
        # adapter node's own count). The sum stays model_bsses.
        nodes = [{"name": "Controller", "STAList": [], "haulTypes": []},
                 {"name": "Agent-1", "STAList": [{"staMAC": "02:00:00:00:05:00"}], "haulTypes": []},
                 {"name": "Pod-1", "kind": "opensync-pod", "backhaulMedia": "Ethernet",
                  "STAList": [], "haulTypes": []},
                 {"name": "Pod-2", "kind": "opensync-pod", "backhaulMedia": "Wireless LAN",
                  "STAList": [], "haulTypes": []}]
        pods = [{"container": "pod-1", "radios": 1, "bsses": 5},
                {"container": "pod-2", "radios": 1, "bsses": 5}]
        run.side_effect = [json.dumps({"nodes": nodes}), "3 5 20 2 1"]
        health = mesh_health(expected_agents=1, expected_clients=1, adapters=pods)
        self.assertEqual({key: health[key] for key in (
            "model_bsses", "model_ap_bsses", "model_link_rows",
            "expected_model_bsses", "expected_model_ap_bsses", "expected_model_link_rows")}, {
            "model_bsses": 20, "model_ap_bsses": 19, "model_link_rows": 1,
            "expected_model_bsses": 21, "expected_model_ap_bsses": 19, "expected_model_link_rows": 2})
        # the whole count short: no complete-node override (only the Controller's node), as before
        self.assertEqual(health["complete_nodes"], 1)
        query = run.call_args_list[1].args[-1]
        self.assertIn("join DeviceList d on substring_index(substring_index(d.ID,'@',2),'@',-1)"
                      "=substring_index(substring_index(b.ID,'@',2),'@',-1) where b.BSSID=d.BackhaulMACAddress", query)

    @patch("wmdcfg.observers._run")
    def test_a_wired_extender_has_no_backhaul_station_association(self, run):
        # the gateway's agent and two extenders, one of them wired: one backhaul
        # station associated (the Wi-Fi extender's), not two
        nodes = [{"name": "Controller", "STAList": [], "haulTypes": []},
                 {"name": "Agent-1", "STAList": [{"staMAC": "02:00:00:00:05:00"}], "haulTypes": []},
                 {"name": "Extender-1", "STAList": [], "haulTypes": []},
                 {"name": "Extender-2", "STAList": [], "haulTypes": []}]
        run.side_effect = [json.dumps({"nodes": nodes}), "3 9 30 2 3"]
        health = mesh_health(expected_agents=3, expected_clients=1, wired=1)
        self.assertEqual(health["expected_model_associated"], 2)
        self.assertEqual(health["complete_nodes"], 4)

    @patch("wmdcfg.observers._run")
    def test_foreign_devices_are_left_out(self, run):
        # a physical pod joined to the controller (opensync-rpi), listed in the foreign
        # devices file: out of the topology's nodes and the model's counts
        nodes = [{"name": "Controller", "id": "00:60:2f:da:68:d4", "STAList": [], "haulTypes": []},
                 {"name": "Agent-1", "id": "00:60:2f:da:68:e4",
                  "STAList": [{"staMAC": "02:00:00:00:05:00"}], "haulTypes": []},
                 {"name": "Pod-1", "id": "02:C0:9E:DF:C1:A2", "kind": "opensync-pod",
                  "STAList": [{"staMAC": "aa:00:00:00:00:01"}], "haulTypes": []}]
        run.side_effect = [json.dumps({"nodes": nodes}), "1 3 10 1 1"]
        with tempfile.TemporaryDirectory() as directory:
            listed = Path(directory) / "foreign-devices"
            listed.write_text("# opensync-rpi\n02:c0:9e:df:c1:a2  # pi1\n\n")
            with patch.dict(os.environ, {"EASYMESH_FOREIGN_DEVICES": str(listed)}):
                health = mesh_health(expected_agents=1, expected_clients=1)
        self.assertEqual((health["topology_nodes"], health["api_active"], health["complete_nodes"]), (2, 1, 2))
        query = run.call_args_list[1].args[-1]
        self.assertIn("not in ('02:c0:9e:df:c1:a2')", query)
        self.assertIn("BackhaulSTA is not null", query)

    @patch("wmdcfg.observers._run")
    def test_without_foreign_devices_the_query_is_unchanged(self, run):
        nodes = [{"name": "Controller", "STAList": [], "haulTypes": []},
                 {"name": "Agent-1", "STAList": [{"staMAC": "02:00:00:00:05:00"}], "haulTypes": []}]
        run.side_effect = [json.dumps({"nodes": nodes}), "1 3 10 1 1"]
        with patch.dict(os.environ, {"EASYMESH_FOREIGN_DEVICES": "/nonexistent/foreign-devices"}):
            mesh_health(expected_agents=1, expected_clients=1)
        self.assertNotIn("not in", run.call_args_list[1].args[-1])

    @patch("wmdcfg.observers._run")
    def test_bss_rows_name_each_bss_in_the_model_with_its_device_and_band(self, run):
        # the same query, then one row per BSS: its device, its radio's band (none for a
        # row whose radio the model does not list), its BSSID, SSID and kind (a link row:
        # its BSSID its device's upstream, zero when wired; else an access point's BSS)
        nodes = [{"name": "Controller", "STAList": [], "haulTypes": []},
                 {"name": "Agent-1", "STAList": [{"staMAC": "02:00:00:00:05:00"}], "haulTypes": []}]
        rows = ("1 3 3 1 2\n"
                "00:60:2F:DA:68:E4\t1\t02:00:00:61:4f:f3\tmesh_backhaul\t0\n"
                "00:60:2f:da:68:e4\t1\t00:00:00:00:00:00\tmesh_backhaul\t1\n"
                "02:00:00:00:6a:01\tNULL\t72:00:00:00:6a:00\t\t1")
        run.side_effect = [json.dumps({"nodes": nodes}), rows]
        health = mesh_health(expected_agents=1, expected_clients=1, bss_rows=True)
        self.assertEqual(health["model_bsses"], 3)
        self.assertEqual(health["model_bss_rows"], [
            {"device": "00:60:2f:da:68:e4", "band": "5", "bssid": "02:00:00:61:4f:f3", "ssid": "mesh_backhaul",
             "kind": "bss"},
            {"device": "00:60:2f:da:68:e4", "band": "5", "bssid": "00:00:00:00:00:00", "ssid": "mesh_backhaul",
             "kind": "link"},
            {"device": "02:00:00:00:6a:01", "band": None, "bssid": "72:00:00:00:6a:00", "ssid": "", "kind": "link"}])
        query = run.call_args_list[1].args[-1]
        self.assertIn("from BSSList b left join RadioList r on r.RadioID=b.RUID left join DeviceList d", query)

    @patch("wmdcfg.observers._run")
    def test_bss_rows_leave_foreign_devices_out(self, run):
        nodes = [{"name": "Controller", "STAList": [], "haulTypes": []},
                 {"name": "Agent-1", "STAList": [{"staMAC": "02:00:00:00:05:00"}], "haulTypes": []}]
        run.side_effect = [json.dumps({"nodes": nodes}), "1 3 1 1 0\n00:60:2f:da:68:e4\t0\t02:00:00:00:0a:00\tiot_ssid\t0"]
        with tempfile.TemporaryDirectory() as directory:
            listed = Path(directory) / "foreign-devices"
            listed.write_text("02:c0:9e:df:c1:a2\n")
            with patch.dict(os.environ, {"EASYMESH_FOREIGN_DEVICES": str(listed)}):
                health = mesh_health(expected_agents=1, expected_clients=1, bss_rows=True)
        self.assertEqual([row["band"] for row in health["model_bss_rows"]], ["2.4"])
        rows_query = run.call_args_list[1].args[-1].split(";")[1]
        self.assertIn("where substring_index(substring_index(b.ID,'@',2),'@',-1) not in ('02:c0:9e:df:c1:a2')",
                      rows_query)

    @patch("wmdcfg.observers._run")
    def test_without_bss_rows_the_health_has_none(self, run):
        nodes = [{"name": "Controller", "STAList": [], "haulTypes": []},
                 {"name": "Agent-1", "STAList": [{"staMAC": "02:00:00:00:05:00"}], "haulTypes": []}]
        run.side_effect = [json.dumps({"nodes": nodes}), "1 3 10 1 1"]
        health = mesh_health(expected_agents=1, expected_clients=1)
        self.assertNotIn("model_bss_rows", health)
        self.assertNotIn("RadioList r", run.call_args_list[1].args[-1])

    def test_a_malformed_foreign_device_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            listed = Path(directory) / "foreign-devices"
            listed.write_text("02:c0:9e:df:c1\n")
            with patch.dict(os.environ, {"EASYMESH_FOREIGN_DEVICES": str(listed)}):
                with self.assertRaises(ValueError):
                    foreign_devices()


if __name__ == "__main__":
    unittest.main()
