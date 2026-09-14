#!/bin/bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCE=${1:?usage: build-cfg80211.sh BUILD_DIRECTORY [--install]}
INSTALL=${2:-}
case "$INSTALL" in ''|--install) ;; *) exit 2 ;; esac
KVER=$(uname -r)
GEN=$(printf '%s\n' "$KVER" | sed -E 's/^([0-9]+\.[0-9]+).*/\1/')
case "$GEN" in 6.8|7.0) ;; *) echo "unsupported cfg80211 generation: $KVER" >&2; exit 1 ;; esac
KBUILD=/lib/modules/$KVER/build
test -d "$KBUILD"
SOURCE=$(realpath -m "$SOURCE")
PACKAGE=linux-hwe-$GEN
VERSION=$(dpkg-query -W -f='${Version}' "linux-image-$KVER")
IDENTITY="$PACKAGE=$VERSION kernel=$KVER"
mkdir -p "$SOURCE"

if [ ! -f "$SOURCE/source.identity" ] || [ "$(cat "$SOURCE/source.identity")" != "$IDENTITY" ] || [ "${REFETCH:-0}" = 1 ]; then
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT
    if ! (cd "$temporary"; apt-get source --download-only "$PACKAGE=$VERSION"); then
        base="https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/$PACKAGE/$VERSION"
        descriptor="${PACKAGE}_${VERSION}.dsc"
        curl --fail --location --retry 3 "$base/$descriptor" -o "$temporary/$descriptor"
        python3 - "$temporary/$descriptor" > "$temporary/checksums" <<'PY'
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]).read_text()
checksums = source.split("Checksums-Sha256:\n", 1)[1].split("\nFiles:", 1)[0]
for line in checksums.splitlines():
    if not line.startswith(" "):
        break
    digest, size, name = line.split()
    if not re.fullmatch(r"[a-f0-9]{64}", digest) or not size.isdigit() or not re.fullmatch(r"[A-Za-z0-9_.+~:-]+", name):
        raise SystemExit("invalid source checksum record")
    print(digest, name)
PY
        test -s "$temporary/checksums"
        while read -r digest name; do
            curl --fail --location --retry 3 "$base/$name" -o "$temporary/$name"
        done < "$temporary/checksums"
        (cd "$temporary"; sha256sum -c checksums)
    fi
    descriptor="$temporary/${PACKAGE}_${VERSION}.dsc"
    test -f "$descriptor"
    dpkg-source --no-check -x "$descriptor" "$temporary/kernel"
    rm -rf "$SOURCE/wireless"
    cp -a "$temporary/kernel/net/wireless" "$SOURCE/wireless"
    install -m 0644 "$descriptor" "$SOURCE/source-package.dsc"
    printf '%s\n' "$IDENTITY" > "$SOURCE/source.identity"
    (cd "$SOURCE/wireless"; sha256sum core.c nl80211.c > "$SOURCE/source.sha256")
    rm -rf "$temporary"
    trap - EXIT
fi

for patch_file in "$HERE"/*.patch; do
    if patch -d "$SOURCE/wireless" -p3 --dry-run -N < "$patch_file" >/dev/null 2>&1; then
        patch -d "$SOURCE/wireless" -p3 -N < "$patch_file"
    elif ! patch -d "$SOURCE/wireless" -p3 --dry-run -R < "$patch_file" >/dev/null 2>&1; then
        echo "cfg80211 patch incompatible with $IDENTITY: $patch_file" >&2
        exit 1
    fi
done
make -C "$KBUILD" M="$SOURCE/wireless" CONFIG_CFG80211=m -j "${CFG80211_BUILD_JOBS:-4}" modules
test "$(modinfo -F version "$SOURCE/wireless/cfg80211.ko")" = lab-netns-owner-1
sha256sum "$SOURCE/wireless/cfg80211.ko" > "$SOURCE/module.sha256"
if [ "$INSTALL" = --install ]; then
    sudo install -D -m 0644 "$SOURCE/wireless/cfg80211.ko" "/lib/modules/$KVER/updates/cfg80211.ko"
    provenance=/usr/share/hwsim-lab/cfg80211
    sudo install -d -m 0755 "$provenance"
    sudo install -m 0644 "$SOURCE/source.identity" "$SOURCE/source-package.dsc" "$SOURCE/source.sha256" "$provenance/"
    sha256sum "/lib/modules/$KVER/updates/cfg80211.ko" | sudo tee "$provenance/module.sha256" >/dev/null
    sudo depmod -a "$KVER"
    echo "Installed cfg80211; reboot the lab VM if the old module is already loaded."
fi
