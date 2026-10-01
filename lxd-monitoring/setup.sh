#!/usr/bin/env bash
set -euo pipefail
umask 077
source_dir=$(cd "$(dirname "$0")" && pwd)
destination=/opt/easymesh-observability
label=${1:?usage: sudo bash setup.sh LAB_LABEL}
bind_address=${LAB_MONITORING_BIND_ADDRESS:-127.0.0.1}
public_host=${LAB_MONITORING_PUBLIC_HOST:-127.0.0.1}
grafana_port=${LAB_GRAFANA_PORT:-18893}
[[ "$label" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$ ]] || { echo 'Invalid lab label' >&2; exit 2; }
test "$EUID" = 0 || { echo 'Run as root inside the appliance VM' >&2; exit 1; }
for dependency in lxc docker openssl jq python3; do command -v "$dependency" >/dev/null; done
test -f /etc/default/easymesh-lab || test -f /etc/default/prplmesh-lab || { echo 'RDK/prpl appliance configuration is missing' >&2; exit 1; }
python3 - "$bind_address" "$public_host" "$grafana_port" <<'PY'
import ipaddress
import sys
for address in sys.argv[1:3]:
    ipaddress.IPv4Address(address)
assert 1024 <= int(sys.argv[3]) <= 65535
PY
docker compose version >/dev/null
lxc --force-local query /1.0 >/dev/null
server_certificate=/var/snap/lxd/common/lxd/server.crt
test -f "$server_certificate"
openssl x509 -in "$server_certificate" -noout -checkip 127.0.0.1 | grep -q 'does match certificate' || {
    echo 'LXD server certificate lacks the loopback IP SAN; see the reference guide' >&2
    exit 1
}
for setting in core.https_address core.metrics_address core.metrics_authentication; do
    current=$(lxc --force-local config get "$setting")
    case "$setting:$current" in
        core.https_address:|core.https_address:127.0.0.1:8443|core.https_address:"$bind_address":8443|core.metrics_address:|core.metrics_address:127.0.0.1:8444|core.metrics_authentication:|core.metrics_authentication:true) ;;
        *) echo "Refusing to replace existing $setting=$current; review the reference guide" >&2; exit 1 ;;
    esac
done
if [ -e "$destination" ]; then
    test -f "$destination/.managed-by-easymesh" || { echo "Refusing unmanaged $destination" >&2; exit 1; }
else
    install -d -m 0755 "$destination"
    touch "$destination/.managed-by-easymesh"
fi
install -d -m 0700 "$destination/state" "$destination/secrets"
if [ -f /etc/default/easymesh-lab ]; then
    python3 "$source_dir/prepare-rdk.py" "$destination/state"
fi
if [ "$bind_address" != 127.0.0.1 ] && [ ! -e "$destination/state/server-identity-reviewed" ]; then
    if [ -z "$(lxc --force-local config get core.https_address)" ] && [ -z "$(lxc --force-local config get core.metrics_address)" ]; then
        bash "$source_dir/reload-lxd.sh" --check
        install -d -m 0700 "$destination/state/original-server"
        if [ ! -e "$destination/state/original-server/server.key" ]; then
            cp -p /var/snap/lxd/common/lxd/server.{crt,key} "$destination/state/original-server/"
        fi
        openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -sha384 \
            -nodes -days 365 -subj "/CN=$label" \
            -addext "subjectAltName=IP:127.0.0.1,IP:$bind_address,IP:$public_host" \
            -keyout "$destination/state/server.key" -out "$destination/state/server.crt"
        install -m 0600 "$destination/state/server.key" /var/snap/lxd/common/lxd/server.key
        install -m 0644 "$destination/state/server.crt" /var/snap/lxd/common/lxd/server.crt
        bash "$source_dir/reload-lxd.sh"
    fi
    touch "$destination/state/server-identity-reviewed"
fi
if [ ! -e "$destination/state/previous-lxd.json" ]; then
    jq -n --arg https "$(lxc --force-local config get core.https_address)" \
        --arg metrics "$(lxc --force-local config get core.metrics_address)" \
        --arg auth "$(lxc --force-local config get core.metrics_authentication)" \
        '{"core.https_address":$https,"core.metrics_address":$metrics,"core.metrics_authentication":$auth}' \
        > "$destination/state/previous-lxd.json"
fi
install -m 0644 "$source_dir/compose.yaml" "$destination/compose.yaml"
install -m 0755 "$source_dir/disable.sh" "$destination/disable.sh"
install -d -m 0755 "$destination/grafana/provisioning/datasources" \
    "$destination/grafana/provisioning/dashboards" "$destination/grafana/dashboards"
install -m 0644 "$source_dir/grafana/provisioning/datasources/prometheus.yml" "$destination/grafana/provisioning/datasources/"
install -m 0644 "$source_dir/grafana/provisioning/dashboards/lxd.yml" "$destination/grafana/provisioning/dashboards/"
install -m 0644 "$source_dir/grafana/dashboards/lxd-containers.json" "$destination/grafana/dashboards/"
python3 "$source_dir/outer-metrics.py" render "$source_dir/prometheus.yml" "$destination/prometheus.yml" \
    --label "$label" --settings "$destination/state/outer-metrics.json"
