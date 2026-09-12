import struct
import tempfile
import unittest
from pathlib import Path

from wmdcfg.beacon import ap_metric_loads, beacon_loads


class BeaconTests(unittest.TestCase):
    def metric_capture(self, fragments, linktype=1):
        capture = struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, linktype)
        for source, identifier, flags, payload in fragments:
            address = bytes.fromhex(source)
            header = {1: bytes(6) + address + bytes.fromhex("893a"),
                      113: bytes(6) + address + bytes(2) + bytes.fromhex("893a"),
                      276: bytes.fromhex("893a") + bytes(10) + address + bytes(2)}[linktype]
            cmdu = struct.pack("!BBHHBB", 0, 0, 0x800C, 123, identifier, flags)
            packet = header + cmdu + payload
            capture += struct.pack("<IIII", 1, 2, len(packet), len(packet)) + packet
        return capture

    def metric_payload(self, utilization=128):
        data = bytes.fromhex("020000000100") + struct.pack("!BHB", utilization, 7, 0)
        return struct.pack("!BH", 0x94, len(data)) + data + bytes(3)

    def test_fragmented_metrics_require_a_complete_message(self):
        payload = self.metric_payload()
        first = ("020000000200", 0, 0, payload[:6])
        last = ("020000000200", 1, 128, payload[6:])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics.pcap"
            for linktype in (1, 113, 276):
                for fragments in ([first, last], [last, first], [first, first, last]):
                    with self.subTest(linktype=linktype, fragments=len(fragments)):
                        path.write_bytes(self.metric_capture(fragments, linktype))
                        self.assertEqual(ap_metric_loads(path)[0]["utilization_byte"], 128)
                for fragments in ([first], [last]):
                    path.write_bytes(self.metric_capture(fragments, linktype))
                    self.assertEqual(ap_metric_loads(path), [])

    def test_interleaved_sources_do_not_mix_same_message_ids(self):
        first = self.metric_payload(0)
        second = self.metric_payload(255)
        fragments = [("020000000200", 0, 0, first[:6]),
                     ("020000000300", 1, 128, second[6:]),
                     ("020000000200", 1, 128, first[6:]),
                     ("020000000300", 0, 0, second[:6])]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics.pcap"
            path.write_bytes(self.metric_capture(fragments))
            self.assertEqual([row["utilization_byte"] for row in ap_metric_loads(path)], [0, 255])

    def test_conflicting_or_malformed_messages_do_not_publish_partial_metrics(self):
        payload = self.metric_payload()
        variants = [
            [("020000000200", 0, 0, payload[:6]),
             ("020000000200", 0, 0, b"wrong"),
             ("020000000200", 1, 128, payload[6:])],
            [("020000000200", 0, 128, payload[:-3])],
            [("020000000200", 0, 128, payload[:-3] + b"\x94\x00\x20short")],
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics.pcap"
            for fragments in variants:
                path.write_bytes(self.metric_capture(fragments))
                self.assertEqual(ap_metric_loads(path), [])
            path.write_bytes(self.metric_capture(variants[0]) + b"truncated")
            with self.assertRaisesRegex(ValueError, "packet header"):
                ap_metric_loads(path)

    def capture(self, elements):
        frame = bytes([0x80, 0]) + bytes(14) + bytes.fromhex("020000000100") + bytes(14) + elements
        packet = struct.pack("<BBHI", 0, 0, 8, 0) + frame
        return struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 127) + \
            struct.pack("<IIII", 1, 2, len(packet), len(packet)) + packet

    def test_missing_zero_half_and_full_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "beacon.pcap"
            for utilization in (None, 0, 128, 255):
                elements = b"\x00\x04test"
                if utilization is not None:
                    elements += bytes([11, 5]) + struct.pack("<HBH", 7, utilization, 0)
                path.write_bytes(self.capture(elements))
                row = beacon_loads(path)[0]
                self.assertEqual(row["bssid"], "02:00:00:00:01:00")
                self.assertEqual(row["ssid"], "test")
                self.assertEqual(row["utilization_byte"], utilization)
                self.assertEqual(row["station_count"], 7 if utilization is not None else None)

    def test_rejects_truncation_and_non_radiotap(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.pcap"
            for raw in (b"", self.capture(b"")[:-1], bytes(24)):
                path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    beacon_loads(path)

    def test_native_ap_metrics_byte_and_station_count(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics.pcap"
            data = bytes.fromhex("020000000100") + struct.pack("!BHB", 128, 7, 0)
            cmdu = struct.pack("!BBHHBB", 0, 0, 0x800C, 123, 0, 0x80)
            cmdu += struct.pack("!BH", 0x94, len(data)) + data + bytes(3)
            for linktype, header in ((1, bytes(12) + bytes.fromhex("893a")),
                                     (113, bytes(14) + bytes.fromhex("893a")),
                                     (276, bytes.fromhex("893a") + bytes(18))):
                packet = header + cmdu
                path.write_bytes(struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, linktype) +
                                 struct.pack("<IIII", 1, 2, len(packet), len(packet)) + packet)
                row = ap_metric_loads(path)[0]
                self.assertEqual(row["bssid"], "02:00:00:00:01:00")
                self.assertEqual(row["utilization_byte"], 128)
                self.assertEqual(row["station_count"], 7)
                self.assertEqual(row["message_id"], 123)
