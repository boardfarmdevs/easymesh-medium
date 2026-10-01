#!/usr/bin/env bash
set -euo pipefail
test "$EUID" = 0
test -f /etc/default/easymesh-lab || test -f /etc/default/prplmesh-lab
missing=false
for dependency in lxc docker openssl jq python3 curl; do
    command -v "$dependency" >/dev/null || missing=true
done
if [ "$missing" = false ] && docker compose version >/dev/null 2>&1; then
    exit 0
fi
source /etc/os-release
[[ "$ID" = ubuntu && "$VERSION_ID" = 24.04 ]] || {
    echo 'Install Docker Compose, curl, OpenSSL, jq and Python in this lab VM; automatic installation requires Ubuntu 24.04.' >&2
    exit 1
}
command -v lxc >/dev/null
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    docker.io docker-compose-v2 curl openssl jq python3
