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
    printf '%s\n' bpibroadband wlan-client
    exit 0
fi

if [ "${1:-}" != exec ]; then
    exit 2
fi
container=$2
shift 3
command_text=$*

case "$command_text" in
  *macaddress*)
    case "$container" in
      bpibroadband) printf '%s\n' 02:00:00:00:01:00 ;;
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

echo "PASS: wmediumd config rejects incomplete managed radio inventories"
