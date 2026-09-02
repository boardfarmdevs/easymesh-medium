#!/bin/bash
# Prove that the 100-client appliance's 105-radio O(N^2) pair matrix remains
# readable without exceeding the bounded 64-KiB observer frame.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
daemon=${WMEDIUMD:-$here/src/wmediumd/wmediumd}
test_dir=$(mktemp -d /tmp/wmediumd-large-pairs.XXXXXX)
daemon_pid=

cleanup() {
    if [ -n "$daemon_pid" ]; then
        kill "$daemon_pid" 2>/dev/null || true
        wait "$daemon_pid" 2>/dev/null || true
    fi
    find "$test_dir" -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null || true
    find "$test_dir" -mindepth 1 -maxdepth 1 -type s -delete 2>/dev/null || true
    rmdir "$test_dir" 2>/dev/null || true
}
trap cleanup EXIT

{
    echo 'ifaces : {'
    echo '  count = 105;'
    echo '  ids = ['
    for index in $(seq 0 104); do
        separator=,
        [ "$index" -lt 104 ] || separator=
        printf '    "42:00:00:00:%02x:00"%s\n' "$index" "$separator"
    done
    echo '  ];'
    echo '};'
    echo 'model : { type = "snr"; default_snr = 30; };'
} > "$test_dir/105-radio.cfg"

"$daemon" -c "$test_dir/105-radio.cfg" -u "$test_dir/vhost.sock" \
    -C "$test_dir/control.sock" -R "$test_dir/metrics.sock" \
    -O "$test_dir/observer.sock" >"$test_dir/log" 2>&1 &
daemon_pid=$!
for _ in $(seq 1 50); do
    [ -S "$test_dir/observer.sock" ] && break
    sleep 0.1
done
[ -S "$test_dir/observer.sock" ] || {
    cat "$test_dir/log" >&2
    exit 1
}

TEST_SOCKET="$test_dir/observer.sock" python3 - <<'PY'
import os
import socket
import struct

MAGIC = 0x574D4443
HEADER = struct.Struct("!IHHIIQ")
PAGE_REQUEST = struct.Struct("!QII")
PAGE_HEADER = struct.Struct("!QQIIII")
LINK = struct.Struct("!6s6shH")
PAGE_END = 0xFFFFFFFF
PAGE_MORE = 1

s = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
s.settimeout(2)
s.connect(os.environ["TEST_SOCKET"])


def request(opcode, payload=b""):
    s.sendall(HEADER.pack(MAGIC, 1, opcode, len(payload), 0, 0) + payload)
    response = s.recv(64 * 1024)
    assert len(response) >= HEADER.size, (opcode, len(response))
    header = HEADER.unpack_from(response)
    assert header[:3] == (MAGIC, 1, opcode), header
    assert header[4] == 0 and len(response) == HEADER.size + header[3], header
    return header, response[HEADER.size:]


header, info = request(1)
capabilities = struct.unpack_from("!I", info, 16)[0]
assert capabilities & (1 << 11), hex(capabilities)
generation = header[5]

cursor = 0
links = set()
pages = 0
while True:
    header, body = request(5, PAGE_REQUEST.pack(0, cursor, 128))
    assert header[5] == generation
    snapshot, oldest, total, next_cursor, flags, reserved = PAGE_HEADER.unpack_from(body)
    assert snapshot == generation and oldest == 0 and reserved == 0
    entries = body[PAGE_HEADER.size:]
    assert len(entries) % LINK.size == 0
    for offset in range(0, len(entries), LINK.size):
        source, destination, _, link_reserved = LINK.unpack_from(entries, offset)
        assert source != destination and link_reserved == 0
        links.add((source, destination))
    pages += 1
    if next_cursor == PAGE_END:
        assert flags == 0
        break
    assert flags == PAGE_MORE and next_cursor > cursor
    cursor = next_cursor

assert total == 105 * 104, total
assert len(links) == total, (len(links), total)
assert pages > 1, pages

header, body = request(8, PAGE_REQUEST.pack(0, 0, 128))
_, _, total, next_cursor, flags, reserved = PAGE_HEADER.unpack_from(body)
assert total == 0 and next_cursor == PAGE_END and flags == 0 and reserved == 0
s.close()
print(f"PASS: paged 105-radio pair dump entries={len(links)} pages={pages}")
PY

PYTHONPATH="$here/configurator" TEST_SOCKET="$test_dir/observer.sock" python3 - <<'PY'
import os

from wmdcfg.actuator import ControlClient

with ControlClient(os.environ["TEST_SOCKET"]) as client:
    status = client.status()
    assert "paged_link_dumps" in status.capabilities, status.capabilities
    generation, links = client.dump_links()
    assert generation == status.generation
    assert len(links) == 105 * 104, len(links)
    assert client.dump_frequency_links() == (generation, [])
print(f"PASS: configurator paged pair dump entries={len(links)}")
PY
