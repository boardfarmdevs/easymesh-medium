#!/bin/bash
# build-wmediumd.sh -- build the channels-aware (multichannel) wmediumd.
#
# Base: upstream wmediumd (github.com/bcopeland/wmediumd), the v0.3.1 line, which
# already carries per-frame HWSIM_ATTR_FREQ on frames received from hwsim. On
# top of it we apply a nineteen-patch series: per-frequency interference and scheduling, learned VIF
# ownership, removal of hot-path file I/O, Linux 7 HT/VHT rate flags,
# frequency-filtered multicast, a larger netlink receive buffer, the atomic
# scenario-control socket, configured default-SNR handling, and evidence-based
# multicast eligibility for newly registered radios, and classification of
# normal mac80211_hwsim receive-state rejections, and frequency-qualified SNR
# overrides for simultaneous 2.4/5/6 GHz scenario control, plus an independently
# permissioned read-only metrics endpoint for hwsim radio-provider queries, and
# a separate bounded host-only telemetry endpoint for wmediumd Console, and
# indexed hot-path scenario/telemetry lookups, and protocol-positive station
# association ownership for rejecting stale hwsim AP peer rows, and learned-VIF
# resolution for association queries made with live NL80211 endpoint MACs, and
# bounded paged pair/frequency dumps for 100-client observer snapshots, and
# TX-status frequency return for channel-context-safe monitor ACKs.
#
#   ./build-wmediumd.sh          # clone (or reuse ./src), patch, build -> ./src/wmediumd/wmediumd
#   ./build-wmediumd.sh --refresh-prebuilt
#                                # also replace tracked ./wmediumd.patched
#
# A prebuilt binary proven on rev130 with Linux 7.0 is committed next to this
# script as ./wmediumd.patched for a no-build fast path.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$HERE/src
REPO=${WMEDIUMD_REPO:-https://github.com/bcopeland/wmediumd}
# Upstream reports version 0.3.1 but does not publish a v0.3.1 Git tag. Pin the
# exact verified commit instead of depending on the moving default branch or a
# tag that cannot be checked out.
REF=${WMEDIUMD_REF:-717e5d7fcc23eecbc8e32bd897a8fd4b1e3ba640}
REFRESH_PREBUILT=0
case "${1:-}" in
    '') ;;
    --refresh-prebuilt) REFRESH_PREBUILT=1 ;;
    -h|--help)
        sed -n '1,30p' "$0"
        exit 0
        ;;
    *) echo "usage: $0 [--refresh-prebuilt]" >&2; exit 2 ;;
esac

if [ ! -d "$SRC/.git" ]; then
    echo ">> cloning $REPO @ $REF"
    git clone "$REPO" "$SRC"
    git -C "$SRC" checkout --detach "$REF"
elif [ "$(git -C "$SRC" rev-parse HEAD)" != "$REF" ]; then
    echo "source checkout is not at pinned commit $REF: $SRC" >&2
    echo "remove it or set WMEDIUMD_REF explicitly after reviewing the patch" >&2
    exit 1
fi

echo ">> applying multichannel patch series"
STAMP=$SRC/.wmediumd-patch-series
SERIES_SHA=$(sha256sum "$HERE"/patches/*.patch | sha256sum | awk '{print $1}')
if [ -f "$STAMP" ]; then
    read -r STAMP_SERIES STAMP_DIFF < "$STAMP"
    CURRENT_DIFF=$(git -C "$SRC" diff --binary | sha256sum | awk '{print $1}')
    [ "$STAMP_SERIES" = "$SERIES_SHA" ] && [ "$STAMP_DIFF" = "$CURRENT_DIFF" ] || {
        echo "wmediumd patch series or prepared source changed since the last build" >&2
        echo "move $SRC aside and rerun to create a clean pinned checkout" >&2
        exit 1
    }
    echo "   (verified previously applied series $SERIES_SHA)"
else
    if ! git -C "$SRC" diff --quiet || ! git -C "$SRC" diff --cached --quiet; then
        echo "untracked patch state in $SRC; refusing to guess whether it is complete" >&2
        echo "move $SRC aside and rerun to create a clean pinned checkout" >&2
        exit 1
    fi
    for p in "$HERE"/patches/*.patch; do
        git -C "$SRC" apply --check "$p" || {
            echo "patch does not apply cleanly: $p" >&2
            exit 1
        }
        git -C "$SRC" apply "$p"
    done
    DIFF_SHA=$(git -C "$SRC" diff --binary | sha256sum | awk '{print $1}')
    printf '%s %s\n' "$SERIES_SHA" "$DIFF_SHA" > "$STAMP"
fi

echo ">> building"
make -C "$SRC" -j"$(nproc)"
echo ">> built $SRC/wmediumd/wmediumd"
echo "   (self-test: sudo $SRC/wmediumd/wmediumd -T )"
if [ "$REFRESH_PREBUILT" = 1 ]; then
    "$SRC/wmediumd/wmediumd" -T
    PREBUILT_TMP=$HERE/.wmediumd.patched.$$
    trap 'rm -f -- "$PREBUILT_TMP"' EXIT
    install -m 0755 "$SRC/wmediumd/wmediumd" "$PREBUILT_TMP"
    mv -f "$PREBUILT_TMP" "$HERE/wmediumd.patched"
    trap - EXIT
    printf '>> refreshed %s sha256=%s\n' "$HERE/wmediumd.patched" \
        "$(sha256sum "$HERE/wmediumd.patched" | awk '{print $1}')"
fi
