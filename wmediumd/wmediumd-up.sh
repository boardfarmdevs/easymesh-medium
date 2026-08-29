#!/bin/bash
# wmediumd-up.sh -- start (or stop) the multichannel wmediumd over the current
# mac80211_hwsim pool, giving the lab a real RF medium instead of the default
# flat-signal everyone-hears-everyone.
#
#   ./wmediumd-up.sh up      # gen config, self-test, start wmediumd (daemon)
#   ./wmediumd-up.sh down     # stop it (kernel reverts to its built-in medium)
#   ./wmediumd-up.sh status
#
# Requires: the pool loaded with a guard-removed module (gen/hwsim/build-hwsim.sh)
# if channels>1 -- stock mac80211_hwsim returns -EOPNOTSUPP to REGISTER at
# channels>1. WMEDIUMD env overrides the binary (default: committed prebuilt).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WMD=${WMEDIUMD:-$HERE/wmediumd.patched}
[ -x "$WMD" ] || WMD=$HERE/src/wmediumd/wmediumd
CONTROL=${WMEDIUMD_CONTROL:-/run/wmediumd-control.sock}
CONTROL_GROUP=${WMEDIUMD_CONTROL_GROUP:-lxd}
RUNTIME=${WMEDIUMD_RUNTIME_DIR:-/run/meta-cmf-wmediumd}
METRICS_DIR=${WMEDIUMD_METRICS_DIR:-$RUNTIME/metrics}
METRICS=${WMEDIUMD_METRICS_SOCKET:-$METRICS_DIR/control.sock}
OBSERVER_DIR=${WMEDIUMD_OBSERVER_DIR:-$RUNTIME/observer}
OBSERVER=${WMEDIUMD_OBSERVER_SOCKET:-$OBSERVER_DIR/telemetry.sock}
IDENTITY=${WMEDIUMD_IDENTITY_INVENTORY:-$RUNTIME/identity-inventory.json}
DAEMON_MANIFEST=${WMEDIUMD_DAEMON_MANIFEST:-$RUNTIME/wmediumd-binary.sha256}
IDENTITY_GENERATOR=${WMEDIUMD_IDENTITY_GENERATOR:-$HERE/observer/generate-identity-inventory.sh}
CFG=${CFG:-$RUNTIME/wmediumd.cfg}
PIDF=${WMEDIUMD_PIDFILE:-$RUNTIME/wmediumd.pid}
LOG=${WMEDIUMD_LOG:-$RUNTIME/wmediumd.log}
CPU_AFFINITY=${WMEDIUMD_CPU_AFFINITY:-}

if [ -n "$CPU_AFFINITY" ]; then
    [[ "$CPU_AFFINITY" =~ ^[0-9]+([,-][0-9]+)*$ ]] || {
        echo "invalid WMEDIUMD_CPU_AFFINITY: $CPU_AFFINITY" >&2
        exit 2
    }
    command -v taskset >/dev/null 2>&1 || {
        echo "WMEDIUMD_CPU_AFFINITY requires taskset" >&2
        exit 2
    }
fi

# Keep shared daemon state out of sticky /tmp. Ubuntu's protected-regular-file
# policy otherwise makes a root provision fail after a non-root lab run (and
# vice versa) even though both callers are authorized to manage the daemon.
sudo install -d -m 0775 -o root -g "$CONTROL_GROUP" "$RUNTIME"
# This directory is mounted read-only into each BPI container.  The socket
# itself is world-connectable, but its protocol rejects every mutation opcode.
sudo install -d -m 0755 -o root -g root "$METRICS_DIR"
# The Console telemetry socket is host-only. Membership of CONTROL_GROUP is
# required even though every opcode on this endpoint is immutable.
sudo install -d -m 0770 -o root -g "$CONTROL_GROUP" "$OBSERVER_DIR"

