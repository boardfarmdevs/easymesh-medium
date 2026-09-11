# wmediumd: operation, control and simulation model

[Subsystem index](README.md)

## Purpose and current conclusion

wmediumd is the RF-medium process between Linux `mac80211_hwsim` radios. It
does not emulate an AP, station, EasyMesh agent or controller. Those are real
processes in the containers. wmediumd receives each simulated 802.11
transmission from the kernel, decides when and whether each receiver gets it,
injects successful frames back into hwsim, and reports transmit status to the
sender.

The current lab uses one patched wmediumd process for all active radios,
an SNR model loaded from a generated startup file, and a dedicated control
socket for atomic in-memory SNR changes. A startup configuration file is still
required. The socket replaces per-phase configuration-file rewrites, not the
initial radio inventory or model selection.

The current daemon also exposes a minimal multi-client `-R` metrics/readback
socket for the hwsim HAL and a separate host-only `-O` telemetry socket for the
Go wmediumd Console. Neither observer endpoint changes the medium.

```text
 EasyMesh and WLAN processes in LXD containers
 hostapd / OneWifi / em_agent / wpa_supplicant / applications
                     |
                     | normal Linux Wi-Fi operations and frames
                     v
          mac80211 + mac80211_hwsim (host kernel)
                     |
                     | MAC80211_HWSIM generic netlink
                     | TX frame, radio identity, frequency, rate, cookie
                     v
       +-----------------------------------------------+
       | one host wmediumd.patched process             |
       |                                               |
       | radio/VIF lookup -> link model -> PER choice  |
       | -> retry/airtime/EDCA scheduler -> delivery   |
       +-----------------------------------------------+
          |                                      |
          | RX frame + signal                    | TX status + ACK result
          +-------------------> kernel <----------+

 startup plane                         live scenario plane
 /run/.../wmediumd.cfg                 /run/wmediumd-control.sock
 IDs, model, initial matrix            atomic directed SNR generations

 observer plane
 /run/.../observer/telemetry.sock -> unprivileged Go wmediumd Console
                                    -> UI/REST/WebSocket/Prometheus
```

## What it can simulate

The pinned engine has more features than the supported lab path. The status in
this table prevents an upstream capability from being mistaken for a supported
lab feature.

| Capability | How it works | Lab status |
| --- | --- | --- |
| Perfect medium | Delivers between configured radios without an explicit loss model | Upstream available; not used |
| Fixed link loss | `prob` model assigns a frame-error probability per directed radio pair | Upstream available; not lab-validated |
| SNR-dependent loss | `snr` model converts SNR, rate and frame length into packet error probability | Supported and used |
| Received signal | Successful RX frames and TX status carry `signal = SNR - 91 dBm` before applicable interference adjustment | Supported |
| Asymmetric links | Both directions can have different matrix values | Supported by file and socket |
| Rate fallback and retries | Uses the hwsim multi-rate retry series, modeled loss and ACK result | Supported, with rate-model limits below |
| Airtime and contention delay | Models PHY airtime, DIFS/SIFS, ACK time, retry backoff and four 802.11 access categories | Supported |
| Independent channels | Schedules different center frequencies independently and suppresses off-channel ACK/delivery | Patched, supported, and used |
| Same-frequency interference | Optional collision/interference accounting from concurrent airtime | Patched for per-frequency buckets; disabled in generated baseline |
| Random fading | Adds pseudo-normal variation scaled by `fading_coefficient` | Upstream available; not used |
| Geometry/path loss | Derives SNR from coordinates, transmit power and a free-space, log-distance or ITU model | Upstream available; not used by the configurator |
| Constant movement | Adds each configured direction vector to its position every three seconds and recalculates path loss | Upstream available; not used |
| External PER table | `-x FILE` replaces the built-in SNR-to-PER calculation | Available; not used |
| Packet capture | `-p FILE` writes scheduled traffic as pcapng, including modeled ACKs | Available; not enabled by the launcher |
| Runtime SNR updates | Local `-C` socket applies validated, atomic matrix generations without restart | Added, supported and used |
| Frequency-qualified SNR | Exact-frequency directed overrides take precedence over radio-pair defaults | Added, supported and used |
| vhost-user and time control | Alternative frame transport and externally controlled scheduler time | Upstream available; not used by the LXD lab |
| Legacy API socket | Relays hwsim/netlink frames and TX-start notifications to API clients | Upstream available; it is not an SNR configuration API |

