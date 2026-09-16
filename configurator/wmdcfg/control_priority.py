from __future__ import annotations

import argparse
import base64
from contextlib import closing, contextmanager, ExitStack
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
from urllib.parse import parse_qs, unquote, urlsplit


TABLE = "easymesh_control_priority"
OWNER = "easymesh-control-priority-v1"
NODES = {
    "rdk": ["bpibroadband", "bpiap", "bpiap-001", "bpiap-002", "bpiap-003"],
    "prplmesh": ["prpl-controller", *[f"prpl-agent-{ordinal:02d}" for ordinal in range(1, 5)]],
}
STATE_DIRECTORY = Path("/var/lib/wmdcfg-control-priority")
START_ACTIONS = {"instance-started", "instance-restarted", "instance-restored",
                 "instance-resumed", "instance-ready", "instance-updated"}
STOP_ACTIONS = {"instance-stopped", "instance-shutdown", "instance-deleted"}


def transaction(existing, enable, preserve=False):
    tables = [row["table"] for row in existing.get("nftables", [])
              if "table" in row and row["table"].get("family") == "bridge"
              and row["table"].get("name") == TABLE]
    if tables and (len(tables) != 1 or tables[0].get("comment") != OWNER):
        raise RuntimeError("refusing to replace an unowned control-priority table")
    if tables and enable and preserve:
        return ""
    commands = [f"delete table bridge {TABLE}"] if tables else []
    if enable:
        commands += [
            f'add table bridge {TABLE} {{ comment "{OWNER}"; }}',
            f"add chain bridge {TABLE} forward {{ type filter hook forward priority -150; policy accept; }}",
            f"add rule bridge {TABLE} forward ether type 0x893a counter meta priority set 0x00000107",
        ]
    return "\n".join(commands) + "\n" if commands else ""


def execute(arguments, **options):
    return subprocess.run(arguments, check=True, text=True, capture_output=True, timeout=10, **options).stdout


def selected_nodes(stack, selected):
    nodes = selected or NODES[stack]
    if len(nodes) != len(set(nodes)) or any(node not in NODES[stack] for node in nodes):
        raise ValueError("only distinct mesh nodes belonging to the selected stack are supported")
    return nodes


def prerequisites(check_tools=True):
    if os.geteuid() != 0:
        raise RuntimeError("requires root inside the lab VM")
    for tool in ("nsenter", "nft") if check_tools else ():
        if shutil.which(tool) is None:
            raise RuntimeError(f"install {tool} before enabling control priority")


def socket_path():
    if os.environ.get("LXD_DIR"):
        return str(Path(os.environ["LXD_DIR"]) / "unix.socket")
    for path in ("/var/snap/lxd/common/lxd/unix.socket", "/var/lib/lxd/unix.socket"):
        if Path(path).exists():
            return path
    raise RuntimeError("local LXD socket unavailable")


class Lxd:
    def __init__(self, path):
        self.path = path

    def connect(self):
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            connection.settimeout(10)
            connection.connect(self.path)
            return connection
        except BaseException:
            connection.close()
            raise

    def state(self, node):
        with closing(http.client.HTTPConnection("localhost", timeout=10)) as client:
            client.sock = self.connect()
            client.request("GET", f"/1.0/instances/{node}/state?project=default")
            response = client.getresponse()
            if response.status == 404:
                return {}
            payload = json.loads(response.read())
            if response.status != 200:
                raise RuntimeError(f"LXD state for {node}: {payload}")
            return payload["metadata"]

    @contextmanager
    def events(self):
        with self.connect() as connection, connection.makefile("rb") as stream:
            key = base64.b64encode(os.urandom(16)).decode()
            connection.sendall((
                "GET /1.0/events?type=lifecycle&project=default HTTP/1.1\r\n"
                "Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode())
            status = stream.readline(4096).split()
            headers = http.client.parse_headers(stream)
            expected = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
            ).digest()).decode()
            if (len(status) < 2 or status[1] != b"101" or
                    headers.get("Sec-WebSocket-Accept") != expected):
                raise RuntimeError("LXD lifecycle websocket handshake failed")
            connection.settimeout(None)
            yield event_messages(connection, stream)


