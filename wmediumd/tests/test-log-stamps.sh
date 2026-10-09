#!/usr/bin/env bash
# The medium's log (patch 0038): every line on stdout and stderr starts with its UTC time, a
# line printed in parts has one stamp, and with -L a log on a file is renamed to FILE.1 past
# the limit and continued in a new FILE, both streams in it. Compiles the patched wmediumd.c's
# own log code (struct log_sink to log_streams_init) with a driver; no radios, no netlink.
#   bash test-log-stamps.sh PATCHED_SOURCE/wmediumd.c
set -euo pipefail
source_file=${1:?usage: bash test-log-stamps.sh PATCHED_SOURCE/wmediumd.c}
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT

python3 - "$source_file" "$temporary/log-code.c" <<'PYEOF'
import sys
source = open(sys.argv[1]).read()
start = source.index("struct log_sink {")
end = source.index("\n}\n", source.index("static void log_streams_init(void)")) + 3
open(sys.argv[2], "w").write(source[start:end])
PYEOF

cat > "$temporary/driver.c" <<'CEOF'
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include "log-code.c"
int main(int argc, char *argv[])
{
	log_max_bytes = argc > 1 ? strtoll(argv[1], NULL, 10) : 0;
	log_streams_init();
	printf("first line\n");
	printf("a line printed ");
	printf("in three ");
	printf("parts\n");
	fprintf(stderr, "an error on stderr\n");
	for (int i = 0; i < 400; i++)
		printf("filler line %03d with some text to fill the log past its limit\n", i);
	fprintf(stderr, "last error\n");
	printf("last line\n");
	return 0;
}
CEOF
"${CC:-cc}" -std=gnu11 -Wall -Wextra -Werror -O2 -I "$temporary" "$temporary/driver.c" -o "$temporary/driver"

stamp='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z '
fail() { echo "FAIL: $*" >&2; exit 1; }

# no limit: one file, every line stamped, the parts on one line
"$temporary/driver" 0 > "$temporary/plain.log" 2>&1
[ ! -e "$temporary/plain.log.1" ] || fail "rotated without -L"
[ "$(wc -l < "$temporary/plain.log")" -eq 405 ] || fail "plain: $(wc -l < "$temporary/plain.log") lines, not 405"
if grep -Evq "$stamp" "$temporary/plain.log"; then fail "plain: a line without its stamp"; fi
grep -Eq "${stamp}a line printed in three parts$" "$temporary/plain.log" || fail "a line in parts not stamped once"
grep -Eq "${stamp}an error on stderr$" "$temporary/plain.log" || fail "stderr not stamped"

# a limit of 8 KiB: FILE.1 and FILE, both bounded, nothing lost, stderr in the new FILE too
"$temporary/driver" 8192 > "$temporary/capped.log" 2>&1
[ -e "$temporary/capped.log.1" ] || fail "no FILE.1 past the limit"
size=$(stat -c %s "$temporary/capped.log")
[ "$size" -lt $((8192 + 200)) ] || fail "FILE is $size bytes past an 8192-byte limit"
size=$(stat -c %s "$temporary/capped.log.1")
[ "$size" -lt $((8192 + 200)) ] || fail "FILE.1 is $size bytes past an 8192-byte limit"
grep -Eq "${stamp}log: past 8192 bytes, the lines before are in .*capped\.log\.1$" "$temporary/capped.log" ||
    fail "no rotation line at the start of the new FILE"
for log in capped.log capped.log.1; do
    if grep -Evq "$stamp" "$temporary/$log"; then fail "$log: a line without its stamp"; fi
done
grep -Eq "${stamp}last error$" "$temporary/capped.log" || fail "stderr not in the new FILE"
grep -Eq "${stamp}last line$" "$temporary/capped.log" || fail "stdout not in the new FILE"
# the last FILE.1 holds the lines just before the new FILE: none lost between them
last_before=$(grep -o 'filler line [0-9]*' "$temporary/capped.log.1" | tail -1 | grep -o '[0-9]*$')
first_after=$(grep -o 'filler line [0-9]*' "$temporary/capped.log" | head -1 | grep -o '[0-9]*$')
[ $((10#$first_after)) -eq $((10#$last_before + 1)) ] || fail "lines lost at the rotation ($last_before, $first_after)"

echo "PASS: every stdout and stderr line stamped once (UTC, microseconds); -L renames FILE to FILE.1 and continues, nothing lost"