The SNR model is more than a displayed RSSI override. Its loss decision affects
management, data and multicast frames, ACK status, retries, scanning, rate
control and the WLAN protocols above it. That is why it is preferable to
falsifying one RSSI field in a client or controller.

## What it does not simulate

wmediumd is intentionally below the Wi-Fi and EasyMesh state machines. It does
not know that a radio is a controller, extender, fronthaul AP, backhaul or
client. It does not create SSIDs, associate a station, send an EasyMesh steer,
select a policy, age a topology node or declare a test successful.

The current build also has these important physical-model boundaries:

- SNR defaults are keyed by source and destination **hwsim radio**, not by
  SSID. Exact-frequency overrides allow different values for concurrent
  2.4, 5 and 6 GHz VAPs. Learned VIF identities resolve to their radio owners;
  a channel change needs corresponding override rebinding or uses the pair default.
- The multichannel patches use exact center-frequency equality. They isolate
  different channels; they do not model spectral masks, partial overlap or
  adjacent-channel interference.
- The built-in PER curves are legacy OFDM/CCK approximations. The Linux 7 patch
  maps 20 MHz, long-GI HT and VHT MCS values to the nearest legacy OFDM curve.
  There is no native HE, EHT, channel-width, guard-interval, spatial-stream,
  beamforming or MLO error model.
- It has transmission/queue delay, but no general scenario primitive for
  arbitrary propagation delay, jitter, bandwidth caps or burst-loss models.
- Low SNR makes an extender unreachable over RF; it does not delete the
  extender object. Whether and when the controller removes it from topology is
  controller liveness/aging behavior.
- wmediumd has no feedback from the EasyMesh topology. Association changes are
  effects to observe, not triggers that rewrite the RF matrix.

These limits permit comparative signal-driven steering experiments when the
same abstraction is used for every policy. They do not establish calibrated
capacity or congestion behavior. The [virtual RF assessment](virtual-rf-assessment.md)
details missing surveys, idealized candidate measurements, fixed RX-rate
metadata, same-frequency contention scheduling and the implementation roadmap.

## How wmediumd knows which devices exist

There are two distinct discovery mechanisms: static radio registration and
runtime virtual-interface learning.

### 1. The lab generator discovers active radios

`gen/wmediumd/gen-config.sh` queries LXD for running lab containers named:

```text
mesh nodes     bpibroadband, bpiap, bpiap-NNN
WLAN clients   wlan-client, wlan-client-NNN
```

For each container it reads the permanent wiphy MAC from
`/sys/class/ieee80211/*/macaddress`. The visible permanent address is normally
`02:...`, but hwsim identifies the transmitting radio in
`HWSIM_ATTR_ADDR_TRANSMITTER` with bit `0x40` set in the first octet. The
generator therefore records `permanent | 0x40`, normally `42:...`.

```text
container sysfs       02:00:00:00:0e:00
                              byte 0 OR 0x40
wmediumd radio ID     42:00:00:00:0e:00
```

Using `02:...` in `ifaces.ids` causes sender lookup failures and can silently
lose frames from secondary VAPs. The generator has a guard that rejects any ID
without the `0x40` bit.

Only active container radios are included. Free pool radios remain in the host
namespace, are omitted from the matrix and have their `virt-wlan*` interface
set down. Including unused, channel-less pool radios causes unnecessary
multicast clones and can starve useful delivery.

wmediumd itself does **not** query LXD, sysfs or `iw`. It only loads the ordered
ID list produced by the generator. Matrix link indices refer to this exact
order.

### 2. The frame path learns VAP ownership and frequency

One configured hwsim radio can create many runtime interface addresses: private
and IoT fronthaul BSSIDs, mesh-backhaul BSSIDs and station VIFs. They can differ
from the `42:...` hardware identity and can change after deployment.

For every transmitted frame, the patched daemon observes:

- the `42:...` hwsim transmitter identity from netlink;
- the 802.11 transmitter address inside the frame; and
- `HWSIM_ATTR_FREQ` from the kernel.

It learns a mapping of `VIF MAC -> owning configured radio + current
frequency`. hwsim `ADD_MAC_ADDR`/`DEL_MAC_ADDR` messages remain receive-filter
information; they do not override transmit-learned ownership. This matters
when a STA roams or a single phy carries several concurrent VAPs.

```text
static, restart-bound                 learned while frames flow
42:radio A  ----------------------->  private BSSID -> radio A @ 5180
                                      IoT BSSID     -> radio A @ 2437
                                      backhaul BSSID-> radio A @ 5975

42:client X ----------------------->  STA VIF       -> client X @ 5180
```

