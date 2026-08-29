#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
binary="$here/wmediumd-console"
start=0

usage() {
    echo "usage: $0 [--binary PATH] [--start]" >&2
    exit 2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --binary)
            [ "$#" -ge 2 ] || usage
            binary=$2
            shift 2
            ;;
        --start)
            start=1
            shift
            ;;
        *) usage ;;
    esac
done

[ -x "$binary" ] || {
    echo "prebuilt Console binary is not executable: $binary" >&2
    echo "supply the static release binary with --binary PATH; this installer does not require or invoke Go" >&2
    exit 1
}
getent group lxd >/dev/null || {
    echo "required lxd group is absent; install/configure LXD before the Console service" >&2
    exit 1
}

if [ "$(id -u)" -eq 0 ]; then
    elevate=
else
    command -v sudo >/dev/null 2>&1 || { echo "sudo is required when not running as root" >&2; exit 1; }
    elevate=sudo
fi

if ! getent group wmediumd-console >/dev/null; then
    $elevate groupadd --system wmediumd-console
fi
if ! getent passwd wmediumd-console >/dev/null; then
    $elevate useradd --system --gid wmediumd-console --home-dir /nonexistent --shell /usr/sbin/nologin wmediumd-console
fi

$elevate install -D -m 0755 "$binary" /usr/local/bin/wmediumd-console
$elevate install -D -m 0644 "$here/README.md" /usr/local/share/doc/wmediumd-console/README.md
$elevate install -D -m 0644 "$here/identity-inventory.example.json" /usr/local/share/doc/wmediumd-console/identity-inventory.example.json
$elevate install -D -m 0644 "$here/packaging/wmediumd-console.service" /etc/systemd/system/wmediumd-console.service
if [ ! -e /etc/default/wmediumd-console ]; then
    $elevate install -D -m 0644 "$here/packaging/wmediumd-console.default" /etc/default/wmediumd-console
fi
$elevate systemctl daemon-reload

if [ "$start" -eq 1 ]; then
    $elevate systemctl enable --now wmediumd-console.service
    $elevate systemctl --no-pager --full status wmediumd-console.service
else
    echo "installed; run: sudo systemctl enable --now wmediumd-console.service"
fi
