from __future__ import annotations

import socket
import struct
from dataclasses import dataclass


MAGIC = 0x574D4443
VERSION = 1
HEADER = struct.Struct("!IHHIIQ")
LINK = struct.Struct("!6s6shH")
FREQUENCY_LINK = struct.Struct("!6s6sIhH")
INFO = struct.Struct("!QQIIII")
PAGE_REQUEST = struct.Struct("!QII")
PAGE_HEADER = struct.Struct("!QQIIII")

OP_HELLO = 1
OP_STATUS = 2
OP_APPLY = 3
OP_GET_LINK = 4
OP_DUMP_LINKS = 5
OP_APPLY_FREQUENCY = 6
OP_GET_FREQUENCY = 7
OP_DUMP_FREQUENCIES = 8

FREQUENCY_OVERRIDE = 1 << 0
PAGE_MORE = 1 << 0
PAGE_END = (1 << 32) - 1
DEFAULT_PAGE_LIMIT = 128

CAPABILITIES = {
    1 << 0: "radio_pair_snr",
    1 << 1: "atomic_generations",
    1 << 2: "readback",
    1 << 3: "dump_links",
    1 << 4: "frequency_qualified_snr",
    1 << 5: "read_only",
    1 << 11: "paged_link_dumps",
}

STATUS = {
    0: "ok",
    1: "protocol",
    2: "length",
    3: "generation",
    4: "identity",
    5: "value",
    6: "internal",
    7: "frequency",
    8: "read-only",
}


class ActuatorError(RuntimeError):
    pass


def _mac_bytes(value: str) -> bytes:
    try:
        raw = bytes.fromhex(value.replace(":", ""))
    except ValueError as error:
        raise ActuatorError(f"invalid MAC address {value!r}") from error
    if len(raw) != 6:
        raise ActuatorError(f"invalid MAC address {value!r}")
    return raw


def _mac_text(value: bytes) -> str:
    return ":".join(f"{part:02x}" for part in value)


@dataclass(frozen=True)
class DaemonStatus:
    instance_id: str
    generation: int
    capabilities: frozenset[str]
    max_updates: int
    num_stations: int


