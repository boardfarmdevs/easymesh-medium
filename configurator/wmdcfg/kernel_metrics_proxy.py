from __future__ import annotations

import argparse
import os
from pathlib import Path
import signal
import socket
import struct

from .actuator import (
    CAPABILITIES,
    FREQUENCY_LINK,
    HEADER,
    INFO,
    LINK,
    MAGIC,
    OP_APPLY,
    OP_APPLY_FREQUENCY,
    OP_DUMP_FREQUENCIES,
    OP_DUMP_LINKS,
    OP_GET_FREQUENCY,
    OP_GET_LINK,
    OP_HELLO,
    OP_STATUS,
    VERSION,
    _mac_text,
)
from .kernel_actuator import KernelMediumClient


OK = 0
ERR_PROTOCOL = 1
ERR_LENGTH = 2
ERR_IDENTITY = 4
ERR_INTERNAL = 6
ERR_FREQUENCY = 7
ERR_READ_ONLY = 8
READ_ONLY_BIT = 1 << 5
MAX_FRAME = 64 * 1024


def _response(opcode: int, status: int, generation: int, payload: bytes = b"") -> bytes:
    return HEADER.pack(
        MAGIC, VERSION, opcode, len(payload), status, generation
    ) + payload


def _capability_mask(names: frozenset[str]) -> int:
    mask = READ_ONLY_BIT
    for bit, name in CAPABILITIES.items():
        if name in names and name != "read_only":
            mask |= bit
    return mask


def _info(status) -> bytes:
    instance = int(status.instance_id, 16)
    return INFO.pack(
        instance >> 64,
        instance & ((1 << 64) - 1),
        _capability_mask(status.capabilities),
        status.max_updates,
        status.num_stations,
        0,
    )


def _links(client: KernelMediumClient) -> tuple[int, bytes]:
    generation, links = client.dump_links()
    payload = b"".join(
        LINK.pack(
            bytes.fromhex(item["source"].replace(":", "")),
            bytes.fromhex(item["destination"].replace(":", "")),
            int(item["value"]),
            0,
        )
        for item in links
    )
    return generation, payload


def _frequency_links(client: KernelMediumClient) -> tuple[int, bytes]:
    generation, links = client.dump_frequency_links()
    payload = b"".join(
        FREQUENCY_LINK.pack(
            bytes.fromhex(item["source"].replace(":", "")),
            bytes.fromhex(item["destination"].replace(":", "")),
            int(item["frequency_mhz"]),
            int(item["value"]),
            1 if item["override"] else 0,
        )
        for item in links
    )
    return generation, payload


def handle_frame(frame: bytes, client_factory=KernelMediumClient) -> bytes:
    if len(frame) < HEADER.size:
        return _response(0, ERR_LENGTH, 0)
    magic, version, opcode, payload_len, _, _ = HEADER.unpack_from(frame)
    if magic != MAGIC or version != VERSION:
        return _response(opcode, ERR_PROTOCOL, 0)
    payload = frame[HEADER.size:]
    if len(payload) != payload_len:
        return _response(opcode, ERR_LENGTH, 0)
    if opcode in {OP_APPLY, OP_APPLY_FREQUENCY}:
        return _response(opcode, ERR_READ_ONLY, 0)

    try:
        # Matrix bank flips are atomic.  The proxy deliberately does not take
        # the writer's long-lived advisory lock, otherwise EasyMesh candidate
        # reads would deadlock while a scenario runner owns that lock.
        with client_factory(locking=False) as client:
            status = client.status()
            generation = status.generation
            if opcode in {OP_HELLO, OP_STATUS}:
                if payload:
                    return _response(opcode, ERR_LENGTH, generation)
                return _response(opcode, OK, generation, _info(status))
            if opcode == OP_GET_LINK:
                if len(payload) != LINK.size:
                    return _response(opcode, ERR_LENGTH, generation)
                source, destination, _, _ = LINK.unpack(payload)
                generation, value = client.get_link(
                    _mac_text(source), _mac_text(destination)
                )
                return _response(
                    opcode, OK, generation,
                    LINK.pack(source, destination, value, 0),
                )
            if opcode == OP_DUMP_LINKS:
                if payload:
                    return _response(opcode, ERR_LENGTH, generation)
                generation, body = _links(client)
                return _response(opcode, OK, generation, body)
            if opcode == OP_GET_FREQUENCY:
                if len(payload) != FREQUENCY_LINK.size:
                    return _response(opcode, ERR_LENGTH, generation)
                source, destination, frequency, _, _ = FREQUENCY_LINK.unpack(payload)
                generation, value, overridden = client.get_frequency_link(
                    _mac_text(source), _mac_text(destination), frequency
                )
                body = FREQUENCY_LINK.pack(
                    source, destination, frequency, value, 1 if overridden else 0
                )
                return _response(opcode, OK, generation, body)
            if opcode == OP_DUMP_FREQUENCIES:
                if payload:
                    return _response(opcode, ERR_LENGTH, generation)
                generation, body = _frequency_links(client)
                return _response(opcode, OK, generation, body)
            return _response(opcode, ERR_PROTOCOL, generation)
    except ValueError:
        return _response(opcode, ERR_IDENTITY, 0)
    except Exception as error:
        status_code = ERR_FREQUENCY if "frequency" in str(error).lower() else ERR_INTERNAL
        return _response(opcode, status_code, 0)


def serve(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    server.bind(str(path))
    os.chmod(path, 0o666)
    server.listen(32)
    server.settimeout(1)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping:
            try:
                connection, _ = server.accept()
            except socket.timeout:
                continue
            with connection:
                while not stopping:
                    frame = connection.recv(MAX_FRAME)
                    if not frame:
                        break
                    connection.sendall(handle_frame(frame))
    finally:
        server.close()
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Expose the hwsim kernel medium through the read-only metrics ABI"
    )
    parser.add_argument(
        "--socket", type=Path,
        default=Path("/run/meta-cmf-wmediumd/metrics/control.sock"),
    )
    args = parser.parse_args(argv)
    serve(args.socket)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
