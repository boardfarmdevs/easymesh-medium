from __future__ import annotations

import struct
import unittest

from wmdcfg.actuator import (
    FREQUENCY_LINK,
    HEADER,
    INFO,
    MAGIC,
    OP_APPLY_FREQUENCY,
    OP_GET_FREQUENCY,
    OP_HELLO,
    VERSION,
)
from wmdcfg.kernel_metrics_proxy import ERR_READ_ONLY, OK, handle_frame


SOURCE = "02:00:00:00:01:40"
DESTINATION = "02:00:00:00:02:40"


class Status:
    instance_id = "0123456789abcdef0011223344556677"
    generation = 9
    capabilities = frozenset({
        "radio_pair_snr", "atomic_generations", "readback",
        "dump_links", "frequency_qualified_snr", "kernel_data_path",
    })
    max_updates = 42
    num_stations = 7


class FakeKernel:
    def __init__(self, *, locking=True):
        assert locking is False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def status(self):
        return Status()

    def get_frequency_link(self, source, destination, frequency):
        self.last = source, destination, frequency
        return 9, 37, True


def request(opcode: int, payload: bytes = b"") -> bytes:
    return HEADER.pack(MAGIC, VERSION, opcode, len(payload), 0, 0) + payload


class ProxyTests(unittest.TestCase):
    def test_hello_advertises_read_only_frequency_metrics(self):
        response = handle_frame(request(OP_HELLO), FakeKernel)
        _, _, opcode, length, status, generation = HEADER.unpack_from(response)
        self.assertEqual((opcode, length, status, generation), (OP_HELLO, INFO.size, OK, 9))
        _, _, capabilities, maximum, stations, _ = INFO.unpack_from(response, HEADER.size)
        self.assertTrue(capabilities & (1 << 4))
        self.assertTrue(capabilities & (1 << 5))
        self.assertEqual((maximum, stations), (42, 7))

    def test_frequency_readback_uses_kernel_matrix(self):
        source = bytes.fromhex(SOURCE.replace(":", ""))
        destination = bytes.fromhex(DESTINATION.replace(":", ""))
        payload = FREQUENCY_LINK.pack(source, destination, 5180, 0, 0)
        response = handle_frame(request(OP_GET_FREQUENCY, payload), FakeKernel)
        *_, length, status, generation = HEADER.unpack_from(response)
        self.assertEqual((length, status, generation), (FREQUENCY_LINK.size, OK, 9))
        actual = FREQUENCY_LINK.unpack_from(response, HEADER.size)
        self.assertEqual(actual, (source, destination, 5180, 37, 1))

    def test_mutation_is_rejected(self):
        response = handle_frame(request(OP_APPLY_FREQUENCY, b"x"), FakeKernel)
        *_, status, generation = HEADER.unpack_from(response)
        self.assertEqual((status, generation), (ERR_READ_ONLY, 0))


if __name__ == "__main__":
    unittest.main()
