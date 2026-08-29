#!/bin/bash
# Runtime regression check for the 02:->42: wmediumd radio-id bug.
# Usage: check-wmediumd-ids.sh <wmediumd.log>
# A correct config produces ZERO "Unable to find sender station" lines: every
# frame's HWSIM_ATTR_ADDR_TRANSMITTER matched a configured radio id. Any such
# line means a radio was registered by the wrong address (perm 02: instead of
# hw 42:), so its secondary-VIF frames are being dropped.
log="${1:?usage: check-wmediumd-ids.sh <wmediumd.log>}"
n=$(grep -c 'Unable to find sender station' "$log" 2>/dev/null || true)
n=${n:-0}
if [ "$n" -gt 0 ]; then
  echo "FAIL: $n 'Unable to find sender station' lines -- radio-id mismatch (02: vs 42:)"
  grep -oE 'hwaddr=[0-9a-f:]+' "$log" | sort | uniq -c
  exit 1
fi
echo "OK: no sender-lookup failures in $log"
