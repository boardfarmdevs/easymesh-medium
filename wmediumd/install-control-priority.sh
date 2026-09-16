#!/bin/bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
STACK=${1:?usage: install-control-priority.sh prplmesh|rdk}
[ "$#" -eq 1 ] || exit 2
case "$STACK" in
    prplmesh|rdk) ;;
    *) echo "stack must be prplmesh or rdk" >&2; exit 2 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo "run inside the lab VM as root" >&2; exit 1; }
[[ "$HERE" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo "unsupported source path" >&2; exit 2; }
for tool in python3 nsenter; do
    command -v "$tool" >/dev/null
done

cat >/etc/systemd/system/wmdcfg-control-priority.service <<EOF
[Unit]
Description=Opt-in EasyMesh control-priority lifecycle reconciliation
After=snap.lxd.daemon.service lxd.service
ConditionPathExists=/var/lib/wmdcfg-control-priority/$STACK.json
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/usr/bin/python3 $HERE/configurator/wmdcfg/control_priority.py --stack $STACK --watch
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable wmdcfg-control-priority.service
echo "Installed lifecycle persistence for $STACK; starts on next boot or opted-in lab startup."
