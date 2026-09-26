#!/bin/bash
# A room larger than one control frame (the lab's rooms with OpenSync pods):
# more frequency-qualified overrides than one 64-KiB frame carries, applied as
# consecutive generations, all held, read back and paged; lookups are indexed
# per radio pair (patch 0035).
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
daemon=${WMEDIUMD:-$here/src/wmediumd/wmediumd}
test_dir=$(mktemp -d /tmp/wmediumd-override-capacity.XXXXXX)
daemon_pid=

cleanup() {
    if [ -n "$daemon_pid" ]; then
        kill "$daemon_pid" 2>/dev/null || true
        wait "$daemon_pid" 2>/dev/null || true
    fi
    find "$test_dir" -mindepth 1 -maxdepth 1 \( -type f -o -type s \) -delete 2>/dev/null || true
    rmdir "$test_dir" 2>/dev/null || true
}
trap cleanup EXIT

{
    echo 'ifaces : {'
    echo '  count = 110;'
    echo '  ids = ['
    for index in $(seq 0 109); do
        separator=,
        [ "$index" -lt 109 ] || separator=
        printf '    "42:00:00:00:%02x:00"%s\n' "$index" "$separator"
    done
    echo '  ];'
    echo '};'
    echo 'model : { type = "snr"; default_snr = 30; };'
} > "$test_dir/110-radio.cfg"

"$daemon" -c "$test_dir/110-radio.cfg" -u "$test_dir/vhost.sock" \
    -C "$test_dir/control.sock" >"$test_dir/log" 2>&1 &
daemon_pid=$!
for _ in $(seq 1 50); do
    [ -S "$test_dir/control.sock" ] && break
    sleep 0.1
done
[ -S "$test_dir/control.sock" ] || { cat "$test_dir/log" >&2; exit 1; }

PYTHONPATH="$here/configurator" TEST_SOCKET="$test_dir/control.sock" python3 - <<'PY'
import os
from wmdcfg.actuator import (ActuatorError, ControlClient, MAX_FREQUENCY_UPDATES_PER_FRAME,
                             apply_frequency_frames)

mac = lambda index: "42:00:00:00:%02x:00" % index
# 100 clients x (5 tri-band APs + 2 single-band pods) x 2 directions, capped here
updates = []
for client in range(10, 110):
    for ap in range(7):
        for frequency in ((2437,) if ap >= 5 else (2437, 5180, 5975)):
            for source, destination in ((client, ap), (ap, client)):
                updates.append({"source": mac(source), "destination": mac(destination),
                                "frequency_mhz": frequency, "value": (client + ap) % 50,
                                "override": True})
assert len(updates) > MAX_FREQUENCY_UPDATES_PER_FRAME, len(updates)
with ControlClient(os.environ["TEST_SOCKET"]) as client:
    status = client.status()
    assert status.max_updates >= len(updates), status.max_updates
    applied, last = apply_frequency_frames(client, status.generation + 1, updates)
    assert len(applied) == len(updates) and last == status.generation + 2
    for item in (updates[0], updates[len(updates) // 2], updates[-1]):
        _, value, overridden = client.get_frequency_link(item["source"], item["destination"],
                                                         item["frequency_mhz"])
        assert (value, overridden) == (item["value"], True), (item, value, overridden)
    _, rows = client.dump_frequency_links()
    assert len(rows) == len(updates), len(rows)
    # clearing one frequency of a pair keeps the pair's others
    first = updates[0]
    client.apply_frequency(last + 1, [{**first, "override": False, "value": 0}])
    _, value, overridden = client.get_frequency_link(first["source"], first["destination"], 2437)
    assert overridden is False and value == 30, (value, overridden)
    _, value, overridden = client.get_frequency_link(first["source"], first["destination"], 5180)
    assert overridden is True, (value, overridden)
print(f"PASS: {len(updates)} frequency overrides in {last - status.generation} generations, "
      f"read back, paged dump {len(rows)}, pair index keeps the rest")
PY
