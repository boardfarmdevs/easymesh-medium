# wmediumd configurator

This directory contains the scenario-language implementation described in
[the wmediumd configurator reference](../../../doc/easymesh/reference/wmediumd-configurator.md).

Python 3.8 or newer is supported so the offline compiler and tests can also run
on the rev140 build host; live inventory and execution still run inside the lab
VM that owns the LXD/hwsim topology.

The current `0.1` increment implements parsing, validation, live LXD/hwsim
inventory, frozen role binding, deterministic event-plan compilation, and live
execution through wmediumd's dedicated atomic control socket. Every generation
is read back, the captured baseline is restored on normal exit or a handled
interrupt, and ramps never restart wmediumd.

The `worlds/` front end adds deterministic 2D layouts, physical role paths,
presence intervals, directed link asymmetry, fixed-loss walls and per-band
golden timelines. It can export one backward-compatible pair projection or all
bands into the auditable `.wmd` language. Patch `0012` applies the all-band form
as frequency-qualified overrides with exact readback and restore. This creates
valid band-specific RF stimulus; the external optimizer still needs reported
target-BSSID measurements before it can make a band-steering decision.

Run directly from the source tree:

```sh
cd gen/wmediumd/configurator
python3 -m unittest discover -s tests -v
python3 -m wmdcfg.cli inventory -o /tmp/inventory.json
python3 -m wmdcfg.cli compile scenarios/two-ap-crossover.wmd \
    --inventory /tmp/inventory.json \
    --bind client=wlan-client \
    --bind ap_a=bpibroadband \
    --bind ap_b=bpiap \
    -o /tmp/two-ap-crossover.plan.json
python3 -m wmdcfg.cli status
python3 -m wmdcfg.cli run /tmp/two-ap-crossover.plan.json \
    --output-root /tmp/wmdcfg-runs

worlds/build-goldens.sh --check
python3 -m wmdcfg.cli world-export \
    worlds/golden/home-a-stationary.world.json \
    --band all -o /tmp/home-a-stationary-all.wmd
```

Every station/AP pair declared by the scenario must be initialized in its first
phase. Bindings are frozen to hwsim transmitter identities (`permanent | 0x40`)
and never follow the client's association.

RDK presents its 2.4, 5 and 6 GHz logical radios as VIFs on one hwsim PHY. The
inventory records that one permanent identity plus all three frequency
contexts. An unqualified station/AP link follows the station's band at compile
time and becomes a frequency-qualified update. Consequently frame delivery,
associated signal, and the HAL's candidate-link provider all observe the same
scenario value without affecting the other two bands.

For a two-minute visual check of live RCPI reporting, the wrapper discovers the
selected client's current serving AP, oscillates only that RF link, samples
`/api/v1/clients`, and restores the captured medium state:

```sh
./run-rcpi-monitor.sh wlan-client
```

The end-to-end policy acceptance is:

```sh
../../tests/optimizer-dynamic.sh recommend wlan-client-007 bpiap-001
../../tests/optimizer-dynamic.sh act wlan-client-007 bpiap-001
```

Keep the WebUI **Connected Clients** tab open during the run. Its Signal column
refreshes every two seconds and shows both dBm and raw RCPI. The wrapper keeps
traffic flowing to `10.0.0.1` so hwsim reports each current phase; set
`WMD_TRAFFIC_TARGET` to use a different reachable address.

The runner requires a complete EasyMesh topology and all expected WLAN clients
to be active at preflight and postflight. It checks WebUI topology/client counts
and the controller's authoritative device/radio/BSS/association counts. Each
generation obtains all client BSSID/RCPI observations with one controller query,
so observation cost does not distort a multi-client RF timeline. Run artifacts
contain the frozen plan, every applied generation and observation, health
snapshots, verified restore, and a machine-readable summary.

## Optional kernel data path

Userspace wmediumd remains the default. When the experimental hwsim kernel
medium was explicitly selected during an isolated cold start, the same compiled
event plan can use its atomic double-buffered matrix:

```sh
sudo python3 -m wmdcfg.cli status --backend kernel
sudo python3 -m wmdcfg.cli run /tmp/two-ap-crossover.plan.json --backend kernel
```

The adapter retains SNR units, generation checks, readback, and restoration.
The kernel backend implements fewer RF effects; consult
[the capability boundary](../../../doc/easymesh/reference/hwsim-kernel-medium.md)
before using it for optimizer conclusions.
