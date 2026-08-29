from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from wmdcfg.actuator import ActuatorError
from wmdcfg.runner import REQUIRED_CAPABILITIES, Runner


SOURCE = "42:00:00:00:01:00"
DESTINATION = "42:00:00:00:02:00"


def _plan() -> dict:
    return {
        "scenario": "runner_test",
        "duration_ms": 0,
        "expected_lab": {"mesh_devices": 5, "clients": 10},
        "bindings": {},
        "events": [
            {
                "time_ms": 0,
                "generation": 1,
                "marks": [],
                "updates": [
                    {"source": SOURCE, "destination": DESTINATION, "value": 10}
                ],
            }
        ],
    }


class FakeControlClient:
    fail_restore = False
    conflict_once = False
    last = None

    def __init__(self, socket_path: str):
        self.generation = 0
        self.matrix = {(SOURCE, DESTINATION): 40}
        self.frequency = {}
        type(self).last = self

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def status(self):
        return SimpleNamespace(
            capabilities=REQUIRED_CAPABILITIES | {"frequency_qualified_snr"},
            generation=self.generation,
        )

    def dump_links(self):
        return self.generation, [
            {"source": source, "destination": destination, "value": value}
            for (source, destination), value in self.matrix.items()
        ]

    def apply(self, generation: int, updates: list[dict]):
        if self.conflict_once:
            self.conflict_once = False
            self.generation += 1
            raise ActuatorError(
                f"daemon rejected opcode 3: generation "
                f"(effective generation {self.generation})"
            )
        self.generation = generation
        for update in updates:
            if not (self.fail_restore and update["value"] == 40):
                self.matrix[(update["source"], update["destination"])] = update["value"]
        return updates

    def get_link(self, source: str, destination: str):
        return self.generation, self.matrix[(source, destination)]

    def get_frequency_link(self, source: str, destination: str, frequency: int):
        key = (source, destination, frequency)
        if key in self.frequency:
            return self.generation, self.frequency[key], True
        return self.generation, self.matrix[(source, destination)], False

    def apply_frequency(self, generation: int, updates: list[dict]):
        self.generation = generation
        for update in updates:
            key = (update["source"], update["destination"], update["frequency_mhz"])
            if update.get("override", True):
                self.frequency[key] = update["value"]
            else:
                self.frequency.pop(key, None)
        return updates


class RunnerTests(unittest.TestCase):
    def _execute(self, fail_restore: bool, conflict_once: bool = False):
        FakeControlClient.fail_restore = fail_restore
        FakeControlClient.conflict_once = conflict_once
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        healthy = {
            "api_active": 10,
            "api_total": 10,
            "complete_nodes": 6,
            "topology_nodes": 6,
        }
        control_patch = patch("wmdcfg.runner.ControlClient", FakeControlClient)
        health_patch = patch("wmdcfg.runner.mesh_health", return_value=healthy)
        snapshot_patch = patch(
            "wmdcfg.runner.snapshot", return_value={"stations": []}
        )
        control_patch.start()
        self.health_mock = health_patch.start()
        snapshot_patch.start()
        for item in (control_patch, health_patch, snapshot_patch):
            self.addCleanup(item.stop)
        runner = Runner(_plan(), "/test/control.sock", root)
        return runner, root

    def test_success_restores_and_reports_passed(self):
        runner, _ = self._execute(False)
        run_dir = runner.execute()
        summary = json.loads((run_dir / "summary.json").read_text())
        self.assertEqual(summary["outcome"], "passed")
        self.assertTrue(summary["restored"])
        self.assertIsNone(summary["error"])
        self.assertIsNotNone(summary["execution_elapsed_ms"])
        self.assertEqual(FakeControlClient.last.matrix[(SOURCE, DESTINATION)], 40)
        self.assertEqual(
            [call.args for call in self.health_mock.call_args_list],
            [(5, 10), (5, 10)],
        )

    def test_restore_readback_failure_reports_failed(self):
        runner, root = self._execute(True)
        with self.assertRaisesRegex(ActuatorError, "restoration readback"):
            runner.execute()
        run_dir = next(root.iterdir())
        summary = json.loads((run_dir / "summary.json").read_text())
        self.assertEqual(summary["outcome"], "failed")
        self.assertFalse(summary["restored"])
        self.assertIn("restoration readback", summary["error"])

    def test_frequency_override_is_removed_on_restore(self):
        runner, _ = self._execute(False)
        runner.plan = _plan()
        runner.plan["events"][0]["updates"][0].update(
            {"frequency_mhz": 5180, "override": True}
        )
        runner.execute()
        self.assertEqual(FakeControlClient.last.frequency, {})

    def test_external_generation_advance_is_retried_and_restored(self):
        runner, _ = self._execute(False, conflict_once=True)
        run_dir = runner.execute()
        summary = json.loads((run_dir / "summary.json").read_text())
        self.assertEqual(summary["outcome"], "passed")
        self.assertTrue(summary["restored"])
        self.assertEqual(FakeControlClient.last.matrix[(SOURCE, DESTINATION)], 40)
        self.assertGreaterEqual(FakeControlClient.last.generation, 3)


if __name__ == "__main__":
    unittest.main()
