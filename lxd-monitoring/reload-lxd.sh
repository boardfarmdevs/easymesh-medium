#!/usr/bin/env bash
set -euo pipefail
restart_units=()
for unit in easymesh-room-service.service prplmesh-room-service.service easymesh-lab.service prplmesh-lab.service; do
    state=$(systemctl is-active "$unit" || true)
    case "$state" in
        active) restart_units+=("$unit") ;;
        activating|deactivating) echo "$unit is transitioning; retry monitoring setup after lab startup/shutdown completes" >&2; exit 1 ;;
    esac
done
if [ "${#restart_units[@]}" -gt 0 ] && [ "${LAB_MONITORING_ALLOW_RESTART:-0}" != 1 ]; then
    echo 'First network setup needs a unique LXD identity and a planned lab restart. Retry with LAB_MONITORING_ALLOW_RESTART=1 during maintenance.' >&2
    exit 1
fi
if [ "${1:-}" = --check ]; then exit 0; fi
restore_lab() {
    if [ "${#restart_units[@]}" -gt 0 ]; then
        systemctl start "${restart_units[@]}"
    fi
}
trap restore_lab EXIT
if [ "${#restart_units[@]}" -gt 0 ]; then
    systemctl stop "${restart_units[@]}"
fi
systemctl restart snap.lxd.daemon
for attempt in $(seq 1 60); do
    if timeout 3 lxc --force-local query /1.0 >/dev/null 2>&1; then
        exit 0
    fi
    sleep 1
done
echo 'LXD did not become ready after its maintenance restart' >&2
exit 1
