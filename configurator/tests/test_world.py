from __future__ import annotations

import unittest
import json

from wmdcfg.model import ScenarioError
from wmdcfg.geometry import directed_link, quantize_position, wall_crossings
from wmdcfg.parser import parse
from wmdcfg.compiler import validate_scenario
from wmdcfg.world import compile_world, export_wmd, verify_world_plan


def _layout(walls=True):
    return {
        "schema": "wmdcfg.world-layout.v1",
        "name": "tiny-home",
        "space": {"width_m": 10, "height_m": 5},
        "tags": ["test"],
        "propagation": {
            "reference_distance_m": 1,
            "reference_snr_db_by_band": {"2.4": 50, "5": 46, "6": 43},
            "path_loss_exponent": 2,
            "shadowing_stddev_db": 0,
            "minimum_snr_db": -20,
            "maximum_snr_db": 60,
        },
        "walls": [{"start": [5, 0], "end": [5, 5], "loss_db": 5}] if walls else [],
        "nodes": [
            {"role": "agent_1", "kind": "fronthaul_ap", "position": [1, 2]},
            {"role": "agent_2", "kind": "fronthaul_ap", "position": [9, 2]},
            {"role": "sta_01", "kind": "station", "position": [2, 2]},
        ],
    }


def _mobility():
    return {
        "schema": "wmdcfg.mobility.v1",
        "name": "walk-and-vanish",
        "duration_ms": 3_000,
        "tick_ms": 1_000,
        "seed": 17,
        "tags": ["mobility"],
        "nodes": [
            {
                "role": "sta_01",
                "path": [
                    {"time_ms": 0, "position": [2, 2]},
                    {"time_ms": 2_000, "position": [8, 2]},
                ],
                "presence": [[0, 2_000]],
            }
        ],
    }


class WorldTests(unittest.TestCase):
    def test_public_geometry_is_quantized_directional_and_names_crossed_walls(self):
        layout = _layout()
        nodes = {item["role"]: item for item in layout["nodes"]}
        positions = {role: tuple(item["position"]) for role, item in nodes.items()}
        present = {role: True for role in nodes}
        link = directed_link(
            nodes["sta_01"], nodes["agent_2"], positions, present,
            layout, {"seed": 0}, 0, "fronthaul",
        )
        self.assertEqual(link["wall_loss_db"], 5)
        self.assertEqual(len(wall_crossings([2, 2], [9, 2], layout["walls"])), 1)
        self.assertEqual(quantize_position([2.024, 2.026]), (2.0, 2.05))

    def test_compile_is_deterministic_and_tracks_geometry(self):
        first = compile_world(_layout(), _mobility())
        second = compile_world(_layout(), _mobility())
        self.assertEqual(first, second)
        verify_world_plan(first)
        self.assertEqual(first["counts"], {"agents": 2, "stations": 1})
        self.assertEqual(first["generations"][1]["positions"]["sta_01"], [5.0, 2.0])
        self.assertIsInstance(first["generations"][1]["positions"]["sta_01"][0], int)
        self.assertFalse(first["generations"][2]["present"]["sta_01"])

    def test_wall_crossing_applies_exact_loss(self):
        with_wall = compile_world(_layout(True), _mobility())
        without_wall = compile_world(_layout(False), _mobility())
        def value(plan):
            return next(
                link for link in plan["generations"][0]["links"]
                if link["source_role"] == "sta_01" and link["destination_role"] == "agent_2"
            )
        self.assertEqual(value(with_wall)["wall_loss_db"], 5)
        self.assertEqual(
            value(without_wall)["snr_db_by_band"]["5"]
            - value(with_wall)["snr_db_by_band"]["5"],
            5,
        )

    def test_export_is_valid_wmd_and_explicitly_projects_one_band(self):
        plan = compile_world(_layout(), _mobility())
        text = export_wmd(plan, "6")
        scenario = parse(text)
        validate_scenario(scenario)
        self.assertIn("projection-band 6GHz", text)
        self.assertIn("current actuator is radio-pair, not per-frequency", text)
        self.assertIn("protect backhaul", text)

    def test_all_band_export_is_frequency_qualified(self):
        plan = compile_world(_layout(), _mobility())
        text = export_wmd(plan, "all")
        scenario = parse(text)
        validate_scenario(scenario)
        self.assertIn("require frequency_qualified_snr", text)
        self.assertIn("band 2.4GHz", text)
        self.assertIn("band 5GHz", text)
        self.assertIn("band 6GHz", text)

    def test_tampered_golden_is_rejected(self):
        plan = compile_world(_layout(), _mobility())
        plan["generations"][0]["time_ms"] = 7
        with self.assertRaisesRegex(ScenarioError, "golden_sha256"):
            verify_world_plan(plan)

    def test_integer_float_rewrite_does_not_break_golden_hash(self):
        plan = compile_world(_layout(), _mobility())
        rewritten = json.loads(json.dumps(plan).replace("5.0", "5"))
        verify_world_plan(rewritten)

    def test_partial_final_tick_is_rejected(self):
        mobility = _mobility()
        mobility["duration_ms"] = 3_500
        with self.assertRaisesRegex(ScenarioError, "exact multiple"):
            compile_world(_layout(), mobility)


if __name__ == "__main__":
    unittest.main()
