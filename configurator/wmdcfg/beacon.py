from __future__ import annotations

import struct
from pathlib import Path


def beacon_loads(path: Path) -> list[dict]:
    raw = path.read_bytes()
    if len(raw) < 24:
        raise ValueError("truncated pcap")
    formats = {b"\xd4\xc3\xb2\xa1": "<", b"\xa1\xb2\xc3\xd4": ">",
               b"\x4d\x3c\xb2\xa1": "<", b"\xa1\xb2\x3c\x4d": ">"}
    endian = formats.get(raw[:4])
    if endian is None or struct.unpack_from(endian + "I", raw, 20)[0] != 127:
        raise ValueError("radiotap pcap required")
    offset = 24
    records = []
    while offset < len(raw):
        if offset + 16 > len(raw):
            raise ValueError("truncated packet header")
        seconds, fraction, length, original = struct.unpack_from(endian + "IIII", raw, offset)
        offset += 16
        packet = raw[offset:offset + length]
        offset += length
        if len(packet) != length:
            raise ValueError("truncated packet")
        if len(packet) < 8:
            continue
        radiotap_length = struct.unpack_from("<H", packet, 2)[0]
        frame = packet[radiotap_length:]
        if len(frame) < 36 or frame[0] & 0xFC != 0x80:
            continue
        row = {"bssid": ":".join(f"{octet:02x}" for octet in frame[16:22]),
               "timestamp_seconds": seconds, "timestamp_fraction": fraction,
               "station_count": None, "utilization_byte": None,
               "admission_capacity": None, "ssid": None}
        position = 36
        while position + 2 <= len(frame):
            identifier, size = frame[position:position + 2]
            data = frame[position + 2:position + 2 + size]
            position += 2 + size
            if len(data) != size:
                break
            if identifier == 0:
                row["ssid"] = data.decode("utf-8", errors="replace")
            elif identifier == 11 and size == 5:
                row["station_count"], row["utilization_byte"], row["admission_capacity"] = \
                    struct.unpack("<HBH", data)
        records.append(row)
    return records

def ap_metric_loads(path: Path) -> list[dict]:
    raw = path.read_bytes()
    if len(raw) < 24 or raw[:4] not in (b"\xd4\xc3\xb2\xa1", b"\xa1\xb2\xc3\xd4"):
        raise ValueError("classic pcap required")
    endian = "<" if raw[0] == 0xD4 else ">"
    linktype = struct.unpack_from(endian + "I", raw, 20)[0]
    headers = {1: (14, 12), 113: (16, 14), 276: (20, 0)}
    if linktype not in headers:
        raise ValueError("Ethernet or Linux cooked pcap required")
    header_size, protocol_offset = headers[linktype]
    records = []
    pending = {}
    offset = 24
    while offset < len(raw):
        if offset + 16 > len(raw):
            raise ValueError("truncated packet header")
        seconds, fraction, length, original = struct.unpack_from(endian + "IIII", raw, offset)
        offset += 16
        frame = raw[offset:offset + length]
        offset += length
        if len(frame) != length:
            raise ValueError("truncated packet")
        if len(frame) < header_size + 8 or frame[protocol_offset:protocol_offset + 2] != b"\x89\x3a":
            continue
        cmdu = frame[header_size:]
        if cmdu[0] != 0 or cmdu[2:4] != b"\x80\x0c":
            continue
        timestamp = seconds + fraction / 1000000
        source = frame[6:12] if linktype == 1 else frame[6:14] if linktype == 113 else frame[12:20]
        message_id = struct.unpack_from("!H", cmdu, 4)[0]
        key = (source, message_id)
        pending = {identity: assembly for identity, assembly in pending.items()
                   if 0 <= timestamp - assembly["started"] <= 5}
        if len(pending) >= 1024 and key not in pending:
            raise ValueError("too many incomplete AP metrics messages")
        assembly = pending.setdefault(key, {"started": timestamp, "parts": {}, "last": None,
                                            "invalid": False})
        fragment = cmdu[6]
        payload = cmdu[8:]
        previous = assembly["parts"].get(fragment)
        if previous is not None and previous != payload:
            assembly["invalid"] = True
        assembly["parts"][fragment] = payload
        if cmdu[7] & 0x80:
            if assembly["last"] is not None and assembly["last"] != fragment:
                assembly["invalid"] = True
            assembly["last"] = fragment
        if sum(map(len, assembly["parts"].values())) > 65535:
            raise ValueError("oversized AP metrics message")
        last = assembly["last"]
        if assembly["invalid"] or last is None or set(assembly["parts"]) != set(range(last + 1)):
            continue
        payload = b"".join(assembly["parts"][index] for index in range(last + 1))
        del pending[key]
        position = 0
        decoded = []
        complete = False
        while position + 3 <= len(payload):
            kind, size = struct.unpack_from("!BH", payload, position)
            data = payload[position + 3:position + 3 + size]
            position += 3 + size
            if len(data) != size:
                break
            if not kind:
                complete = size == 0
                break
            if kind == 0x94 and size >= 10:
                decoded.append({
                    "bssid": ":".join(f"{octet:02x}" for octet in data[:6]),
                    "utilization_byte": data[6],
                    "station_count": struct.unpack_from("!H", data, 7)[0],
                    "message_id": message_id,
                    "timestamp_seconds": seconds, "timestamp_fraction": fraction,
                })
        if complete:
            records.extend(decoded)
    return records
