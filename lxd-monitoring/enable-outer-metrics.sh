#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
exec python3 "$source_dir/outer-metrics.py" enable "$@"
