#!/bin/sh

# Run the visual client-carousel scenario without relying on a shared /tmp
# directory. Older root-run demonstrations may leave the legacy output root
# unwritable by the normal lab user.

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
output_root=${WMD_CAROUSEL_RUN_ROOT:-/tmp/wmediumd-client-carousel-$(id -u)}

mkdir -p "$output_root"

exec "$repo_dir/gen/tests/wmediumd-client-carousel.py" \
    --output-root "$output_root" \
    "$@"
