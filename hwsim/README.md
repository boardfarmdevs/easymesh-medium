# hwsim module build

The builder also installs the required namespace-safe `cfg80211.ko` companion.
See [socket ownership isolation](cfg80211/README.md) for the source pin, VM
restart requirement and bounded live regression test.

`build-hwsim.sh` first requests the source matching the running Ubuntu kernel,
falling back to the available HWE source when that version is no longer indexed.
It applies the lab patches and builds an out-of-tree `mac80211_hwsim.ko` against
the installed kernel headers. Retain the build log and module checksum when
recording release provenance. Linux 6.8 and
7.0 are supported; the optional kernel-medium evaluation is accepted only on
Linux 7.0.

Normal build and installation:

```sh
hwsim/build-hwsim.sh --6ghz --install
```

This preserves the default data path: the kernel option remains disabled and
the lab starts userspace wmediumd.

An isolated VM can explicitly load the experimental kernel backend:

```sh
HWSIM_KERNEL_MEDIUM=1 hwsim/build-hwsim.sh --6ghz --load
```

Rate-aware packet loss and receive timing are separate opt-ins. Their neutral
defaults preserve the Phase 1/2 signal-and-loss behavior:

```sh
HWSIM_KERNEL_MEDIUM=1 \
HWSIM_KERNEL_MEDIUM_RATE_PER=1 \
HWSIM_KERNEL_MEDIUM_NOISE_FLOOR=-91 \
HWSIM_KERNEL_MEDIUM_DELAY_US=2000 \
HWSIM_KERNEL_MEDIUM_JITTER_US=500 \
  hwsim/build-hwsim.sh --6ghz --load
```

Never use `--load` while a BPI or WLAN-client container owns an hwsim PHY. For
the complete design, controls, results, and limitations, see
[the kernel-medium reference](../docs/reference/kernel-medium.md).

## The transmit ring (0012, Linux 7.0)

A radio's frames at wmediumd (sent, their status not back) wait in hwsim's
pending queue. At 200 the stock driver drops the oldest down to 99, 101 frames
at once, and refuses their status when wmediumd later sends it (EINVAL). With
`pending_limit=N` the queue is a driver's transmit ring instead: at N frames the
radio's mac80211 queues stop, and its frames wait there (fair across stations,
under mac80211's queue management); at N/2 they wake. Beacons, which no queue
holds back, are kept within 2N, the oldest dropped first. A frame the medium has
not answered in `pending_timeout_ms` (default 5000), or one sent to a wmediumd
since gone or replaced, is dropped, so a ring nothing drains never holds the
queues stopped. The default, 0, keeps the stock queue.

```sh
HWSIM_PENDING_LIMIT=256 hwsim/build-hwsim.sh --6ghz --load
ethtool -S <a radio's interface> | grep -E 'd_tx_(pending|flow|dropped)'
```

`d_tx_pending` is the ring now, `d_tx_pending_max` its high-water mark,
`d_tx_flow_stops` how often the queues stopped, `d_tx_pending_expired` the frames
dropped unanswered and `d_tx_dropped` those dropped at 2N (or, without the limit,
at 200).

The ring's evaluator is destructive too (an isolated Linux 7.0 VM, no lab):

```sh
sudo hwsim/tests/evaluate-transmit-ring.py \
  --module ring/mac80211_hwsim.ko --stock-module stock/mac80211_hwsim.ko \
  --wmediumd wmediumd/build/wmediumd --output /tmp/transmit-ring.json
```

On 7.0.0-30 (10 October; two radios, eight UDP streams of 4 Mbit/s into a link
forced to 6 Mbit/s, pings alongside) the stock queue dropped 28,583 frames (283
times 101), wmediumd's statuses for 27,359 of them were refused and 80 % of the
pings were lost. A ring of 64 dropped none, refused none, stopped its queues 154
times and lost no ping; the excess UDP was dropped in mac80211's queues instead.
With wmediumd killed under the load a ping went through after 0.09 s (48 frames
expired); with it frozen for 3 s, 119 frames expired and a ping went through
0.24 s after it resumed. Neither module warned in the kernel log.

The destructive two-radio QEMU evaluator is:

```sh
sudo hwsim/tests/evaluate-medium-backends.py \
  --module hwsim/build/mac80211_hwsim.ko \
  --wmediumd wmediumd/build/wmediumd \
  --duration 10 --rate 20M --output /tmp/medium-eval.json
```

Run it only in an isolated VM with the lab stopped.

The 25/55/105-radio fan-out evaluator is also destructive:

```sh
sudo hwsim/tests/evaluate-medium-scale.py \
  --module hwsim/build/mac80211_hwsim.ko \
  --wmediumd wmediumd/build/wmediumd \
  --output /tmp/medium-scale.json
```

The patched module permits at most 128 static radios. The default remains 32;
raising the bound does not itself provision a 50- or 100-client EasyMesh lab.
The separate 64-radio, 50-client cold-reconstruction gate has passed on both
backends. The 100-client full lab remains unaccepted; its 105-radio result is a
synthetic medium fan-out measurement only.
