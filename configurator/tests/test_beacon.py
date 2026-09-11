import struct
import tempfile
import unittest
from pathlib import Path

from wmdcfg.beacon import ap_metric_loads, beacon_loads


class BeaconTests(unittest.TestCase):
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
