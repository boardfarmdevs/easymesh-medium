#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

"$here/install.sh" --binary "$here/wmediumd-console"
if [ "$(id -u)" -eq 0 ]; then
    elevate=
else
    elevate=sudo
fi
$elevate install -m 0644 \
    "$here/packaging/prplmesh-wmediumd-console.default" \
    /etc/default/wmediumd-console
$elevate systemctl daemon-reload
$elevate systemctl enable wmediumd-console.service

echo 'Installed read-only wmediumd Console NG for prplMesh on port 8090.'
