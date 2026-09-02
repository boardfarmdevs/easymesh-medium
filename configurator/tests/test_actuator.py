from __future__ import annotations

import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from wmdcfg.actuator import ActuatorError, ControlClient


ROOT = Path(__file__).resolve().parents[1]
BINARY = os.environ.get("WMDC_TEST_DAEMON")
SOURCE = "42:00:00:00:01:00"
DESTINATION = "42:00:00:00:02:00"
UNSPECIFIED = "42:00:00:00:03:00"


@unittest.skipUnless(BINARY, "set WMDC_TEST_DAEMON for daemon integration tests")
class ActuatorIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.control = root / "control.sock"
        self.vhost = root / "vhost.sock"
        self.daemon = subprocess.Popen(
            [BINARY, "-c", str(ROOT / "tests/fixtures/two-radio.cfg"),
             "-u", str(self.vhost), "-C", str(self.control)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(100):
            if self.control.exists():
                break
            if self.daemon.poll() is not None:
                stdout, stderr = self.daemon.communicate()
                self.fail(f"daemon exited: {stdout} {stderr}")
            time.sleep(0.02)
        else:
            self.fail("control socket did not appear")

    def tearDown(self):
        self.daemon.terminate()
        try:
            self.daemon.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.daemon.kill()
            self.daemon.wait()
        self.daemon.communicate()
        self.temp.cleanup()

    def test_atomic_apply_rejection_readback_and_restore(self):
        original_pid = self.daemon.pid
        with ControlClient(str(self.control)) as client:
            status = client.status()
            self.assertEqual(status.generation, 0)
            self.assertEqual(status.num_stations, 3)
            self.assertIn("atomic_generations", status.capabilities)
            self.assertIn("frequency_qualified_snr", status.capabilities)
            self.assertIn("paged_link_dumps", status.capabilities)
            generation, links = client.dump_links()
            self.assertEqual(generation, 0)
            self.assertEqual(len(links), 6)
            self.assertEqual(client.get_link(SOURCE, DESTINATION), (0, 33))
            self.assertEqual(client.get_link(SOURCE, UNSPECIFIED), (0, 37))

            with self.assertRaises(ActuatorError):
                with ControlClient(str(self.control)):
                    pass

            update = [{"source": SOURCE, "destination": DESTINATION, "value": 12}]
            self.assertEqual(client.apply(1, update), update)
            self.assertEqual(client.get_link(SOURCE, DESTINATION), (1, 12))

            self.assertEqual(
                client.get_frequency_link(SOURCE, DESTINATION, 5180),
                (1, 12, False),
            )
            frequency = [
                {
                    "source": SOURCE,
                    "destination": DESTINATION,
                    "frequency_mhz": 5180,
                    "value": 44,
                    "override": True,
                }
            ]
            self.assertEqual(client.apply_frequency(2, frequency), frequency)
            self.assertEqual(
                client.get_frequency_link(SOURCE, DESTINATION, 5180),
                (2, 44, True),
            )
            self.assertEqual(
                client.get_frequency_link(SOURCE, DESTINATION, 2437),
                (2, 12, False),
            )
            self.assertEqual(client.dump_frequency_links()[1], frequency)

            invalid_frequency = [dict(frequency[0], frequency_mhz=9000)]
            with self.assertRaisesRegex(ActuatorError, "frequency"):
                client.apply_frequency(3, invalid_frequency)
            self.assertEqual(client.status().generation, 2)

            clear = [dict(frequency[0], value=0, override=False)]
            self.assertEqual(client.apply_frequency(3, clear), clear)
            self.assertEqual(
                client.get_frequency_link(SOURCE, DESTINATION, 5180),
                (3, 12, False),
            )
            self.assertEqual(client.dump_frequency_links()[1], [])

            with self.assertRaisesRegex(ActuatorError, "generation"):
                client.apply(3, update)
            self.assertEqual(client.get_link(SOURCE, DESTINATION), (3, 12))

            invalid = [{"source": SOURCE, "destination": DESTINATION, "value": 80}]
            with self.assertRaisesRegex(ActuatorError, "value"):
                client.apply(4, invalid)
            self.assertEqual(client.get_link(SOURCE, DESTINATION), (3, 12))

            restored = [{"source": SOURCE, "destination": DESTINATION, "value": 33}]
            client.apply(4, restored)
            self.assertEqual(client.get_link(SOURCE, DESTINATION), (4, 33))

        self.assertIsNone(self.daemon.poll())
        self.assertEqual(self.daemon.pid, original_pid)


if __name__ == "__main__":
    unittest.main()
