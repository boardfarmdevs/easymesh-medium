#!/bin/bash
# build-hwsim.sh -- build a mac80211_hwsim.ko that lets wmediumd register at
# channels > 1 (patch 0001), optionally with 6 GHz support and an opt-in
# impaired in-kernel medium (patches 0003-0007), and keeps multichannel
# userspace monitor ACKs channel-context safe (patch 0008). Userspace wmediumd
# remains default; the rate-aware PER model is separately opt-in.
#
#   ./build-hwsim.sh            # build patched module -> ./build/mac80211_hwsim.ko
#   ./build-hwsim.sh --6ghz     # also enable 6 GHz (kernel-generation dependent)
#   ./build-hwsim.sh --install  # build, then install to updates/ and depmod
#   ./build-hwsim.sh --load     # build+install, then reload the patched pool
#                               #   (HWSIM_RADIOS / HWSIM_CHANNELS env, default 32/2)
#
# Kernel-generation aware: 6.8 and 7.0 are both proven and build without FORCE.
# The 6 GHz story differs by generation (see review TODO #5):
#   * 6.8  -- the applied regdom marks 6 GHz NO-IR, so --6ghz applies the strict
#             custom-regd patch 0002 (custom_01 -> custom_03 + STRICT_REG).
#   * 7.0  -- regtest=5 already selects custom_03 (6 GHz IR-capable), so NO regd
#             patch is needed; --6ghz just builds 0001 and loads the pool with
#             regtest=5 + channels=3. Proven in
#             doc/easymesh/Linux-7.0-hwsim-6GHz-VLP-AP-results.md.
# Any other kernel: re-verify the hunks against its source, then FORCE=1.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
KVER=$(uname -r)
# kernel major.minor generation, e.g. 6.8 or 7.0
GEN=$(printf '%s\n' "$KVER" | sed -E 's/^([0-9]+\.[0-9]+).*/\1/')
SUPPORTED_GENS="6.8 7.0"
WITH_6GHZ=0; DO_INSTALL=0; DO_LOAD=0
for a in "$@"; do case "$a" in
    --6ghz)   WITH_6GHZ=1 ;;
    --install) DO_INSTALL=1 ;;
    --load)   DO_INSTALL=1; DO_LOAD=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
esac; done

case " $SUPPORTED_GENS " in
    *" $GEN "*) : ;;
    *) if [ "${FORCE:-0}" != 1 ]; then
           echo "running kernel $KVER (gen $GEN) is not a proven generation ($SUPPORTED_GENS)." >&2
           echo "The patches target those hwsim sources; re-verify the hunks, then FORCE=1." >&2
           exit 1
       fi ;;
esac

KBUILD=/lib/modules/$KVER/build
[ -d "$KBUILD" ] || { echo "missing kernel headers: $KBUILD (apt install linux-headers-$KVER)" >&2; exit 1; }

SRCDIR=$HERE/build
mkdir -p "$SRCDIR"

# 1. obtain the stock mac80211_hwsim source for this kernel generation.
HWE_PKG=linux-hwe-$GEN
if [ ! -f "$SRCDIR/mac80211_hwsim.c" ] || [ "${REFETCH:-0}" = 1 ]; then
    echo ">> fetching mac80211_hwsim source for $KVER (apt source $HWE_PKG)"
    TMP=$(mktemp -d)
    ( cd "$TMP"
      # Ubuntu HWE: the module source ships in the linux-hwe-<gen> source package.
      apt-get source "$HWE_PKG=$(dpkg-query -W -f='${Version}' linux-image-$KVER 2>/dev/null)" 2>/dev/null \
        || apt-get source "$HWE_PKG" )
    SRC=$(find "$TMP" -path '*wireless*mac80211_hwsim.c' | head -1)
    [ -n "$SRC" ] || { echo "could not locate mac80211_hwsim.c in apt source; see gen/hwsim/README.md for the manual path" >&2; exit 1; }
    cp "$SRC" "$SRCDIR/mac80211_hwsim.c"
    cp "$(dirname "$SRC")/mac80211_hwsim.h" "$SRCDIR/mac80211_hwsim.h" 2>/dev/null || true
    rm -rf "$TMP"
fi

