from pathlib import Path
import unittest

from wmdcfg.world import compile_world, load_json, verify_world_plan


ROOT = Path(__file__).resolve().parents[1] / "worlds"


class BackhaulBranchTests(unittest.TestCase):
    def test_branch_relays_exceed_hysteresis_against_every_alternative(self):
        world = load_json(ROOT / "golden/backhaul-branch-formation.world.json")
        verify_world_plan(world)
        self.assertEqual(world, compile_world(
            load_json(ROOT / "layouts" / f"{world['layout']}.json"),
            load_json(ROOT / "mobility/backhaul-branch-formation.json")))
        self.assertEqual(world["duration_ms"], 24000)
        self.assertEqual(world["pause_at_ms"], [12000])
        self.assertEqual(world["counts"]["stations"], 10)
        self.assertEqual(world["layout"], "backhaul-branches")
        self.assertEqual(world["generations"][0]["positions"], world["generations"][-1]["positions"])
        mesh_roles = {role for role, kind in world["roles"].items() if kind == "fronthaul_ap"}
        for frame in world["generations"]:
            if not 10000 <= frame["time_ms"] <= 14000:
                continue
            for relay, child in (("extender_1", "extender_3"), ("extender_2", "extender_4")):
                links = {link["source_role"]: link["snr_db_by_band"] for link in frame["links"]
                         if link["destination_role"] == child and link["source_role"] in mesh_roles}
                self.assertEqual(set(links), mesh_roles - {child})
                for band in ("2.4", "5", "6"):
                    for alternative in mesh_roles - {child, relay}:
                        with self.subTest(time=frame["time_ms"], child=child, band=band, alternative=alternative):
                            self.assertGreaterEqual(links[relay][band] - links[alternative][band], 8)
                    if band == "5":
                        self.assertGreaterEqual(links[relay][band] - links["gateway"][band], 10)
                        self.assertLess(links["gateway"][band], 0)


if __name__ == "__main__":
    unittest.main()