A BSSID change, new VAP or client association therefore does not require a
configuration rewrite if the underlying configured radio set is unchanged. A
new or removed container radio does require a generated inventory refresh and
wmediumd restart.

## What happens to one frame

The normal netlink path is:

```text
1  mac80211 submits an hwsim transmission
2  hwsim sends HWSIM_CMD_FRAME to the registered wmediumd
3  wmediumd resolves the 42: transmitter and learns its VIF/frequency
4  destination VIF ownership selects a receiver for unicast
5  directed source->receiver matrix SNR is read
6  optional same-frequency interference and fading adjust effective SNR
7  SNR + rate + frame length, or fixed probability/PER table, yields PER
8  a random trial chooses success for each retry/rate attempt
9  EDCA queue, airtime, ACK and backoff determine scheduled completion
10 successful unicast is delivered to its owner; multicast is evaluated and
   cloned independently to each frequency-eligible radio
11 wmediumd injects HWSIM_CMD_FRAME with frequency and signal into receivers
12 wmediumd returns HWSIM_CMD_TX_INFO_FRAME with ACK/no-ACK and retry status
13 mac80211, hostapd, supplicant, OneWifi and EasyMesh react normally
```

The scheduler has per-radio queues for background, best effort, video and
voice traffic. Management traffic uses voice priority; non-QoS data uses best
effort; QoS data maps from its 802.11 priority. The current patch finds queue tails
only at the same center frequency, so beacons on 2.4 or 6 GHz cannot serialize
5 GHz traffic.

For the SNR model, the built-in noise floor is `-91 dBm`:

```text
configured/effective SNR 40 dB -> reported signal about -51 dBm
configured/effective SNR 10 dB -> reported signal about -81 dBm
```

This is a model value, not a calibrated hardware RSSI. Multicast below the
`-90 dBm` carrier-sense threshold is not delivered. Unicast success is governed
by the PER/retry path and receiver frequency eligibility.

## Static startup configuration

### What remains required

The launcher always starts wmediumd with:

```sh
wmediumd.patched \
  -c /run/meta-cmf-wmediumd/wmediumd.cfg \
  -C /run/wmediumd-control.sock
```

`-c FILE` is mandatory in this build. The file supplies:

1. the complete ordered hwsim radio ID set;
2. matrix dimensions;
3. model selection;
4. default values for unspecified pairs; and
5. initial directed link overrides.

The accepted launcher generates the file rather than asking an operator to
maintain radio indices:

```sh
cd gen
SNR=40 ./wmediumd/wmediumd-up.sh up
sudo sed -n '1,220p' /run/meta-cmf-wmediumd/wmediumd.cfg
```

Its normal shape is:

```text
ifaces : {
  ids = [
    "42:00:00:00:01:00",
    "42:00:00:00:02:00"
  ];
};
model : {
  type = "snr";
  default_snr = 40;
  links = (
    (0, 1, 50),
    (1, 0, 50)
  );
};
```

The generator establishes a strong baseline, not a movement scenario:

- controller-to-extender pairs are 50 dB;
- extender-to-extender pairs are 45 dB;
- each associated client and its current home mesh node are 50 dB; and
- every unspecified pair gets `SNR`, normally 40 dB.

The current configuration explicitly writes both directions. In the parser, a
link specified in only one direction is mirrored automatically. Specifying both
directions preserves asymmetry. `default_snr` and live socket values are
validated in `[-20, 60]` dB. The parser also accepts legacy SNR links under
`ifaces.links`; the generator uses the clearer `model.links` location.

### Other upstream model files

The same mandatory file can select other upstream models, although they are
not part of current lab acceptance.

Fixed loss probability:

```text
model : {
  type = "prob";
  default_prob = 1.0;
  links = ((0, 1, 0.0));
};
```

Geometry-derived path loss:

```text
model : {
  type = "path_loss";
  positions  = ((0.0, 0.0), (10.0, 0.0));
  directions = ((0.0, 0.0), (1.0, 0.0));
  tx_powers  = (15.0, 15.0);
  model_name = "log_distance";
  path_loss_exp = 3.5;
  xg = 0.0;
  fading_coefficient = 0;
};
```

`directions` is optional. When present, each vector is added to its station
position every three seconds. `model_name` may be `log_distance`, `free_space`
or `itu`; each has its own required parameters. Setting
`ifaces.enable_interference` to `true` enables interference accounting. These
inputs cannot currently be changed by the dedicated scenario socket.

