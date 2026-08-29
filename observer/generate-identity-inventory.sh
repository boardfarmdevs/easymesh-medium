#!/bin/bash
# Generate the short-lived, unprivileged Console identity handoff. This runs
# from an operator/cold-start context where LXC discovery is appropriate; the
# long-running Console never receives LXD socket access.
set -euo pipefail

output=${WMEDIUMD_IDENTITY_INVENTORY:-/run/meta-cmf-wmediumd/identity-inventory.json}
lxc_bin=${LXC:-lxc}
topology_url=${WMEDIUMD_EASYMESH_TOPOLOGY_URL:-http://127.0.0.1:8888/api/v1/topology}
topology_file=${WMEDIUMD_EASYMESH_TOPOLOGY_FILE:-}

usage() {
    echo "usage: $0 [--output PATH]" >&2
    exit 2
}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --output) [ "$#" -ge 2 ] || usage; output=$2; shift 2 ;;
        *) usage ;;
    esac
done

command -v "$lxc_bin" >/dev/null 2>&1 || { echo "identity inventory: LXC command not found: $lxc_bin" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "identity inventory: python3 is required for safe JSON encoding" >&2; exit 1; }

work=$(mktemp -d)
rows=$work/rows.tsv
topology=$work/topology.json
trap 'rm -rf "$work"' EXIT
: > "$rows"
: > "$topology"

# EasyMesh numbers extenders in its current topology traversal, which is not
# the same thing as the LXC container suffix.  Use the live topology when it is
# available so both UIs display the same name; retain deterministic container
# labels when the controller/WebUI is not ready yet.
if [ -n "$topology_file" ] && [ -r "$topology_file" ]; then
    cp "$topology_file" "$topology"
elif command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 --max-filesize 1048576 "$topology_url" \
        -o "$topology" 2>/dev/null || : > "$topology"
fi
[ "$(wc -c < "$topology")" -le 1048576 ] || : > "$topology"

mapfile -t containers < <("$lxc_bin" list -c n --format csv 2>/dev/null \
    | grep -E '^(bpibroadband|bpiap(-[0-9]{3})?|wlan-client(-[0-9]{3})?)$' \
    | sort -V)

transmitter_mac() {
    local container=$1 permanent first
    permanent=$("$lxc_bin" exec "$container" -- sh -c \
        'cat /sys/class/ieee80211/*/macaddress 2>/dev/null | head -1' \
        </dev/null 2>/dev/null || true)
    permanent=${permanent,,}
    [[ "$permanent" =~ ^[0-9a-f]{2}(:[0-9a-f]{2}){5}$ ]] || return 1
    first=$(printf '%02x' $((16#${permanent:0:2} | 0x40)))
    printf '%s%s\n' "$first" "${permanent:2}"
}

easymesh_id_for_transmitter() {
    local mac=$1 first
    first=$(printf '%02x' $((16#${mac:0:2} & 0xbf)))
    printf '%s%s20\n' "$first" "${mac:2:13}"
}

config_value() {
    "$lxc_bin" config get "$1" "$2" 2>/dev/null || true
}

for container in "${containers[@]}"; do
    mac=$(transmitter_mac "$container") || continue
    interface=
    mesh_id=
    case "$container" in
        bpibroadband)
            label=Agent-1; role=controller-agent
            ;;
        bpiap)
            label=Extender-1; role=extender
            mesh_id=$(easymesh_id_for_transmitter "$mac")
            ;;
        bpiap-[0-9][0-9][0-9])
            suffix=${container#bpiap-}
            label=$(printf 'Extender-%d' "$((10#$suffix + 1))")
            role=extender
            mesh_id=$(easymesh_id_for_transmitter "$mac")
            ;;
        wlan-client|wlan-client-[0-9][0-9][0-9])
            interface=wlan0
            cohort=$(config_value "$container" user.easymesh.cohort)
            ordinal=$(config_value "$container" user.easymesh.ordinal)
            ssid=$(config_value "$container" user.easymesh.ssid)
            [[ "$ordinal" =~ ^[1-9][0-9]{0,2}$ ]] || {
                if [ "$container" = wlan-client ]; then ordinal=1
                else suffix=${container#wlan-client-}; ordinal=$((10#$suffix + 1)); fi
            }
            if [ "$cohort" != iot ] && [ "$cohort" != private ]; then
                if [ "$ssid" = iot_ssid ]; then cohort=iot; else cohort=private; fi
            fi
            # Match the EM CLI topology identity.  Lab client MACs encode the
            # stable client number in octet five (02:00:00:00:NN:00); the
            # wmediumd transmitter identity differs only by its 0x40 bit.
            # Cohort ordinals restart at one and therefore cannot be used as
            # the cross-UI device identity (for example 14:00 is iot-14, not
            # the second IoT client).
            if [[ "$mac" =~ ^[0-9a-f]{2}:00:00:00:([0-9a-f]{2}):00$ ]]; then
                stable_id=${BASH_REMATCH[1]}
            else
                stable_id=$(printf '%02d' "$ordinal")
            fi
            if [ "$cohort" = iot ]; then label="iot-$stable_id"; role=iot-client
            else label="sta-$stable_id"; role=wlan-client; fi
            ;;
        *) continue ;;
    esac
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$mac" "$label" "$role" "$container" "$interface" "$mesh_id" >> "$rows"
done

[ -s "$rows" ] || { echo "identity inventory: no active hwsim radios discovered" >&2; exit 1; }
[ "$(wc -l < "$rows")" -le 512 ] || { echo "identity inventory: more than 512 radios discovered" >&2; exit 1; }

directory=$(dirname -- "$output")
[ -d "$directory" ] || { echo "identity inventory: output directory does not exist: $directory" >&2; exit 1; }
staging=$(mktemp "$directory/.identity-inventory.XXXXXX")
trap 'rm -rf "$work"; rm -f "$staging"' EXIT
python3 - "$rows" "$topology" "$staging" <<'PY'
import csv
import datetime
import json
import sys

rows_path, topology_path, output_path = sys.argv[1:]
topology_names = {}
try:
    with open(topology_path, encoding="utf-8") as source:
        topology = json.load(source)
    for node in topology.get("nodes", [])[:512]:
        device_id = str(node.get("id", "")).lower()
        name = str(node.get("name", ""))
        if device_id and name.startswith("Extender-") and name[9:].isdigit():
            topology_names[device_id] = name
except (OSError, ValueError, TypeError, AttributeError):
    pass

stations = []
with open(rows_path, encoding="utf-8", newline="") as source:
    for mac, label, role, owner, interface, mesh_id in csv.reader(source, delimiter="\t"):
        label = topology_names.get(mesh_id.lower(), label)
        stations.append({
            "mac": mac,
            "label": label,
            "role": role,
            "owner": owner,
            "interface": interface,
        })
document = {
    "schema_version": 1,
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "stations": stations,
}
with open(output_path, "w", encoding="utf-8") as target:
    json.dump(document, target, indent=2, sort_keys=True)
    target.write("\n")
PY
chmod 0644 "$staging"
mv -f "$staging" "$output"
trap 'rm -rf "$work"' EXIT
echo "identity inventory: wrote $(wc -l < "$rows") radios to $output"
