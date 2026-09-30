#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d /tmp/wmediumd-offline-build.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
source_dir=$work/source
output_dir=$work/output
fake_bin=$work/bin
git_log=$work/git.log
mkdir -p "$fake_bin"

cat > "$fake_bin/git" <<'EOF'
#!/bin/bash
set -eu
printf '%s\n' "$*" >> "$WMEDIUMD_TEST_GIT_LOG"
case " $* " in
    *' clone '*|*' fetch '*)
        echo 'network-capable git operation attempted in offline mode' >&2
        exit 97
        ;;
esac
exit 0
EOF
cat > "$fake_bin/make" <<'EOF'
#!/bin/bash
set -eu
source_dir=
while [ "$#" -gt 0 ]; do
    if [ "$1" = -C ]; then
        source_dir=$2
        shift 2
    else
        shift
    fi
done
mkdir -p "$source_dir/wmediumd"
printf '#!/bin/sh\nexit 0\n' > "$source_dir/wmediumd/wmediumd"
chmod 0755 "$source_dir/wmediumd/wmediumd"
EOF
chmod 0755 "$fake_bin/git" "$fake_bin/make"

if PATH="$fake_bin:$PATH" WMEDIUMD_TEST_GIT_LOG="$git_log" \
        "$ROOT/wmediumd/build-wmediumd.sh" --offline \
        --source "$source_dir" --output "$output_dir" >/dev/null 2>&1; then
    echo 'offline build accepted a missing source cache' >&2
    exit 1
fi
test ! -s "$git_log"

mkdir -p "$source_dir/.git"
PATH="$fake_bin:$PATH" WMEDIUMD_TEST_GIT_LOG="$git_log" \
    "$ROOT/wmediumd/build-wmediumd.sh" --offline \
    --source "$source_dir" --output "$output_dir" >/dev/null
test -x "$output_dir/wmediumd"
test -r "$output_dir/wmediumd.provenance.env"
! grep -Eq '(^| )(clone|fetch)( |$)' "$git_log"
grep -Fq 'WMEDIUMD_COMMIT=' "$output_dir/wmediumd.provenance.env"
grep -Fq 'WMEDIUMD_PATCHSET_SHA256=' "$output_dir/wmediumd.provenance.env"
for patch in "$ROOT"/wmediumd/patches/*.patch; do
    grep -Fqx -- "-C $source_dir apply --check $patch" "$git_log"
    grep -Fqx -- "-C $source_dir apply $patch" "$git_log"
done

echo 'PASS: wmediumd offline build uses only the accepted source cache'
