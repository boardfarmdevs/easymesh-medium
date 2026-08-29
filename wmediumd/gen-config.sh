#!/bin/bash
# wmediumd SNR config for in-use mesh+client radios.
# ARG1: default_snr (Phase1a: 40 all-strong; Phase1b: ~8 weak -> gradient)
DEF="${1:-8}"
# Discover the active scenario instead of silently limiting the medium to the
# original 2-extender/5-client smoke topology.  bpi.sh and wlan-client.sh use
# these stable names for additional instances; version sorting keeps the base
# instance first and numeric instances in human order.
mapfile -t MESH < <(lxc list -c n --format csv 2>/dev/null \
  | grep -E '^(bpibroadband|bpiap|bpiap-[0-9]{3})$' | sort -V)
mapfile -t CLIENTS < <(lxc list -c n --format csv 2>/dev/null \
  | grep -E '^(wlan-client|wlan-client-[0-9]{3})$' | sort -V)
case "${WMEDIUMD_ALLOW_INCOMPLETE_RADIOS:-0}" in
  0|1) ;;
  *) echo "gen-config: FATAL WMEDIUMD_ALLOW_INCOMPLETE_RADIOS must be 0 or 1" >&2; exit 2 ;;
esac
declare -A ADDR IDX; IDS=(); MISSING=(); i=0
# wmediumd identifies a radio by the frame's HWSIM_ATTR_ADDR_TRANSMITTER, which
# mac80211_hwsim derives as addresses[1] = perm_addr with byte0 |= 0x40 (see
# mac80211_hwsim.c: data->addresses[1].addr[0] |= 0x40). /sys/.../macaddress is
# addresses[0] (perm, 02:..). Using perm here made get_station_by_addr() miss on
# every frame, so any VAP whose BSSID != perm got dropped ("Unable to find sender
# station") -- fatal for FEATURE_SINGLE_PHY where one radio carries several
# per-band BSSIDs. Emit the 42:-prefixed hw address instead.
addr(){ local a; a=$(lxc exec "$1" -- sh -c 'cat /sys/class/ieee80211/*/macaddress 2>/dev/null|head -1' </dev/null 2>/dev/null); [ -z "$a" ] && return; printf '%02x%s\n' $(( 0x${a:0:2} | 0x40 )) "${a:2}"; }
# Only active scenario radios belong in the matrix.  wmediumd attempts every
# multicast delivery against every configured station; adding unused pool
# radios (which have no channel context) causes a storm of rejected cloned
# frames and, empirically, starves active data delivery.  wmediumd-up quiesces
# the unused host-side virt-wlan interfaces so omitted radios cannot transmit.
for c in "${MESH[@]}" "${CLIENTS[@]}"; do
  a=$(addr "$c")
  if [ -z "$a" ]; then
    MISSING+=("$c")
    continue
  fi
  ADDR[$c]=$a
  IDX[$c]=$i
  IDS+=("$a")
  i=$((i+1))
done
if [ "${#MISSING[@]}" -gt 0 ] && [ "${WMEDIUMD_ALLOW_INCOMPLETE_RADIOS:-0}" != 1 ]; then
  echo "gen-config: FATAL managed containers are missing active hwsim radios:" >&2
  printf 'gen-config:   %s\n' "${MISSING[@]}" >&2
  echo "gen-config: start every intended mesh/client container before wmediumd" >&2
  echo "gen-config: or set WMEDIUMD_ALLOW_INCOMPLETE_RADIOS=1 for an intentional subset" >&2
  exit 1
fi
[ "${#IDS[@]}" -gt 0 ] || { echo "gen-config: FATAL no active hwsim radios found" >&2; exit 1; }
# Regression guard for the 02:->42: bug: every emitted radio id MUST be a hwsim
# TX address (byte0 has 0x40 set). If addr() is ever rewritten from sysfs
# macaddress (perm/02:) without the |0x40 transform, get_station_by_addr() will
# miss every frame; the first VIF still works by src-fallback while secondary
# BSSIDs silently vanish ("Unable to find sender station"). Fail loud instead.
for id in "${IDS[@]}"; do
  if [ $(( 0x${id:0:2} & 0x40 )) -eq 0 ]; then
    echo "gen-config: FATAL radio id '$id' is not a hwsim TX addr (byte0 0x40 unset);" >&2
    echo "gen-config:   wmediumd would drop secondary-VIF frames. Use perm|0x40." >&2
    exit 1
  fi
done
# each mesh node's owned VAP BSSIDs (to map a client's current BSS -> home node)
declare -A OWNER
for m in "${MESH[@]}"; do
  for v in $(lxc exec "$m" -- sh -c 'iw dev 2>/dev/null|awk "/Interface/{print \$2}"' </dev/null 2>/dev/null); do
    b=$(lxc exec "$m" -- sh -c "iw dev $v info 2>/dev/null|awk '/addr/{print \$2}'" </dev/null 2>/dev/null)
    [ -n "$b" ] && OWNER[$b]=$m
  done
done
L=(); add(){ [ -n "$1" ] && [ -n "$2" ] && [ -n "$3" ] || return; L+=("($1, $2, $3)"); L+=("($2, $1, $3)"); }
# Full strong backhaul graph. Controller-to-extender links are strongest; the
# slightly lower extender-to-extender links still allow repeatable multi-hop
# experiments without excluding newly added extenders from the medium.
for ((left=0; left < ${#MESH[@]}; left++)); do
  for ((right=left+1; right < ${#MESH[@]}; right++)); do
    left_node=${MESH[$left]}; right_node=${MESH[$right]}; snr=45
    if [ "$left_node" = bpibroadband ] || [ "$right_node" = bpibroadband ]; then snr=50; fi
    add "${IDX[$left_node]:-}" "${IDX[$right_node]:-}" "$snr"
  done
done
# each client strong to its CURRENT home AP
for c in "${CLIENTS[@]}"; do
  [ -z "${IDX[$c]:-}" ] && continue
  bss=$(lxc exec "$c" -- sh -c 'iw dev wlan0 link 2>/dev/null|grep -oE "[0-9a-f:]{17}"|head -1' </dev/null 2>/dev/null)
  # A freshly created client may not have associated yet.  An empty BSSID is a
  # normal transient state, but it is not a valid associative-array subscript.
  # The default SNR still gives the client bootstrap connectivity; a later
  # scenario refresh can add its current-home override once association exists.
  [ -n "$bss" ] || continue
  home=${OWNER[$bss]:-}
  [ -n "$home" ] && [ -n "${IDX[$home]}" ] && add ${IDX[$c]} ${IDX[$home]} 50
done
{
  echo "ifaces : {"; echo "  ids = ["
  n=${#IDS[@]}; for j in $(seq 0 $((n-1))); do s=,; [ $j -eq $((n-1)) ]&&s=""; echo "    \"${IDS[$j]}\"$s"; done
  echo "  ];"; echo "};"
  echo "model : {"; echo "  type = \"snr\";"; echo "  default_snr = ${DEF};"; echo "  links = ("
  m=${#L[@]}; for j in $(seq 0 $((m-1))); do s=,; [ $j -eq $((m-1)) ]&&s=""; echo "    ${L[$j]}$s"; done
  echo "  );"; echo "};"
}
