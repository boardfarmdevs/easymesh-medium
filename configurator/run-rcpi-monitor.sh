#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$script_dir/../../.." && pwd)
# shellcheck source=../../tests/lib/observer-status.sh
source "$repo/gen/tests/lib/observer-status.sh"
client_container=${1:-wlan-client}
api_url=${EM_CLIENTS_API:-http://127.0.0.1:8888/api/v1/clients}
output_root=${WMD_RUN_ROOT:-/tmp/wmdcfg-runs}
traffic_target=${WMD_TRAFFIC_TARGET:-10.0.0.1}
inventory_file=$(mktemp --suffix=.json /tmp/rcpi-monitor-inventory.XXXXXX)
plan_file=$(mktemp --suffix=.json /tmp/rcpi-monitor-plan.XXXXXX)
sampler_pid=
traffic_pid=

cleanup() {
    if [[ -n "$sampler_pid" ]]; then
        kill "$sampler_pid" 2>/dev/null || true
        wait "$sampler_pid" 2>/dev/null || true
    fi
    if [[ -n "$traffic_pid" ]]; then
        kill "$traffic_pid" 2>/dev/null || true
        wait "$traffic_pid" 2>/dev/null || true
    fi
    rm -f -- "$inventory_file" "$plan_file"
}
trap cleanup EXIT

for command in curl jq lxc python3 timeout; do
    command -v "$command" >/dev/null || {
        echo "required command not found: $command" >&2
        exit 2
    }
done

cd "$script_dir"
status_section "Live client RCPI monitor"
status_action "Discovering $client_container and its current serving BSSID."
python3 -m wmdcfg.cli inventory -o "$inventory_file"

client_mac=$(jq -r --arg container "$client_container" '
    .radios[]
    | select(.kind == "station" and .container == $container)
    | .permanent_mac' "$inventory_file")
serving_bssid=$(jq -r --arg container "$client_container" '
    .radios[]
    | select(.kind == "station" and .container == $container)
    | .associated_bssid // empty' "$inventory_file")

if [[ -z "$client_mac" || -z "$serving_bssid" ]]; then
    echo "$client_container is absent or not associated" >&2
    exit 2
fi

serving_ap=$(jq -r --arg bssid "$serving_bssid" '
    [.radios[]
     | select(.kind == "mesh")
     | select(any(.interfaces[]?;
         ((.mac // "") | ascii_downcase) == ($bssid | ascii_downcase)))
     | .container]
    | if length == 1 then .[0] else empty end' "$inventory_file")

if [[ -z "$serving_ap" ]]; then
    echo "could not map serving BSSID $serving_bssid to exactly one mesh container" >&2
    exit 2
fi

python3 -m wmdcfg.cli compile scenarios/client-rcpi-monitor.wmd \
    --inventory "$inventory_file" \
    --bind "client=$client_container" \
    --bind "ap=$serving_ap" \
    -o "$plan_file"
status_note "$client_container is served by $serving_ap ($serving_bssid)."

# hwsim updates the observed signal when frames cross the RF link. Start a
# small traffic stream before checking RCPI so an otherwise idle client gets a
# fresh observation during the next reporting interval.
lxc exec "$client_container" -- ping -I wlan0 -c 1 -W 2 "$traffic_target" \
    >/dev/null
timeout 150 lxc exec "$client_container" -- \
    ping -I wlan0 -i 0.2 "$traffic_target" >/dev/null 2>&1 &
traffic_pid=$!
status_wait_seconds 6 "generating traffic and waiting for the first metrics-reporting interval"

initial_rcpi=$(curl -fsS "$api_url" | jq -r --arg mac "$client_mac" '
    first(.clients[]
      | select((.mac | ascii_downcase) == ($mac | ascii_downcase))
      | .client_metrics.rcpi) // 0')
if [[ "$initial_rcpi" -le 0 ]]; then
    echo "the clients API has no reported RCPI for $client_mac" >&2
    echo "enable metrics reporting and deploy the live-RCPI WebUI/API fix first" >&2
    exit 2
fi

echo "client=$client_container mac=$client_mac serving_ap=$serving_ap bssid=$serving_bssid"
status_note "Open Network Topology or Connected Clients; signal refreshes every two seconds."
printf 'time\tclient\tbssid\trcpi\trssi_dbm\n'

sample_api() {
    while true; do
        sample_time=$(date -u +%H:%M:%S)
        curl -fsS "$api_url" | jq -r \
            --arg sample_time "$sample_time" --arg mac "$client_mac" '
            first(.clients[]
              | select((.mac | ascii_downcase) == ($mac | ascii_downcase))) as $client
            | [$sample_time, $client.mac, $client.connected_bssid,
               $client.client_metrics.rcpi,
               $client.client_metrics.rssi_dbm]
            | @tsv'
        sleep 2
    done
}

sample_api &
sampler_pid=$!

status_action "Running the SNR gradient; watch RCPI/RSSI fall and then recover."
python3 -m wmdcfg.cli run "$plan_file" --output-root "$output_root"

# Keep traffic and API sampling alive for one more five-second reporting period
# so the restored baseline is visible before the script exits.
status_wait_seconds 6 "showing the restored baseline for one final reporting interval"
status_pass "RCPI monitor scenario completed and restored the medium."
