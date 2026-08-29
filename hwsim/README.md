# hwsim module build

`build-hwsim.sh` obtains the source matching the running Ubuntu kernel, applies
the lab patches, and builds an out-of-tree `mac80211_hwsim.ko`. Linux 6.8 and
7.0 are supported; the optional kernel-medium evaluation is accepted only on
Linux 7.0.

Normal build and installation:

```sh
gen/hwsim/build-hwsim.sh --6ghz --install
```

This preserves the default data path: the kernel option remains disabled and
the lab starts userspace wmediumd.

An isolated VM can explicitly load the experimental kernel backend:

```sh
HWSIM_KERNEL_MEDIUM=1 gen/hwsim/build-hwsim.sh --6ghz --load
```

Rate-aware packet loss and receive timing are separate opt-ins. Their neutral
defaults preserve the Phase 1/2 signal-and-loss behavior:

```sh
HWSIM_KERNEL_MEDIUM=1 \
HWSIM_KERNEL_MEDIUM_RATE_PER=1 \
HWSIM_KERNEL_MEDIUM_NOISE_FLOOR=-91 \
HWSIM_KERNEL_MEDIUM_DELAY_US=2000 \
HWSIM_KERNEL_MEDIUM_JITTER_US=500 \
  gen/hwsim/build-hwsim.sh --6ghz --load
```

Never use `--load` while a BPI or WLAN-client container owns an hwsim PHY. For
the complete design, controls, results, and limitations, see
[the kernel-medium reference](../../doc/easymesh/reference/hwsim-kernel-medium.md).

The destructive two-radio QEMU evaluator is:

```sh
sudo gen/hwsim/tests/evaluate-medium-backends.py \
  --module gen/hwsim/build/mac80211_hwsim.ko \
  --wmediumd gen/wmediumd/wmediumd.patched \
  --duration 10 --rate 20M --output /tmp/medium-eval.json
```

Run it only in an isolated VM with the lab stopped.

The 25/55/105-radio fan-out evaluator is also destructive:

```sh
sudo gen/hwsim/tests/evaluate-medium-scale.py \
  --module gen/hwsim/build/mac80211_hwsim.ko \
  --wmediumd gen/wmediumd/wmediumd.patched \
  --output /tmp/medium-scale.json
```

The patched module permits at most 128 static radios. The default remains 32;
raising the bound does not itself provision a 50- or 100-client EasyMesh lab.
The separate 64-radio, 50-client cold-reconstruction gate has passed on both
backends. The 100-client full lab remains unaccepted; its 105-radio result is a
synthetic medium fan-out measurement only.