# 2. Apply patches to the flattened source copied above.  The patch paths are
# rooted at a/drivers/net/wireless/virtual/, so strip all five leading
# components to address $SRCDIR/mac80211_hwsim.c directly.  Treat a genuinely
# incompatible patch as an error; silently ignoring it produces an apparently
# successful build of the stock module.
apply() {
    local patch_file=$1
    if patch -d "$SRCDIR" -p5 --dry-run -N < "$patch_file" >/dev/null 2>&1; then
        patch -d "$SRCDIR" -p5 -N < "$patch_file"
    elif patch -d "$SRCDIR" -p5 --dry-run -R < "$patch_file" >/dev/null 2>&1; then
        echo ">> already applied: $(basename "$patch_file")"
    else
        echo "patch does not apply: $patch_file" >&2
        return 1
    fi
}
apply "$HERE/patches/0001-mac80211_hwsim-allow-multichannel-wmediumd.patch"
if [ "$WITH_6GHZ" = 1 ]; then
    if [ "$GEN" = 6.8 ]; then
        apply "$HERE/patches/0002-mac80211_hwsim-6ghz-strict-regd.patch"
    else
        echo ">> 6 GHz on gen $GEN: no regd patch needed -- regtest=5 selects custom_03"
        echo "   (6 GHz IR-capable; see doc/easymesh/Linux-7.0-hwsim-6GHz-VLP-AP-results.md)."
    fi
fi
apply "$HERE/patches/0003-mac80211_hwsim-optional-kernel-medium.patch"
apply "$HERE/patches/0004-mac80211_hwsim-kernel-medium-link-matrix.patch"
apply "$HERE/patches/0005-mac80211_hwsim-kernel-medium-rate-per.patch"
apply "$HERE/patches/0006-mac80211_hwsim-kernel-medium-timing-observability.patch"
apply "$HERE/patches/0007-mac80211_hwsim-allow-128-static-radios.patch"
apply "$HERE/patches/0008-mac80211_hwsim-fix-multichannel-monitor-ack.patch"
grep -q 'EXPERIMENTAL wmediumd' "$SRCDIR/mac80211_hwsim.c" \
    || { echo "patch 0001 did not apply -- check source version" >&2; exit 1; }

# 3. build just the module.
echo 'obj-m += mac80211_hwsim.o' > "$SRCDIR/Makefile"
make -C "$KBUILD" M="$SRCDIR" modules
echo ">> built $SRCDIR/mac80211_hwsim.ko"

if [ "$DO_INSTALL" = 1 ]; then
    DEST=/lib/modules/$KVER/updates
    sudo install -D -m 0644 "$SRCDIR/mac80211_hwsim.ko" "$DEST/mac80211_hwsim.ko"
    sudo depmod -a "$KVER"
    echo ">> installed to $DEST and ran depmod"
fi

if [ "$DO_LOAD" = 1 ]; then
    # 32 covers the target small profile: five mesh nodes, twenty client
    # radios and spare capacity for controlled replacement/tests. Medium uses
    # 64 and the optional stress profile uses the patched 128-radio bound.
    R=${HWSIM_RADIOS:-32}
    # 6 GHz tri-band wants a third channel context; default channels=3 with --6ghz.
    if [ -n "${HWSIM_CHANNELS:-}" ]; then C=$HWSIM_CHANNELS
    elif [ "$WITH_6GHZ" = 1 ]; then C=3
    else C=2; fi
    # On a non-6.8 generation, 6 GHz needs the custom_03 regdom, selected by regtest=5.
    REG=""
    if [ "$WITH_6GHZ" = 1 ] && [ "$GEN" != 6.8 ]; then
        REG="regtest=${HWSIM_REGTEST:-5}"
    fi
    KMEDIUM=""
    if [ "${HWSIM_KERNEL_MEDIUM:-0}" = 1 ]; then
        KMEDIUM="kernel_medium=1 kernel_medium_cutoff=${HWSIM_KERNEL_MEDIUM_CUTOFF:--95} kernel_medium_loss_pct=${HWSIM_KERNEL_MEDIUM_LOSS_PCT:-0} kernel_medium_rate_per=${HWSIM_KERNEL_MEDIUM_RATE_PER:-0} kernel_medium_noise_floor=${HWSIM_KERNEL_MEDIUM_NOISE_FLOOR:--91} kernel_medium_delay_us=${HWSIM_KERNEL_MEDIUM_DELAY_US:-0} kernel_medium_jitter_us=${HWSIM_KERNEL_MEDIUM_JITTER_US:-0} kernel_medium_delay_queue_limit=${HWSIM_KERNEL_MEDIUM_QUEUE_LIMIT:-4096}"
    fi
    echo ">> reloading pool: radios=$R channels=$C $REG $KMEDIUM"
    sudo modprobe -r mac80211_hwsim || true
    # shellcheck disable=SC2086
    sudo modprobe mac80211_hwsim radios="$R" channels="$C" $REG $KMEDIUM
    dmesg | tail -3 | grep -i hwsim || true
fi
