from __future__ import annotations

import signal
import subprocess
import unittest
from unittest.mock import Mock

from wmdcfg.rf_validate import stop_process


class AcceptanceCleanupTests(unittest.TestCase):
    def test_absent_or_finished_process_needs_no_signal(self):
        stop_process(None)
        process = Mock()
        process.poll.return_value = 0
        stop_process(process)
        process.send_signal.assert_not_called()

    def test_capture_gets_interrupt_and_is_reaped(self):
        process = Mock()
        process.poll.return_value = None
        stop_process(process, signal.SIGINT)
        process.send_signal.assert_called_once_with(signal.SIGINT)
        process.wait.assert_called_once_with(timeout=5)
        process.kill.assert_not_called()

    def test_stuck_process_is_killed_and_reaped(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("fixture", 5), 0]
        stop_process(process)
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)


if __name__ == "__main__":
    unittest.main()
