# Virtual RF assessment and implementation roadmap

[Radio reference](README.md) · [Neighbor-room design](../proposals/neighbor-rooms/design.md)

**Status: Phases 0–2 checkpointed; Phase 3 implemented with qualification gates still open.**
See [operation, supported profile and acceptance](#124-implemented-phases-12-survey-and-native-bss-load).
The supported model remains legacy-rate, 20 MHz. The Phase 3 visibility profile
is opt-in and conservative, not calibrated physical capacity or full DCF.
This shared RDK/prpl assessment targets `codex/0908-clean`. Keep both repository
copies synchronized, not separate backlogs.

Evidence extends through 2026-09-11 Pacific / 2026-09-12 UTC. Phases 1–2 deploy
the module, daemon and native providers, testing fixed fields, traffic, retunes,
failure and recovery. No soak or physical-capacity qualification was run.

## Navigation

- [Conclusions](#1-conclusions)
- [Evidence and deployed architecture](#2-evidence-and-deployed-architecture)
- [Available RF attributes](#3-available-rf-attributes)
- [Survey/BSS Load operation](#124-implemented-phases-12-survey-and-native-bss-load)
- [Phase 3 changes, qualification and remaining gates](#125-phase-3-qualified-model-and-open-gates)
- [Important implementation gaps](#4-important-implementation-gaps)
- [Required measurement contract](#5-required-measurement-contract)
- [Common implementation work](#6-common-implementation-work)
- [RDK implementation work](#7-rdk-implementation-work)
- [prpl implementation work](#8-prpl-implementation-work)
- [Optimizer and viewer integration](#9-optimizer-and-viewer-integration)
- [Phased delivery](#10-phased-delivery)
- [Correctness and performance qualification](#11-correctness-and-performance-qualification)
- [Reproducing the audit and maintaining this document](#12-reproducing-the-audit-and-maintaining-this-document)

## 1. Conclusions

The labs run real AP, station, security and EasyMesh software with simulated
frame delivery. They are **not calibrated RF-capacity or congestion
simulators**. Steering success does not qualify utilization, airtime sharing,
PHY throughput or measurement availability.

The highest-value findings are:

1. Directed, frequency-qualified SNR control already exists in both systems.
   It affects delivery, reported signal and loss. It is not necessary to
   invent this capability again.
2. A context-qualified hwsim survey cache now replaces dummy scan records
   when enabled. A bounded bridge publishes modeled occupancy through native
   nl80211, both HALs, BSS Load advertisements and native AP metrics. Missing
   data is not idle; unsupported noise/rate/capacity fields remain unqualified.
3. Candidate RCPI is deliberately synthesized from the configured link matrix
   at the HAL boundary. That is useful for controlled experiments, but it is
   not proof that a radio actually heard an unassociated station. RDK HAL
   `0038` also samples current fronthaul signal from this model; neither
   signal source qualifies real-world measurement availability.
4. Default contention remains global per frequency. Optional `-F` permits
   isolated unicast pairs to overlap, using bidirectional endpoint visibility.
   This is not a hidden-node collision or full DCF model.
5. RX injection now reports the selected modeled legacy rate. FCS, DSSS/OFDM
   airtime and ACK length are corrected; HT/VHT remain legacy proxies.
6. Forward decoding and reverse ACK decoding have independent outcomes.
   An ACK lost over RF differs from a kernel injection rejection; submission
   still does not prove native receiver acceptance.

7. Current shared optimizer snapshots are RCPI/band/association oriented.
   Adding load to an AP report alone would not make that optimizer load-aware.

**Recommendation:** preserve survey/reporting safeguards and declare signal
provenance before adding load-aware policy. Reservations and reverse ACKs
need scoped qualification; calibrated PHY service and hidden nodes remain
future work.

## 2. Evidence and deployed architecture

### 2.1 Deployed architecture

| Item | RDK on rev140 | prpl on rev150 |
| --- | --- | --- |
| Running VM | `rdkeasymesh-20-0908` | `prplmesh-20-0908` |
| Canonical repository | `/home/rev/yocto/rdkb-bpi-nosrc-vcpe-0908-clean/meta-cmf-bananapi-vcpe` | `/home/rev/git/prplmesh-lab` |
| Prior qualification checkpoint | `0d9cde2` | `e70a431` |
| Guest kernel | `7.0.0-30-generic` | `7.0.0-30-generic` |
| Loaded/on-disk hwsim srcversion, patch 0010 | `542E9DB26233E9A8439431A`, matching | Same, matching |
| Configured radio pool / channel contexts | 32 / 3 | 40 / 3 |
| Mesh radio ownership | One wiphy per mesh container, concurrent band-specific VAPs | Three wiphys per mesh container |
| Default active radio requirement | 5 mesh + 20 client = 25 | 15 mesh + 20 client = 35 |
| Logical mesh roles | Controller plus colocated Agent-1 and four extenders | Same logical arrangement |
| Selected medium | Userspace wmediumd; `kernel_medium=N` | Userspace wmediumd; `kernel_medium=N` |
| Startup signal model | `snr`, default SNR 40 dB | Same |
| Radio regulatory test setting | `regtest=5` | Same |

The pool totals are not counts of independent RF channels. Nor are six
logical mesh roles six physical mesh containers. Recheck spare radio ownership
before adding foreign APs; do not reload hwsim during a room transition.

Both build scripts pin wmediumd to
`717e5d7fcc23eecbc8e32bd897a8fd4b1e3ba640`. The hwsim patch sets are identical
in the inspected repositories. wmediumd patch numbering differs after the
shared initial series, and prpl includes an additional learned-VIF control
identity patch. Compare content and capabilities, not patch numbers alone.

RDK's canonical Yocto source trees identify Wi-Fi HAL
`ce3170c9c8710a44b4627248e1443c31a9f7ad43`, OneWifi/libwebconfig
`6281b770f10654644c23e6f474c556cf913e41b4`, and Unified Wi-Fi Mesh
`1ef3cfd3014296defd2c5b575584e5f1d8195e0f`, plus the lab patches.
prpl's manifest pins release 6.0.0 at
`2e153c7e00cbcab6b8ee35082f494a364e23f018`, plus its lab patches.
Phase 1–2 acceptance rebuilt the affected native providers from these pins and
the checked-in patches. See the deployment and artifact details in section 12.4;
this is not a byte-for-byte rebuild comparison of every appliance component.

### 2.2 Evidence baseline

The initial audit remains outside the repository under
`/home/rev/work/rf-phase0-0910/`. Its relevant findings were:

- **E01/E12:** userspace medium and matching module identity; monitor ACK
  channel-context fix present.
- **E02–E06:** dummy/absent surveys, missing prpl BSS-load configuration and
  RDK HAL no-op survey methods. Phases 1–2 replace these.
- **E07:** legacy PHY approximations, fixed RX metadata and global queue
  reservations; Phase 3 addresses sections 4.5–4.7's bounded subset.
- **E08/E10:** idealized candidate metrics and signal-only optimizer inputs.
- **E09:** prpl noise/ESP placeholders and zero-to-10 scan rewrite; the rewrite
  is removed, unsupported noise/ESP remain unqualified.
- **E11:** documented RDK rate/storage limitations, not a reproduced overflow.

Old dummy values are not current measurements. Empty, unsupported, stale and
measured idle remain distinct. Current contracts and acceptance below supersede
historical source observations.

### 2.3 Three separate planes

```text
Room geometry/events
    -> configurator/compiler -> atomic medium state generation
                                  |
AP/STA applications               v
    -> hostapd/OneWifi/supplicant -> mac80211/hwsim
                                  <-> wmediumd frame scheduler/PER
    <- received frames + signal + modeled TX status

Native measurement/reporting:
    driver or hwsim HAL provider -> RDK OneWifi/EasyMesh or prpl Agent
    -> IEEE 1905 reports -> native controller -> read-only APIs
    -> selected optimizer -> native steering/channel action

Independent observation:
    medium counters + kernel/stack events + traffic + browser timestamps
    -> diagnostic evidence, not a replacement controller database
```

Linux hwsim is a mac80211 hardware substitute, not an RF waveform solver.
The Wi-Fi state machines above it remain real software.
[Linux hwsim documentation](https://wireless.docs.kernel.org/en/latest/en/users/drivers/mac80211_hwsim.html)

The control socket changes the medium. The HAL metrics socket is read-only.
The separate Console telemetry socket exposes diagnostics. Keep these
privileges and roles separate when adding counters.

RDK requires measurement keys containing the actual radio/channel context:
a wiphy-only key would merge 2.4, 5 and 6 GHz. prpl has separate mesh wiphys,
but several BSSs share each band radio. In both labs, distinguish permanent
radio identity, learned transmitting VIF, BSSID, STA address and namespace.

## 3. Available RF attributes

### 3.1 Current support and usefulness

“Available” below does not imply hardware-calibrated accuracy.

| Attribute | Current source or manipulation | Native/optimizer value and limitation |
| --- | --- | --- |
| Radio/BSS/STA identity | hwsim inventory, VIF ownership learning, native associations | Essential and implemented; identities are not interchangeable |
| Band, operating class, frequency | Native configuration and hwsim frame frequency; delivery eligibility checks | Available; validate operating class and current context, especially 6 GHz |
| Channel width | Native advertised/configured capability | Not a qualified wide-channel interference or service-time model |
| Directed link SNR | Radio-pair defaults plus exact-frequency overrides, atomic generations | Working scenario control; not a measurement of physical noise |
| RSSI on received frames | Medium signal derived from SNR with fixed -91 dBm noise reference | Kernel signal needs received traffic; RDK HAL `0038` samples current serving RF separately |
| RCPI | HAL/controller conversion of signal; candidate provider conversion | Useful for signal steering; retain conversion, source and observation time |
| Candidate signal | HAL reads matrix for requested direction/frequency | Idealized synthetic availability, not reception-backed scanning |
| Noise floor | Fixed medium reference and native placeholders; new survey deliberately omits noise | No trustworthy independently varied/measured noise floor today |
| Distance and walls | World compiler's logarithmic loss, wall-crossing loss, per-band reference | Repeatable geometry-to-SNR abstraction, not ray tracing |
| Transmit gain/power | World `tx_gain_db_by_band`; native power configuration also exists | Scenario gain affects SNR; native power changes are not proven to update that matrix |
| Shadowing/fading | Seeded world shadow term; upstream medium fading option | World term is repeatable but not temporally correlated fading; medium fading not enabled in baseline |
| Packet error probability | Legacy PER curves use SNR, length and approximated rate | Real delivery consequences; absolute curves are not modern-PHY calibration |
| Retries and TX success/failure | Medium retry series and TX status; kernel station counters | Available diagnostics, subject to ACK/delivery limitations |
| TX/RX bytes and packets | Real software traffic and native station/interface statistics | Useful demand/goodput inputs after units, wrap and ownership validation |
| TX/RX PHY-rate fields | Kernel rate control and HAL parsing | TX model approximated; RX-rate injection fixed; do not treat as measured capacity |
| Airtime/service delay | Union of modeled data and transmitted ACK energy, excluding waits | Global per frequency by default; local visibility with opt-in `-F`; legacy20 only |
| Channel utilization | Fresh hwsim TIME/BUSY deltas through both native HALs | Tested in both labs for the declared legacy20 model; missing/stale/unsupported contexts are unavailable |
| BSS station count | hostapd/native association tables | Available independently of channel load; filter stale and AP/VLAN duplicates |
| Beacon/probe BSS Load | Qualified hostapd survey integration and actual BSS association count | Beacon/scan/native AP metric round-trip tested at bytes 0, 128 and 255; measured-mode traffic response tested separately |
| Estimated Service Parameters | EasyMesh structures; prpl nl80211 setter is a no-op | Do not use as qualified service-capacity input |
| Neighbor BSS discovery | Real beacons/probes and native scan mechanisms | Available protocol substrate; fresh off-channel end-to-end coverage still needs qualification |
| CCA / carrier sensing | Coarse receive cutoff and queue/interference approximations | Not a per-radio, visibility-aware CCA/NAV model |
| Co-channel interference | Optional same-frequency accounting, disabled in startup baseline | Not qualified; source contains additional modeling concerns |
| Hidden/exposed nodes and spatial reuse | Directed matrix can describe asymmetry | Scheduler/ACK behavior prevents a claim of realistic hidden-node performance |
| Adjacent-channel overlap | Exact-frequency isolation | No partial-overlap/spectral-mask model |
| Non-Wi-Fi interference | No supported room primitive | Proposed noise/energy occupancy model, distinct from foreign Wi-Fi traffic |
| QoS/access categories | Four medium queues, management priority, retry timing | Not complete TXOP, aggregation, OFDMA or MU scheduling |
| RTT, loss and application throughput | Real traffic through the simulated datapath | Observable outcome, includes host/software delay as well as modeled RF effects |
| DFS/CAC, regulatory flags, power limits | Kernel capabilities and native control protocols | Protocol testing possible; no qualified radar/AFC/physical-spectrum simulation |
| HE/EHT, MIMO, beamforming, MLO | Some capabilities/protocol paths exist | No calibrated modern-PHY spatial, RU or multi-link capacity model |
| Raw management capture | Global hwsim monitor, or daemon capture support | TX-side evidence, not receiver-local occupancy or proof of decoding |

### 3.2 How the room changes the medium

The world compiler calculates a directed value approximately as:

```text
SNR(band) =
    reference_SNR(band)
    - 10 * path_loss_exponent * log10(max(distance, reference_distance) / reference_distance)
    - sum(crossed_wall_losses)
    + source_gain(band)
    + seeded_shadow_term
```

The result is rounded and clamped; absent roles receive the configured minimum.
The shadow term is seeded by time, pair and band; reciprocal pairs share its
draw, while source gains can introduce asymmetry. A seed stabilizes the world
plan, not all scheduling, rate-control and random frame-loss outcomes.

The compiler can project one band onto a radio-pair matrix or compile
frequency-qualified updates for multiple bands. Exact-frequency overrides
take precedence over pair defaults. Older descriptions saying only one
cross-band matrix value is possible are incomplete.

A channel change needs a deliberate rebinding strategy: an override for
5180 MHz does not automatically become one for 5220 MHz. Recompile/apply the
geometry for the new channel with an epoch boundary, rather than accidentally
falling back to a strong startup default.

Changing RF conditions does not itself associate a client, remove a topology
node, alter an SSID or select a parent. Native software and the explicitly
selected external policy perform those actions. Protected startup backhaul,
adaptive backhaul and stimulus-only operation are distinct experiment modes.

## 4. Important implementation gaps

### 4.1 Operating-context survey replaces scan dummy data

With `survey_cache=Y`, hwsim returns only fresh, eligible current-context
TIME/BUSY counters. It never falls back to scan dummy values while enabled.
The bridge derives those counters from the medium's actual modeled occupied
intervals, not byte totals. Frequency, width, context epoch, provider and
observation time prevent stale/retuned data from becoming a new measurement.

This remains a **global contention domain per frequency**, not an audibility-
qualified observer model. Noise, TX/RX airtime breakdown, interference energy,
spatial reuse and calibrated service capacity are not supplied by this cache.
Disabling it restores the old signal-only driver behavior, including its
unqualified scan-survey fallback.

### 4.2 RDK native reporting path is implemented

HAL patches `0035-nl80211-channel-survey-provider.patch` and
`0036-hwsim-channel-survey-stats.patch` replace the Banana Pi success/no-output
paths. They select the actual requested operating channel, require supported
survey fields, deliver hostapd survey events, and return channel time in the
**microseconds expected by OneWifi**. Unsupported requests fail instead of
returning untouched output.

The hwsim hostapd configuration uses a BSS-load update period of 10 beacon
intervals. This assignment is deliberately outside the HAL's
`CONFIG_BSS_LOAD` guard: that guard is absent in the deployed HAL build.
Libhostap patch `0005-qualified-bss-load-survey.patch` handles resets, failure,
true zero and full-busy 255, withdrawing the element when unavailable while
keeping the timer alive for recovery.

Existing OneWifi translation and EasyMesh reporting carry the result. Native
AP-metric packet captures confirm the field; no controller database injection
is used. Unsupported noise and TX/RX subfields are still not qualified.

### 4.3 prpl native monitor now actually consumes survey data

Native patch `0014-qualified-channel-utilization.patch` preserves nl80211
field presence, chooses the interface's current frequency and differences a
per-context baseline. Crucially, `update_radio_stats()` now calls the survey
helper: fixing an otherwise unused helper alone did not populate AP reports.

Missing/reset/stale data no longer becomes a fabricated zero AP metric.
Unavailable utilization omits that AP metric rather than blocking independent
station/traffic reporting. The scan zero-to-10 rewrite is removed; zero is a
valid measured byte. Other HAL backends keep their existing behavior.

Hostap patch `0001-qualified-bss-load-survey.patch` supplies the same availability
and recovery rules as RDK; all three BSSs in each band configuration enable
updates. Tests cover remote-agent IEEE 1905 reports and the colocated agent's
native NBAPI path, which uses local IPC rather than a separate Ethernet CMDU.

Radio noise, associated SNR, ESP and RX-rate placeholders remain separate
unfinished work. Existing controller fields may retain their last report;
an omitted AP metric is not a promise that every legacy UI displays freshness.

### 4.4 Synthetic signal bypasses physical availability

RDK patch `0024-hwsim-read-candidate-rcpi-from-wmediumd.patch` and prpl patch
`0006-nl80211-read-hwsim-candidate-metrics.patch` deliberately read link
configuration at the HAL boundary. RDK converts SNR to bounded RCPI; prpl
supplies RSSI to its normal agent reporting path.

RDK HAL `0038` uses the same read-only model for current fronthaul RSSI:
confirmed owner, actual frequency, STA-to-AP direction and fixed -91 dBm
noise. Kernel counters, rates and association state remain native. Invalid
evidence fails the poll. This avoids refreshing an idle peer's old packet
RSSI with a new timestamp, without probe traffic or faster native timers.
It is idealized RF availability for protocol profiling, not a new received
packet. Backhaul retains kernel RSSI; four-address peers can predate ownership
observation. prpl's serving-link provider is unchanged.

These reports still traverse native software and IEEE 1905, which is valuable.
However, matrix access can produce a fresh answer without hearing the STA,
performing an off-channel dwell or suffering a failed measurement exchange.
A newly stamped response is not necessarily a new RF observation.

Retain this explicit **idealized candidate-provider** mode for policy tests.
Add a separate reception-backed mode with sample count, age, frequency and
receiver eligibility. Do not silently switch semantics or compare timing
between modes as if the underlying measurement work were equivalent.

prpl's patched controller reconstructs measurement time but serializes it at
whole-second resolution. Existing freshness handling compensates for that
ambiguity. A higher-resolution native sequence/timestamp is preferable to
pretending acquisition was instantaneous.

### 4.5 Airtime and PHY-rate fidelity are coupled

Phase 3A replaces fixed `HWSIM_ATTR_RX_RATE=1` with the selected modeled
legacy rate. Duration includes four FCS bytes, DSSS long preamble or OFDM
symbol rounding; ACK MAC length is 10 bytes. Band SIFS and 2.4 GHz OFDM
signal extension are service waits, not energy.

The basis is Linux's
[`ieee80211_frame_duration`](https://raw.githubusercontent.com/torvalds/linux/v7.0/net/mac80211/util.c)
and [hwsim RX metadata](https://raw.githubusercontent.com/torvalds/linux/v7.0/drivers/net/wireless/virtual/mac80211_hwsim.c).
HT/VHT MCS/NSS still map to legacy PER/rate proxies capped at 54 Mbit/s.
This does not implement modern PHY timing, aggregation or calibrated capacity.
RDK native counter widths and bitrate parsing still require separate review.

### 4.6 Conservative visibility reservations

Default same-frequency contention stays global. Opt-in `-F` permits simultaneous
unicast reservations only if both pairs' endpoints are mutually below the
coarse -90 dBm visibility cutoff in both directions. Shared endpoints, audible
cross-links, multicast and unknown recipients retain serialization. Reservations
across all priorities are respected; later traffic cannot preempt already
accounted airtime.

This permits isolated-pair reuse without claiming hidden-node collisions,
full CSMA/CA, calibrated sensing, random contention or TXOP fairness.
Optional interference now includes unit-normalized thermal noise before adding
I/N; an equal-noise interferer adds 3 dB in the fixture. That path remains
disabled by default and is not a qualified interference model.

### 4.7 Independent ACK outcomes and transport errors

Phase 3B independently evaluates forward data and reverse ACK SNR/PER.
Forward-decoded data is delivered once even if its ACK is lost; native TX
status reports failed ACK/retries. Transmitted ACK energy is counted even
when the sender cannot decode it; timeout waiting is not energy. No-ACK
frames do not fabricate ACK success. Off-channel receivers cannot ACK;
eligibility is rechecked before delivery.

Netlink EINVAL is no longer silently relabeled as an RF/context drop:
rejections remain transport failures. `rx_injected` means submission, not
proof of application reception. Authoritative per-frame receiver acceptance
is still absent; no blocking per-frame userspace round trip was added.
Internal PCAP is not a complete trace of every retry and lost ACK.

### 4.8 Signal, noise, interference and CCA must be separate

The active medium uses `signal = SNR - 91`; its coarse CCA cutoff is -90 dBm.
These are model constants, not calibrated receiver characteristics. Lowering
SNR currently lowers reported signal, which is not equivalent to increasing
noise at unchanged received power.

A better model separates received power, background noise, interfering energy,
decode probability and carrier sensing. Native transmit-power changes must
either feed that model or be reported as unsupported RF actuation. Avoid
applying the same power change in both geometry and the medium.

Likewise, wall loss is currently a scalar sum; changing antenna orientation,
material response by band, moving reflectors or fading correlation requires
explicit new model parameters.

### 4.9 Optional kernel medium is not an occupancy shortcut

The opt-in kernel patches provide directed link state, cutoff/loss, optional
rate/PER and bounded delay/jitter, plus per-band airtime/overlap diagnostics.
Those are not complete per-channel, per-observer CCA surveys. Band-wide overlap
and receive-fanout accounting cannot simply be relabeled channel utilization.

Userspace remains the baseline. Share the measurement schema and conformance
tests with kernel mode, but qualify each backend independently. Identical
socket shapes do not establish equal model fidelity.

### 4.10 Capture and host delay are observation limits

`hwsim0` is the global transmitter-side monitor for one VM's virtual radios.
It is useful for beacon fields; it is not a local spectrum analyzer or proof
that every intended receiver accepted a frame. Modeled retries/ACKs also need
their own interpretation rather than assuming a hardware-equivalent trace.

The current patch set contains the multichannel monitor-ACK fix. Older blanket
warnings that dynamic capture is always unsafe do not describe that fix.
Nevertheless, verify the loaded module, preserve monitor state, bound capture
duration and record drops. The room trace helper's normal management filter
excludes beacons/probes, so use a deliberately chosen beacon capture for BSS Load.

CPU contention, netlink backlog, container scheduling, polling, candidate
admission and browser rendering add real latency. They are not RF congestion.
Fast emulation requires measuring and bounding these costs, not claiming zero
cost or interpreting a loaded host as a busy wireless channel.

## 5. Required measurement contract

### 5.1 Keep three kinds of information distinct

| Class | Examples | Who may consume it |
| --- | --- | --- |
| Scenario/model state | Intended SNR, noise setting, traffic schedule, geometry generation | Stimulus engine and independent test oracle |
| Native observations | Received RSSI, operating-channel survey, reported neighbor BSS Load | Native controller and selected optimizer |
| Decisions/outcomes | Steering request, actual association, channel change, verified goodput | Observer, operator and evaluation |

An idealized HAL sample is an explicit model-derived observation, not an
unlabeled passive measurement. Diagnostic access to scenario truth must not
silently become an optimizer input.

### 5.2 Proposed radio/channel record

The full producer/driver record below remains a design contract, not an
existing driver API. Phase 0 implements its per-field validity/unit rules and
a guarded survey-delta helper without enabling a measured-airtime provider:

| Group | Required fields |
| --- | --- |
| Identity | Medium instance/boot ID, stable radio ID, logical radio/context ID, frequency, width, context epoch |
| Window | Monotonic start/end, sequence, publication time, measurement source and fidelity profile |
| Cumulative counters | Active, sensed-busy, own TX, RX; separately supported in-BSS RX, decoded foreign RX, undecodable energy |
| Quality | Valid-field mask; unsupported, missing, warming-up, partial, stale, invalid or valid state |
| Correlation | Applied RF generation, capture/receipt timestamps where available, reset reason |
| Derived values | Utilization percentage and protocol encoding, each with explicit unit and averaging window |
| Health | Transport loss, scheduler lateness, observation gaps and counter-overflow indicators |

Use 64-bit internal time counters, preferably microseconds or finer where
needed. Export Linux survey units correctly; do not round every short frame
independently to milliseconds. Keep fractional/remainder accounting until
snapshot conversion. Avoid per-frame allocations merely to retain history.

An AP that is up and tuned accumulates observation time even when idle.
A disabled context does not accumulate fresh on-channel time. Retune, restart,
radio reuse and daemon replacement establish explicit epochs. Multiple BSSs on
one context reference the same channel record rather than duplicating airtime.

### 5.3 Definitions and invariants

```text
utilization_percent = 100 * delta_busy / delta_active
BSS_Load_utilization_byte = round(255 * delta_busy / delta_active)
SNR_dB = received_power_dBm - noise_power_dBm
RCPI = clamp(round(2 * (RSSI_dBm + 110)), 0, 220)
```

The RCPI expression covers valid representable signal values; preserve
unavailable/reserved encodings separately. A zero denominator is unavailable,
not idle. Preserve the raw BSS-load byte alongside normalized percentages.

Busy time is the union of sensed occupied intervals intersected with the
observer's valid on-channel window. Specify whether own TX is included in
total busy and keep this consistent with the chosen driver/export semantics.
Idle backoff, userspace queue waiting and scheduler lateness are not
transmitted RF energy. ACK airtime is occupied; an ACK timeout without energy
is not equivalent to an ACK transmission.

Require nonnegative deltas and `busy <= active`. Do not assume all diagnostic
subcounters are mutually exclusive; collision energy and decoded RX may overlap.
Validate context identity before differencing counters.

Linux defines active/busy/TX/RX survey fields with explicit support flags.
Use that interface where possible rather than inventing a controller-only
busy metric. [Linux survey contract](https://cdn.kernel.org/doc/html/latest/driver-api/80211/cfg80211.html)

### 5.4 BSS Load is not three independent capacity measurements

The element contains station count, channel utilization and available admission
capacity. Station count belongs to a BSS; utilization describes the channel as
observed by its radio. Admission capacity is not simply `100 - utilization`,
CPU headroom or spare Internet bandwidth.

Our AP's sensed utilization and a neighbor's advertised utilization are
different observations. An unseen interferer at the neighbor can make them
differ legitimately. Multiple private/IoT BSS advertisements from one radio
must not be summed as independent loads.

Hostapd supports periodic BSS Load and fixed test values, subject to build
support. A fixed advertisement is appropriate for parser tests only.
[Hostapd BSS-load settings](https://chromium.googlesource.com/external/w1.fi/cgit/hostap/+/9c6b0a941672eb54e5a5e11f4d6a699f2aba1709/hostapd/hostapd.conf)

Where an IEEE 1905 TLV has no general unknown encoding, use its specified
failure/omission behavior where applicable and retain availability in local
diagnostics. Do not invent reserved wire values or break required messages.
Audit required fields individually; native APIs and UI must not reinterpret an
uninitialized placeholder as a valid measurement.

## 6. Common implementation work

### 6.1 Implemented architecture and next boundary

One medium event loop maintains bounded interval tables. hwsim explicitly
tracks radio/VIF contexts and lifecycle epochs, including quiet radios, scan,
retune and availability, rather than relying exclusively on TX learning.

Accumulate per-observer interval counters from the actual modeled transmission
timeline. Separate PHY occupancy from service/queue duration. A low-overhead
bounded snapshot export feeds a driver-side cache; nl80211 survey queries read
that cache without synchronously asking userspace to process traffic.

The implemented low-complexity transport is root-only, versioned hwsim debugfs
context records plus a single 100 ms bridge. It queries one read-only snapshot per distinct operating frequency plus
one batched observer-context request, then writes validated context caches.
There is no per-frame IPC or per-container collector. Epoch/provider validation
and a one-second TTL fail closed on loss or retune. Native nl80211 readers do
not synchronously wait for the medium. A future event/batch transport can
replace this bridge if measured scale requires it; it is not needed here.

Start with an explicit 20 MHz, single-contending-domain profile. Its measured
occupancy must reflect its actual model. Do not claim spatial reuse until the
scheduler uses a visibility graph consistent with local sensing.

### 6.2 One measurement source

The driver-first provider serves nl80211, hostapd and both native HALs. Do not
add a second HAL-only utilization model or inject controller/UI database
values for qualification. Global PCAP is a diagnostic, not a replacement
for observer-context accounting. No Redis, Kafka, database, per-container
packet collector or replacement simulator is required.

### 6.3 Common work packages

C01–C04 are implemented for the declared profile. C09 has a bounded ping actor
and labeled fixed-field fixture, not a general foreign-traffic scheduler.
C05/C06 have a scoped Phase 3 implementation; C07 has an arithmetic correction,
not a complete sensing model. C08/C10 and remaining fidelity/policy gates stay open.

| ID | Work and implementation points | Acceptance |
| --- | --- | --- |
| C01 | Capability/provenance manifest; common unit and availability rules in configurator, medium, observers and adapters | Unsupported fields never appear as valid zero; backend/version mismatch fails clearly |
| C02 | Radio/context lifecycle in hwsim and wmediumd; current frequency, scan dwell, up/down, VIF ownership and epochs | Quiet/retuning radios have correct eligibility without needing a learning transmission |
| C03 | Refactor scheduler duration into transmission/ACK occupancy versus waiting; bounded per-observer counters | Hand-calculated interval fixtures, no double counting, no busy inflation from CPU delay |
| C04 | Versioned snapshot export and survey cache, or bounded HAL-first adapter | Concurrent readers get coherent epochs; daemon failure becomes stale; readers cannot mutate RF |
| C05 | Truthful RX-rate metadata and supported PHY airtime; separate PER calibration | Known-rate airtime fixtures agree; unsupported modes are explicit, not plausible invented throughput |
| C06 | Visibility-aware same-channel contention and independent reverse ACK outcome | RF-isolated pairs can reuse airtime; asymmetric reverse-link test fails/retries appropriately |
| C07 | Receiver-side received-power/noise/CCA/interference model; fix disabled interference arithmetic before use | Correct sub-milliwatt power addition, noise-only degradation and CCA/decode distinction |
| C08 | Reception-backed candidate sample cache alongside explicit idealized mode | Silent/off-channel/undecodable STA does not gain a fake fresh sample |
| C09 | Bounded traffic actor and F1 BSS-load injection profiles | Advertised load and actual offered load are independently controllable and visibly labeled |
| C10 | Deterministic impairment streams, generation correlation and latency/drop accounting | Same plan reproducible at model level; transport/host failures never counted as RF policy failures |

Update both wmediumd patch series by semantic content. Keep old APIs compatible
where possible, negotiate new capabilities, and add unsupported responses
rather than making old HAL clients parse a changed packet layout.

Frequency override capacity is bounded in the current implementation. A
channel-switch stress test must check reclamation and capacity explicitly;
do not accumulate overrides for every historical channel indefinitely.

## 7. RDK implementation work

Repository paths below are relative to the RDK repository root. R01/R02 are
implemented; the existing R03 translation and periodic R04 AP metrics are
exercised. R04's full reporting-policy matrix and R05–R07 remain separate
qualification work. R08 build/service integration is in source; no new thin
release was made for this milestone.

| ID | Location / responsibility | Required work |
| --- | --- | --- |
| R01 | `recipes-ccsp/hal/rdk-wifi-hal/`; Banana Pi `wifi_getRadioChannelStats()` | Replace success/no-output with real common survey conversion; validate requested channel, pool membership, units and availability |
| R02 | Same HAL; `wifi_drv_get_survey()` and `wifi_hal_hostapd.c` | Supply hostapd survey results through its callback/event contract; audit BSS-load build flag, period and beacon generation |
| R03 | `recipes-ccsp/ccsp/ccsp-one-wifi/` and libwebconfig; `source/stats/wifi_stats_radio_channel.c`, radio diagnostics and translators | Trace valid data into AP/radio metrics; share one context sample, preserve collection time, check idle-radio reports |
| R04 | `recipes-ccsp/unified-wifi-mesh/unified-wifi-mesh/` | Verify query/periodic/threshold-crossing AP reports and native model persistence; fix demonstrated field/age/encoding errors |
| R05 | HAL associated/candidate providers and native rate storage | Audit 64-bit counters, 16/32-bit bitrate fallback, units and signed range; add reception-backed candidate mode without leaking matrix truth |
| R06 | Native scan/channel-control paths | Preserve neighbor load presence and local scan utilization separately; verify actual channel change, VAP sharing and backhaul continuity |
| R07 | `gen/optimizer/`, `gen/demo/room_demo/`, native web UI | Version load-aware snapshots only after R01-R06 gates; expose validity and decision reasons |
| R08 | `gen/hwsim/`, `gen/wmediumd/`, `gen/vm/` packaging | Pin rebuilt module/daemon/HAL compatibility; include conformance tests and safe rollback in future artifacts |

A standard survey response may identify a channel on a shared wiphy but not
all logical RDK radio semantics by itself. Map frequency/context back to the
correct RDK radio index and VAP group. Do not aggregate all three bands into
one `radio_ChannelUtilization` value.

Collection and publication are separate. Prove the value through the HAL,
OneWifi provider, translation, Agent CMDU, controller model and API rather
than concluding success from a populated `iw` counter alone. Exercise
threshold crossings upward and downward, periodic reporting, policy changes,
agent restart and an AP with no associated client traffic.

Existing source includes metrics transport and scan infrastructure; this is
integration/completion work, not a reason to replace OneWifi or EasyMesh.
No native load-balancing decision should be changed merely to make a new
demonstration appear to converge.

## 8. prpl implementation work

Repository paths below are relative to the prpl lab repository root. P01,
P03 and P04 are implemented; periodic P05 wire and native NBAPI reporting are
exercised. P02, the remaining P05 policy/time semantics, P06 UI availability
and P07 channel-selection policy are not claimed complete. P08 build/service
integration is in source; no new thin release was made for this milestone.

| ID | Location / responsibility | Required work |
| --- | --- | --- |
| P01 | `patches/prplmesh/`; BWL `base_wlan_hal_nl80211::get_channel_utilization()` and underlying survey client | Consume a valid current-channel survey; preserve failure/empty/stale state through monitor and NBAPI |
| P02 | BWL `mon_wlan_hal_nl80211.cpp` | Replace radio-noise placeholder where a valid source exists; qualify associated SNR, counters and rates; audit no-op ESP setter |
| P03 | Agent `channel_scan_task.cpp` | Remove or explicitly test-gate the zero-to-10 workaround; preserve BSS-load presence and raw byte separately from local utilization |
| P04 | `manifests/hostapd-wlan*.conf`, `scripts/container/setup-nl80211-node.sh`, hostap build | Enable measured BSS-load updates once surveys work; explicit synthetic-test setting only in F1 mode; no uncontrolled restarts |
| P05 | Agent metrics tasks, controller link-metrics handling and NBAPI | Query/periodic/threshold reports, high-resolution time/sequence, empty-result semantics and restart recovery |
| P06 | `topology-adapter/server.py`, `optimizer/`, `demo/room_demo/` | Adapter currently passes `Radio.Utilization`; add availability/source/window, not a fabricated replacement value |
| P07 | Native scan/channel selection and backhaul handling | Verify actual enabled policy/capabilities; channel request acceptance is not proof of radio convergence |
| P08 | `patches/hwsim/`, `patches/wmediumd/`, `scripts/build-*`, `deploy/lxd-vm/` | Package the same common contracts and tests with independently reproducible prpl artifacts |

prpl's radio-per-band structure simplifies ownership but does not remove
BSS sharing, scan-state, retune or stale-result problems. Check all three band
workers and all four extenders, not just the colocated Agent.

The nl80211 backend is the assessed backend. Results must not be generalized
to other prpl hardware/HAL backends or to an independently certified device.
A certification-related workaround in source is not evidence that fabricated
RF values are suitable for optimizer profiling.

## 9. Optimizer and viewer integration

### 9.1 Desirable inputs in priority order

| Priority | Input | Useful decision | Guard against |
| --- | --- | --- | --- |
| First | Valid current/candidate RSSI/RCPI, direction, age and sample count | Link viability and steering eligibility | Comparing idealized candidates with stale associated samples |
| First | Local utilization, own TX/RX share, observation window | Congestion detection, AP/channel comparison | Equating foreign advertised load with local sensing |
| First | Client demand/goodput, retry/failure deltas | Distinguish a weak link from a busy AP | Byte counters mistaken for airtime; transport drops mistaken for RF |
| First | Backhaul signal, utilization, traffic and topology | Avoid moving a client behind an overloaded path | Treating strongest fronthaul as best end-to-end service |
| Next | Neighbor BSSID/channel/width/RSSI and optional BSS Load | Discover alternatives and corroborate congestion | Counting multiple BSSs on one physical radio as separate occupancy |
| Next | Per-AC queue/service delay and defensible ESP estimates | QoS-aware admission and steering | Filling ESP from an arbitrary scalar “free capacity” |
| Next | Independent noise/interference, CCA and channel preference constraints | Noise diagnosis and channel selection | Choosing an illegal, unavailable or backhaul-breaking channel |
| Later | Qualified width/NSS/PHY service capacity, MLO/link-specific metrics | Modern-radio capacity policy | Inferring physical performance from advertised capabilities |

Maximum SNR is not the optimization objective once real load is available.
A slightly weaker AP with spare airtime and a healthy backhaul can be better.
Conversely, an AP with few clients can be saturated by one slow/high-demand
station. For multihop paths, account for shared-channel airtime consumed by
multiple hops; taking only the smallest nominal link rate is insufficient.

Begin with explainable gates rather than an elaborate new scoring formula:
reject stale/ineligible candidates, require a viable target link/backhaul,
identify sustained overload, estimate whether moving the demand helps, then
apply hold/dwell/cooldown and verify the native outcome. Freeze policy settings
when comparing RF implementations.

### 9.2 Versioned observations and explicit policy ownership

Extend the shared snapshot model with radio/channel observations and BSS
references, rather than copying load into every client record. Backward
compatibility should retain the existing signal-only policy when load is
unsupported. Adding a field must not silently change all existing rooms.

Record one decision owner per run:

- Native optimizer profiling: room supplies stimulus; external steering and
  backhaul selection are disabled.
- External optimizer profiling: named policy consumes native observations and
  sends native requests; conflicting native automation is controlled explicitly.
- Field-handling test: synthetic values are allowed and labeled; performance
  conclusions are not.
- Manual demonstration: operator actions are recorded separately from policy.

The room's strongest-simulated-link overlay remains an oracle visualization.
It is not evidence that the optimizer received that candidate measurement.
Do not call a load-aware topology incorrect merely because a client is not
attached to its highest-SNR AP.

### 9.3 Presentation and latency attribution

Show signal and utilization as separate quantities. Reuse the established
signal colors for signal; do not make high channel utilization look like a
good green link. Show load numerically with its window, source and freshness.
Keep optimizer explanations stable enough to read.

For each change, retain timestamps for stimulus request, medium application,
sample window/end, HAL availability, Agent report, controller ingestion,
policy decision, native action, observed association/channel and rendered
frame. Track acquisition delay separately from policy delay and UI delay.
Monotonic clocks inside one VM are suitable for local durations; record clock
mapping/uncertainty when correlating hosts or packet captures.

Normal protocol timers, physical observation windows and intentional policy
holds are legitimate. Unbounded queues, artificial replay waits and accidental
serialization are not. “Instant” should mean bounded measured overhead,
not removal of every meaningful timing mechanism.

## 10. Phased delivery

Effort labels are relative: **S** is bounded adapter/configuration work,
**M** crosses components, **L** changes core model behavior. They are not
calendar commitments. Every phase ends with a working baseline and explicit
unsupported capabilities, not a partly enabled production experiment.

| Phase | Scope and dependencies | Owners | Effort | Exit gate |
| --- | --- | --- | --- | --- |
| 0: Truthfulness — implemented | Capability/validity contract, reproducible survey/source audits, regression fixtures rejecting stubs/placeholders/rates; no RF behavior change | C01 baseline, R01 audit, P01-P03 audit | S-M | Passed on both labs; see Phase 0 acceptance below |
| 1: Reporting-only — implemented | Explicit fixed BSS Load test; native beacon/scan/report round-trip; availability and unit fixes | C09, R02-R04, P03-P06 | S-M | F1 field tests pass on both stacks; no congestion claim |
| 2: Modeled airtime — implemented | C02-C04; declared legacy20 surrogate, occupancy/wait separation, both HAL paths | Common plus R01-R04/P01-P05 | M-L | Idle/load/channel controls pass within one declared contention domain |
| 3: Credible contention | Visibility-aware scheduling, reverse ACK/receiver outcomes, interference power tests, truthful PHY metadata/service time | C05-C07, R05/P02 | L | Same-channel spatial reuse and asymmetric-link tests pass; no transport-error masking |
| 4: Load-aware policy | Native observations, client demand/backhaul costs, optional neighbor actors, reason reporting | C08-C10, R06-R07/P05-P07 | M-L | Both policies evaluated separately with traceable improvement and no oscillation |
| 5: Advanced RF | Calibrated HT/VHT/HE/EHT models, correlated fading, width/overlap, non-Wi-Fi energy; kernel-backend parity as separately justified | Common/platform specialists | L | Per-feature conformance and physical-reference comparison |

Phases 1–2 passed the scoped reporting/native-traffic gates. Phase 3 adds
legacy timing, reverse ACK and conservative reservations; section 12.5 lists
its remaining qualification gates. Neither phase validates against hardware.

**Next gate:** resolve Phase 3 repeatability and host limitations before
load-aware policy. Retain twenty clients and existing mesh roles; no extra
VM, neighbor-room UI or soak is required.

A shared scenario and independent RDK/prpl runs are preferable to forcing both
systems to share a medium process. Run in parallel only after reserving enough
host CPU and memory. Host capacity is its own fixable issue, not a reason to
weaken RF or measurement correctness.

## 11. Correctness and performance qualification

### 11.1 Short test catalog

This is the full qualification catalog, not a claim that every test has run.
The implemented short Phase 1–2 subset and results are in section 12.4. Start with
30-60 second observation phases after warm-up and a few repeat runs. Use
longer tests only when a specific timing/variance question requires them.

| Test | Stimulus | Required evidence |
| --- | --- | --- |
| RF01 Identity/context | Same BSSID lifecycle, multiple VAPs, separate bands, disabled/recreated radio | No cross-radio/channel contamination; epoch/reset correct |
| RF02 Idle and unknown | Quiet enabled AP; no provider; provider restart | Idle may include beacons; missing/stale never becomes measured 0 |
| RF03 SNR step | Fixed-rate traffic with low/high SNR and exact restoration | Applied generation precedes new samples; loss/signal respond consistently |
| RF04 Directed asymmetry | Strong forward data, weak reverse ACK, then swap | Retries/success follow both directions in the qualified ACK profile |
| RF05 Unit boundaries | Utilization 0/mid/full, valid/invalid RCPI, negative dBm, counter wrap | Native and displayed encodings correct; no reserved-value invention |
| RF06 Fixed BSS Load | Controlled advertisement with negligible application load | Beacon, scan and controller preserve fields; clearly F1, not measured congestion |
| RF07 Load ramp | Paced UDP low/high/off on a supported fixed PHY | Busy/demand/goodput trend consistently; window and service time match fixtures |
| RF08 Shared BSS | Private and IoT clients on one channel | One airtime budget; accurate distinct station counts; no double counting |
| RF09 Co-channel visible | Two mutually audible transmitter/receiver pairs | Appropriate contention, bounded busy and measurable service impact |
| RF10 RF-isolated co-channel | Same frequency, mutually isolated pairs | Compare global default against opt-in conservative reservations; distinguish queue fixtures from live throughput |
| RF11 Different channel | Move second pair to nonoverlapping supported channel | No modeled cross-channel interference or queue serialization |
| RF12 Noise-only / hidden node | Constant desired power, raised noise; then hidden interferer | Distinguish RSSI/SNR/CCA/PER; conditional on C06-C07 |
| RF13 Scan and retune | Native off-channel scan and native channel change under light traffic | Valid dwell-only survey, no inherited old-channel load; service impact recorded |
| RF14 Reporting policy | Query, periodic interval, upward/downward threshold crossing | Correlated native CMDUs and timestamps; behavior survives agent restart |
| RF15 Candidate availability | Silent, transmitting, off-channel and RF-isolated STA | Idealized/reception-backed modes distinct; no false fresh passive sample |
| RF16 Overload/failure | Slow observer, saturated export queue, medium loss, netlink rejection | Fail closed; classify transport versus RF loss; bounded memory and recovery |
| RF17 Policy outcome | Busy strong AP versus viable quieter AP; overloaded backhaul; no better target | Explainable decision/no-action, traffic benefit where expected, no ping-pong |
| RF18 Existing rooms | Load each existing room, static then short movement, both backends' native topology views | Roster, steering, backhaul mode, signal and restoration regressions absent |

RF10 is deliberately a discriminator: it may expose the current coarse model,
not a controller bug. RF12 and advanced PHY cases are skipped as unsupported
until their dependencies pass, never silently marked successful.

### 11.2 Quantitative gates

Freeze traffic size/rate, PHY profile, channel width, RF matrix, CPU allocation,
observer settings and decision mode before measuring. Report offered and
achieved load; the host must be able to generate the requested traffic.

Proposed initial engineering targets, to be calibrated rather than represented
as achieved:

- Zero incorrect identity/epoch joins, unexplained counter resets, or accepted
  invalid samples; zero unclassified netlink/transport failures.
- Exact accounting against deterministic interval fixtures before statistical
  traffic tests. Specify the permitted time/encoding quantization error.
- Counter snapshot publication every 100-250 ms under the small supported
  profile, without a per-frame synchronous IPC exchange.
- No extra full-second polling delay in a newly implemented local adapter;
  report its p50/p95/p99 separately from the native reporting interval.
- Less than 5% throughput impact from the added observation path versus the
  identical RF model with observation disabled, when run variance is below
  that threshold. Otherwise report the comparison as inconclusive.
- Record medium scheduling lateness and export age at 25 RDK / 35 prpl active
  radios, with one and multiple readers. Fail the performance claim when
  host throttling/backlog prevents faithful timekeeping.

Do not demand equality between a short driver window and a longer beacon or
controller averaging window. Compare aligned intervals and account for byte
encoding and timestamp resolution. Reporting policy must still satisfy the
applicable EasyMesh version; measurement and reporting periods are not the
same knob.

Physical calibration is required before absolute “real-world capacity” claims:
use one supported hardware AP/STA setup at known conditions, compare RSSI
steps, rate selection, loss, service time and saturation, and document the
range where the model agrees. Without it, publish comparative results within
the declared virtual profile.

### 11.3 Completion evidence and release gates

For every work package retain compact machine-readable run artifacts outside
the reference tree: revisions, binary/module hashes, topology/roles, scenario
hash, seed, policy, raw/normalized samples, event timing, traffic and restoration.
The reference keeps conclusions and reusable acceptance rules, not raw logs.

Run existing configurator/model, medium self-test, HAL/provider,
optimizer/freshness, topology and room regression tests before packaging.
Rebuild hwsim/daemon/HAL only as required by the phase. Verify old/new ABI
rejection and a rollback to the signal-only baseline.

This assessment does not certify either lab. Protocol/reporting compliance,
measurement fidelity and optimizer quality require separate evidence. A
certified hardware product does not confer certification on a replacement
hwsim/HAL deployment.

## 12. Reproducing the audit and maintaining this document

### 12.1 Safe read-only checks

Run inside the outer lab VM; `lxc` there targets the inner AP containers.
These commands do not start a scan, change a channel, enable a monitor,
generate traffic or reconfigure policy.

```sh
uname -r
cat /sys/module/mac80211_hwsim/srcversion
modinfo -F srcversion mac80211_hwsim
cat /sys/module/mac80211_hwsim/parameters/kernel_medium
cat /sys/module/mac80211_hwsim/parameters/channels
```

RDK:

```sh
lxc exec bpibroadband -- iw dev wifi1 info
lxc exec bpibroadband -- iw dev wifi1 survey dump
```

prpl:

```sh
lxc exec prpl-controller -- iw dev wlan2 info
lxc exec prpl-controller -- iw dev wlan2 survey dump
lxc exec prpl-controller -- sh -c \
  'grep -nE "^(bss_load_update_period|chan_util_avg_period|bss_load_test)=" /etc/hostapd/wlan*.conf || true'
```

Empty survey output is not a zero-utilization observation. Match the returned
frequency to the operating context. Do not provoke a scan merely to populate
dummy records. Hostapd configuration inspection does not replace beacon
verification during phase 1.

### 12.2 Source map for future changes

| Component | RDK repository | prpl repository |
| --- | --- | --- |
| hwsim patches/build | `gen/hwsim/patches/`, `gen/hwsim/build-hwsim.sh` | `patches/hwsim/`, `scripts/build-hwsim.sh` |
| Medium patches/build | `gen/wmediumd/patches/`, `gen/wmediumd/build-wmediumd.sh` | `patches/wmediumd/`, `scripts/build-wmediumd.sh` |
| Geometry, compilation, actuation | `gen/wmediumd/configurator/wmdcfg/` | `wmediumd/configurator/wmdcfg/` |
| Console/protocol diagnostics | `gen/wmediumd/observer/` | `wmediumd/observer/` |
| Native HAL/reporting changes | `recipes-ccsp/hal/`, `recipes-ccsp/ccsp/`, `recipes-ccsp/unified-wifi-mesh/` | `patches/prplmesh/`, `scripts/container/`, `manifests/` |
| External optimizer | `gen/optimizer/optimizer/` | `optimizer/optimizer/` |
| Room orchestration | `gen/demo/room_demo/` | `demo/room_demo/` |
| Documentation validation | `gen/tests/test_documentation.py` | `tests/test_documentation.py` |

For E07 inspect the assembled patched source, especially
`wmediumd.c:queue_frame`, `send_cloned_frame_msg`,
`wmediumd_deliver_frame`, `model_rate_idx`, `per.c`,
`control.c` and `control.h`. Upstream source alone omits lab changes.
For E05 inspect `mac80211_hwsim_get_survey`, scan record writers and the
optional kernel-medium counter updates.

Keep this page as the capability/gap assessment. The
[neighbor-room proposal](../proposals/neighbor-rooms/design.md) owns foreign-AP
scenarios and discovery/contention fidelity levels; it does not replace the
lower-layer measurement work here. Treat old proposal observations as
historical unless rechecked against the pinned implementation.

When a phase lands, replace the relevant proposed item with its implemented
contract, source pointer and compact validation summary. Remove superseded
claims rather than appending another dated report. Update both mirrored copies
and both radio indexes; preserve independent release/build instructions.

### 12.3 Implemented Phase 0: truthfulness baseline

Shared `rf_contract` defines units, provenance, identity, time and explicit
availability states. Numeric values require finite, fresh, in-range qualified
observations; missing flags, mixed epochs, resets and impossible deltas fail
closed. True zero and the 0–255 encoding have regression fixtures.

`python3 -m wmdcfg.cli rf-capabilities` works offline. Live negotiation and
`rf_audit` check identity/provenance without changing RF. The latter remains
a conservative **signal-only** audit: exit zero can include unsupported load.
Use `rf_survey` below for the enabled modeled provider.

Run from the configurator directory as root in the VM:

```sh
python3 -m wmdcfg.rf_audit --stack rdk --repo-root /home/easymesh/git/meta-cmf-bananapi-vcpe -o /tmp/rdk-rf-audit.json
```

For prpl use `--stack prplmesh --repo-root /opt/prplmesh-lab`.
`rf_source_audit` accepts assembled `--native-source`, `--hwsim-source`,
`--wmediumd-source` and `-o`; pattern matches are diagnostic, not semantic
proof or a completion oracle. Never substitute the writable control socket
for the audit's read-only metrics endpoint.

### 12.4 Implemented Phases 1–2: survey and native BSS Load

#### Supported contract

The normal service source is `wmediumd-modeled-airtime`; fixed-value tests use
`synthetic-field-test`. Both set `physical_capacity_qualified=false`.
The profile is `single-contention-domain-legacy20`: one global contention
domain per exact frequency, 20 MHz contexts, existing legacy-rate airtime
surrogates. This is **measurement of this model**, not hardware RF capacity.

- Medium opcode **15**, capability **bit 12 / channel_survey**, wire version 1.
  A 4-byte big-endian frequency request returns 40 bytes:
  `frequency, flags, started_us, observed_us, busy_us, overruns`
  (`!IIQQQQ`). Flags 1 and 2 mean valid and legacy20 model.
  It is accepted on the read-only endpoint; old peers lacking the capability
  cannot enable the new provider.
- Busy is the union of modeled data and transmitted ACK intervals, including
  ACKs lost on the reverse link. Retries contribute energy; DIFS, backoff,
  queue waits and ACK timeout waiting do not.
  Ring fixtures verify overlap, wait exclusion, channel isolation and overflow.
- At most **128 observer/frequency subscriptions**, 128 KiB each and about
  1.049 s future horizon. Default global contention shares one counter per
  frequency; `-F` allocates local observer counters. Reads renew a **2-second**
  lease; traffic cannot keep abandoned subscriptions alive. Overflow fails
  closed rather than clipping to a plausible load.
- hwsim patch `0009-mac80211_hwsim-context-survey-cache.patch` provides at most
  **8 contexts per radio** and root-only (0600)
  `/sys/kernel/debug/ieee80211/phy*/hwsim/rf_survey`.
  Read header: `v1 radio MAC available 0|1`; each row:
  `SLOT EPOCH FREQ WIDTH PROVIDER OBSERVED_US ACTIVE_US BUSY_US VALID`.
  Write: `v1 SLOT EPOCH PROVIDER OBSERVED_US ACTIVE_US BUSY_US`.
  Epoch, monotonic counters and provider identity are checked in the driver.
- The single root bridge polls every **100 ms**: one request per frequency
  plus one batched observer request. Scan/ROC, disable, retune, context reuse
  and provider restart reset measurements. Cache TTL is **one second**;
  driver reads never wait synchronously for userspace. Status JSON has a
  250 ms minimum publication interval (normally 300 ms at this tick).
- Native nl80211 survey supplies TIME/BUSY/IN_USE in **milliseconds**, without
  invented noise/TX/RX flags. RDK converts time to **microseconds** for OneWifi.
  Native utilization is a byte **0–255**, not a percentage. Zero is valid;
  absent data is not zero. Separate diagnostics retain percent, raw byte,
  window, identity and freshness.
- Hostapd updates every 10 beacon intervals (about one second). Invalid data
  withdraws BSS Load and rearms its timer; recovery needs no AP restart.
  Station count comes from native association state. Admission-capacity zero
  is not a measured available-bandwidth assertion.

#### Build, enable and inspect

This deployment is built and tested on **Linux 7.0.0-30-generic**. prpl's
module builder requires Linux 7.0. RDK retains its earlier 6.8 signal-only
build path but skips the new cache patch there; do not claim 6.8 survey support.
The optional kernel medium is still unqualified for this provider.

Rebuild through each repository's module, wmediumd and native build scripts.
RDK includes the HAL/libhostap patches in its Yocto recipes; prpl includes
the native and hostap patch series in its artifact builder. Replace a module
only with the lab stopped, and deploy matching native libraries/binaries as a
set. A running old module cannot gain this ABI from a file-only update.

Future guest setup calls the installer from RDK
`gen/vm/scripts/50-runtime-service.sh` or prpl
`deploy/guest/install-service.sh`. It enables a unit tied to the lab lifecycle.
To install on an existing, already rebuilt VM, run as root:

RDK:

```sh
cd /home/easymesh/git/meta-cmf-bananapi-vcpe
bash gen/wmediumd/install-survey-bridge.sh /run/meta-cmf-wmediumd/metrics/control.sock easymesh-lab.service
systemctl start wmdcfg-survey-bridge.service
cd gen/wmediumd/configurator
python3 -m wmdcfg.rf_survey --socket /run/meta-cmf-wmediumd/metrics/control.sock --seconds 10 --output /tmp/rdk-survey.json
```

prpl:

```sh
cd /opt/prplmesh-lab
bash wmediumd/install-survey-bridge.sh /run/prpl-wmediumd/metrics.sock prplmesh-lab.service
systemctl start wmdcfg-survey-bridge.service
cd wmediumd/configurator
python3 -m wmdcfg.rf_survey --socket /run/prpl-wmediumd/metrics.sock --seconds 10 --output /tmp/prpl-survey.json
```

Common inspection:

```sh
systemctl status wmdcfg-survey-bridge.service
cat /run/wmdcfg-survey.json
cat /sys/module/mac80211_hwsim/parameters/survey_cache
```

`rf_survey` is read-only and rejects fixture providers, mismatched identities,
invalid/stale samples and unsupported capability sets. Its 20 ms diagnostic
sampling measures cache age and socket round-trip time; it is not another
permanent collector. No extra VM, database or per-container daemon is added.

For a signal-only rollback, stop and disable the bridge, then disable the
cache. The previous scan dummy values are again **unqualified**, not measured
utilization. Do not use them for load policy:

```sh
systemctl disable --now wmdcfg-survey-bridge.service
echo N > /sys/module/mac80211_hwsim/parameters/survey_cache
```

To restore modeled reporting, reenable the unit and start it; its `--enable`
negotiates the medium API before turning the cache on. Native timers recover
without restarting every AP. Rollback to old native binaries additionally
requires their matching hostap/HAL set, not mixing shared-library ABIs.

#### Repeat the short acceptance

Run inside one outer VM, as root, from its configurator directory. These are
**disruptive** tests: they temporarily stop room movement and the bridge, use
fixed fixtures, capture beacons/AP metrics, scan/roam one client, send short
ping traffic and stop/restart the provider. They restore prior room activity,
normal measured mode, client frequency and monitor-interface state in cleanup.
Keep the default lab roles running and use a new output directory.

```sh
python3 -m wmdcfg.rf_validate --stack rdk --output /tmp/rdk-rf-acceptance --yes-change-survey
```

On prpl substitute `--stack prplmesh` and a prpl output directory. The VM needs
`tcpdump`, `nsenter`, `iw`, LXD and the existing client supplicant. Native AP
metric capture uses the outer VM's tcpdump in the AP's network namespace;
installing a collector in every AP is unnecessary.

Fixtures publish exact 0/128/255 with quantized windows, checking native
station counts and beacon/scan fields separately from modeled traffic.
prpl's colocated agent uses NBAPI; remote agents use IEEE 1905.

#### Short acceptance results

Both labs pass again on 2026-09-12 UTC with hwsim 0010 and 20 clients.

| Check | RDK / rev140 | prpl / rev150 |
| --- | --- | --- |
| Live acceptance checks | **25/25 passed** | **28/28 passed** |
| Actual beacon/scan/native AP metric bytes | **0 / 128 / 255 exact** | **0 / 128 / 255 exact** |
| Native AP reporting evidence | Colocated AP IEEE 1905, actual BSSID | 36 remote BSSs over IEEE 1905; colocated native NBAPI |
| Selected BSS station count in fixture capture | 2 | 2 |
| Modeled busy, baseline → short ping traffic | **5.01% → 22.82%** | **32.25% → 48.38%** |
| Native client cross-band roam and return | 5180 → 2437 → 5180 MHz | 2437 → 5180 → 2437 MHz |
| Retune epoch/provider reset, stale/bad-write rejection | Passed | Passed |
| Provider loss withdraws survey and BSS Load; recovery without AP restart | Passed | Passed |

The load step sends 800 × 1200-byte pings at 5 ms spacing: modeled activity,
not calibrated saturation.

Native reporting remains separate: observed RDK periodic AP reports take
about 5 seconds, prpl about 1 second; prpl threshold checks remain 10 seconds.
The 100 ms cache period does not guarantee controller/UI freshness.

Current evidence: `/home/rev/work/profiling-gates-0912/*-feedback-rf-evidence/`.
Prior results remain in `/home/rev/work/rf-phases12-0911/`.

Phase 3 separately qualifies overhead, spatial reuse, ACKs and UI freshness.

### 12.5 Phase 3: qualified model and open gates

The airtime model starts with RDK
`0021/0022/0023`, prpl `0022/0023/0024` (PHY/airtime, reverse ACK,
observer surveys/reservations). Normal startup keeps global contention.
`WMEDIUMD_VISIBILITY_CONTENTION=1` adds `-F` on the **next medium start**;
changing the environment does not reconfigure a running daemon. Return it to
zero and restart during a maintenance window to restore the default profile.

Opcode **16**, capability **bit 13 / observer_surveys**, batches 1–128 unique
`!6sI` radio/frequency requests. Responses are ordered `!6sIIQQQQ` records:
radio, frequency, flags, start, observation, busy and overruns. Identities,
lengths, duplicate keys and frequencies are validated. One batch uses one
clock sample. Capability **bit 14 / visibility_contention** declares `-F`.
`-S` disables survey accounting and its capabilities for A/B qualification,
not normal deployment.

The room's **Modeled channel activity** card uses read-only
`/api/demo/rf-load`, separately from SNR. It shows frequency-wide activity,
not per-AP capacity. A true zero stays zero; missing, synthetic or >1-second-old
data becomes —. Hover exposes frequency, age and window. Its three fixed rows
do not replace DOM nodes on updates. Static/replay viewers do not fetch live
load. The network topology and optimizer have not gained load-aware policy.

#### Repeatable short checks

Run as root inside the VM, from its configurator directory, with an unleased
room and no concurrent maintenance. Install outer-VM `iperf3`; tests use
existing container network namespaces, not new containers.

```sh
python3 -m wmdcfg.rf_qualify --stack rdk --medium /absolute/path/wmediumd --seconds 20 --output /tmp/rf-ab-new --yes-change-lab
python3 -m wmdcfg.rf_latency --stack rdk --output /tmp/rf-latency-new --yes-change-lab
```

For prpl use `--stack prplmesh`; add `--visibility` to the first command
for the experimental profile. Omitting `--medium` tests **bridge-only**
overhead, not the full path. A/B runs on/off/off/on, restores the original
binary command/RF matrices, checks BSSID/frequency stability and retains raw
iperf output. At least 5% run spread is **inconclusive**, never a pass.
Latency uses a synthetic 0→255 fixture, observing 30 seconds with a separate
15-second pass budget. It first verifies fresh zero values in the driver,
beacon and native report, then measures 255 on the same BSS identities.
Earlier sleep-only baselines are diagnostic, not qualified latency results.
Driver, beacon and native 1905 delays exclude controller/UI end-to-end latency;
over-budget observations still fail.

#### Results and remaining work

Builds, self-tests, sanitizers, load-card and daemon integration tests pass.
Earlier observer A/B overhead passes <5%
(`/home/rev/work/rf-correctness-0911/`), not calibrated capacity.

See [room qualification](../testing/room-acceptance.md#current-qualification)
for gates, timings and host limitations. prpl now accepts fresh native
RCPI 0–220, including zero, while still rejecting reserved/missing values
and unchanged timestamps. Native reporting intervals are unchanged.
RDK builds retain global `/home/rev/oe/{downloads,sstate-cache}`.

Run two-flow qualification as root from the VM's configurator, with new output:

```sh
python3 -m wmdcfg.rf_spatial --stack rdk --seconds 12 \
  --output /tmp/rf-spatial-new --yes-change-lab
```

For prpl use `--stack prplmesh`. Require iperf3, default twenty-client world
paused at zero, no lease/recording, global medium and no 2.4-GHz managed
backhaul. Private clients (prpl 01/03, not IoT 02) use gateway/first-extender
APs. With orchestration stopped, trials run global, isolated, hidden-receiver,
then reverse. Check associations, RF readback, both rates and AP surveys.
Hidden-receiver reservations are not physical collisions.

Cleanup removes temporary routes/address/TCP rule and restores medium,
matrices, associations and services. Retain JSON and verify readiness.
Failed/inconclusive trials exit nonzero.

Use `--daemon /absolute/candidate` for temporary replacement. `--diagnostics`
retains native rates, TCP state and Console counters, labeling cached data.
Qualification leaves diagnostics off.

The visibility calendar fills independent reservation gaps while retaining
sender FIFO and multicast/hidden-receiver exclusion. A subsequent **common
scheduler bug** affected both profiles: inserting a later packet rearmed the
wallclock timer for that packet, postponing earlier completions. RDK **0026** /
prpl **0027** now request the pending queue's earliest deadline.

Scheduler regression fails before and passes after. A timerfd fixture delivers
a 20-ms job at **250.062 ms before / 20.063 ms after** when later work arrives.
Clean builds and sanitizers pass.
Run `bash gen/wmediumd/tests/test-scheduler-deadline.sh /patched/source/wmediumd`
on RDK; omit `gen/` on prpl. No native rate, buffer, steering or VM-limit changes.

Correlated RDK tracing finds per-flow p95 deadline lateness **22–92 ms before /
0.21–0.69 ms after**. Netlink ingress still reaches **5.69 ms p95**: not zero
external delay. Traced runs are diagnostic. Clean-binary qualification disables
tracing/diagnostics and retains unchanged gates:

| Timer + feedback fixed | Global / isolated / hidden median Mbit/s | Isolated / global | Hidden / global | Maximum repeat spread | Verdict |
| --- | --- | --- | --- | --- | --- |
| RDK, 12 s | 10.759 / 21.503 / 10.755 | 1.999 | 1.000 | 0.81% | Pass |
| RDK, 20 s | 10.734 / 21.530 / 10.723 | 2.006 | 0.999 | 0.13% | Pass |
| prpl, 12 s | 9.678 / 19.390 / 9.624 | 2.003 | 0.994 | 1.78% | Pass |
| prpl, 20 s | 9.631 / 19.383 / 9.684 | 2.013 | 1.005 | 0.96% | Pass |

Association/readback/survey and restoration pass. Earlier RDK 11.10/8.98/14.82%
inconclusive runs remain retained. Timer-only RDK passes 1.73/2.11% spread,
but prpl's 20-second run remains **20.66% inconclusive**, with native TX stuck
at 1 Mbit/s and only 9–10 accounted packets despite thousands transmitted.

Tracing confirms ACKed aggregation requests lack aggregate status:
[Minstrel ignores AMPDU requests without
AMPDU status](https://github.com/torvalds/linux/blob/v7.0/net/mac80211/rc80211_minstrel_ht.c).
Common hwsim **0010** completes singleton status in both TX paths, using the
real ACK outcome. This restores native rate adaptation, not physical
aggregation or forced rates. Three helper regressions and clean kernel builds
pass. Live 16-ping probes advance Minstrel counters **52→70 RDK / 21→41 prpl**;
ACKed aggregation requests now carry aggregate status. Monitor ACK checks pass.
prpl's builder now includes four-digit patches beyond 0009.

For module maintenance, stop the room, bridge, console and lab before unload;
preserve module options and rollback binary. On RDK, restart
`easymesh-hwsim-pool` after reload, **before** starting the lab: the boot-only
oneshot otherwise retains obsolete state while radios are newly named wlanN.
Never reload a live room's radio pool.

Complete RF host sampling: RDK CPU ≤21.49%, RAM ≥51.41 GiB, 76°C,
zero throttle increments; prpl CPU ≤17.95%, RAM ≥14.53 GiB, 74.13°C, throttle
counter unsupported. Catalog thermal evidence remains separate. rev140 exposes
100°C CPU critical temperature and 40/64-W power limits, but no fan RPM.
Do not increase VM resources or silently change host power policy.

Modern PHY/DCF, live collisions/interference, reception-backed candidates,
calibration and Phase 4 load-aware policy remain open. Raw evidence on rev150:
`/home/rev/work/profiling-gates-0912/`; prior evidence remains under
`/home/rev/work/qualification-fixes-0912/`. No thin tar or box is made.
