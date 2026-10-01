#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
instance=${1:?usage: bash enable.sh VM HOST_IPV4 [LABEL]}
host_address=${2:?supply the physical host IPv4 address}
label=${3:-$instance}
# The lab's ports: LAB_LXD_UI_PORT, LAB_GRAFANA_PORT and LAB_OUTER_METRICS_PORT, else base+3,
# +4 and +5 from LAB_PORT_BASE (each lab's gen/vm/lxd/monitoring.sh or deploy/lxd-vm/
# monitoring.sh sets them), else from the lab's instance-config.sh beside this bundle (an
# exported lab bundle carries it), else base 18889.
if [ -z "${LAB_PORT_BASE:-}" ] && [ -r "$source_dir/../instance-config.sh" ]; then
    . "$source_dir/../instance-config.sh"
    if declare -F easymesh_instance_port_base >/dev/null; then    # the RDK lab
        EASYMESH_LXD_NAME=${EASYMESH_LXD_NAME:-$instance}
        LAB_PORT_BASE=$(easymesh_instance_port_base "$instance")
    elif declare -F prplmesh_instance_config >/dev/null; then     # the prplMesh lab
        prplmesh_instance_config "$instance"
        LAB_PORT_BASE=$PRPLMESH_PORT_BASE
    fi
fi
port_base=${LAB_PORT_BASE:-18889}
ui_port=${LAB_LXD_UI_PORT:-$((port_base + 3))}
grafana_port=${LAB_GRAFANA_PORT:-$((port_base + 4))}
outer_metrics_port=${LAB_OUTER_METRICS_PORT:-$((port_base + 5))}
python3 - "$host_address" "$ui_port" "$grafana_port" <<'PY'
import ipaddress
import sys
address = ipaddress.IPv4Address(sys.argv[1])
assert not address.is_unspecified and not address.is_multicast
ports = [int(value) for value in sys.argv[2:]]
assert all(1024 <= value <= 65535 for value in ports) and len(set(ports)) == 2
PY
lxc info "$instance" | grep 'Type: virtual-machine' >/dev/null
guest_address=$(lxc exec "$instance" -- ip -4 -o route get 1.1.1.1 | \
    awk '{for (field=1; field<=NF; field++) if ($field == "src") {print $(field+1); exit}}')
python3 - "$guest_address" <<'PY'
import ipaddress
import sys
ipaddress.IPv4Address(sys.argv[1])
PY
for device in lab-lxd-ui lab-grafana; do
    if lxc config device show "$instance" | grep "^$device:" >/dev/null; then
        expected_port=$ui_port
        expected_guest=8443
        if [ "$device" = lab-grafana ]; then expected_port=$grafana_port; expected_guest=3000; fi
        test "$(lxc config device get "$instance" "$device" listen)" = "tcp:$host_address:$expected_port"
        test "$(lxc config device get "$instance" "$device" connect)" = "tcp:$guest_address:$expected_guest"
        test "$(lxc config device get "$instance" "$device" nat)" = true
    fi
done
lxc exec "$instance" -- install -d -m 0755 /usr/local/share/lab-observability
tar -C "$source_dir" -czf - . | lxc exec "$instance" -- tar -xzf - -C /usr/local/share/lab-observability
lxc exec "$instance" -- bash /usr/local/share/lab-observability/prepare-dependencies.sh
lxc exec "$instance" -- env LAB_MONITORING_BIND_ADDRESS="$guest_address" \
    LAB_MONITORING_PUBLIC_HOST="$host_address" LAB_GRAFANA_PORT="$grafana_port" \
    LAB_MONITORING_ALLOW_RESTART="${LAB_MONITORING_ALLOW_RESTART:-0}" \
    bash /usr/local/share/lab-observability/setup.sh "$label"
lxc exec "$instance" -- docker compose --project-directory /opt/easymesh-observability config --quiet
lxc exec "$instance" -- docker compose --project-directory /opt/easymesh-observability pull --policy missing
lxc exec "$instance" -- docker compose --project-directory /opt/easymesh-observability \
    run --rm --no-deps --entrypoint promtool prometheus check config /etc/prometheus/prometheus.yml
lxc exec "$instance" -- docker compose --project-directory /opt/easymesh-observability up -d
lxc exec "$instance" -- python3 - "$guest_address" <<'PY'
import ssl
import sys
import time
import urllib.request
context = ssl.create_default_context(cafile='/opt/easymesh-observability/secrets/grafana.crt')
for address in ('http://127.0.0.1:9090/-/ready', f'https://{sys.argv[1]}:3000/api/health'):
    for attempt in range(60):
        try:
            with urllib.request.urlopen(address, context=context, timeout=3) as response:
                assert response.status == 200
            break
        except (OSError, AssertionError):
            if attempt == 59:
                raise
            time.sleep(1)
PY
if ! lxc config device show "$instance" | grep '^lab-lxd-ui:' >/dev/null; then
    lxc config device add "$instance" lab-lxd-ui proxy nat=true \
        listen="tcp:$host_address:$ui_port" connect="tcp:$guest_address:8443"
fi
if ! lxc config device show "$instance" | grep '^lab-grafana:' >/dev/null; then
    lxc config device add "$instance" lab-grafana proxy nat=true \
        listen="tcp:$host_address:$grafana_port" connect="tcp:$guest_address:3000"
fi
if [ -n "${LAB_OUTER_METRICS_ADDRESS:-}" ]; then
    LAB_OUTER_METRICS_PORT="$outer_metrics_port" \
        bash "$source_dir/enable-outer-metrics.sh" "$instance" "$LAB_OUTER_METRICS_ADDRESS" \
        "${LAB_OUTER_TLS_NAME:?Set LAB_OUTER_TLS_NAME to a DNS SAN in the host LXD certificate}" "$label"
fi
lxc exec "$instance" -- docker compose --project-directory /opt/easymesh-observability kill --signal SIGHUP prometheus
printf '%s\n' "LXD UI: https://$host_address:$ui_port/" "Grafana: https://$host_address:$grafana_port/" \
    "Grafana login: admin; password: lxc exec $instance -- cat /opt/easymesh-observability/secrets/grafana-admin-password" \
    'LXD 6.9 browser enrollment: verify the admins group/permissions first (see the reference guide).' \
    "From a terminal: lxc exec $instance --mode=interactive -- lxc auth identity create local:tls/lab-browser --group admins" \
    'When using SSH, also use ssh -t. Keep the browser token private; it grants administration access.'
