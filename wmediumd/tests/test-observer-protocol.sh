#!/bin/bash
# Exercise the host-only observer wire contract without requiring hwsim.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
daemon=${WMEDIUMD:-$here/src/wmediumd/wmediumd}
config=${WMEDIUMD_TEST_CONFIG:-$here/src/tests/2node.cfg}
test_dir=$(mktemp -d)
daemon_pid=

cleanup() {
    if [ -n "$daemon_pid" ]; then
        kill "$daemon_pid" 2>/dev/null || true
        wait "$daemon_pid" 2>/dev/null || true
    fi
    unlink "$test_dir/vhost.sock" "$test_dir/control.sock" \
        "$test_dir/metrics.sock" "$test_dir/observer.sock" \
        "$test_dir/log" 2>/dev/null || true
    rmdir "$test_dir" 2>/dev/null || true
}
trap cleanup EXIT

"$daemon" -c "$config" -u "$test_dir/vhost.sock" \
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
PAGE = struct.Struct("!QII")


def request(opcode, payload=b"", generation=0):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    connection.connect(os.environ["TEST_SOCKET"])
    connection.sendall(
        HEADER.pack(MAGIC, 1, opcode, len(payload), 0, generation) + payload
    )
    response = connection.recv(65536)
    connection.close()
    header = HEADER.unpack_from(response)
    assert header[:3] == (MAGIC, 1, opcode), header
    assert len(response) == HEADER.size + header[3]
    return header, response[HEADER.size:]


header, info = request(1)
capabilities = struct.unpack_from("!I", info, 16)[0]
for bit in (5, 6, 7, 8, 9):
    assert capabilities & (1 << bit), hex(capabilities)

# The observer socket must reject even a syntactically incomplete mutation
# before it reaches the shared apply implementation.
header, _ = request(3)
assert header[4] == 8, header

header, summary = request(9)
assert header[4] == 0 and len(summary) == 248, (header, len(summary))

for opcode, entry_size in ((10, 136), (11, 164), (12, 24), (13, 44)):
    header, body = request(opcode, PAGE.pack(0, 0, 2))
    assert header[4] == 0, (opcode, header)
    assert len(body) >= 32 and (len(body) - 32) % entry_size == 0

print(
    f"PASS observer protocol caps=0x{capabilities:x} "
    f"summary={len(summary)} paged-dumps=4 mutation=read-only"
)
PY
