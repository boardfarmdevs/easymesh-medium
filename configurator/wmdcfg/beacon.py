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
    offset = 24
    while offset + 16 <= len(raw):
        seconds, fraction, length, original = struct.unpack_from(endian + "IIII", raw, offset)
        offset += 16
        frame = raw[offset:offset + length]
        offset += length
        if len(frame) != length:
            raise ValueError("truncated packet")
        if len(frame) < header_size + 8 or frame[protocol_offset:protocol_offset + 2] != b"\x89\x3a":
            continue
        cmdu = frame[header_size:]
        if cmdu[2:4] != b"\x80\x0c" or cmdu[6] != 0:
            continue
        position = 8
        while position + 3 <= len(cmdu):
            kind, size = struct.unpack_from("!BH", cmdu, position)
            data = cmdu[position + 3:position + 3 + size]
            position += 3 + size
            if len(data) != size or not kind:
                break
            if kind == 0x94 and size >= 10:
                records.append({
                    "bssid": ":".join(f"{octet:02x}" for octet in data[:6]),
                    "utilization_byte": data[6],
                    "station_count": struct.unpack_from("!H", data, 7)[0],
                    "message_id": struct.unpack_from("!H", cmdu, 4)[0],
                    "timestamp_seconds": seconds, "timestamp_fraction": fraction,
                })
    return records
