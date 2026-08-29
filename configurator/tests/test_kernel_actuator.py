from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from wmdcfg.kernel_actuator import KernelMediumClient


class _TestClient(KernelMediumClient):
    def _instance_id(self) -> str:
        return "0" * 32


class KernelMediumActuatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.debug = root / "debug"
        self.parameters = root / "parameters"
        self.parameters.mkdir(parents=True)
        (self.parameters / "kernel_medium").write_text("Y\n")
        (self.parameters / "kernel_medium_generation").write_text("7\n")
        (self.parameters / "kernel_medium_bank").write_text("1\n")
        controls = {
            "phy0": (
                "radio 42:00:00:00:00:00 idx 0 active_bank 1\n"
                "default signal -50 loss_pct 0 cutoff -95\n"
                "stats considered 10 delivered 10 dropped 0\n"
            ),
            "phy1": (
                "radio 42:00:00:00:01:00 idx 1 active_bank 1\n"
                "default signal -50 loss_pct 0 cutoff -95\n"
                "set 1 42:00:00:00:00:00 5 -61 0\n"
                "stats considered 10 delivered 10 dropped 0\n"
            ),
        }
        for phy, text in controls.items():
            path = self.debug / phy / "hwsim"
            path.mkdir(parents=True)
            (path / "kernel_medium_links").write_text(text)
        self.client = _TestClient(
            str(self.debug),
            parameters_root=str(self.parameters),
            lock_path=str(root / "medium.lock"),
        )

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def test_status_pair_inventory_and_band_readback(self):
        with self.client as client:
            status = client.status()
            self.assertEqual(status.generation, 7)
            self.assertEqual(status.num_stations, 2)
            self.assertIn("kernel_data_path", status.capabilities)
            generation, pairs = client.dump_links()
            self.assertEqual(generation, 7)
            self.assertEqual(len(pairs), 2)
            self.assertEqual(
                client.get_frequency_link(
                    "42:00:00:00:00:00", "42:00:00:00:01:00", 5180
                ),
                (7, 30, True),
            )
            self.assertEqual(
                client.get_frequency_link(
                    "42:00:00:00:00:00", "42:00:00:00:01:00", 2437
                ),
                (7, 41, False),
            )


if __name__ == "__main__":
    unittest.main()
