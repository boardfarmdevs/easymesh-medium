import unittest
import hashlib
from pathlib import Path
import tempfile
from unittest.mock import Mock, patch

from wmdcfg.rf_qualify import MediumRestarter, association_identity, comparison, launch_medium, qualification_passed, restore_actions


class ThroughputComparisonTests(unittest.TestCase):
    def test_inconclusive_or_unrestored_qualification_is_not_cli_success(self):
        for state in ("inconclusive", "incomplete", "failed", "passed"):
            for restored in (False, True):
                for error in (None, "traffic failed"):
                    report = {"comparison": {"state": state}, "restored": restored, "error": error}
                    self.assertEqual(qualification_passed(report), state == "passed" and restored and not error)

    def test_medium_is_owned_by_systemd_not_the_management_exec_session(self):
        with patch("wmdcfg.rf_qualify.command", side_effect=["", "123\n"]) as command:
            process = launch_medium(["/medium", "-F"], "/tmp/medium.log", {0, 1}, 5, "/tmp")
        self.assertEqual(process.pid, 123)
        arguments = command.call_args_list[0].args
        self.assertEqual(arguments[0], "systemd-run")
        self.assertIn("--collect", arguments)
        self.assertIn("--property=CPUAffinity=0 1", arguments)
        self.assertIn("--property=Nice=5", arguments)
        self.assertIn("--property=WorkingDirectory=/tmp", arguments)
        self.assertEqual(arguments[-2:], ("/medium", "-F"))

    def test_mismatched_process_identity_is_never_stopped(self):
        digest = hashlib.sha256(b"binary").hexdigest()
        for path, expected_hash, pidfile in (("/unrelated", digest, "123"),
                                             ("/expected", "bad-hash", "123"),
                                             ("/expected", digest, "124")):
            with patch.object(Path, "read_text", side_effect=[
                    f"123\t{expected_hash}\t/expected\n", pidfile]), \
                    patch.object(Path, "read_bytes", side_effect=[path.encode() + b"\0", b"binary"]), \
                    patch("wmdcfg.rf_qualify.os.kill") as kill:
                with self.assertRaisesRegex(RuntimeError, "refusing to stop"):
                    MediumRestarter("rdk")
                kill.assert_not_called()

    def test_restarter_advances_generations_and_persists_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            medium = MediumRestarter.__new__(MediumRestarter)
            medium.original_args = medium.args = [__file__]
            medium.process = Mock()
            medium.log = None
            medium.permissions = {}
            medium.affinity = {0, 1}
            medium.priority = 0
            medium.working_directory = root
            medium.socket = "/unused"
            medium.pidfile = root / "pid"
            medium.manifest = root / "manifest"
            medium.links = [{"value": 40}]
            medium.frequencies = [{"value": 7}]
            client = Mock()
            client.status.side_effect = [Mock(generation=0), Mock(generation=1)]
            client.dump_links.return_value = (1, medium.links)
            client.dump_frequency_links.return_value = (2, medium.frequencies)
            process = Mock(pid=123)
            process.poll.return_value = None
            with patch("wmdcfg.rf_qualify.ControlClient") as factory, \
                    patch("wmdcfg.rf_qualify.launch_medium", return_value=process) as launch, \
                    patch("wmdcfg.rf_qualify.stop_process"), patch("wmdcfg.rf_qualify.time.sleep"):
                factory.return_value.__enter__.return_value = client
                medium.restart(root)
            medium.log.close()
            client.apply.assert_called_once_with(1, medium.links)
            client.apply_frequency.assert_called_once_with(2, medium.frequencies)
            self.assertEqual(medium.pidfile.read_text(), "123\n")
            self.assertEqual(launch.call_args.args[2:], ({0, 1}, 0, root))
            self.assertTrue((root / "original-medium.json").exists())

    def test_association_requires_connected_address_and_frequency(self):
        self.assertIsNone(association_identity("Not connected.\n"))
        self.assertEqual(association_identity("Connected to 02:00:00:00:06:00 (on wlan0)\n\tfreq: 2437\n"),
                         ("02:00:00:00:06:00", 2437))
        self.assertEqual(association_identity("Connected to 02:00:00:00:06:00 (on wlan0)\n\tfreq: 5180.0\n"),
                         ("02:00:00:00:06:00", 5180))
        self.assertIsNone(association_identity("Connected to 02:00:00:00:06:00 (on wlan0)\n\tfreq: 5180.5\n"))

    def test_restore_continues_after_failure(self):
        restored = []
        def failure():
            raise RuntimeError("expected")
        errors = restore_actions([("medium", failure), ("room", lambda: restored.append(True))])
        self.assertEqual(restored, [True])
        self.assertEqual(errors, ["medium: RuntimeError: expected"])

    def rows(self, on, off):
        return [{"mode": mode, "bits_per_second": value}
                for mode, values in (("on", on), ("off", off)) for value in values]

    def test_stable_observer_overhead(self):
        result = comparison(self.rows([98, 99], [100, 101]))
        self.assertEqual(result["state"], "passed")
        self.assertLess(result["observed_overhead_percent"], 5)

    def test_variance_is_inconclusive_not_a_false_pass(self):
        self.assertEqual(comparison(self.rows([80, 120], [100, 101]))["state"], "inconclusive")

    def test_missing_zero_and_large_overhead_fail(self):
        self.assertEqual(comparison(self.rows([98], [100]))["state"], "incomplete")
        self.assertEqual(comparison(self.rows([0, 0], [100, 100]))["state"], "incomplete")
        self.assertEqual(comparison(self.rows([90, 90], [100, 100]))["state"], "failed")
