import base64
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from wmdcfg import control_priority as priority
from wmdcfg.control_priority import OWNER, TABLE, transaction


class ControlPriorityTests(unittest.TestCase):
    def test_only_native_control_frames_are_classified_without_drop_or_shaping(self):
        script = transaction({}, True)
        self.assertIn('ether type 0x893a counter meta priority set 0x00000107', script)
        self.assertIn('hook forward priority -150; policy accept;', script)
        self.assertNotIn('drop', script)
        self.assertNotIn('limit', script)
        self.assertNotIn('flush ruleset', script)

    def test_owned_update_is_one_delete_and_recreate_transaction(self):
        existing = {"nftables": [{"table": {"family": "bridge", "name": TABLE, "comment": OWNER}}]}
        script = transaction(existing, True)
        self.assertTrue(script.startswith(f"delete table bridge {TABLE}\nadd table bridge {TABLE}"))
        self.assertEqual(transaction(existing, False), f"delete table bridge {TABLE}\n")

    def test_disable_without_our_table_leaves_other_firewall_tables_alone(self):
        existing = {"nftables": [{"table": {"family": "inet", "name": "firewall"}}]}
        self.assertEqual(transaction(existing, False), "")

    def test_unowned_collision_is_never_replaced_or_removed(self):
        for enable in (False, True):
            with self.assertRaisesRegex(RuntimeError, "unowned"):
                transaction({"nftables": [{"table": {"family": "bridge", "name": TABLE}}]}, enable)

    def test_catch_up_preserves_owned_counters_but_refuses_unowned_table(self):
        table = {"family": "bridge", "name": TABLE, "comment": OWNER}
        self.assertEqual(transaction({"nftables": [{"table": table}]}, True, preserve=True), "")
        table.pop("comment")
        with self.assertRaisesRegex(RuntimeError, "unowned"):
            transaction({"nftables": [{"table": table}]}, True, preserve=True)


def lifecycle(action="instance-started", node="prpl-agent-04", project="default"):
    return {"type": "lifecycle", "project": project,
            "metadata": {"action": action, "source": f"/1.0/instances/{node}"}}


