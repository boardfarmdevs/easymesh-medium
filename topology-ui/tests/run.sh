#!/bin/sh
# The topology page's tests without a browser (the medium's CI and the labs' suites):
# against an assembled page, by default this directory's page assembled for RDK; each
# webui test loads script.js, rf-hover the room topology, steering-cues its module.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
static=${1:-}
if [ -z "$static" ]; then
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    static=$work/static
    "$here/../assemble.sh" rdk "$static"
fi
status=0
for test in "$here"/*-test.js; do
    case $(basename "$test") in
        *browser-test.js) continue ;;
        webui-rf-hover-test.js) source=$static/room-topology.js ;;
        steering-cues-test.js) source=$static/steering-cues.js ;;
        *) source=$static/script.js ;;
    esac
    if output=$(node "$test" "$source" 2>&1); then
        echo "PASS $(basename "$test")"
    else
        echo "FAIL $(basename "$test")"; echo "$output" | tail -n 20; status=1
    fi
done
exit "$status"
