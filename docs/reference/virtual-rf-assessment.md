# Virtual RF assessment and implementation roadmap

[Radio reference](README.md) · [Neighbor-room design](../proposals/neighbor-rooms/design.md)

**Status: Phases 0–2 implemented and short-tested on both labs.**
See [operation, supported profile and acceptance](#124-implemented-phases-12-survey-and-native-bss-load).
Phase 2 measures the existing legacy-rate, 20 MHz virtual medium; it does not
qualify physical capacity, modern PHY rates or spatial reuse.
This is the shared RF assessment for the RDK EasyMesh and prplMesh labs on
`codex/0908-clean`. It is mirrored in each repository's radio reference so
either repository remains independently useful. Maintain the common text
together; do not create a second backlog for the same RF work.

The evidence baseline and short acceptance are 2026-09-10 Pacific /
2026-09-11 UTC. The initial read-only audit identified the gaps in the evidence
register. Subsequent Phases 1–2 rebuilt and deployed the module, daemon and
native providers, then exercised fixed fields, real traffic, channel changes,
failure and recovery. No long soak or physical-capacity qualification was run.

## Navigation

- [Conclusions](#1-conclusions)
- [Evidence and deployed architecture](#2-evidence-and-deployed-architecture)
- [Available RF attributes](#3-available-rf-attributes)
- [Phases 1–2: operation and results](#124-implemented-phases-12-survey-and-native-bss-load)
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

The labs are useful **frame-level, signal-driven protocol test environments**.
They run real AP, station, security, association and EasyMesh software. Their
medium changes affect actual frame delivery and native stack behavior, not
just the pictures in the room viewer.

They are **not yet calibrated RF-capacity or congestion simulators**. In
particular, a successful steering demonstration does not establish valid
channel utilization, realistic airtime sharing, accurate PHY throughput or
real-world measurement availability.

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
   not proof that a radio actually heard an unassociated station.
4. The userspace scheduler serializes equal/higher-priority queue tails across
   all radios on the same frequency, without testing mutual audibility.
   It cannot establish realistic spatial reuse merely by placing nodes far apart.
5. HT/VHT rates are approximated using legacy rate curves, including for
   airtime; RX injection supplies a fixed rate index. Rate fields and modeled
   service capacity can therefore disagree.
6. ACK selection is primarily a forward-link success model, not a separately
   simulated reverse-link exchange. Kernel injection and receiver acceptance
   are also not the same event.
7. Current shared optimizer snapshots are RCPI/band/association oriented.
   Adding load to an AP report alone would not make that optimizer load-aware.

**Recommendation:** preserve the working signal baseline and the implemented
bounded survey/native-reporting path. Keep its declared model restrictions
visible before adding load-aware policy. Visibility-aware contention, reverse
ACK modeling and calibrated PHY service time are the next fidelity gates,
not optional details when claiming realistic capacity or hidden-node behavior.

## 2. Evidence and deployed architecture

### 2.1 Deployed architecture

| Item | RDK on rev140 | prpl on rev150 |
| --- | --- | --- |
| Running VM | `rdkeasymesh-20-0908` | `prplmesh-20-0908` |
| Canonical repository | `/home/rev/yocto/rdkb-bpi-nosrc-vcpe-0908-clean/meta-cmf-bananapi-vcpe` | `/home/rev/git/prplmesh-lab` |
| Repository HEAD before Phases 1–2 working changes | `e48e002b116b615c65081989c69d6fbe578e8e51` | `6e2cecac4dfeb865d35588243eaddcff15730da9` |
| Guest kernel | `7.0.0-30-generic` | `7.0.0-30-generic` |
| Loaded/on-disk hwsim srcversion after Phases 1–2 | `787E6C52AFFB528353585A5`, matching | Same, matching |
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

### 2.2 Initial audit evidence register

This register records the pre-implementation audit, not current survey output.
E02–E06 and the E09 zero rewrite motivated the now-implemented fixes in section 4.
**Live** means observed in that audit; **Source** means inspected source;
**Documented** means an existing limitation not remeasured then.

| ID | Evidence | Finding |
| --- | --- | --- |
| E01 | Live, both module parameters and srcversion | Userspace backend active; matching installed/loaded hwsim identity |
| E02 | Live, RDK `iw dev wifi1 info` and `survey dump` | Operating at 5180 MHz; survey returned 5955 MHz, noise -92 dBm, active 120 ms, busy 15 ms |
| E03 | Live, prpl controller survey queries | No survey rows returned for its queried interfaces |
| E04 | Live, prpl hostapd configuration and monitor logs | No periodic BSS-load settings in generated configs; repeated current utilization 0 in monitor log |
| E05 | Source, deployed prpl `build/hwsim-source/mac80211_hwsim.c` | `mac80211_hwsim_get_survey()` uses scan records and `time_busy = time / 8` |
| E06 | Source, RDK canonical HAL | `wifi_getRadioChannelStats()` and `wifi_drv_get_survey()` return success without populating measurements |
| E07 | Source, shared wmediumd patches and deployed prpl source | Frequency overrides, rate approximation, fixed RX-rate index, same-frequency queue-tail scheduling, bounded telemetry |
| E08 | Source, each lab's candidate-provider patches | HAL reads directed frequency-qualified matrix values through a read-only socket |
| E09 | Source, pinned prpl BWL and scan task | Survey consumer exists; radio noise/SNR/ESP gaps; zero scan utilization rewritten to 10 |
| E10 | Source, shared optimizer model/policy and room integration | RCPI, band, freshness and association gates; no channel-load field in the shared policy snapshot |
| E11 | Documented RDK metrics limitations | Some rate values/storage are unreliable; no new rate-overflow reproduction performed |
| E12 | Source and loaded module identity | Monitor-ACK channel-context fix is present; raw monitor capture still needs bounded, explicit qualification |

E02 is not evidence of 12.5% utilization on the current 5 GHz AP. E04 is
not proof that every monitor cycle made a successful survey request. An empty
survey, default zero, stale scan and measured idle channel are different states.

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
| RSSI on received frames | Medium signal derived from SNR with fixed -91 dBm noise reference | Drives kernel/native associated signal; new samples depend on received traffic |
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
| Airtime/service delay | Bounded union of modeled data and successful ACK intervals, separate from queue/backoff waits | Implemented per frequency and exported to eligible contexts; legacy20, one contention domain, not local visibility |
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

### 4.4 Synthetic candidate metrics bypass physical availability

RDK patch `0024-hwsim-read-candidate-rcpi-from-wmediumd.patch` and prpl patch
`0006-nl80211-read-hwsim-candidate-metrics.patch` deliberately read link
configuration at the HAL boundary. RDK converts SNR to bounded RCPI; prpl
supplies RSSI to its normal agent reporting path.

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

The Linux-7 rate patch maps HT/VHT MCS/NSS combinations to nearby legacy OFDM
rates. The same mapped rate drives both PER and `pkt_duration()`; the
available OFDM curves top out at 54 Mbit/s. Thus a higher native PHY rate does
not imply matching modeled service time.

The inspected `send_cloned_frame_msg()` also writes
`HWSIM_ATTR_RX_RATE=1`, despite accepting a rate argument. RX metadata is
therefore not a faithful description of the selected transmission mode.

Fixing airtime reporting without addressing or explicitly restricting this
model can make a wrong capacity calculation more visible, not more correct.
Initially qualify a supported 20 MHz legacy-rate case. Later separate airtime
calculation from PER-curve selection and preserve the actual supported RX mode.

RDK's associated parser consumes 32-bit byte counters and a limited bitrate
attribute path. Audit 64-bit preference, wrap and legacy bitrate fallback.
The existing signed-rate/storage warning is E11, not a newly reproduced
overflow in this assessment.

### 4.6 Contention is broader than the RF visibility graph

In E07, `queue_frame()` advances a frame behind equal/higher-priority queue
tails from every station on the same frequency. It does not require those
transmitters to hear one another. The model is closer to a coarse shared
collision domain than independent local contention domains.

Consequences:

- Two RF-isolated same-channel pairs may still delay each other.
- A distant foreign AP can impose scheduler delay inconsistent with locally
  observed busy time.
- Hidden/exposed-node and spatial-reuse experiments cannot be qualified just
  by changing SNR values.

The optional interference path is not an automatic fix. Its power arithmetic
also deserves a focused unit test: the inspected routine sums values expressed
in milliwatts, then returns no offset when the sum is at most 1.0. Ordinary
negative-dBm interferers are below that level. Verify linear-power addition,
noise reference and SINR degradation before enabling this path for experiments.
This is a source concern in a disabled path, not a measured production fault.

### 4.7 Modeled ACK and receiver delivery are different

Unicast PER/retry success is selected using the forward-link model before
delivery. There is no independent reverse-link ACK PER trial in that path.
Some receiver eligibility is learned from transmitted VIFs and checked again
at delivery, rather than obtained as authoritative current kernel state.

A frame can be selected as ACKed before a later off-channel/injection failure.
The delivery path does not provide a general receiver-acceptance handshake
that proves successful MAC decoding. `rx_injected` records submission, not
application reception; asynchronous netlink rejections are separate counters.

Required improvements are explicit context/lifecycle state, outcome
classification, and reverse-ACK modeling where bidirectional fidelity is
claimed. Do not add a blocking userspace round trip for every frame merely to
hide this distinction.

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
context records plus a single 100 ms bridge. It queries one read-only medium
snapshot per distinct operating frequency and writes validated context caches.
There is no per-frame IPC or per-container collector. Epoch/provider validation
and a one-second TTL fail closed on loss or retune. Native nl80211 readers do
not synchronously wait for the medium. A future event/batch transport can
replace this bridge if measured scale requires it; it is not needed here.

Start with an explicit 20 MHz, single-contending-domain profile. Its measured
occupancy must reflect its actual model. Do not claim spatial reuse until the
scheduler uses a visibility graph consistent with local sensing.

### 6.2 Driver-first versus HAL-first

| Approach | Advantage | Cost / limitation | Recommendation |
| --- | --- | --- | --- |
| Common hwsim survey provider | Native Linux consumers and hostapd share one source; reusable across stacks | New kernel/provider contract, context lifecycle and ABI validation | Preferred durable solution |
| Common counter snapshot with thin HAL adapters | Can validate native reporting before the driver export is ready | Both adapters plus hostapd integration; no automatic `iw survey` parity | Acceptable bounded intermediate step |
| UI/controller database injection | Fast-looking demonstration | Bypasses real collection, freshness and protocol behavior | Do not use for qualification |
| Global PCAP-derived utilization | No driver change | Misses observer sensing and reliable airtime/acceptance semantics | Diagnostic comparison only |
| Replace the complete lab with another simulator | Potentially richer PHY | Major integration/calibration cost and new behavior differences | Not a prerequisite |

HAL-first must consume the same counter contract and remain removable. Do not
grow two independent utilization models. No Redis, Kafka, separate database or
per-container packet collector is needed.

### 6.3 Common work packages

C01–C04 are implemented for the declared profile. C09 has a bounded ping actor
and labeled fixed-field fixture, not a general foreign-traffic scheduler.
C05–C08/C10 remain fidelity or policy work; the table retains their acceptance
boundaries rather than implying that Phase 2 completed them.

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

Phases 1–2 passed the scoped reporting, interval accounting, native traffic,
channel, failure and recovery gates below. This does not pass Phase 3 or
validate the legacy-rate approximation against hardware.

**Smallest useful implementation:** phase 0, a fixed-value BSS-load round-trip,
then one AP/client load experiment with real common counters through each
native stack. Keep the default 20 clients and mesh roles. Reuse existing
traffic endpoints first; add one foreign AP/STA pair only when required.
No extra VM, full neighbor-room UI or long soak is necessary for this milestone.

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
| RF10 RF-isolated co-channel | Same frequency, pairs unable to sense/interfere with each other | Spatial reuse; known current scheduler limitation until C06 |
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

Phase 0 introduced the shared `rf_contract`: explicit units, source,
identity, time, and valid/unsupported/missing/warming-up/partial/stale/invalid
states. Only a qualified, finite, fresh, in-range observation exposes a
numeric value; raw placeholders remain diagnostic. Its survey converter
rejects missing flags, mixed epochs, counter resets, impossible deltas and
stale observations. True zero and the 0–255 encoding have regression fixtures.

`python3 -m wmdcfg.cli rf-capabilities` is offline; live `status`, configurator
run artifacts and room preflight negotiate the daemon capabilities. A wire
capability is never itself a fresh native observation.

The original `rf_audit` remains a conservative **signal-only** truthfulness and
provenance audit. It deduplicates AP contexts and checks loaded/disk module
identity, running/disk/startup daemon hashes, selected backend and read-only
protocol without changing the lab. Exit 0 includes explicitly unsupported
measurements, not proof of measured utilization. For the now-enabled modeled
provider use `rf_survey` in section 12.4 instead.

Run from the configurator directory as root inside the selected VM:

```sh
python3 -m wmdcfg.rf_audit --stack rdk --repo-root /home/easymesh/git/meta-cmf-bananapi-vcpe -o /tmp/rdk-rf-audit.json
```

On prpl use `--stack prplmesh --repo-root /opt/prplmesh-lab`. Defaults select the
read-only metrics socket; never substitute the writable scenario endpoint.

`rf_source_audit` accepts `--stack`, `--native-source`, optional
`--hwsim-source`/`--wmediumd-source` and `-o`. Give it assembled patched sources,
not patch files or another release's checkout. It records hashes and source
locations for known gaps, not C/C++ semantic proof. Removed gap patterns may
now return `review_required`; this is not the Phase 2 completion oracle.

The initial Phase 0 acceptance passed both labs before RF behavior changed:
39 new contract/audit/source tests, module/daemon/context identity checks and
isolated read-only protocol tests. Raw historical evidence remains in
`/home/rev/work/rf-phase0-0910/` on rev150; current acceptance is below.

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
- Busy is the union of modeled data and successful ACK intervals. Retries
  contribute their actual modeled transmissions; DIFS, backoff, queue waits
  and an unsuccessful ACK timeout do not become transmitted energy.
  Ring fixtures verify overlap, wait exclusion, channel isolation and overflow.
- At most **16 subscribed frequencies**, 128 KiB interval storage per frequency,
  approximately 1.049 s future horizon; overflow invalidates instead of
  clipping to a plausible load. Queries allocate subscriptions, not scan
  traffic. Unused subscriptions are reclaimable after 60 seconds.
- hwsim patch `0009-mac80211_hwsim-context-survey-cache.patch` provides at most
  **8 contexts per radio** and root-only (0600)
  `/sys/kernel/debug/ieee80211/phy*/hwsim/rf_survey`.
  Read header: `v1 radio MAC available 0|1`; each row:
  `SLOT EPOCH FREQ WIDTH PROVIDER OBSERVED_US ACTIVE_US BUSY_US VALID`.
  Write: `v1 SLOT EPOCH PROVIDER OBSERVED_US ACTIVE_US BUSY_US`.
  Epoch, monotonic counters and provider identity are checked in the driver.
- The single root bridge polls every **100 ms**, once per distinct frequency,
  then publishes per-context baselines. Scan/ROC, disable, retune, context
  reuse and provider restart invalidate or reset measurements. Cache TTL is
  **one second**. Driver queries read the cache, not a synchronous userspace
  request. Status JSON is published at most once per second.
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

Fixtures publish exact 0, 128 and 255 through the same cache/native path, with
quantized windows to avoid mistaking millisecond rounding for a field bug.
They test native station counts and actual beacon/scan fields separately from
modeled traffic. Remote prpl agents use IEEE 1905; its colocated agent is
checked through native NBAPI because it shares the controller's AL/local IPC.

#### Short acceptance results

Both labs passed on 2026-09-11 UTC; each retained 20 clients and the usual mesh
roles. Results below are final reruns after fixing missing RDK BSS-load
configuration, the unused prpl monitor survey path, provider-restart epochs
and scan-frequency subscription exhaustion.

| Check | RDK / rev140 | prpl / rev150 |
| --- | --- | --- |
| Live acceptance checks | **25/25 passed** | **28/28 passed** |
| Actual beacon/scan/native AP metric bytes | **0 / 128 / 255 exact** | **0 / 128 / 255 exact** |
| Native AP reporting evidence | Colocated AP IEEE 1905, actual BSSID | 36 remote BSSs over IEEE 1905; colocated native NBAPI |
| Selected BSS station count in fixture capture | 1 | 2 |
| Modeled busy, baseline → short ping traffic | **5.00% → 37.94%** | **30.23% → 55.12%** |
| Native client cross-band roam and return | 5180 → 2437 → 5180 MHz | 2437 → 5180 → 2437 MHz |
| Retune epoch/provider reset, stale/bad-write rejection | Passed | Passed |
| Provider loss withdraws survey and BSS Load; recovery without AP restart | Passed | Passed |
| Read-only 10 s publication audit | 35 contexts; zero errors | 35 contexts; zero errors |
| Cache age p50 / p95 / p99 | 52.52 / 98.31 / **103.80 ms** | 50.71 / 95.04 / **99.87 ms** |
| Read-only control round-trip p99 | 3.72 ms | 5.92 ms |
| Bridge CPU, percent of one core during audit | **4.99%** | **3.30%** |
| Configurator regression suite | 102 passed | 98 passed |
| Room orchestration regression suite | 159 passed | 131 passed |
| Native prpl survey unit suite | Not applicable | 7 passed |
| Module/native builds and medium self-tests | Passed | Passed |

Baseline busy includes beacons and existing lab traffic; it is not a quiet
physical channel. The load step is 800 pings with 1200-byte payloads at 5 ms
spacing to the native WLAN gateway. It proves a modeled busy response, not
calibrated saturation or a throughput-overhead limit. CPU percentage is also
not a measurement of throughput impact.

Native reporting cadence remains separate from the bridge: the observed RDK
periodic AP report is about 5 seconds, prpl periodic reporting about 1 second,
and prpl's existing threshold-check cadence remains 10 seconds. No claim is
made that all controller/UI values update within the 100 ms cache period.

Raw JSON, PCAP, scan output, build and regression logs are outside the reference
tree under `/home/rev/work/rf-phases12-0911/` on rev150. Final live artifacts are
`rdk-final/rf-phases12-validation-4/` and
`prpl-final/rf-phases12-validation-3/`, with publication JSON beside each.
Both loaded/disk module identities match the table in section 2.1; running,
disk and startup-manifest daemon hashes were checked. The native sources and
build logs are retained alongside those artifacts. No new thin tar was made.

**Not claimed by this milestone:** all-room live replay, a soak, less-than-5%
throughput overhead, physical calibration, spatial reuse, reverse-link ACK
fidelity, measured noise, TX/RX airtime components, calibrated RX rates,
kernel-medium parity, load-aware optimizer or complete UI freshness semantics.
Those remain the explicit Phase 3–5/policy qualification boundaries.
