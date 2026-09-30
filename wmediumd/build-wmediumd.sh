#!/bin/bash
# Build the medium's wmediumd: upstream wmediumd at the pinned commit
# (upstream.env) with this repository's patch series (patches/, applied in
# order), from a clean checkout every time.
#
#   wmediumd/build-wmediumd.sh [--offline] [--source DIR] [--output DIR]
#
#   --source DIR   the upstream checkout to reuse or create (default wmediumd/src)
#   --output DIR   where wmediumd and wmediumd.provenance.env go (default wmediumd/build)
#   --offline      never fetch: the source checkout must already hold the pinned commit
#
# The binary is never committed. wmediumd.provenance.env records the upstream
# commit, the patch series' digest and this repository's commit, so a lab can
# tell which medium it runs. Self-test after a build: sudo <output>/wmediumd -T
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/upstream.env"
SOURCE=$HERE/src
OUTPUT=$HERE/build
OFFLINE=0
while [ $# -gt 0 ]; do
    case $1 in
        --offline) OFFLINE=1 ;;
        --source) SOURCE=${2:?--source DIR}; shift ;;
        --output) OUTPUT=${2:?--output DIR}; shift ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "usage: $0 [--offline] [--source DIR] [--output DIR]" >&2; exit 2 ;;
    esac
    shift
done

if [ ! -d "$SOURCE/.git" ]; then
    [ "$OFFLINE" = 0 ] || { echo "offline build needs an existing source checkout: $SOURCE" >&2; exit 1; }
    mkdir -p "$(dirname "$SOURCE")"
    git clone -q "$WMEDIUMD_REPO" "$SOURCE"
fi
if ! git -C "$SOURCE" cat-file -e "$WMEDIUMD_COMMIT^{commit}" 2>/dev/null; then
    [ "$OFFLINE" = 0 ] || { echo "the source checkout lacks $WMEDIUMD_COMMIT: $SOURCE" >&2; exit 1; }
    git -C "$SOURCE" fetch -q origin
fi
git -C "$SOURCE" checkout -q --detach "$WMEDIUMD_COMMIT"
git -C "$SOURCE" reset -q --hard "$WMEDIUMD_COMMIT"
git -C "$SOURCE" clean -q -fdx

for patch in "$HERE"/patches/*.patch; do
    git -C "$SOURCE" apply --check "$patch" || { echo "does not apply: $patch" >&2; exit 1; }
    git -C "$SOURCE" apply "$patch"
done

make -C "$SOURCE" -j"$(nproc)" >/dev/null
install -D -m 0755 "$SOURCE/wmediumd/wmediumd" "$OUTPUT/wmediumd"
series=$(cd "$HERE" && sha256sum patches/*.patch | sha256sum | awk '{print $1}')
medium=$(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo unknown)
git -C "$HERE" diff --quiet HEAD -- . 2>/dev/null || medium="$medium+dirty"
printf '%s\n' \
    "WMEDIUMD_COMMIT=$WMEDIUMD_COMMIT" \
    "WMEDIUMD_PATCHSET_SHA256=$series" \
    "EASYMESH_MEDIUM_COMMIT=$medium" \
    "WMEDIUMD_SHA256=$(sha256sum "$OUTPUT/wmediumd" | awk '{print $1}')" \
    > "$OUTPUT/wmediumd.provenance.env"
echo "built $OUTPUT/wmediumd (upstream ${WMEDIUMD_COMMIT:0:7}, $(ls "$HERE"/patches/*.patch | wc -l) patches, series ${series:0:12})"
