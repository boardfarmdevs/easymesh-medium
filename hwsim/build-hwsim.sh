#!/bin/bash
# Build the medium's mac80211_hwsim.ko for the running kernel: the stock driver
# source from the Ubuntu HWE source package of this kernel generation, with the
# patches in patches/, and the namespace-safe cfg80211 (cfg80211/).
#
#   hwsim/build-hwsim.sh [--6ghz] [--install] [--load] [--source DIR] [--cfg80211 DIR]
#
#   --6ghz        6 GHz: on 6.8 apply the strict custom-regd patch 0002; on 7.0
#                 regtest=5 already selects the 6 GHz-capable custom_03, and a
#                 load uses it (no patch)
#   --install     install to /lib/modules/<kernel>/updates and run depmod
#   --load        install, then reload the pool (HWSIM_RADIOS, HWSIM_CHANNELS,
#                 HWSIM_REGTEST; HWSIM_KERNEL_MEDIUM=1 turns on the opt-in kernel
#                 medium with its HWSIM_KERNEL_MEDIUM_* parameters; HWSIM_PENDING_LIMIT
#                 and HWSIM_PENDING_TIMEOUT_MS the transmit ring of 0012, on 7.0)
#   --source DIR  where the driver source is kept and built (default hwsim/build)
#   --cfg80211 DIR  the cfg80211 build directory (default <source>/cfg80211)
#   INSTALL_MODULE=1 and LOAD_MODULE=1 in the environment mean --install and --load.
#
# Proven kernel generations: 6.8 and 7.0; any other needs its hunks verified,
# then FORCE=1. Patches 0009, 0011 and 0012 need 7.0. Userspace wmediumd stays the
# medium unless the kernel medium is asked for. The source's provenance (the
# source package's .dsc and the sources' digests) is kept next to it.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
KVER=$(uname -r)
GEN=$(printf '%s\n' "$KVER" | sed -E 's/^([0-9]+\.[0-9]+).*/\1/')
SUPPORTED_GENS="6.8 7.0"
WITH_6GHZ=0
DO_INSTALL=${INSTALL_MODULE:-0}
DO_LOAD=${LOAD_MODULE:-0}
SOURCE=$HERE/build
CFG80211=
while [ $# -gt 0 ]; do
    case $1 in
        --6ghz) WITH_6GHZ=1 ;;
        --install) DO_INSTALL=1 ;;
        --load) DO_LOAD=1 ;;
        --source) SOURCE=${2:?--source DIR}; shift ;;
        --cfg80211) CFG80211=${2:?--cfg80211 DIR}; shift ;;
        -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done
[ "$DO_LOAD" = 1 ] && DO_INSTALL=1
CFG80211=${CFG80211:-$SOURCE/cfg80211}
elevate=
[ "$(id -u)" -eq 0 ] || elevate=sudo

case " $SUPPORTED_GENS " in
    *" $GEN "*) ;;
    *) if [ "${FORCE:-0}" != 1 ]; then
           echo "kernel $KVER (generation $GEN) is not a proven generation ($SUPPORTED_GENS);" >&2
           echo "verify the patches' hunks against its source, then FORCE=1" >&2
           exit 1
       fi ;;
esac

KBUILD=/lib/modules/$KVER/build
[ -d "$KBUILD" ] || { echo "missing kernel headers: $KBUILD (apt install linux-headers-$KVER)" >&2; exit 1; }
mkdir -p "$SOURCE"

# 1. The stock driver of this kernel, from the HWE source package.
if [ ! -f "$SOURCE/mac80211_hwsim.c" ] || [ "${REFETCH:-0}" = 1 ]; then
    if ! grep -Rqs '^Types:.*deb-src\|^deb-src ' /etc/apt/sources.list.d /etc/apt/sources.list 2>/dev/null; then
        echo "enable Ubuntu deb-src entries before building hwsim" >&2
        exit 1
    fi
    package=linux-hwe-$GEN
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT
    image_version=$(dpkg-query -W -f='${Version}' "linux-image-$KVER" 2>/dev/null || true)
    (
        cd "$temporary"
        { [ -n "$image_version" ] && apt-get source "$package=$image_version"; } || apt-get source "$package"
    )
    driver=$(find "$temporary" -path '*/drivers/net/wireless/*mac80211_hwsim.c' | head -n 1)
    [ -n "$driver" ] || { echo "mac80211_hwsim.c not found in the $package source" >&2; exit 1; }
    install -m 0644 "$driver" "$SOURCE/mac80211_hwsim.c"
    header=$(dirname "$driver")/mac80211_hwsim.h
    [ ! -f "$header" ] || install -m 0644 "$header" "$SOURCE/mac80211_hwsim.h"
    descriptor=$(find "$temporary" -maxdepth 1 -name "${package}_*.dsc" -print -quit)
    [ -z "$descriptor" ] || install -m 0644 "$descriptor" "$SOURCE/source-package.dsc"
    (cd "$SOURCE" && sha256sum mac80211_hwsim.c $( [ -f mac80211_hwsim.h ] && echo mac80211_hwsim.h ) > source.sha256)
fi

