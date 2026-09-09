from pathlib import Path
import unittest

from wmdcfg.world import compile_world, load_json, verify_world_plan


ROOT = Path(__file__).resolve().parents[1] / "worlds"


class QuickDemoWorldTests(unittest.TestCase):
    def world(self, name):
        world = load_json(ROOT / "golden" / f"{name}.world.json")
        verify_world_plan(world)
        layout = load_json(ROOT / "layouts" / f"{world['layout']}.json")
        mobility = load_json(ROOT / "mobility" / f"{world['mobility']}.json")
        self.assertEqual(compile_world(layout, mobility), world)
        self.assertEqual(sum(kind == "fronthaul_ap" for kind in world["roles"].values()), 5)
        self.assertTrue(all(all(frame["present"].values()) for frame in world["generations"]))
        return world

    def assert_best(self, frame, role, expected):
        for band in ("2.4", "5", "6"):
            candidates = sorted((link for link in frame["links"]
                                 if link["destination_role"] == role and link["link_class"] == "fronthaul"),
                                key=lambda link: link["snr_db_by_band"][band], reverse=True)
            self.assertEqual(candidates[0]["source_role"], expected)
            self.assertGreaterEqual(candidates[0]["snr_db_by_band"][band]
                                    - candidates[1]["snr_db_by_band"][band], 4)

    def test_single_client_crosses_wall_and_finishes_at_a_stronger_ap(self):
        world = self.world("home-a-one-client-handover")
        self.assertEqual(world["duration_ms"], 20000)
        self.assertEqual(world["counts"]["stations"], 11)
        self.assert_best(world["generations"][0], "sta_mobile_01", "extender_1")
        self.assert_best(world["generations"][-1], "sta_mobile_01", "gateway")
        self.assertEqual(world["generations"][-1]["positions"]["sta_mobile_01"], [10, 3])
        self.assertTrue(any(wall["start"][0] == 6 for wall in world["walls"]))
        for frame in world["generations"]:
            for role, position in frame["positions"].items():
                if role != "sta_mobile_01":
                    self.assertEqual(position, world["generations"][0]["positions"][role])

    def test_extender_moves_away_from_eight_stationary_clients(self):
        world = self.world("large-room-extender-evacuation")
        self.assertEqual(world["duration_ms"], 20000)
        self.assertEqual(world["counts"]["stations"], 12)
        initial, final = world["generations"][0], world["generations"][-1]
        self.assertEqual(initial["positions"]["extender_1"], [8, 8])
        self.assertEqual(final["positions"]["extender_1"], [36, 32])
        for number in range(1, 9):
            role = f"sta_static_{number:02d}"
            self.assert_best(initial, role, "extender_1")
            self.assert_best(final, role, "gateway")
        for frame in world["generations"]:
            for role, position in frame["positions"].items():
                if role != "extender_1":
                    self.assertEqual(position, initial["positions"][role])

    def test_two_perimeter_walkers_visit_all_extenders_in_opposite_order(self):
        world = self.world("large-room-perimeter-counter-roam")
        self.assertEqual(world["duration_ms"], 60000)
        self.assertEqual(world["pause_at_ms"], [14000, 28000, 42000])
        self.assertEqual(world["counts"]["stations"], 12)
        self.assertEqual(world["walls"], [])
        orders = {"sta_mobile_01": [1, 2, 4, 3, 1], "sta_mobile_02": [1, 3, 4, 2, 1]}
        frames = {frame["time_ms"]: frame for frame in world["generations"]}
        for role, order in orders.items():
            for elapsed, extender in zip((0, 14000, 28000, 42000, 56000), order):
                self.assert_best(frames[elapsed], role, f"extender_{extender}")
            self.assertEqual(frames[0]["positions"][role], world["generations"][-1]["positions"][role])
        for frame in world["generations"]:
            for role, position in frame["positions"].items():
                if role in orders:
                    self.assertLessEqual(min(*position, 40 - position[0], 40 - position[1]), 3)
                else:
                    self.assertEqual(position, frames[0]["positions"][role])
            self.assertNotEqual(frame["positions"]["sta_mobile_01"], frame["positions"]["sta_mobile_02"])


if __name__ == "__main__":
    unittest.main()