def frame(payload, opcode=1, final=True):
    header = opcode | (128 if final else 0)
    if len(payload) < 126:
        return bytes((header, len(payload))) + payload
    return bytes((header, 126)) + struct.pack("!H", len(payload)) + payload


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.state_patch = patch.object(priority, "STATE_DIRECTORY", self.root)
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)
        self.path = self.root / "prplmesh.json"
        self.cache = priority.NamespaceCache()
        self.addCleanup(self.cache.close)

    def test_enable_persists_selected_stopped_node_and_keeps_other_opt_ins(self):
        priority.write_intent(self.path, {"prpl-controller"})
        with patch.object(priority, "prerequisites"), patch.object(priority, "socket_path"), \
                patch.object(priority.Lxd, "state", return_value={"status": "Stopped", "pid": -1}), \
                patch.object(priority, "execute") as execute:
            priority.configure("prplmesh", True, ["prpl-agent-04"])
        execute.assert_not_called()
        self.assertEqual(priority.read_intent(self.path, "prplmesh"),
                         {"prpl-controller", "prpl-agent-04"})

    def test_failed_enable_does_not_record_intent(self):
        with patch.object(priority, "prerequisites"), patch.object(priority, "socket_path"), \
                patch.object(priority, "apply_nodes", side_effect=RuntimeError("unowned")):
            with self.assertRaisesRegex(RuntimeError, "unowned"):
                priority.configure("prplmesh", True, ["prpl-agent-04"])
        self.assertFalse(self.path.exists())

    def test_disable_revokes_intent_before_removal_even_when_lxd_is_unavailable(self):
        priority.write_intent(self.path, {"prpl-controller", "prpl-agent-04"})

        def unavailable():
            self.assertEqual(priority.read_intent(self.path, "prplmesh"), {"prpl-controller"})
            raise RuntimeError("unavailable")

        with patch.object(priority, "prerequisites"), \
                patch.object(priority, "socket_path", side_effect=unavailable):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                priority.configure("prplmesh", False, ["prpl-agent-04"])
        with patch.object(priority, "apply_nodes") as apply:
            priority.reconcile(Mock(), "prplmesh", self.cache, ["prpl-agent-04"])
        apply.assert_not_called()

    def test_disable_revokes_intent_even_when_nft_is_unavailable(self):
        priority.write_intent(self.path, {"prpl-agent-04"})
        with patch.object(priority.os, "geteuid", return_value=0), \
                patch.object(priority.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "install nsenter"):
                priority.configure("prplmesh", False, ["prpl-agent-04"])
        self.assertFalse(self.path.exists())

    def test_no_intent_means_no_discovery_or_classification(self):
        client = Mock()
        priority.reconcile(client, "prplmesh", self.cache)
        client.assert_not_called()
        client.state.assert_not_called()

    def test_rollback_clears_cached_namespace_before_later_events(self):
        with tempfile.TemporaryFile() as descriptor:
            self.cache.remember("prpl-agent-04", descriptor.fileno())
            pin = self.cache.descriptors["prpl-agent-04"]
            priority.write_intent(self.path, set())
            with patch.object(priority, "apply_nodes") as apply:
                priority.reconcile(Mock(), "prplmesh", self.cache, ["prpl-agent-04"])
            apply.assert_not_called()
            with self.assertRaises(OSError):
                os.fstat(pin)

    def test_reconciliation_visits_other_nodes_before_reporting_failure(self):
        priority.write_intent(self.path, {"prpl-controller", "prpl-agent-04"})
        with patch.object(priority, "apply_nodes", side_effect=[RuntimeError("unowned"), None]) as apply:
            with self.assertRaisesRegex(RuntimeError, "unowned"):
                priority.reconcile(Mock(), "prplmesh", self.cache)
        self.assertEqual(apply.call_count, 2)

    def test_invalid_selection_and_corrupt_intent_fail_closed(self):
        for nodes in (["prpl-client-01"], ["prpl-controller", "prpl-controller"], ["bpiap"]):
            with self.assertRaises(ValueError):
                priority.selected_nodes("prplmesh", nodes)
        self.path.write_text('{"nodes": ["bpiap"]}')
        with self.assertRaises(ValueError):
            priority.reconcile(Mock(), "prplmesh", self.cache)

    def test_file_lock_serializes_rollback_and_reconciliation(self):
        entered = threading.Event()
        finished = threading.Event()

        def disable():
            entered.set()
            with priority.intent_lock("prplmesh") as path:
                priority.write_intent(path, set())
            finished.set()

        with priority.intent_lock("prplmesh") as path:
            priority.write_intent(path, {"prpl-agent-04"})
            worker = threading.Thread(target=disable)
            worker.start()
            self.assertTrue(entered.wait(2))
            self.assertFalse(finished.is_set())
            self.assertEqual(priority.read_intent(path, "prplmesh"), {"prpl-agent-04"})
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(priority.read_intent(self.path, "prplmesh"), set())

    def test_duplicate_events_skip_nft_and_new_namespace_gets_a_new_table(self):
        with tempfile.TemporaryFile() as first, tempfile.TemporaryFile() as replacement:
            @contextmanager
            def pinned(client, node):
                yield active.fileno()

            active = first
            with patch.object(priority, "namespace", side_effect=pinned), \
                    patch.object(priority, "execute", return_value='{}') as execute:
                priority.apply_nodes(Mock(), True, ["prpl-agent-04"], self.cache)
                self.assertEqual(execute.call_count, 3)
                self.assertEqual(execute.call_args.kwargs["pass_fds"], (first.fileno(),))
                priority.apply_nodes(Mock(), True, ["prpl-agent-04"], self.cache)
                self.assertEqual(execute.call_count, 3)
                active = replacement
                priority.apply_nodes(Mock(), True, ["prpl-agent-04"], self.cache)
                self.assertEqual(execute.call_count, 6)
                self.assertEqual(execute.call_args.kwargs["pass_fds"], (replacement.fileno(),))

    def test_cache_pins_inode_until_stop_and_preserves_owned_table_after_reconnect(self):
        owned = {"nftables": [{"table": {"family": "bridge", "name": TABLE, "comment": OWNER}}]}
        with tempfile.TemporaryFile() as descriptor:
            @contextmanager
            def pinned(client, node):
                yield descriptor.fileno()

            with patch.object(priority, "namespace", side_effect=pinned), \
                    patch.object(priority, "execute", return_value=json.dumps(owned)) as execute:
                priority.apply_nodes(Mock(), True, ["prpl-agent-04"], self.cache)
                pin = self.cache.descriptors["prpl-agent-04"]
                self.assertNotEqual(pin, descriptor.fileno())
                self.assertTrue(os.path.samestat(os.fstat(pin), os.fstat(descriptor.fileno())))
                self.assertEqual(execute.call_count, 2)
                self.assertTrue(all("-f" not in call.args[0] for call in execute.call_args_list))
                self.cache.forget("prpl-agent-04")
                with self.assertRaises(OSError):
                    os.fstat(pin)

    def test_stopped_node_does_not_block_running_nodes(self):
        with tempfile.TemporaryFile() as descriptor:
            @contextmanager
            def pinned(client, node):
                yield None if node == "prpl-agent-04" else descriptor.fileno()

            with patch.object(priority, "namespace", side_effect=pinned), \
                    patch.object(priority, "execute", return_value='{}') as execute:
                priority.apply_nodes(Mock(), True, ["prpl-agent-04", "prpl-controller"], self.cache)
                self.assertEqual(execute.call_count, 3)


