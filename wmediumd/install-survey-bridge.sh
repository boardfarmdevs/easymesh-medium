#!/bin/bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SOCKET=${1:?read-only wmediumd socket required}
LAB_SERVICE=${2:?lab service name required}
[ "$(id -u)" -eq 0 ] || { echo "run inside the lab VM as root" >&2; exit 1; }
[[ "$SOCKET" = /* && "$SOCKET" != *[[:space:]]* && "$LAB_SERVICE" =~ ^[a-z0-9-]+\.service$ ]] || exit 2

cat >/etc/systemd/system/wmdcfg-survey-bridge.service <<EOF
[Unit]
Description=Modeled wmediumd airtime to native hwsim survey bridge
After=$LAB_SERVICE
PartOf=$LAB_SERVICE

[Service]
Type=simple
Environment=PYTHONPATH=$HERE/configurator
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 -m wmdcfg.survey_bridge --socket $SOCKET --enable --status-file /run/wmdcfg-survey.json
Restart=on-failure
RestartSec=1
NoNewPrivileges=true
PrivateTmp=true
RestrictAddressFamilies=AF_UNIX

[Install]
WantedBy=$LAB_SERVICE
EOF
systemctl daemon-reload
systemctl enable wmdcfg-survey-bridge.service
