#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
cd "$here"
if [[ ${1:-} == --vendor ]]; then
    npm ci --ignore-scripts --no-audit --no-fund
    npm run vendor
    shift
fi
if (( $# > 1 )); then
    echo "usage: bash $0 [--vendor] [output-binary]" >&2
    exit 2
fi
python3 build-manual.py
CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags='-s -w' \
    -o "${1:-$here/wmediumd-console}" ./cmd/wmediumd-observer
echo 'Console NG compiled; no tests or services were run.'
