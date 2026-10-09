# wmediumd focused transport tests

The transport tests compile full functions extracted from the supplied patched
`wmediumd.c`, using the installed libnl rather than replacing its send/receive
parser. Prerequisites: Python 3, a C compiler, `pkg-config`, and libnl development
headers/libraries. Build the pinned source with `wmediumd/build-wmediumd.sh`.

From the repository root, choosing an unused evidence directory:

```sh
record=$(mktemp -d)
source=wmediumd/src/wmediumd/wmediumd.c    # the patched source the build leaves
python3 wmediumd/tests/test-netlink-ack.py \
  --source "$source" --output "$record/ack.json"
python3 wmediumd/tests/test-netlink-receive.py \
  --source "$source" --output "$record/receive.json"
cc -std=gnu11 -Wall -Wextra -Werror \
  wmediumd/tests/test-netlink-kernel-ack.c -o "$record/kernel-ack"
"$record/kernel-ack"
wmediumd/build/wmediumd -T
```

- ACK test: 19 checks, including unchanged commands/payloads, automatic sequence
  assignment, absence of redundant success ACK requests, and negative-error
  dispatch. Socket connection/send operations are stubbed; no RF traffic.
- Receive test: five cases with a blocking local socketpair and real libnl.
  Non-multipart messages return without any success ACK; multipart messages
  finish on DONE. A two-second alarm bounds an unexpected receive wait.
- Kernel ACK test: four read-only generic-netlink control-family queries. It
  checks real success/error responses with and without ACK requests, without
  hwsim access, family auto-loading, or configuration changes.

Netlink success ACKs are administrative replies, not 802.11 ACKs. Disabling
automatic ACKs also disables libnl's implicit strict sequence check; explicit
sequence numbers remain available for correlating negative replies. The
asynchronous radio parser is unchanged.

`test-frequency-override-capacity.sh` starts the built daemon without radios
(110 vhost-user stations) and applies 3,400 frequency overrides, more than one
64-KiB control frame, as consecutive generations through the configurator's
client; it reads them back, pages the dump and clears one frequency of a pair
(patch 0035: overrides indexed per radio pair). The previous daemon rejects it.

`test-log-stamps.sh PATCHED_SOURCE/wmediumd.c` compiles the daemon's own log code
(patch 0038) with a driver: every stdout and stderr line starts with its UTC time, a
line printed in parts is stamped once, and with `-L` the log on a file is renamed to
`FILE.1` past the limit and continued, nothing lost between them. `wmediumd-up.sh`
passes `-L` (`WMEDIUMD_LOG_MAX_BYTES`, 16 MiB) and keeps the previous start's log as
`wmediumd.log.prev`.

`test-netlink-rejection-class.sh PATCHED_SOURCE/wmediumd.c` compiles the clone tracker
and `nl_err_cb` against libnl (patch 0039): hwsim's `EINVAL` for a cloned frame this
process sent and tracked is counted as `netlink_clone_einval` and logged at debug level;
an untracked sequence, another error and a refused TX status (command 3) stay errors
(`netlink_other_errors`, error level); a clone's record outlives 65535 later clones.

These tests do not qualify a live lab. A daemon replacement loses learned
medium state. Native health, complete client traffic coverage, root-proof
continuity, and kernel receive-drop deltas still require runtime evidence;
zero netlink drops alone is insufficient.