class ControlClient:
    def __init__(self, path: str):
        self.path = path
        self.socket: socket.socket | None = None
        self.instance_id: str | None = None
        self.capabilities: frozenset[str] = frozenset()

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    def connect(self) -> DaemonStatus:
        if self.socket is not None:
            raise ActuatorError("control client is already connected")
        client = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        client.settimeout(5)
        client.connect(self.path)
        self.socket = client
        try:
            status = self.hello()
        except Exception:
            self.close()
            raise
        self.instance_id = status.instance_id
        self.capabilities = status.capabilities
        return status

    def close(self) -> None:
        if self.socket is not None:
            self.socket.close()
            self.socket = None

    def _request(
        self, opcode: int, payload: bytes = b"", generation: int = 0
    ) -> tuple[int, bytes]:
        if self.socket is None:
            raise ActuatorError("control client is not connected")
        frame = HEADER.pack(MAGIC, VERSION, opcode, len(payload), 0, generation) + payload
        try:
            self.socket.sendall(frame)
            response = self.socket.recv(64 * 1024)
        except OSError as error:
            raise ActuatorError(f"control socket failed: {error}") from error
        if len(response) < HEADER.size:
            raise ActuatorError("short control response")
        magic, version, response_opcode, length, status, effective_generation = (
            HEADER.unpack_from(response)
        )
        if magic != MAGIC or version != VERSION or response_opcode != opcode:
            raise ActuatorError("control response protocol mismatch")
        body = response[HEADER.size:]
        if len(body) != length:
            raise ActuatorError("control response length mismatch")
        if status:
            raise ActuatorError(
                f"daemon rejected opcode {opcode}: {STATUS.get(status, f'error-{status}')} "
                f"(effective generation {effective_generation})"
            )
        return effective_generation, body

    def _status(self, opcode: int) -> DaemonStatus:
        generation, payload = self._request(opcode)
        if len(payload) != INFO.size:
            raise ActuatorError("invalid daemon status payload")
        instance_hi, instance_lo, mask, max_updates, stations, _ = INFO.unpack(payload)
        instance_id = f"{instance_hi:016x}{instance_lo:016x}"
        if self.instance_id is not None and instance_id != self.instance_id:
            raise ActuatorError("wmediumd instance changed during the run")
        return DaemonStatus(
            instance_id=instance_id,
            generation=generation,
            capabilities=frozenset(
                name for bit, name in CAPABILITIES.items() if mask & bit
            ),
            max_updates=max_updates,
            num_stations=stations,
        )

    def hello(self) -> DaemonStatus:
        return self._status(OP_HELLO)

    def status(self) -> DaemonStatus:
        return self._status(OP_STATUS)

    @staticmethod
    def _encode_links(updates: list[dict]) -> bytes:
        return b"".join(
            LINK.pack(
                _mac_bytes(item["source"]),
                _mac_bytes(item["destination"]),
                int(item.get("value", 0)),
                0,
            )
            for item in updates
        )

    @staticmethod
    def _decode_links(payload: bytes) -> list[dict]:
        if len(payload) % LINK.size:
            raise ActuatorError("invalid link payload length")
        result = []
        for offset in range(0, len(payload), LINK.size):
            source, destination, snr_db, _ = LINK.unpack_from(payload, offset)
            result.append(
                {
                    "source": _mac_text(source),
                    "destination": _mac_text(destination),
                    "value": snr_db,
                }
            )
        return result

    def dump_links(self) -> tuple[int, list[dict]]:
        if "paged_link_dumps" in self.capabilities:
            generation, payload = self._dump_pages(OP_DUMP_LINKS, LINK.size)
        else:
            generation, payload = self._request(OP_DUMP_LINKS)
        return generation, self._decode_links(payload)

    def _dump_pages(self, opcode: int, entry_size: int) -> tuple[int, bytes]:
        cursor = 0
        generation: int | None = None
        total: int | None = None
        result = bytearray()
        for _ in range(4096):
            current_generation, payload = self._request(
                opcode, PAGE_REQUEST.pack(0, cursor, DEFAULT_PAGE_LIMIT)
            )
            if len(payload) < PAGE_HEADER.size:
                raise ActuatorError(f"opcode {opcode} returned a short page")
            _, _, page_total, next_cursor, flags, reserved = PAGE_HEADER.unpack_from(
                payload
            )
            entries = payload[PAGE_HEADER.size:]
            if reserved or flags & ~PAGE_MORE or len(entries) % entry_size:
                raise ActuatorError(f"opcode {opcode} returned an invalid page")
            if generation is None:
                generation = current_generation
                total = page_total
            elif current_generation != generation or page_total != total:
                raise ActuatorError(f"opcode {opcode} changed during paged dump")
            result.extend(entries)
            if next_cursor == PAGE_END:
                if len(result) // entry_size != total:
                    raise ActuatorError(
                        f"opcode {opcode} returned {len(result) // entry_size} "
                        f"entries, expected {total}"
                    )
                return generation, bytes(result)
            if not flags & PAGE_MORE or next_cursor <= cursor:
                raise ActuatorError(f"opcode {opcode} returned an invalid cursor")
            cursor = next_cursor
        raise ActuatorError(f"opcode {opcode} exceeded the page limit")

    def get_link(self, source: str, destination: str) -> tuple[int, int]:
        request = [{"source": source, "destination": destination, "value": 0}]
        generation, payload = self._request(OP_GET_LINK, self._encode_links(request))
        links = self._decode_links(payload)
        if len(links) != 1:
            raise ActuatorError("daemon returned an invalid link readback")
        return generation, links[0]["value"]

    def apply(self, generation: int, updates: list[dict]) -> list[dict]:
        if not updates:
            raise ActuatorError("an atomic generation requires at least one update")
        effective, payload = self._request(
            OP_APPLY, self._encode_links(updates), generation=generation
        )
        if effective != generation:
            raise ActuatorError(
                f"daemon acknowledged generation {effective}, expected {generation}"
            )
        applied = self._decode_links(payload)
        if applied != [
            {"source": item["source"], "destination": item["destination"],
             "value": int(item["value"])}
            for item in updates
        ]:
            raise ActuatorError("daemon apply echo differs from requested generation")
        self.status()
        return applied

    @staticmethod
    def _encode_frequency_links(updates: list[dict]) -> bytes:
        return b"".join(
            FREQUENCY_LINK.pack(
                _mac_bytes(item["source"]),
                _mac_bytes(item["destination"]),
                int(item["frequency_mhz"]),
                int(item.get("value", 0)),
                FREQUENCY_OVERRIDE if item.get("override", True) else 0,
            )
            for item in updates
        )

    @staticmethod
    def _decode_frequency_links(payload: bytes) -> list[dict]:
        if len(payload) % FREQUENCY_LINK.size:
            raise ActuatorError("invalid frequency-link payload length")
        result = []
        for offset in range(0, len(payload), FREQUENCY_LINK.size):
            source, destination, frequency, snr_db, flags = FREQUENCY_LINK.unpack_from(
                payload, offset
            )
            result.append(
                {
                    "source": _mac_text(source),
                    "destination": _mac_text(destination),
                    "frequency_mhz": frequency,
                    "value": snr_db,
                    "override": bool(flags & FREQUENCY_OVERRIDE),
                }
            )
        return result

    def dump_frequency_links(self) -> tuple[int, list[dict]]:
        if "paged_link_dumps" in self.capabilities:
            generation, payload = self._dump_pages(
                OP_DUMP_FREQUENCIES, FREQUENCY_LINK.size
            )
        else:
            generation, payload = self._request(OP_DUMP_FREQUENCIES)
        return generation, self._decode_frequency_links(payload)

    def get_frequency_link(
        self, source: str, destination: str, frequency_mhz: int
    ) -> tuple[int, int, bool]:
        request = [
            {
                "source": source,
                "destination": destination,
                "frequency_mhz": frequency_mhz,
                "value": 0,
                "override": False,
            }
        ]
        generation, payload = self._request(
            OP_GET_FREQUENCY, self._encode_frequency_links(request)
        )
        links = self._decode_frequency_links(payload)
        if len(links) != 1:
            raise ActuatorError("daemon returned an invalid frequency-link readback")
        return generation, links[0]["value"], links[0]["override"]

    def apply_frequency(self, generation: int, updates: list[dict]) -> list[dict]:
        if not updates:
            raise ActuatorError("an atomic generation requires at least one update")
        normalized = [
            {
                "source": item["source"],
                "destination": item["destination"],
                "frequency_mhz": int(item["frequency_mhz"]),
                "value": int(item.get("value", 0)),
                "override": bool(item.get("override", True)),
            }
            for item in updates
        ]
        effective, payload = self._request(
            OP_APPLY_FREQUENCY,
            self._encode_frequency_links(normalized),
            generation=generation,
        )
        if effective != generation:
            raise ActuatorError(
                f"daemon acknowledged generation {effective}, expected {generation}"
            )
        applied = self._decode_frequency_links(payload)
        if applied != normalized:
            raise ActuatorError("daemon frequency apply echo differs from requested generation")
        self.status()
        return applied