# 2. The patches, rooted at a/drivers/net/wireless/virtual/: -p5 addresses the
# flat copy. A patch that does not apply is an error (the stock module would
# otherwise build as if patched).
apply() {
    local patch_file=$HERE/patches/$1
    if patch -d "$SOURCE" -p5 --dry-run -N < "$patch_file" >/dev/null 2>&1; then
        patch -d "$SOURCE" -p5 -N < "$patch_file"
    elif patch -d "$SOURCE" -p5 --dry-run -R < "$patch_file" >/dev/null 2>&1; then
        echo "already applied: $1"
    else
        echo "does not apply to the $KVER source: $patch_file" >&2
        exit 1
    fi
}
apply 0001-mac80211_hwsim-allow-multichannel-wmediumd.patch
if [ "$WITH_6GHZ" = 1 ] && [ "$GEN" = 6.8 ]; then
    apply 0002-mac80211_hwsim-6ghz-strict-regd.patch
fi
apply 0003-mac80211_hwsim-optional-kernel-medium.patch
apply 0004-mac80211_hwsim-kernel-medium-link-matrix.patch
apply 0005-mac80211_hwsim-kernel-medium-rate-per.patch
apply 0006-mac80211_hwsim-kernel-medium-timing-observability.patch
apply 0007-mac80211_hwsim-allow-128-static-radios.patch
apply 0008-mac80211_hwsim-fix-multichannel-monitor-ack.patch
if [ "$GEN" = 7.0 ]; then
    apply 0009-mac80211_hwsim-context-survey-cache.patch
else
    echo "the modeled survey cache (0009) needs Linux 7.0: signal-only surveys"
fi
apply 0010-mac80211_hwsim-complete-aggregation-feedback.patch
if [ "$GEN" = 7.0 ]; then
    apply 0011-mac80211_hwsim-report-native-receive-contexts.patch
    apply 0012-mac80211_hwsim-pending-frames-as-a-transmit-ring.patch
fi
grep -q 'EXPERIMENTAL wmediumd' "$SOURCE/mac80211_hwsim.c" \
    || { echo "patch 0001 did not apply: check the source version" >&2; exit 1; }

# 3. The module, then cfg80211.
printf 'obj-m += mac80211_hwsim.o\n' > "$SOURCE/Makefile"
make -C "$KBUILD" M="$SOURCE" modules
echo "built $SOURCE/mac80211_hwsim.ko for $KVER"
cfg80211_options=()
[ "$DO_INSTALL" = 1 ] && cfg80211_options+=(--install)
bash "$HERE/cfg80211/build-cfg80211.sh" "$CFG80211" "${cfg80211_options[@]}"

if [ "$DO_INSTALL" = 1 ]; then
    $elevate install -D -m 0644 "$SOURCE/mac80211_hwsim.ko" "/lib/modules/$KVER/updates/mac80211_hwsim.ko"
    $elevate depmod -a "$KVER"
    echo "installed to /lib/modules/$KVER/updates"
fi

if [ "$DO_LOAD" = 1 ]; then
    $elevate modprobe cfg80211
    if [ "$(cat /sys/module/cfg80211/version 2>/dev/null)" != lab-netns-owner-1 ]; then
        echo "reboot to load the namespace-safe cfg80211 before loading hwsim" >&2
        exit 1
    fi
    # 32 radios cover a small lab (five mesh nodes, twenty clients, spares);
    # a lab passes its own (the prplMesh lab: 120). Tri-band 6 GHz wants a
    # third channel context.
    options=("radios=${HWSIM_RADIOS:-32}")
    if [ -n "${HWSIM_CHANNELS:-}" ]; then options+=("channels=$HWSIM_CHANNELS")
    elif [ "$WITH_6GHZ" = 1 ]; then options+=(channels=3)
    else options+=(channels=2); fi
    if [ -n "${HWSIM_REGTEST:-}" ]; then options+=("regtest=$HWSIM_REGTEST")
    elif [ "$WITH_6GHZ" = 1 ] && [ "$GEN" != 6.8 ]; then options+=(regtest=5); fi
    if [ "${HWSIM_KERNEL_MEDIUM:-0}" = 1 ]; then
        options+=(
            kernel_medium=1
            "kernel_medium_cutoff=${HWSIM_KERNEL_MEDIUM_CUTOFF:--95}"
            "kernel_medium_loss_pct=${HWSIM_KERNEL_MEDIUM_LOSS_PCT:-0}"
            "kernel_medium_rate_per=${HWSIM_KERNEL_MEDIUM_RATE_PER:-0}"
            "kernel_medium_noise_floor=${HWSIM_KERNEL_MEDIUM_NOISE_FLOOR:--91}"
            "kernel_medium_delay_us=${HWSIM_KERNEL_MEDIUM_DELAY_US:-0}"
            "kernel_medium_jitter_us=${HWSIM_KERNEL_MEDIUM_JITTER_US:-0}"
            "kernel_medium_delay_queue_limit=${HWSIM_KERNEL_MEDIUM_QUEUE_LIMIT:-4096}"
        )
    fi
    # 0012 (7.0): the frames at wmediumd as a transmit ring, its queues stopped when full
    if [ -n "${HWSIM_PENDING_LIMIT:-}" ] && [ "$GEN" = 7.0 ]; then
        options+=("pending_limit=$HWSIM_PENDING_LIMIT"
                  "pending_timeout_ms=${HWSIM_PENDING_TIMEOUT_MS:-5000}")
    fi
    echo "reloading the pool: ${options[*]}"
    $elevate modprobe -r mac80211_hwsim 2>/dev/null || true
    $elevate modprobe mac80211_hwsim "${options[@]}"
fi
