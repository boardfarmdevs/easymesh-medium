#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat > "$tmp/bin/lxc" <<'FAKE_LXC'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = list ]; then
    if [ "${FAKE_GUESTS:-0}" = 1 ] && [[ $* == *config:user.wmediumd.guest* ]]; then
        printf '%s\n' bpibroadband, wlan-client, pod-1,true em-gtp,true
    else
        printf '%s\n' bpibroadband wlan-client
    fi
    exit 0
fi

if [ "${1:-}" = config ] && [ "${2:-}" = get ]; then
    [ "$3" = pod-1 ] && [ "$4" = user.wmediumd.links ] && printf '%s\n' "${FAKE_LINKS:-}"
    exit 0
fi

if [ "${1:-}" != exec ]; then
    exit 2
fi
container=$2
shift 3
command_text=$*

case "$command_text" in
  *class/net/wlan1/phy80211/macaddress*)
    [ "$container" = pod-1 ] && printf '%s\n' 02:00:00:00:04:00
    ;;
  *class/net/wlan0/phy80211/macaddress*)
    [ "$container" = em-gtp ] && printf '%s\n' 02:00:00:00:05:00
    ;;
  *macaddress*)
    case "$container" in
      bpibroadband) printf '%s\n' 02:00:00:00:01:00 ;;
      pod-1) printf '%s\n' 02:00:00:00:03:00 02:00:00:00:04:00 ;;
      em-gtp) printf '%s\n' 02:00:00:00:05:00 ;;
      wlan-client)
        [ "${FAKE_CLIENT_ACTIVE:-0}" = 1 ] && printf '%s\n' 02:00:00:00:02:00
        ;;
    esac
    ;;
esac
FAKE_LXC
chmod 0755 "$tmp/bin/lxc"

if PATH="$tmp/bin:$PATH" "$repo/gen/wmediumd/gen-config.sh" 40 \
        >"$tmp/incomplete.cfg" 2>"$tmp/incomplete.err"; then
    echo "FAIL: incomplete managed radio inventory was accepted" >&2
    exit 1
fi
grep -q 'managed containers are missing active hwsim radios' "$tmp/incomplete.err"
grep -q 'wlan-client' "$tmp/incomplete.err"

PATH="$tmp/bin:$PATH" WMEDIUMD_ALLOW_INCOMPLETE_RADIOS=1 \
    "$repo/gen/wmediumd/gen-config.sh" 40 >"$tmp/subset.cfg"
grep -q '42:00:00:00:01:00' "$tmp/subset.cfg"
if grep -q '42:00:00:00:02:00' "$tmp/subset.cfg"; then
    echo "FAIL: inactive client appeared in intentional subset" >&2
    exit 1
fi

PATH="$tmp/bin:$PATH" FAKE_CLIENT_ACTIVE=1 \
    "$repo/gen/wmediumd/gen-config.sh" 40 >"$tmp/complete.cfg"
grep -q '42:00:00:00:01:00' "$tmp/complete.cfg"
grep -q '42:00:00:00:02:00' "$tmp/complete.cfg"

# guests: every radio at the default SNR, plus the links they pin
PATH="$tmp/bin:$PATH" FAKE_CLIENT_ACTIVE=1 FAKE_GUESTS=1 FAKE_LINKS='wlan1=em-gtp/wlan0:45' \
    "$repo/gen/wmediumd/gen-config.sh" 8 >"$tmp/guests.cfg"
for id in 42:00:00:00:03:00 42:00:00:00:04:00 42:00:00:00:05:00; do
    grep -q "$id" "$tmp/guests.cfg"
done
# indices: bpibroadband 0, wlan-client 1, then guests by name: em-gtp 2, pod-1 3 and 4
grep -q '(4, 2, 45)' "$tmp/guests.cfg"
grep -q '(2, 4, 45)' "$tmp/guests.cfg"
if grep -q '(3, 2, ' "$tmp/guests.cfg"; then
    echo "FAIL: a pinned link reached another radio of the guest" >&2
    exit 1
fi
if PATH="$tmp/bin:$PATH" FAKE_CLIENT_ACTIVE=1 FAKE_GUESTS=1 FAKE_LINKS='wlan1=em-gtp:45' \
        "$repo/gen/wmediumd/gen-config.sh" 8 >/dev/null 2>"$tmp/bad.err"; then
    echo "FAIL: a malformed guest link was accepted" >&2
    exit 1
fi
# a radio that is not up yet: the link is skipped, the rest of the medium stands
PATH="$tmp/bin:$PATH" FAKE_CLIENT_ACTIVE=1 FAKE_GUESTS=1 FAKE_LINKS='wlan9=em-gtp/wlan0:45' \
    "$repo/gen/wmediumd/gen-config.sh" 8 >"$tmp/pending.cfg" 2>"$tmp/pending.err"
grep -q 'skipped' "$tmp/pending.err"
grep -q '42:00:00:00:05:00' "$tmp/pending.cfg"

echo "PASS: wmediumd config rejects incomplete managed radio inventories; guest links pinned"