if [ -f "$destination/state/outer-metrics.json" ]; then
    install -m 0644 "$source_dir/grafana/dashboards/lxd-outer-vms.json" "$destination/grafana/dashboards/"
fi
chmod 0644 "$destination/prometheus.yml"
if [ ! -e "$destination/.env" ]; then
    install -m 0600 "$source_dir/.env.example" "$destination/.env"
fi
python3 - "$destination/.env" "$bind_address" "$public_host" "$grafana_port" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
values = {'GRAFANA_BIND_ADDRESS': sys.argv[2], 'GRAFANA_PUBLIC_URL': f'https://{sys.argv[3]}:{sys.argv[4]}/'}
lines = [line for line in path.read_text().splitlines() if line.split('=', 1)[0] not in values]
path.write_text('\n'.join(lines + [f'{key}={value}' for key, value in values.items()]) + '\n')
PY
install -d -m 0750 -o root -g 65534 "$destination/tls"
if [ ! -e "$destination/tls/metrics.crt" ] && [ ! -e "$destination/tls/metrics.key" ]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -sha384 \
        -nodes -days 365 -subj "/CN=easymesh-prometheus-$label" \
        -keyout "$destination/tls/metrics.key" -out "$destination/tls/metrics.crt"
fi
openssl x509 -in "$destination/tls/metrics.crt" -checkend 86400 -noout
certificate_key=$(openssl x509 -in "$destination/tls/metrics.crt" -pubkey -noout)
private_key=$(openssl pkey -in "$destination/tls/metrics.key" -pubout)
test "$certificate_key" = "$private_key" || { echo 'Metrics key/certificate mismatch' >&2; exit 1; }
install -m 0640 -o root -g 65534 "$server_certificate" "$destination/tls/server.crt"
chown root:65534 "$destination/tls/metrics.crt" "$destination/tls/metrics.key"
chmod 0640 "$destination/tls/metrics.crt" "$destination/tls/metrics.key"
fingerprint=$(openssl x509 -in "$destination/tls/metrics.crt" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d : | tr A-F a-f)
trusted=$(lxc --force-local config trust list --format json)
if jq -e --arg fingerprint "$fingerprint" 'any(.[]; .fingerprint == $fingerprint)' <<< "$trusted" >/dev/null; then
    jq -e --arg fingerprint "$fingerprint" 'any(.[]; .fingerprint == $fingerprint and .type == "metrics")' <<< "$trusted" >/dev/null
else
    lxc --force-local config trust add "$destination/tls/metrics.crt" --type=metrics --name="easymesh-prometheus-$label"
fi
printf '%s\n' "$fingerprint" > "$destination/state/metrics-fingerprint"
if [ ! -e "$destination/secrets/grafana-admin-password" ]; then
    openssl rand -hex 24 > "$destination/secrets/grafana-admin-password"
fi
chown root:472 "$destination/secrets/grafana-admin-password"
chmod 0640 "$destination/secrets/grafana-admin-password"
if [ ! -e "$destination/secrets/grafana.crt" ] && [ ! -e "$destination/secrets/grafana.key" ]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -sha384 \
        -nodes -days 365 -subj "/CN=$label-grafana" \
        -addext "subjectAltName=IP:127.0.0.1,IP:$bind_address,IP:$public_host" \
        -keyout "$destination/secrets/grafana.key" -out "$destination/secrets/grafana.crt"
fi
openssl x509 -in "$destination/secrets/grafana.crt" -checkend 86400 -noout
openssl x509 -in "$destination/secrets/grafana.crt" -noout -checkip "$public_host" | grep -q 'does match certificate'
test "$(openssl x509 -in "$destination/secrets/grafana.crt" -pubkey -noout)" = "$(openssl pkey -in "$destination/secrets/grafana.key" -pubout)"
chown root:472 "$destination/secrets/grafana.crt" "$destination/secrets/grafana.key"
chmod 0640 "$destination/secrets/grafana.crt" "$destination/secrets/grafana.key"
lxc --force-local config set core.metrics_authentication true
lxc --force-local config set core.metrics_address 127.0.0.1:8444
lxc --force-local config set core.https_address "$bind_address:8443"
if [ "$(snap get lxd ui.enable 2>/dev/null || true)" = false ]; then
    bash "$source_dir/reload-lxd.sh" --check
    snap set lxd ui.enable=true
    bash "$source_dir/reload-lxd.sh"
fi
jq -n --arg https "$bind_address:8443" \
    '{"core.https_address":$https,"core.metrics_address":"127.0.0.1:8444","core.metrics_authentication":"true"}' \
    > "$destination/state/managed-lxd.json"
docker compose --project-directory "$destination" config --quiet
printf '%s\n' "Installed $destination for $label; no monitoring container started." \
    "Next: cd $destination && sudo docker compose pull && sudo docker compose up -d" \
    "LXD UI/API: https://$bind_address:8443/ ; Grafana: https://$public_host:$grafana_port/" \
    'LXD requires browser-certificate enrollment. Grafana initial password: secrets/grafana-admin-password.'
