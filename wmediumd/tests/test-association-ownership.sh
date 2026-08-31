#!/usr/bin/env bash
# Validate protocol-positive association ownership and HAL precedence.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
daemon=${WMEDIUMD:-$repo/gen/wmediumd/src/wmediumd/wmediumd}
wmediumd_patch=$repo/gen/wmediumd/patches/0016-wmediumd-expose-authoritative-association-ownership.patch
vif_patch=$repo/gen/wmediumd/patches/0017-wmediumd-resolve-association-vifs.patch
hal_patch=$repo/recipes-ccsp/hal/rdk-wifi-hal/0033-hwsim-filter-stale-peers-by-medium-ownership.patch
bbappend=$repo/recipes-ccsp/hal/rdk-wifi-hal.bbappend
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

[ -x "$daemon" ] || {
    echo "missing patched daemon: $daemon (run gen/wmediumd/build-wmediumd.sh)" >&2
    exit 1
}

python3 - "$wmediumd_patch" "$vif_patch" "$hal_patch" "$bbappend" "$tmp/decision.c" <<'PY'
from pathlib import Path
import sys

wmediumd = Path(sys.argv[1]).read_text()
vif_resolution = Path(sys.argv[2]).read_text()
hal = Path(sys.argv[3]).read_text()
bbappend = Path(sys.argv[4]).read_text()
output = Path(sys.argv[5])

for source in (wmediumd, hal):
    assert "WMDC_OP_GET_ASSOCIATION = 14" in source
    assert "WMDC_CAP_ASSOCIATION_OWNERSHIP = 1U << 10" in source
for field in ("endpoint[6]", "station[6]", "owner[6]"):
    assert field in wmediumd and field in hal
for behavior in (
    "ctx->telemetry->vifs[k]",
    "learned >= 0 && learned != vif->radio",
    "station_index_endpoint(&ctx, unknown_vif) != -1",
):
    assert behavior in vif_resolution

# Production must apply the ownership refinement after the existing fallback.
fallback_apply = "with open(d.getVar('PLATFORM_HWSIM_STA_LIVENESS_PATCH')"
owner_apply = "with open(d.getVar('PLATFORM_HWSIM_ASSOC_OWNERSHIP_PATCH')"
assert bbappend.index(fallback_apply) < bbappend.index(owner_apply)

# Compile and execute the exact decision helper from the layer patch. This
# explicitly protects an idle current client, rejects a known old AP row, and
# retains the conservative fallback only when ownership is unknown.
lines = hal.splitlines()
function = []
capture = False
opened = False
depth = 0
for line in lines:
    if line.startswith("+static bool hwsim_should_filter_station"):
        capture = True
    if not capture or not line.startswith("+"):
        continue
    code = line[1:]
    function.append(code)
    opens = code.count("{")
    closes = code.count("}")
    if opens:
        opened = True
    depth += opens - closes
    if opened and depth == 0:
        break
assert function and function[-1] == "}", "decision helper missing from HAL patch"

output.write_text(
    "#include <assert.h>\n"
    "#include <stdbool.h>\n"
    "#include <stdint.h>\n"
    "#include <string.h>\n"
    "#define HWSIM_ASSOC_STALE_MSEC 120000U\n"
    "typedef uint8_t mac_address_t[6];\n\n"
    + "\n".join(function)
    + "\n\nint main(void)\n{\n"
      "    mac_address_t local = {0x42, 0, 0, 0, 1, 0};\n"
      "    mac_address_t other = {0x42, 0, 0, 0, 2, 0};\n"
      "    assert(!hwsim_should_filter_station(true, local, local, true, 900000));\n"
      "    assert(hwsim_should_filter_station(true, other, local, false, 0));\n"
      "    assert(!hwsim_should_filter_station(false, other, local, false, 0));\n"
      "    assert(!hwsim_should_filter_station(false, other, local, true, 120000));\n"
      "    assert(hwsim_should_filter_station(false, other, local, true, 120001));\n"
      "    return 0;\n}\n"
)
PY

cc -std=gnu11 -Wall -Wextra -Werror "$tmp/decision.c" -o "$tmp/decision"
"$tmp/decision"
"$daemon" -T

echo "PASS: learned-VIF association ownership, ambiguity rejection, idle safety, roam delta, and unknown fallback"
