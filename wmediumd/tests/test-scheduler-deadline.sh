#!/usr/bin/env bash
set -euo pipefail
source_dir=${1:?usage: bash test-scheduler-deadline.sh PATCHED_SOURCE/wmediumd}
test_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
"${CC:-cc}" -O2 -Wno-format-zero-length -I "$source_dir/inc" "$test_dir/test-scheduler-deadline.c" \
    "$source_dir/lib/sched.c" "$source_dir/lib/loop.c" "$source_dir/lib/wallclock.c" \
    -o "$temporary/test-scheduler-deadline"
timeout 3 "$temporary/test-scheduler-deadline"
