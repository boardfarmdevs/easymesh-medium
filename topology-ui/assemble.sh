#!/bin/sh
# assemble.sh STACK OUT_DIR [VIEWER_DIR]: the EasyMesh topology page for a stack (rdk or
# prplmesh), as its backend serves it under /static/: this directory's static files, the
# room viewer's shared modules (listed in shared-modules, from VIEWER_DIR, by default this
# medium's configurator/worlds/viewer), the checked vendor libraries and the stack's
# profile as ui-profile.js. RDK's unified-wifi-mesh recipe and prplmesh-lab's controller-ui
# both build their page with it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
stack=${1:?usage: assemble.sh rdk|prplmesh OUT_DIR [VIEWER_DIR]}
out=${2:?usage: assemble.sh rdk|prplmesh OUT_DIR [VIEWER_DIR]}
viewer=${3:-$here/../configurator/worlds/viewer}
[ -f "$here/profiles/$stack.js" ] || { echo "assemble.sh: no profile for stack $stack" >&2; exit 2; }
mkdir -p "$out"
cp -R "$here/static/." "$out/"
while read -r module; do
    [ -n "$module" ] && cp "$viewer/$module" "$out/$module"
done < "$here/shared-modules"
(cd "$here" && sha256sum -c --quiet web-vendor.tar.gz.sha256)
tar --no-same-owner -xzf "$here/web-vendor.tar.gz" -C "$out"
(cd "$out" && sha256sum -c --quiet vendor/SHA256SUMS)
cp "$here/profiles/$stack.js" "$out/ui-profile.js"