# `up` is also the normal way to refresh the matrix after adding clients.  It
# must replace the existing daemon, not overwrite the pidfile and leave the old
# process registered with mac80211_hwsim.  Match the full executable path so an
# unrelated system wmediumd is not affected. Also include the owner of our
# configured control socket: it may have been started from another checkout of
# this same lab. Wait for REGISTER ownership to be released, and use SIGKILL
# only as a bounded fallback.
find_running_wmediumd() {
    local pattern="$1" pids
    pids=$(sudo pgrep -f "$pattern" 2>/dev/null || true)
    # Releases before the control API was added were started as
    #   /home/<user>/.../gen/wmediumd/wmediumd.patched -c <config>
    # and therefore cannot be found through CONTROL.  Include only that
    # lab-specific executable shape so an unrelated packaged wmediumd remains
    # outside our lifecycle management.
    pids="$pids $(sudo pgrep -f '^/home/[^[:space:]]+/.*/gen/wmediumd/wmediumd\.patched[[:space:]]+-c[[:space:]]+' 2>/dev/null || true)"
    if [ -S "$CONTROL" ] && command -v fuser >/dev/null 2>&1; then
        pids="$pids $(sudo fuser "$CONTROL" 2>/dev/null || true)"
    fi
    if [ -S "$METRICS" ] && command -v fuser >/dev/null 2>&1; then
        pids="$pids $(sudo fuser "$METRICS" 2>/dev/null || true)"
    fi
    if [ -S "$OBSERVER" ] && command -v fuser >/dev/null 2>&1; then
        pids="$pids $(sudo fuser "$OBSERVER" 2>/dev/null || true)"
    fi
    # Normalize whitespace and suppress duplicates when both checks find the
    # same daemon.
    printf '%s\n' $pids | sed '/^[[:space:]]*$/d' | sort -un
}

stop_running_wmediumd() {
    local pattern pids n
    pattern="^${WMD//./\\.}([[:space:]]|$)"
    pids=$(find_running_wmediumd "$pattern")
    [ -n "$pids" ] || { sudo rm -f "$PIDF" "$CONTROL" "$METRICS" "$OBSERVER" "$IDENTITY" "$DAEMON_MANIFEST"; return; }
    sudo kill $pids 2>/dev/null || true
    for n in $(seq 1 20); do
        pids=$(find_running_wmediumd "$pattern")
        [ -z "$pids" ] && break
        sleep 0.1
    done
    if [ -n "$pids" ]; then
        sudo kill -KILL $pids 2>/dev/null || true
    fi
    sudo rm -f "$PIDF" "$CONTROL" "$METRICS" "$OBSERVER" "$IDENTITY" "$DAEMON_MANIFEST"
}

