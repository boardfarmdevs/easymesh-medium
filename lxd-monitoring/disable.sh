#!/usr/bin/env bash
set -euo pipefail
destination=/opt/easymesh-observability
test "$EUID" = 0 || { echo 'Run as root inside the appliance VM' >&2; exit 1; }
test -f "$destination/.managed-by-easymesh"
test -f "$destination/state/previous-lxd.json"
if [ -f "$destination/state/outer-metrics.json" ]; then
    echo 'Run observability/disable-outer-metrics.sh VM on the outer host first to revoke outer metrics trust.' >&2
    exit 1
fi
docker compose --project-directory "$destination" down
if [ -s "$destination/state/metrics-fingerprint" ]; then
    fingerprint=$(cat "$destination/state/metrics-fingerprint")
    if lxc --force-local config trust list --format json | jq -e --arg fingerprint "$fingerprint" \
        'any(.[]; .fingerprint == $fingerprint and .type == "metrics")' >/dev/null; then
        lxc --force-local config trust remove "$fingerprint"
    fi
fi
result=0
for setting in core.https_address core.metrics_address core.metrics_authentication; do
    previous=$(jq -r --arg setting "$setting" '.[$setting]' "$destination/state/previous-lxd.json")
    current=$(lxc --force-local config get "$setting")
    case "$setting" in
        core.https_address) managed=127.0.0.1:8443 ;;
        core.metrics_address) managed=127.0.0.1:8444 ;;
        core.metrics_authentication) managed=true ;;
    esac
    if [ -f "$destination/state/managed-lxd.json" ]; then
        managed=$(jq -r --arg setting "$setting" '.[$setting]' "$destination/state/managed-lxd.json")
    fi
    if [ "$current" = "$previous" ]; then
        continue
    elif [ "$current" != "$managed" ]; then
        echo "Preserving operator-modified $setting=$current; restore it manually if intended" >&2
        result=1
        continue
    fi
    if [ -n "$previous" ]; then
        lxc --force-local config set "$setting" "$previous"
    else
        lxc --force-local config unset "$setting"
    fi
done
printf '%s\n' 'Monitoring stopped; data volumes and local credentials retained for deliberate reuse or removal.'
exit "$result"
