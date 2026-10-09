#!/usr/bin/env bash
# hwsim's refusals (patch 0039, restoring 0011's rule that 0022 dropped): EINVAL for a cloned
# frame (command 2) this process sent and tracked is RF delivery loss (a radio idle, scanning or
# between channels): counted as netlink_clone_einval (transient) and logged at debug level.
# Anything else stays an error (other errors, error level): an untracked sequence, another error
# number, a refused TX status (command 3). A clone's record outlives 65535 later clones.
# Compiles the patched wmediumd.c's own tracker and nl_err_cb against libnl; no kernel, no RF.
#   bash test-netlink-rejection-class.sh PATCHED_SOURCE/wmediumd.c
set -euo pipefail
source_file=${1:?usage: bash test-netlink-rejection-class.sh PATCHED_SOURCE/wmediumd.c}
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT

python3 - "$source_file" "$temporary/production.c" <<'PYEOF'
import sys
source = open(sys.argv[1]).read()
tracker = source[source.index("#define NL_CLONED_FRAME_TRACK_SLOTS"):
                 source.index("static struct mc_vif_state *mc_vif_find(")]
start = source.index("int nl_err_cb(struct sockaddr_nl")
callback = source[start:source.index("\n}\n", start) + 3]
open(sys.argv[2], "w").write(tracker + "\n" + callback)
PYEOF

cat > "$temporary/driver.c" <<'CEOF'
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <syslog.h>
#include <linux/genetlink.h>
#include <netlink/netlink.h>
#include <netlink/msg.h>
typedef uint8_t u8;
typedef uint32_t u32;
enum { HWSIM_CMD_FRAME = 2, HWSIM_CMD_TX_INFO_FRAME = 3 };
struct station { int index; };
struct wmediumd { int unused; };
static struct { int calls; struct station *source, *destination; u32 frequency; int error; bool transient; } seen;
static int logged_level = -1;
void wmd_telemetry_netlink_rejection(struct wmediumd *ctx, struct station *source,
				     struct station *destination, u32 frequency_mhz, int error, bool transient)
{
	(void)ctx;
	seen.calls++;
	seen.source = source;
	seen.destination = destination;
	seen.frequency = frequency_mhz;
	seen.error = error;
	seen.transient = transient;
}
int w_logf(struct wmediumd *ctx, u8 level, const char *format, ...)
{
	(void)ctx; (void)format;
	logged_level = level;
	return 0;
}
int w_flogf(struct wmediumd *ctx, u8 level, FILE *stream, const char *format, ...)
{
	(void)ctx; (void)stream; (void)format;
	logged_level = level;
	return 0;
}
int nl_err_cb(struct sockaddr_nl *nla, struct nlmsgerr *nlerr, void *arg);
#include "production.c"

static struct station source = { 1 }, destination = { 2 };

static void track(u32 seq)
{
	struct nl_msg *msg = nlmsg_alloc();

	assert(msg);
	nlmsg_hdr(msg)->nlmsg_seq = seq;
	nl_track_cloned_frame(msg, &source, &destination, 2437);
	nlmsg_free(msg);
}

static void reject(u32 seq, u8 cmd, int error)
{
	struct { struct nlmsgerr err; struct genlmsghdr genl; } reply;
	struct wmediumd ctx = { 0 };

	memset(&reply, 0, sizeof(reply));
	memset(&seen, 0, sizeof(seen));
	logged_level = -1;
	reply.err.error = error;
	reply.err.msg.nlmsg_seq = seq;
	reply.genl.cmd = cmd;
	assert(nl_err_cb(NULL, &reply.err, &ctx) == NL_SKIP);
	assert(seen.calls == 1 && seen.error == error);
}

int main(void)
{
	track(1000);
	reject(1000, HWSIM_CMD_FRAME, -EINVAL);
	assert(seen.transient && logged_level == LOG_DEBUG);
	assert(seen.source == &source && seen.destination == &destination && seen.frequency == 2437);

	reject(1001, HWSIM_CMD_FRAME, -EINVAL);    /* not ours */
	assert(!seen.transient && logged_level == LOG_ERR && !seen.source);
	reject(1000, HWSIM_CMD_FRAME, -ENOMEM);    /* another error */
	assert(!seen.transient && logged_level == LOG_ERR && seen.source == &source);
	reject(1000, HWSIM_CMD_TX_INFO_FRAME, -EINVAL);    /* a refused TX status */
	assert(!seen.transient && logged_level == LOG_ERR);
	reject(0, HWSIM_CMD_FRAME, -EINVAL);    /* no sequence */
	assert(!seen.transient && logged_level == LOG_ERR);

	/* the record outlives 65535 later clones, not 65536 */
	track(5000);
	for (u32 seq = 5001; seq < 5000 + 65536; seq++)
		track(seq);
	reject(5000, HWSIM_CMD_FRAME, -EINVAL);
	assert(seen.transient);
	track(5000 + 65536);
	reject(5000, HWSIM_CMD_FRAME, -EINVAL);
	assert(!seen.transient && logged_level == LOG_ERR);
	return 0;
}
CEOF
# shellcheck disable=SC2046 # pkg-config's flags are words
"${CC:-cc}" -std=gnu11 -Wall -Wextra -Werror -Wno-unused-parameter -I "$temporary" "$temporary/driver.c" -o "$temporary/driver" \
    $(pkg-config --cflags --libs libnl-3.0 libnl-genl-3.0)
"$temporary/driver"
echo "PASS: a tracked clone's EINVAL is transient at debug level; untracked, other errors and refused TX status stay errors; 65536 records"