case "${1:-up}" in
  up)
    [ -x "$WMD" ] || { echo "no wmediumd binary ($WMD); run build-wmediumd.sh" >&2; exit 1; }
    # Validate the complete managed radio inventory before replacing a healthy
    # daemon. Starting from only the BPI radios appears successful but cannot
    # deliver frames for client radios that become active afterward.
    echo ">> preflight radio inventory"
    "$HERE/gen-config.sh" "${SNR:-40}" >/dev/null
    stop_running_wmediumd
    # Pool vifs are created administratively UP even while unused.  They are not
    # part of the active matrix and must not originate frames after REGISTER.
    # bpi.sh/wlan-client.sh bring a vif back up after assigning its phy.
    for netdev in /sys/class/net/virt-wlan*; do
        [ -e "$netdev" ] || continue
        sudo ip link set "${netdev##*/}" down
    done
    echo ">> generating config -> $CFG"
    "$HERE/gen-config.sh" "${SNR:-40}" | sudo tee "$CFG" >/dev/null
    echo ">> self-test"
    sudo "$WMD" -T || {
        echo "wmediumd self-test failed; the binary may be an unpatched/stale v0.3.1 build" >&2
        exit 1
    }
    echo ">> starting wmediumd"
    sudo rm -f "$PIDF" "$CONTROL" "$METRICS" "$OBSERVER" "$LOG" "$IDENTITY" "$DAEMON_MANIFEST"
    echo ">> generating Console radio identities -> $IDENTITY"
    if ! "$IDENTITY_GENERATOR" --output "$IDENTITY"; then
        echo "WARN: Console identity inventory unavailable; telemetry will use radio MAC labels" >&2
        sudo rm -f "$IDENTITY"
    fi
    if [ -n "$CPU_AFFINITY" ]; then
        sudo sh -c "taskset -c '$CPU_AFFINITY' '$WMD' -c '$CFG' -C '$CONTROL' -R '$METRICS' -O '$OBSERVER' >'$LOG' 2>&1 & echo \$! > '$PIDF'"
    else
        sudo sh -c "'$WMD' -c '$CFG' -C '$CONTROL' -R '$METRICS' -O '$OBSERVER' >'$LOG' 2>&1 & echo \$! > '$PIDF'"
    fi
    sleep 1
    pid=$(cat "$PIDF" 2>/dev/null || true)
    if [ -z "$pid" ] || ! sudo kill -0 "$pid" 2>/dev/null; then
        echo "!! wmediumd exited during startup" >&2
        tail -20 "$LOG" 2>/dev/null >&2 || true
        exit 1
    fi
    if grep -Eqi "Operation not supported|Device or resource busy|REGISTER.*failed|Unable to find sender" "$LOG" 2>/dev/null; then
        echo "!! wmediumd registered incompletely or rejected a radio" >&2
        tail -20 "$LOG" 2>/dev/null >&2 || true
        sudo kill "$pid" 2>/dev/null || true
        sudo rm -f "$PIDF" "$IDENTITY"
        exit 1
    fi
    if [ ! -S "$CONTROL" ]; then
        echo "!! wmediumd control socket did not appear: $CONTROL" >&2
        sudo kill "$pid" 2>/dev/null || true
        sudo rm -f "$PIDF" "$CONTROL" "$IDENTITY"
        exit 1
    fi
    if [ ! -S "$METRICS" ]; then
        echo "!! wmediumd read-only metrics socket did not appear: $METRICS" >&2
        sudo kill "$pid" 2>/dev/null || true
        sudo rm -f "$PIDF" "$CONTROL" "$METRICS" "$OBSERVER" "$IDENTITY"
        exit 1
    fi
    if [ ! -S "$OBSERVER" ]; then
        echo "!! wmediumd observer socket did not appear: $OBSERVER" >&2
        sudo kill "$pid" 2>/dev/null || true
        sudo rm -f "$PIDF" "$CONTROL" "$METRICS" "$OBSERVER" "$IDENTITY"
        exit 1
    fi
    sudo chgrp "$CONTROL_GROUP" "$CONTROL"
    sudo chmod 0660 "$CONTROL"
    sudo chmod 0666 "$METRICS"
    sudo chgrp "$CONTROL_GROUP" "$OBSERVER"
    sudo chmod 0660 "$OBSERVER"
    binary_sha256=$(sha256sum "$WMD" | awk '{print $1}')
    printf '%s\t%s\t%s\n' "$pid" "$binary_sha256" "$WMD" \
        | sudo tee "$DAEMON_MANIFEST" >/dev/null
    sudo chown root:root "$DAEMON_MANIFEST"
    sudo chmod 0644 "$DAEMON_MANIFEST"
    affinity=$(taskset -pc "$pid" 2>/dev/null | sed 's/.*: //' || true)
    threads=$(ps -o nlwp= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    echo ">> up (pid $pid); threads ${threads:-unknown}; affinity ${affinity:-unknown}; log $LOG; read-only metrics $METRICS; telemetry $OBSERVER; identities $IDENTITY; binary manifest $DAEMON_MANIFEST"
    ;;
  down)
    stop_running_wmediumd
    echo ">> down (kernel back to built-in medium)"
    ;;
  status)
    if [ -f "$PIDF" ] && sudo kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      if [ -S "$CONTROL" ] && [ -S "$METRICS" ] && [ -S "$OBSERVER" ]; then
            pid=$(cat "$PIDF")
            affinity=$(taskset -pc "$pid" 2>/dev/null | sed 's/.*: //' || true)
            threads=$(ps -o nlwp= -p "$pid" 2>/dev/null | tr -d ' ' || true)
            echo "wmediumd running (pid $pid); threads ${threads:-unknown}; affinity ${affinity:-unknown}; control, metrics and telemetry sockets ready"
        else
            echo "wmediumd running (pid $(cat "$PIDF")); socket missing"
            exit 1
        fi
        tail -3 "$LOG" 2>/dev/null
    else echo "wmediumd not running"; fi
    ;;
  *) echo "usage: $0 {up|down|status}" >&2; exit 2 ;;
esac
