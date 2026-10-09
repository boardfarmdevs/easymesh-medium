#!/usr/bin/env bash
# The medium's logs across starts (wmediumd-up.sh): a start keeps the previous start's LOG and
# LOG.1 as LOG.prev and LOG.prev.1, and the two starts before it as LOG.prev2 and LOG.prev3, each
# with its .1 or none; the fourth start back is gone. Runs the script's own log_shift and its
# rotation block (sudo as a plain call) over a directory, start after start.
#   bash test-log-rotation.sh [wmediumd-up.sh]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script=${1:-$here/../wmediumd-up.sh}
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT

{
    echo 'sudo() { "$@"; }'
    awk '/^log_shift\(\) \{/ {f = 1} f {print} f && /^\}/ {exit}' "$script"
    echo 'start() {'
    # the rotation block: from its comment to the if's fi
    awk '/# The previous starts. logs are evidence/ {f = 1} f && /^    if sudo test -e "\$LOG"; then/ {g = 1}
         g {print} g && /^    fi$/ {exit}' "$script"
    echo '}'
} > "$temporary/rotation.sh"
grep -q 'log_shift prev2 prev3' "$temporary/rotation.sh" || { echo "FAIL: the rotation block was not found" >&2; exit 1; }

LOG=$temporary/wmediumd.log
# shellcheck source=/dev/null # the script's own code, extracted above
source "$temporary/rotation.sh"
fail=0
expect() {    # expect FILE CONTENT|-: FILE holds CONTENT, or (-) does not exist
    local file=$LOG$1 got
    if [ "$2" = - ]; then
        [ ! -e "$file" ] || { echo "FAIL: wmediumd.log$1 exists ($(cat "$file"))" >&2; fail=1; }
        return 0
    fi
    got=$(cat "$file" 2>/dev/null || echo missing)
    [ "$got" = "$2" ] || { echo "FAIL: wmediumd.log$1 is '$got', not '$2'" >&2; fail=1; }
}
run() {    # run N [rotated]: run N wrote LOG (and LOG.1 when it was rotated), then a start
    echo "run $1" > "$LOG"
    if [ "${2:-}" = rotated ]; then echo "run $1 part 1" > "$LOG.1"; else rm -f "$LOG.1"; fi
    start
}

run 1 rotated
expect .prev "run 1"; expect .prev.1 "run 1 part 1"; expect .prev2 -; expect .prev3 -
run 2
expect .prev "run 2"; expect .prev.1 -; expect .prev2 "run 1"; expect .prev2.1 "run 1 part 1"; expect .prev3 -
run 3 rotated
expect .prev "run 3"; expect .prev.1 "run 3 part 1"; expect .prev2 "run 2"; expect .prev2.1 -
expect .prev3 "run 1"; expect .prev3.1 "run 1 part 1"
run 4
expect .prev "run 4"; expect .prev.1 -; expect .prev2 "run 3"; expect .prev2.1 "run 3 part 1"
expect .prev3 "run 2"; expect .prev3.1 -
expect "" -; expect .1 -
# nothing but the three generations: the fourth start back (run 1) is gone
left=$(find "$temporary" -maxdepth 1 -name 'wmediumd.log*' -printf '%f\n' | sort | tr '\n' ' ')
[ "$left" = "wmediumd.log.prev wmediumd.log.prev2 wmediumd.log.prev2.1 wmediumd.log.prev3 " ] ||
    { echo "FAIL: left $left" >&2; fail=1; }
# a start with no log of its own keeps the generations as they are
start
expect .prev "run 4"; expect .prev3 "run 2"

[ "$fail" = 0 ] && echo "PASS: three generations of the medium's log, each with its .1"
exit "$fail"