An optional `-x PER_FILE` provides rows keyed by signal level followed by one
probability per built-in rate. It cannot be combined with the `prob` model. The
accepted launcher does not pass `-x`.

## Dynamic control socket

The current patch adds `-C /run/wmediumd-control.sock`. This is a Unix
`SOCK_SEQPACKET` endpoint, owned `root:lxd` and mode `0660`. It uses protocol
version 1, magic `WMDC`, network-byte-order fixed-width records and a 64 KiB
maximum message.

| Operation | Purpose |
| --- | --- |
| `HELLO` | Return daemon instance ID, generation, capabilities and matrix size |
| `STATUS` | Return the same current control state |
| `APPLY` | Apply one or more directed `(source MAC, destination MAC, SNR)` updates |
| `GET_LINK` | Read one directed matrix cell |
| `DUMP_LINKS` | Read all non-self directed matrix cells |
| `APPLY_FREQUENCY` | Atomically set or clear `(source, destination, frequency MHz, SNR)` overrides |
| `GET_FREQUENCY` | Read effective SNR and whether an explicit override exists |
| `DUMP_FREQUENCIES` | Read all explicit frequency overrides |

The advertised capabilities are radio-pair SNR, atomic generations, readback
and full dump, plus frequency-qualified SNR in patch `0012`. For `N` configured
stations, the base matrix contains `N x N` cells and its dump returns the
`N x (N - 1)` non-self directed links. The frequency table is sparse and
preallocated for up to four contexts per pair within the 64 KiB message limit.
Only one client can remain connected to the writable `-C` endpoint. The
accepted 25-radio topology dumps 600 base links and reports a maximum atomic
update capacity of 2,500 records.

`APPLY` must request exactly `current_generation + 1`. Before changing any
cell, wmediumd validates the entire packet, known radio identities, number of
updates and SNR range. If one update is invalid, none is applied. On success it
mutates the live matrix and advances the generation. This makes a crossover in
which AP-A weakens while AP-B strengthens one visible medium transition rather
than two partially applied writes.

`APPLY_FREQUENCY` shares the generation counter. A set entry overrides the base
pair only for an hwsim frame at the exact keyed frequency; other frequencies
use the base pair. A clear entry removes the override. `GET_FREQUENCY` returns
both the effective value and an override-presence flag, so restoration can
remove a temporary override rather than leave a numerically equal stale entry.

The socket does not:

- add or remove radios;
- change the model, frequency, VIF map, coordinates or transmit power;
- write the startup file;
- persist values across a daemon restart; or
- restore values automatically after process or host failure.

The random 128-bit instance ID and generation returning to zero expose a daemon
restart. The Python runner captures pair state with `DUMP_LINKS` and frequency
state with `GET_FREQUENCY`, applies each generation, reads it back and restores
both values and original override presence in a `finally` path.

The older upstream `-a` API socket is a frame-relay/control-notification
interface for additional wmediumd clients. Its `SET_CONTROL` flags request all
frames or TX-start notifications; it does not edit the SNR matrix. Scenario
tools must use `-C`, not `-a`.

### Read-only metrics and observer sockets

Patch `0013` adds `-R`, a multi-client read-only form of the versioned control
protocol. It permits identity/status, pair/frequency readback and bounded dumps
but rejects both APPLY operations. The BPI hwsim HAL uses this socket for
candidate-link metric lookup without receiving scenario-write authority.

Patch `0014` adds `-O`, retaining the same immutable readback and adding paged
bounded daemon, radio/frequency, active-link, VIF-ownership and event-ring
telemetry. It counts frame classes, modeled attempts/retries, ACK/no-ACK,
receiver injection, explicit drop reasons, multicast fan-out, queue delay and
netlink health without copying payloads. A slow or absent reader cannot block
the single wmediumd frame loop.

The separate Go wmediumd Console consumes `-O`; see
[wmediumd Console](console.md). Its managed service is
read-only. Explicit typed-control mode opens `-C` separately and exposes only
generation-checked pair/frequency set, clear and one-step undo operations.

## Operator workflow

### Start, stop and inspect the medium

Run these on the host or VM that owns the LXD/hwsim lab:

```sh
cd <meta-cmf-bananapi-vcpe-checkout>/gen

SNR=40 ./wmediumd/wmediumd-up.sh up
./wmediumd/wmediumd-up.sh status
sudo stat /run/wmediumd-control.sock
sudo tail -f /run/meta-cmf-wmediumd/wmediumd.log

./wmediumd/wmediumd-up.sh down
```