class LifecycleTests(unittest.TestCase):
    def test_only_allowlisted_default_project_lifecycle_events_are_selected(self):
        self.assertEqual(priority.event_node(lifecycle(), "prplmesh"), "prpl-agent-04")
        self.assertEqual(priority.event_node(lifecycle(node="bpiap-003"), "rdk"), "bpiap-003")
        for event in (lifecycle(node="prpl-client-01"), lifecycle(project="other"),
                      lifecycle(action="instance-exec"), lifecycle(node="bpiap"),
                      {"type": "logging"}, {"type": "lifecycle", "metadata": None}):
            self.assertIsNone(priority.event_node(event, "prplmesh"))
        event = lifecycle()
        event["metadata"]["source"] += "?project=other"
        self.assertIsNone(priority.event_node(event, "prplmesh"))
        event["metadata"]["source"] = "/1.0/containers/prpl-agent-04?project=default"
        self.assertEqual(priority.event_node(event, "prplmesh"), "prpl-agent-04")

    def test_each_subscription_precedes_snapshot_and_buffers_start_during_discovery(self):
        order = []
        queued = []

        @contextmanager
        def subscribed(client):
            order.append("subscribed")
            yield iter(queued)

        def reconcile(client, stack, cache, selected=None):
            if selected is None:
                order.append("snapshot")
                queued.append(lifecycle())
            else:
                order.append(selected[0])

        with patch.object(priority, "prerequisites"), patch.object(priority, "socket_path"), \
                patch.object(priority.Lxd, "events", subscribed), \
                patch.object(priority, "reconcile", side_effect=reconcile):
            for attempt in range(2):
                queued.clear()
                with self.assertRaises(EOFError):
                    priority.watch("prplmesh")
        self.assertEqual(order, ["subscribed", "snapshot", "prpl-agent-04"] * 2)

    def test_subscription_failure_never_starts_discovery(self):
        with patch.object(priority, "prerequisites"), patch.object(priority, "socket_path"), \
                patch.object(priority.Lxd, "events", side_effect=OSError("disconnected")), \
                patch.object(priority, "reconcile") as reconcile:
            with self.assertRaises(OSError):
                priority.watch("prplmesh")
        reconcile.assert_not_called()

    def test_changed_pid_or_inode_is_rejected_before_nft(self):
        first = {"status": "Running", "pid": 100}
        for current in ({"status": "Running", "pid": 101}, first):
            client = Mock()
            client.state.side_effect = [first, current]
            with patch.object(priority.os, "open", side_effect=[20, 21]) as opened, \
                    patch.object(priority.os, "close"), \
                    patch.object(priority.os, "fstat", return_value=Mock(st_dev=1, st_ino=2)), \
                    patch.object(priority.os, "stat", return_value=Mock(st_dev=1, st_ino=3)), \
                    patch.object(priority, "execute") as execute:
                with self.assertRaisesRegex(RuntimeError, "restarted|namespace changed"):
                    priority.apply_nodes(client, True, ["prpl-agent-04"])
                self.assertEqual(opened.call_args.kwargs["dir_fd"], 20)
                execute.assert_not_called()

    def test_stop_event_releases_cache_and_does_not_reapply(self):
        @contextmanager
        def subscribed(client):
            yield iter([lifecycle(action="instance-stopped")])

        cache = Mock()
        with patch.object(priority, "prerequisites"), patch.object(priority, "socket_path"), \
                patch.object(priority.Lxd, "events", subscribed), \
                patch.object(priority, "reconcile") as reconcile, \
                patch.object(priority, "NamespaceCache", return_value=cache):
            with self.assertRaises(EOFError):
                priority.watch("prplmesh")
        self.assertEqual(reconcile.call_count, 1)
        cache.forget.assert_called_once_with("prpl-agent-04")
        cache.close.assert_called_once_with()

    def test_namespace_descriptors_close_when_node_stops_during_discovery(self):
        client = Mock()
        client.state.side_effect = [{"status": "Running", "pid": 100}, {"status": "Stopped"}]
        with patch.object(priority.os, "open", side_effect=[20, 21]), \
                patch.object(priority.os, "close") as close:
            with priority.namespace(client, "prpl-agent-04") as descriptor:
                self.assertIsNone(descriptor)
        self.assertEqual([call.args[0] for call in close.call_args_list], [21, 20])

    def test_host_namespace_is_refused(self):
        client = Mock()
        client.state.return_value = {"status": "Running", "pid": os.getpid()}
        with self.assertRaisesRegex(RuntimeError, "host namespace"):
            with priority.namespace(client, "prpl-agent-04"):
                self.fail("must not enter the host namespace")

    def test_state_queries_default_project_and_only_404_means_absent(self):
        for status in (200, 404, 503):
            connection = Mock(spec_set=priority.http.client.HTTPConnection("localhost", timeout=10))
            response = connection.getresponse.return_value
            response.status = status
            response.read.return_value = b'{"metadata": {"status": "Running", "pid": 100}}'
            with patch.object(priority.Lxd, "connect"), \
                    patch.object(priority.http.client, "HTTPConnection", return_value=connection):
                if status == 503:
                    with self.assertRaisesRegex(RuntimeError, "LXD state"):
                        priority.Lxd("fixture").state("prpl-agent-04")
                else:
                    result = priority.Lxd("fixture").state("prpl-agent-04")
                    self.assertEqual(result, {} if status == 404 else {"status": "Running", "pid": 100})
            connection.request.assert_called_once_with(
                "GET", "/1.0/instances/prpl-agent-04/state?project=default")
            connection.close.assert_called_once_with()

    def test_state_uses_real_http_connection_and_closes_socket_on_every_response(self):
        payload = b'{"metadata": {"status": "Running", "pid": 100}}'
        for status, body, error in ((200, payload, None), (404, b"", None),
                                    (503, payload, RuntimeError), (200, b"invalid", ValueError)):
            with self.subTest(status=status, body=body):
                client_socket, server_socket = socket.socketpair()
                with client_socket, server_socket:
                    client_socket.settimeout(2)
                    server_socket.settimeout(2)
                    server_socket.sendall(
                        f"HTTP/1.1 {status} Fixture\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
                    with patch.object(priority.Lxd, "connect", return_value=client_socket):
                        if error is not None:
                            with self.assertRaises(error):
                                priority.Lxd("fixture").state("prpl-agent-04")
                        else:
                            result = priority.Lxd("fixture").state("prpl-agent-04")
                            self.assertEqual(result, {} if status == 404 else
                                             {"status": "Running", "pid": 100})
                    self.assertEqual(client_socket.fileno(), -1)
                    self.assertIn(b"GET /1.0/instances/prpl-agent-04/state?project=default HTTP/1.1\r\n",
                                  server_socket.recv(8192))


class WebsocketTests(unittest.TestCase):
    def test_fragments_ping_pong_and_close_without_sleep(self):
        payload = json.dumps(lifecycle()).encode()
        stream = io.BytesIO(frame(payload[:20], final=False) + frame(b"ping", opcode=9) +
                            frame(payload[20:], opcode=0) + frame(b"", opcode=8))
        connection = Mock()
        messages = priority.event_messages(connection, stream)
        self.assertEqual(next(messages), lifecycle())
        pong = connection.sendall.call_args.args[0]
        self.assertEqual(pong[:2], bytes((138, 132)))
        self.assertEqual(bytes(value ^ pong[2 + index % 4]
                              for index, value in enumerate(pong[6:])), b"ping")
        with self.assertRaises(EOFError):
            next(messages)

    def test_truncated_oversized_and_invalid_frames_fail_for_reconnect(self):
        for payload in (b"", b"\x81", b"\x81\x02x", b"\x81\x80", b"\x80\x00",
                        b"\x81\x7f" + struct.pack("!Q", 1024 * 1024 + 1)):
            with self.assertRaises((EOFError, RuntimeError)):
                next(priority.event_messages(Mock(), io.BytesIO(payload)))

    def test_real_socket_handshake_and_buffered_event(self):
        client_socket, server_socket = socket.socketpair()
        self.addCleanup(server_socket.close)
        errors = []

        def serve():
            try:
                server_socket.settimeout(2)
                request = bytearray()
                while not request.endswith(b"\r\n\r\n"):
                    request.extend(server_socket.recv(1))
                self.assertIn(b"type=lifecycle&project=default", request)
                key = bytes(request).split(b"Sec-WebSocket-Key: ")[1].split(b"\r\n")[0]
                accept = base64.b64encode(hashlib.sha1(
                    key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
                server_socket.sendall(b"HTTP/1.1 101 Switching Protocols\r\n"
                                      b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n" +
                                      frame(json.dumps(lifecycle()).encode()))
            except BaseException as error:
                errors.append(error)
            finally:
                server_socket.close()

        worker = threading.Thread(target=serve)
        worker.start()
        client_socket.settimeout(2)
        with patch.object(priority.Lxd, "connect", return_value=client_socket):
            with priority.Lxd("fixture").events() as events:
                self.assertEqual(next(events), lifecycle())
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])


class InstallerTests(unittest.TestCase):
    def test_shell_installs_one_restarting_service_without_enabling_nodes(self):
        installer = Path(__file__).resolve().parents[2] / "install-control-priority.sh"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for tool in ("id", "python3", "nsenter", "nft", "systemctl"):
                executable = root / tool
                body = 'echo 0' if tool == "id" else 'exit 0'
                if tool == "systemctl":
                    body = 'printf "%s\\n" "$*" >> "$INSTALLER_LOG"'
                executable.write_text("#!/bin/sh\n" + body + "\n")
                executable.chmod(0o755)
            script = root / "install.sh"
            script.write_text(installer.read_text().replace("/etc/systemd/system", directory))
            for stack in ("prplmesh", "rdk"):
                result = subprocess.run(["bash", str(script), stack], capture_output=True, text=True,
                                        env={**os.environ, "PATH": f"{root}:/usr/bin:/bin",
                                             "INSTALLER_LOG": str(root / "calls")}, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                unit = (root / "wmdcfg-control-priority.service").read_text()
                self.assertIn(f"--stack {stack} --watch", unit)
                self.assertIn("Restart=always", unit)
                self.assertIn("RestartSec=5", unit)
                self.assertIn("StartLimitIntervalSec=0", unit)
                self.assertIn(f"ConditionPathExists=/var/lib/wmdcfg-control-priority/{stack}.json", unit)
                self.assertNotIn("--enable", unit)
            self.assertEqual((root / "calls").read_text().splitlines(),
                             ["daemon-reload", "enable wmdcfg-control-priority.service"] * 2)

    def test_startup_zero_clears_all_intent_and_opt_in_starts_installed_watcher(self):
        shared_root = Path(__file__).resolve().parents[3]
        prpl = shared_root / "scripts/radio-lab.sh"
        if prpl.exists():
            source = prpl.read_text()
            body = "configure_control_priority()\n" + source.split(
                "configure_control_priority()\n", 1)[1].split("\nstart_agent()", 1)[0]
            body += "\nconfigure_control_priority --node prpl-agent-04\n"
            stack = "prplmesh"
        else:
            source = (shared_root / "wmediumd/wmediumd-up.sh").read_text()
            body = '    if [ -n "$PRIORITY_FLAG" ]; then\n' + source.split(
                '    if [ -n "$PRIORITY_FLAG" ]; then\n', 1)[1].split(
                    "    stop_running_wmediumd", 1)[0]
            stack = "rdk"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            intent = root / f"{stack}.json"
            unit = root / "watcher.service"
            unit.touch()
            script = """set -eu
python3() {
    printf 'python %s\\n' "$*" >> "$CALLS"
    case "$*" in *--disable*) rm -f "$INTENT" ;; esac
}
systemctl() { printf 'systemctl %s\\n' "$*" >> "$CALLS"; }
sudo() { "$@"; }
""" + body.replace(f"/var/lib/wmdcfg-control-priority/{stack}.json", str(intent)).replace(
                "/etc/systemd/system/wmdcfg-control-priority.service", str(unit))
            for mode, present in (("0", True), ("0", False), ("1", False)):
                if present:
                    intent.write_text('{"nodes": ["fixture"]}')
                calls = root / "calls"
                calls.write_text("")
                result = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                                        env={**os.environ, "ROOT": directory, "HERE": directory,
                                             "MEDIUM_BACKEND": "userspace", "INTENT": str(intent),
                                             "CALLS": str(calls), "WMEDIUMD_PRIORITY_QUEUES": mode,
                                             "PRIORITY_FLAG": "-Q" if mode == "1" else ""}, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = calls.read_text()
                if mode == "1":
                    self.assertIn(f"--stack {stack} --enable", output)
                    self.assertIn("systemctl start wmdcfg-control-priority.service", output)
                elif present:
                    self.assertIn(f"--stack {stack} --disable", output)
                    self.assertNotIn("--node", output)
                    self.assertNotIn("systemctl", output)
                    self.assertFalse(intent.exists())
                else:
                    self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