def read_exact(stream, size):
    payload = stream.read(size)
    if len(payload) != size:
        raise EOFError("LXD lifecycle connection closed")
    return payload


def event_messages(connection, stream):
    message = bytearray()
    fragmented = False
    while True:
        header, length = read_exact(stream, 2)
        opcode = header & 15
        final = bool(header & 128)
        if header & 112 or length & 128:
            raise RuntimeError("invalid LXD websocket frame")
        if length == 126:
            length = struct.unpack("!H", read_exact(stream, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", read_exact(stream, 8))[0]
        if length + len(message) > 1024 * 1024:
            raise RuntimeError("oversized LXD lifecycle message")
        if opcode >= 8 and (not final or length > 125):
            raise RuntimeError("invalid LXD websocket control frame")
        payload = read_exact(stream, length)
        if opcode == 8:
            raise EOFError("LXD lifecycle connection closed")
        if opcode == 9:
            mask = os.urandom(4)
            masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            connection.sendall(bytes((138, 128 | length)) + mask + masked)
        elif opcode == 10:
            continue
        elif opcode in (0, 1):
            if (opcode == 0) != fragmented:
                raise RuntimeError("invalid LXD websocket continuation")
            message.extend(payload)
            fragmented = not final
            if final:
                yield json.loads(message)
                message.clear()
        else:
            raise RuntimeError("unsupported LXD websocket opcode")


def running(state):
    return (state.get("status") == "Running" and type(state.get("pid")) is int
            and state["pid"] > 0)


@contextmanager
def namespace(client, node):
    state = client.state(node)
    if not running(state):
        yield None
        return
    with ExitStack() as cleanup:
        try:
            process = os.open(f"/proc/{state['pid']}", os.O_RDONLY | os.O_DIRECTORY)
            cleanup.callback(os.close, process)
            descriptor = os.open("ns/net", os.O_RDONLY, dir_fd=process)
            cleanup.callback(os.close, descriptor)
        except FileNotFoundError as error:
            raise RuntimeError(f"{node} restarted while opening its namespace") from error
        current = client.state(node)
        if not running(current):
            yield None
            return
        if current["pid"] != state["pid"]:
            raise RuntimeError(f"{node} restarted while opening its namespace")
        pinned = os.fstat(descriptor)
        latest = os.stat(f"/proc/{current['pid']}/ns/net")
        if (pinned.st_dev, pinned.st_ino) != (latest.st_dev, latest.st_ino):
            raise RuntimeError(f"{node} namespace changed while opening it")
        if os.path.samestat(pinned, os.stat("/proc/self/ns/net")):
            raise RuntimeError(f"refusing to classify the host namespace for {node}")
        yield descriptor


class NamespaceCache:
    def __init__(self):
        self.descriptors = {}

    def matches(self, node, descriptor):
        previous = self.descriptors.get(node)
        return previous is not None and os.path.samestat(os.fstat(previous), os.fstat(descriptor))

    def forget(self, node):
        previous = self.descriptors.pop(node, None)
        if previous is not None:
            os.close(previous)

    def remember(self, node, descriptor):
        self.forget(node)
        self.descriptors[node] = os.dup(descriptor)

    def close(self):
        for node in list(self.descriptors):
            self.forget(node)


def apply_nodes(client, enable, nodes, cache=None):
    plans = []
    with ExitStack() as cleanup:
        for node in nodes:
            descriptor = cleanup.enter_context(namespace(client, node))
            if descriptor is None:
                if cache is not None:
                    cache.forget(node)
                print(json.dumps({"node": node, "state": "stopped-or-absent"}), flush=True)
                continue
            if cache is not None and cache.matches(node, descriptor):
                continue
            command = ["nsenter", f"--net=/proc/self/fd/{descriptor}", "nft"]
            options = {"pass_fds": (descriptor,)}
            listing = json.loads(execute(command + ["-j", "list", "tables"], **options))
            present = any(row.get("table", {}).get("family") == "bridge" and
                          row["table"].get("name") == TABLE for row in listing.get("nftables", []))
            existing = json.loads(execute(command + ["-j", "list", "table", "bridge", TABLE], **options)) if present else {}
            script = transaction(existing, enable, preserve=cache is not None)
            if script:
                execute(command + ["-c", "-f", "-"], input=script, **options)
            plans.append((node, descriptor, command, options, script))
        for node, descriptor, command, options, script in plans:
            if script:
                execute(command + ["-f", "-"], input=script, **options)
            if cache is not None:
                cache.remember(node, descriptor)
            print(json.dumps({"node": node, "state": "enabled" if enable else "disabled",
                              "table": TABLE, "user_priority": 7 if enable else None}), flush=True)


@contextmanager
def intent_lock(stack):
    STATE_DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE_DIRECTORY / f"{stack}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield STATE_DIRECTORY / f"{stack}.json"


def read_intent(path, stack):
    if not path.exists():
        return set()
    nodes = json.loads(path.read_text())["nodes"]
    if not isinstance(nodes, list):
        raise ValueError("invalid control-priority intent")
    if nodes:
        selected_nodes(stack, nodes)
    return set(nodes)


def write_intent(path, nodes):
    if nodes:
        temporary = path.with_suffix(".tmp")
        with temporary.open("w") as output:
            json.dump({"nodes": sorted(nodes)}, output)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    else:
        path.unlink(missing_ok=True)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def configure(stack, enable, selected=None):
    nodes = selected_nodes(stack, selected)
    prerequisites(check_tools=enable)
    with intent_lock(stack) as path:
        desired = read_intent(path, stack)
        if not enable:
            write_intent(path, desired.difference(nodes))
            prerequisites()
        apply_nodes(Lxd(socket_path()), enable, nodes)
        if enable:
            write_intent(path, desired.union(nodes))


def event_node(event, stack):
    if not isinstance(event, dict) or event.get("type") != "lifecycle":
        return None
    metadata = event.get("metadata")
    if not isinstance(metadata, dict):
        return None
    if metadata.get("action") not in START_ACTIONS | STOP_ACTIONS:
        return None
    if not isinstance(metadata.get("source"), str):
        return None
    source = urlsplit(metadata["source"])
    if source.scheme or source.netloc or source.fragment:
        return None
    project = parse_qs(source.query).get("project", ["default"])
    if event.get("project", "default") != "default" or project != ["default"]:
        return None
    for prefix in ("/1.0/instances/", "/1.0/containers/"):
        if source.path.startswith(prefix):
            node = unquote(source.path[len(prefix):])
            if node in NODES[stack]:
                return node
    return None


def reconcile(client, stack, cache, selected=None):
    errors = []
    with intent_lock(stack) as path:
        desired = read_intent(path, stack)
        for node in set(cache.descriptors).difference(desired):
            cache.forget(node)
        for node in sorted(desired.intersection(selected) if selected is not None else desired):
            try:
                apply_nodes(client, True, [node], cache)
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
                cache.forget(node)
                errors.append(f"{node}: {error}")
    if errors:
        raise RuntimeError("; ".join(errors))


def watch(stack):
    prerequisites()
    client = Lxd(socket_path())
    cache = NamespaceCache()
    try:
        with client.events() as events:
            reconcile(client, stack, cache)
            for event in events:
                node = event_node(event, stack)
                if node is None:
                    continue
                if event["metadata"]["action"] in STOP_ACTIONS:
                    cache.forget(node)
                else:
                    reconcile(client, stack, cache, [node])
        raise EOFError("LXD lifecycle connection closed")
    finally:
        cache.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Opt-in bridge classification for lab IEEE 1905 control traffic")
    parser.add_argument("--stack", choices=tuple(NODES), required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--enable", action="store_true")
    mode.add_argument("--disable", action="store_true")
    mode.add_argument("--watch", action="store_true")
    parser.add_argument("--node", action="append")
    args = parser.parse_args(argv)
    if args.watch:
        if args.node:
            parser.error("--watch uses the persisted opt-in nodes; --node is only for enable/disable")
        watch(args.stack)
    else:
        configure(args.stack, args.enable, args.node)


if __name__ == "__main__":
    try:
        main()
    except (OSError, EOFError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"control priority: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