`up` is a **static inventory refresh**. It stops the existing lab daemon,
quiesces unused pool interfaces, regenerates the file, runs the internal
self-test, starts wmediumd, checks registration and exposes the socket. Use it
after adding or removing lab radios, not between scenario phases.

`down` stops wmediumd. hwsim then falls back to its built-in forwarding medium,
so connectivity can remain but the configured RF constraints are gone. A
running WLAN is therefore not proof that wmediumd is active.

Only one daemon can register with the hwsim instance. A second registration is
rejected as busy. Stock hwsim also rejects registration when configured for
multiple channels; the lab's kernel-side
`0001-mac80211_hwsim-allow-multichannel-wmediumd.patch` permits that
registration and retains per-frame frequency transport.

### Run a dynamic scenario

Use the Python client rather than encoding binary socket frames manually:

```sh
cd gen/wmediumd/configurator

python3 -m wmdcfg.cli inventory -o /tmp/inventory.json
python3 -m wmdcfg.cli status
python3 -m wmdcfg.cli validate scenarios/two-ap-crossover.wmd
python3 -m wmdcfg.cli compile scenarios/two-ap-crossover.wmd \
  --inventory /tmp/inventory.json \
  --bind client=wlan-client \
  --bind ap_a=bpibroadband \
  --bind ap_b=bpiap \
  -o /tmp/crossover.plan.json
python3 -m wmdcfg.cli run /tmp/crossover.plan.json \
  --output-root /tmp/wmdcfg-runs
```

The `.wmd` source and compiled `.plan.json` are inputs to `wmdcfg`; wmediumd
does not read either format. Compilation freezes semantic roles to the
`42:...` radio IDs. A roam does not swap these bindings or make the link
gradient follow the association.

For special tests that need more control than language version 1, use
`wmdcfg.actuator.ControlClient` as the extender-outage and client-carousel
tests do. They still use the same generation, readback and restore contract.

## Files and runtime state

| Path or artifact | Required? | Owner and lifetime |
| --- | --- | --- |
| `gen/wmediumd/wmediumd.patched` | Yes, unless rebuilt | Proven patched daemon binary committed with the lab |
| `gen/wmediumd/patches/*.patch` | Required to rebuild | Fourteen-patch delta over pinned upstream |
| `/run/meta-cmf-wmediumd/wmediumd.cfg` | Yes at every start | Generated static radio inventory and initial model |
| `/run/wmediumd-control.sock` | Yes for dynamic scenarios | Runtime socket; disappears with daemon |
| `/run/meta-cmf-wmediumd/metrics/control.sock` | Yes for HAL candidate metrics | Multi-client minimal read-only protocol (`-R`) |
| `/run/meta-cmf-wmediumd/observer/telemetry.sock` | Yes for the Console | Host-only paged read-only telemetry (`-O`) |
| `/run/meta-cmf-wmediumd/identity-inventory.json` | Console identity overlay | Atomically generated radio label/owner map |
| `/run/meta-cmf-wmediumd/wmediumd-binary.sha256` | Console provenance | PID-qualified live-binary hash manifest |
| `/run/meta-cmf-wmediumd/wmediumd.pid` | Lifecycle state | Launcher-created runtime PID |
| `/run/meta-cmf-wmediumd/wmediumd.log` | Diagnostic state | Daemon stdout/stderr for current launch |
| scenario `.wmd` | Only for configurator use | Human-authored scenario source, not a daemon config |
| compiled `.plan.json` | Only for configurator use | Frozen bindings and timed generations |
| `/tmp/wmdcfg-runs/...` | Required evidence for a run | Apply/readback, observations, health and restore result |
| optional PER file | Only with manual `-x` | Alternative SNR/signal-to-PER table |
| optional pcapng | Only with manual `-p` | Scheduled frame capture |

Editing `/run/meta-cmf-wmediumd/wmediumd.cfg` while the daemon runs has no
effect. Restarting to load it discards live socket changes and creates a new
control instance. Conversely, socket updates change memory only and do not
modify the file.

## Current multichannel patch behavior

The lab pins upstream commit
`717e5d7fcc23eecbc8e32bd897a8fd4b1e3ba640` (the source reports v0.3.1) and
applies fourteen patches in `gen/wmediumd/patches/`:

| Patch | Operational effect |
| --- | --- |
| `0001` | Per-frequency interference buckets, off-channel ACK suppression, VIF/frequency learning foundation and internal tests |
| `0002` | Transmit-learned VIF owner takes precedence over stale receive filters |
| `0003` | Removes synchronous per-frame ACK debug-file writes |
| `0004` | Gives each center frequency an independent scheduler tail |
| `0005` | Parses Linux 7 HT/VHT rate flags and maps them to usable PER curves |
| `0006` | Sends multicast only to radios on the learned matching frequency |
| `0007` | Requests a 4 MiB netlink receive buffer to reduce burst loss |
| `0008` | Adds the atomic scenario-control socket |
| `0009` | Makes generated `model.default_snr` effective and validates its range |
| `0010` | Requires transmit-learned receive-frequency evidence and rechecks directed delivery after scan/channel changes |
| `0011` | Distinguishes a tracked clone rejected during a transient radio receive state from an untracked netlink/protocol error |
| `0012` | Adds frequency-qualified SNR set/clear, readback, sparse dump and pair fallback |
| `0013` | Adds the multi-client read-only `-R` pair/frequency metrics endpoint used by the hwsim HAL |
| `0014` | Adds bounded packet/outcome, radio/frequency, active-link, VIF and event telemetry on host-only `-O` |

The launcher executes `wmediumd.patched -T` before every start. That suite
checks multichannel interference isolation, frequency override/fallback,
ownership/filter invariants, frequency-filtered multicast, independent
scheduling, Linux 7 rate mapping, bounded telemetry and the related regression
cases.

The current patch-`0014` prebuilt binary has SHA-256
`f8fb9d668c8bfc1964728f8db620254817ff4bce3de3493f7e5166dcb576641f`.

Interference accounting is not enabled by the current generated config. If it
is enabled manually, the patch keeps exact-frequency buckets and writes bounded
development diagnostics to `/tmp/mc_intf.log`; VIF ownership changes can appear
in `/tmp/mc_owner.log`. These are implementation diagnostics, not scenario
result artifacts.

## Health checks and failure interpretation

```sh
# Process, current log tail and socket
gen/wmediumd/wmediumd-up.sh status
sudo test -S /run/wmediumd-control.sock

# Control protocol and configured station count
cd gen/wmediumd/configurator
python3 -m wmdcfg.cli status

# Static radio identities and matrix
sudo sed -n '1,240p' /run/meta-cmf-wmediumd/wmediumd.cfg

# Sender identity regression
gen/wmediumd/check-wmediumd-ids.sh \
  /run/meta-cmf-wmediumd/wmediumd.log

# Patched-binary regression suite
sudo gen/wmediumd/wmediumd.patched -T
```

| Symptom | Likely meaning |
| --- | --- |
| `Operation not supported` at registration | Stock hwsim multichannel guard is still active |
| `Device or resource busy` | Another wmediumd owns hwsim registration |
| `Unable to find sender station` | Static `ifaces.ids` is stale/wrong, commonly `02:` instead of `42:` |
| Socket absent while PID exists | Wrong/stale binary, startup failure or daemon without `-C` |
| Scenario reports unknown identity | Plan was compiled for another deployment, or the radio inventory changed |
| Generation error | Another writer advanced state or the client used a stale generation |
| WLAN works after `down` | Expected hwsim fallback; the experiment is no longer using modeled RF |
| Topology does not remove an RF-isolated extender within the accepted bound | liveness publication/probe regression; preserve the outage artifact and IEEE1905/controller logs |

Command-2 `EINVAL` for a clone tracked through outbound-netlink sequence
correlation is classified as RF loss during a transient receive state. Clones
are not created when current receive-frequency evidence is absent or stale.
Untracked command-2 errors and every other command/error remain visible; an
increase in those diagnostics is a regression.

## Source and design references

- `gen/wmediumd/build-wmediumd.sh` pins, verifies, patches and builds upstream.
- `gen/wmediumd/gen-config.sh` defines active-radio discovery and the baseline.
- `gen/wmediumd/wmediumd-up.sh` owns the daemon lifecycle and runtime paths.
- `gen/wmediumd/configurator/wmdcfg/actuator.py` implements the socket client.
- [wmediumd configurator](configurator.md) defines the supported scenario language
  and restoration contract.
- [extender outage](../../experiments/README.md) tests RF isolation
  and recovery without stopping a container.
- [client carousel](../../experiments/README.md) exercises repeated
  client movement visible in the live topology.
- [client scale](../../experiments/README.md) defines the 20/50/100-client profiles,
  pair-state growth, measured wmediumd cost and overload gates.
- [patch set](../platform/patch-set.md) places the wmediumd and kernel patches in the
  complete component ownership model.
