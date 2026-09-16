# Virtual RF assessment and implementation roadmap

[Radio reference](README.md) · [Neighbor-room design](../proposals/neighbor-rooms/design.md)

**Status: Phases 0–2 and the bounded Phase 3 profile are qualified; Phase 4 is partially implemented.**
See [operation, supported profile and acceptance](#124-implemented-phases-12-survey-and-native-bss-load).
The supported model remains legacy-rate, 20 MHz. The Phase 3 visibility profile
is opt-in and conservative, not calibrated physical capacity or full DCF.
The measurements originated on `codex/0908-clean`; the shared assessment is
maintained on `codex/0913-clean`. Keep both copies synchronized, not separate backlogs.

Evidence extends through September 15, 2026 UTC. Phases 1–2 deploy
the module, daemon and native providers, testing fixed fields, traffic, retunes,
failure and recovery. No soak or physical-capacity qualification was run.

For subsequent client cross-band work, see [band steering and dedicated-room
qualification](../optimizer/band-steering.md): capability-aware passive scans,
native receive-channel reporting, and independent signal/load telemetry. Its
room results do not replace the RF-capacity qualification limits in this assessment.

0913 requires [namespace-safe cfg80211 socket cleanup](../../../../gen/hwsim/cfg80211/README.md).
Its live regression passes on both labs; room convergence remains a separate gate.

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
   RDK HAL `0041` resolves each requested STA/VIF through read-only native
   association ownership before looking up its canonical radio's candidate
   link. A station connected elsewhere can be measured as unassociated to the
   queried AP, including random-MAC backhaul STAs. Globally unassociated,
   never-observed, departed or ambiguously mapped stations are unavailable,
   **not zero RCPI**; there is no guessed-MAC fallback. The ledger's owner AP
   does not select the candidate: the receiving AP remains the local HAL radio
   and the query supplies the frequency. This is an identity safeguard, not
   evidence that the candidate AP received a probe or measurement frame.
4. Default contention remains global per frequency. Optional `-F` permits
   isolated unicast pairs to overlap, using bidirectional endpoint visibility.
   This is not a hidden-node collision or full DCF model.
5. RX injection now reports the selected modeled legacy rate. FCS, DSSS/OFDM
   airtime and ACK length are corrected; HT/VHT remain legacy proxies.
6. Forward decoding and reverse ACK decoding have independent outcomes.
   An ACK lost over RF differs from a kernel injection rejection; submission
   still does not prove native receiver acceptance.

7. Default optimizer snapshots remain signal-based. Opt-in schema 2 adds native
   AP load/activity, guarded balancing and reasons; section 12.6 scopes qualification.

**Recommendation:** preserve survey/reporting safeguards and signal provenance.
Calibrated PHY service, hidden nodes and demand/capacity remain future work.

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

The lab controls directed per-frequency link budgets, geometry, walls,
presence and transmit-gain stimuli. hwsim/wmediumd turn these into modeled
reception, losses, retries and legacy-rate airtime; native software supplies
association, survey and AP metrics. The matrix below separates those paths
from unsupported or unqualified quantities. See §4 for fidelity boundaries
and §§12.4–12.6 for the declared profiles and recorded evidence.

### 3.2 RDK/prpl data-element support matrix

This is the maintained RF/metric subset, **not** a complete TR-181 DataElements
conformance inventory. Implemented, activated, freshly observed and qualified
are separate states. Historical profile acceptance does not qualify new code
or prove the running binaries match their repository. Native request support
does not imply autonomous optimization.

| Element / normalized unit | RDK source/support | prpl source/support | Availability and use |
| --- | --- | --- | --- |
| Radio/BSSID/channel identity | Controller REST inventory; logical radios share a wiphy | Native DataElements inventory via adapter; per-band radios | Context/epoch required; shared-BSS reports must not be summed |
| Serving RCPI / 0–220 | Native STA metrics; hwsim HAL may use model-derived signal; named kernel fallback | Native STA metrics; named kernel fallback | Preserve provider and receipt time; 0 is valid, reserved/missing is unavailable; default policy/UI |
| Same-band candidate RCPI / 0–220 | Unassociated STA report backed by HAL matrix | Unassociated STA report backed by HAL matrix | Idealized availability; not proof AP heard the station |
| Received candidate RCPI / 0–220 | Client passive nl80211 scans with hwsim receive contexts | Same common scanner and receive-context contract | AP→client only; opt-in, two-second age, exact BSSID/frequency/security; no native 802.11k claim |
| Local channel utilization / percent | hwsim survey → HAL → OneWifi → native AP metrics | hwsim survey → BWL → native AP metrics/NBAPI | Qualified legacy20 profile; context/epoch/TTL required; unavailable is not idle |
| AP utilization / raw 0–255 | Native Ethernet AP Metrics TLV → BssLoadObservation.utilization | Native broker AP Metrics TLV → same type | Opt-in load collector; timestamp is report receipt, measurement window unknown |
| BSS station count / clients | Native AP Metrics TLV | Native AP Metrics TLV | Distinct BSS count, not radio airtime; same freshness/identity checks as load |
| Advertised BSS Load / raw 0–255 | Actual hostapd beacon/scan field | Actual hostapd beacon/scan field | Keep presence/raw byte; field fixture is not congestion; not the inspector's AP-report value |
| Packet activity / packets per second | Native STA counter deltas | Native STA counter deltas | ClientActivityObservation: source, interval and epoch; not offered demand |
| Bytes/packets/retries/errors | HAL/native station reporting; octets | BWL/native station reporting; KiB normalized to octets; patch 0022 maps TX failures/RX drops | Bounded data-loss/lost-ACK qualification; AP-relative direction; RX drops are not undecodable RF frames |
| RX PHY metadata / modeled legacy rate | Patched medium → hwsim | Same common path | Selected-rate fix exists; reported rate is not qualified HT/VHT/HE capacity |
| Backhaul RCPI / hop count | Native parent/link records | Native parent/link records | Signal plus conservative hop guard; no measured backhaul-capacity estimate |
| Noise / dBm | Fixed model reference; provider omits unsupported noise | HAL placeholders are not qualified observations | Unavailable; do not infer independently measured noise from SNR |
| ESP / service capacity | Structures do not establish calibrated values | nl80211 ESP setter remains unqualified/no-op | Not an enabled policy input |
| Access-category admission | Opt-in priority queues and bridge classification | Same common opt-in | Bounded priority, not calibrated EDCA/ESP; actual activation is reported |
| Neighbor BSSID/channel/load | Native scan substrate | Native scan substrate | Per-path reception/presence qualification; not a managed steering target by discovery alone |
| Native channel/power action | Platform-specific control path | Platform-specific control path | General room orchestration/feedback not qualified; no silent retune or RF-power double application |

Evidence: sections 12.4–12.6 and [band steering](../optimizer/band-steering.md).
The new inspector is a projection of existing immutable observations, not another
collector. Its native view excludes the frequency-wide modeled activity card;
its decision view preserves historical target exclusions and timestamps.

The run's `rf.capabilities` event and `rf-capabilities.json` record source
revision/dirty state, patch hashes, kernel/module context, medium manifest,
decision owner and active wire flags. Native HAL binary identity and loaded
binary/source equality remain explicitly unverified until an independent audit.
The additive `support` report describes repository implementation and recorded
evidence; legacy `qualification` booleans remain conservative current-run claims.
The September 15 short qualification in §12.7 covers these additions; it does
not establish loaded HAL/source equality or physical RF calibration.

### 3.3 How the room changes the medium

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

Scan-time survey data is not steady-state channel utilization. The implemented
context cache supplies current-channel TIME/BUSY/IN_USE for quiet as well as
transmitting radios. Retune, scan/ROC and provider changes invalidate epochs;
stale or unsupported values must not become valid zero (§12.4).

### 4.2 RDK native reporting path is implemented

The HAL channel-stat and hostapd-survey callbacks consume the common provider.
OneWifi patch 0029 evaluates per-radio utilization crossings with independent
one-second sampling; interval zero disables periodic reports, not sampling.
Native patch 0194 handles bounded AP queries, preserves MID/BSSID correlation
and exposes asynchronous controller submission. See [qualification](../testing/room-acceptance.md#rdk-threshold-and-query-qualification).
Shared-wiphy contexts retain separate logical radios and units.

### 4.3 prpl native monitor now actually consumes survey data

The BWL monitor consumes valid operating-channel surveys and refreshes station
statistics before publishing native metrics. Fixed scan-utilization overrides
are removed or explicitly isolated as fixtures. Noise/ESP placeholders and
unqualified native fields remain unavailable, not inferred from successful calls.

### 4.4 Synthetic signal bypasses physical availability

The ordinary HAL candidate path answers from the RF matrix: an apparent fresh
RCPI need not prove reception. Explicit received-scan profiles instead require
fresh, correctly identified AP→client frames; missing serving or target samples
cannot be filled from geometry. They do not prove reciprocal STA→AP reception,
silent-client measurement, or end-to-end native 802.11k support. Preserve the
idealized path for existing rooms and label the distinction.

### 4.5 Airtime and PHY-rate fidelity are coupled

Legacy20 timing and selected RX metadata have scoped fixtures. They are not
qualified HT/VHT/HE/EHT capacity, aggregation or rate/PER calibration.
Separate actual on-air energy from backoff, queue and ACK-timeout waits;
host scheduling delay must not inflate modeled channel busy time.

### 4.6 Conservative visibility reservations

Optional `-F` permits reuse for isolated same-frequency links. Its reservations
protect hidden-receiver cases instead of modeling receiver-local collisions.
The recorded two-flow result qualifies that reservation behavior, not full
DCF or physical spatial reuse. Exact-frequency isolation is not spectral overlap.

### 4.7 Independent ACK outcomes and transport errors

Forward data delivery and reverse ACK success have independent modeled outcomes.
Lost ACKs may cause retries despite delivered data; count their actual energy
without charging timeout waits as RF occupancy. Netlink loss, stale context,
unsupported rate and host failures remain separate diagnostics, never
misattributed to RF or optimizer behavior.

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

One medium event loop accounts for bounded transmission/ACK intervals.
hwsim tracks radio/VIF lifecycle and operating/receive contexts. A root-only,
versioned debugfs bridge polls every 100 ms, batches observer requests and
feeds driver caches; nl80211 readers never wait synchronously on userspace.
Epoch changes and a one-second TTL invalidate data. See §12.4 for wire formats,
limits and service setup; §12.5 covers optional visibility reservations.

### 6.2 One measurement source

Keep the driver-first provider shared by nl80211, hostapd and both HALs.
Do not add a HAL-only utilization model, controller-database injection,
per-container collector or broker infrastructure. Global PCAP is diagnostic,
not observer-local occupancy. Measure scale before replacing the bounded bridge.

### 6.3 Common work packages

| IDs | Status and remaining acceptance |
| --- | --- |
| C01–C04 | Manifest, contexts, interval accounting and survey cache implemented; retain valid-zero, lifecycle, wait-exclusion and coherent-epoch tests |
| C05–C06 | Legacy-rate metadata, reverse ACK and conservative visibility reservations scoped in §12.5; modern PHY and receiver-local collisions remain open |
| C07 | Disabled interference arithmetic corrected; independent power/noise, CCA and decoding remain unqualified |
| C08 | Opt-in received AP→client candidates in §12.7; not proof AP heard the station or full native 802.11k |
| C09 | Bounded traffic and labeled fixed-field fixtures; foreign traffic and advertised-load controls remain distinct |
| C10 | Deterministic impairment streams and RF-generation-to-observation timing remain open |

Apply shared changes to both patch series by semantic content. Negotiate
capabilities without changing legacy packet layouts. Channel-change testing
must verify override reclamation: never accumulate historical frequencies
without a bound.

## 7. RDK implementation work

| IDs | Source boundary and follow-up |
| --- | --- |
| R01–R02 | `recipes-ccsp/hal/rdk-wifi-hal/`: channel-stat and hostapd-survey paths implemented; preserve unavailable/zero and BSS-load timer recovery |
| R03–R04 | Native threshold sampling/events and AP-query dispatch/correlation implemented; bounded qualification and restart evidence below |
| R05 | Native station byte/packet counters and units qualify against endpoint traffic; controlled retry/error and rate provenance remain |
| R06 | Scan/channel control: neighbor-load presence, actual retunes, shared VAPs and backhaul continuity |
| R07–R08 | `gen/optimizer/`, demo and packaging: guarded load policy implemented; general channel control and compatible artifact qualification remain separate |

Map frequency/context to the correct logical radio and VAP group on the shared
wiphy. Prove delivery through HAL → OneWifi → Agent CMDU → controller/API;
a populated local survey alone is insufficient. Do not change native policy
merely to make a demonstration pass.

## 8. prpl implementation work

| IDs | Source boundary and follow-up |
| --- | --- |
| P01, P03–P04 | `patches/prplmesh/`: current-channel survey consumption, scan override removal and associated-stat refresh implemented |
| P02 | BWL station counters qualify after Profile 2 KiB-to-octet normalization; noise, ESP, retry/error and rate semantics remain unqualified |
| P05–P06 | Periodic, explicit-query, upward/downward threshold and restart behavior pass; preserve native timestamps and availability in UI consumers |
| P07–P08 | Scoped external policy and build/service integration implemented; channel planning and new artifact qualification remain separate |

Keep BSSID, band-radio and scan-cache identities distinct. Native AP-report
receipt time does not establish the unknown measurement window, and a bare
NBAPI utilization value without freshness/provenance cannot qualify a decision.

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

Effort: **S** bounded adapter work, **M** cross-component, **L** core model;
not calendar commitments. Unsupported capabilities stay explicit.

| Phase | Scope and dependencies | Owners | Effort | Exit gate |
| --- | --- | --- | --- | --- |
| 0: Truthfulness — implemented | Capability/validity contract, reproducible survey/source audits, regression fixtures rejecting stubs/placeholders/rates; no RF behavior change | C01 baseline, R01 audit, P01-P03 audit | S-M | Passed on both labs; see Phase 0 acceptance below |
| 1: Reporting-only — implemented | Explicit fixed BSS Load test; native beacon/scan/report round-trip; availability and unit fixes | C09, R02-R04, P03-P06 | S-M | F1 field tests pass on both stacks; no congestion claim |
| 2: Modeled airtime — implemented | C02-C04; declared legacy20 surrogate, occupancy/wait separation, both HAL paths | Common plus R01-R04/P01-P05 | M-L | Idle/load/channel controls pass within one declared contention domain |
| 3: Credible contention — bounded profile qualified | Visibility reservations, reverse ACK/receiver outcomes and legacy-rate metadata/service time; independent interference power remains open | C05-C07, R05/P02 | L | Two-flow reuse and asymmetric ACK tests pass without transport-error masking; not full DCF |
| 4: Load-aware policy — partial | Native load/activity, traffic counters, owner epochs, hop guard and reasons implemented; demand/capacity and neighbor/backhaul actors remain future work | C08-C10, R06-R07/P05-P07 | M-L | Separate two-client native BTM qualifies on both stacks; default signal policy unchanged |
| 5: Advanced RF | Calibrated HT/VHT/HE/EHT models, correlated fading, width/overlap, non-Wi-Fi energy; kernel-backend parity as separately justified | Common/platform specialists | L | Per-feature conformance and physical-reference comparison |

Phases 1–2 pass reporting/native-traffic gates; section 12.5 qualifies legacy
timing, reverse ACK and conservative reservations, not hardware fidelity.

Load-policy qualification retains twenty clients/mesh roles; demand/capacity
modeling remains outside scope.

Run independent labs in parallel only with sufficient host headroom.
Capacity constraints never justify weaker correctness gates.

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
load. Default topology/optimizer operation remains signal-based.

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

The visibility calendar preserves FIFO and multicast/hidden-receiver
exclusion. RDK **0026** / prpl **0027** prevent later work from postponing
earlier deadlines. The 20-ms regression completes at **20.063 ms**, formerly
250.062 ms; clean builds and sanitizers pass.
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

Common hwsim **0010** completes singleton aggregate status using real ACK
outcomes, restoring native rate adaptation rather than forcing rates or
modeling aggregation. [Minstrel requires that
status](https://github.com/torvalds/linux/blob/v7.0/net/mac80211/rc80211_minstrel_ht.c).
Helper regressions, clean builds, live counter progression and monitor ACK
checks pass. prpl's builder accepts four-digit patches beyond 0009.

For module maintenance, stop the room, bridge, console and lab before unload;
preserve module options and rollback binary. On RDK, restart
`easymesh-hwsim-pool` after reload, **before** starting the lab: the boot-only
oneshot otherwise retains obsolete state while radios are newly named wlanN.
Never reload a live room's radio pool.

See [current thermal findings](../testing/room-acceptance.md#host-headroom-and-restoration)
before changing host placement or resources. Unsupported counters are not zero.

### 12.6 Opt-in native-load policy

`optimizer/configs/load-aware-policy.yaml` enables schema-2 native AP-load
and STA packet-activity observations. Default signal policy is unchanged.
Only different-channel, same-band targets with viable RF, fresh matching
reports and no additional wireless hop qualify. Holds, one-client batching,
settling and cooldown prevent mass movement; unknown load never means idle.
Packet activity is not offered demand; hop count is not backhaul capacity.
The receiver uses bridge metadata only for provenance/epoch, never as a load
oracle. RDK captures Ethernet; prpl subscribes to its native broker, including
colocated AP reports with conservative native timestamps.
See [coverage qualification](../testing/room-acceptance.md#native-load-coverage) and the package README.

Channels and client `freq_list` are prerequisites, not policy side effects.
RDK uses single-radio retunes without restarting agents. Its staggered reports
require five-second skew/freshness and a ten-second hold; prpl uses one-second
skew/five-second hold. Neither changes native cadence or default room gates.
See [UDP/BTM qualification and restoration](../testing/room-acceptance.md#opt-in-load-policy-qualification)
for measured outcomes and retained failures. Missing telemetry never means idle.
RDK association publication and ready-command dispatch are event-driven;
[extender-loss qualification](../testing/room-acceptance.md#extender-loss-repair-and-attribution)
passes without changing security timers.

prpl HAL **0015** preserves candidate socket identity across interruptions;
it does not replace idealized candidates with reception-backed measurements.
See [repair qualification](../testing/room-acceptance.md#prpl-snapshot-coherence-and-candidate-diagnosis)
and [native RCPI → room presentation profiling](../testing/room-acceptance.md#room-webgl-presentation),
which excludes RF generation and physical scanout.
The pinned prpl ubus dependency also receives a
[reentrant-dispatch backport](../testing/room-acceptance.md#prpl-libubus-reentrancy);
this changes message coordination, not RF or steering policy.

Modern PHY/DCF, live collisions/interference, reception-backed candidates
and physical calibration remain open. Evidence:
`/home/rev/work/policy-profiling-0912/`; RF baseline:
`/home/rev/work/profiling-gates-0912/`. No thin tar or box is made.

### 12.7 RF increments and short qualification

These additions are implemented in both `codex/0913-clean` trees and deployed
to RDK/rev140 and prplMesh/rev150. September 15 short tests cover representative
rooms, not the complete catalog or a soak.

| Addition | Implemented boundary |
| --- | --- |
| Support/provenance | §3.2 plus `rf-capabilities.json`; implementation, activation and qualification remain separate |
| Target explanations | Deterministic per-BSSID exclusions for freshness, identity, channel, hop, load and signal; policy thresholds unchanged |
| RF inspector | Fixed native/stimulus/decision/traffic views reuse session observations; no UI polling or geometry fallback |
| Bounded traffic | One pinned WLAN namespace; measured iperf3 sender/receiver results; pause, lease, world, offline, fault and shutdown cleanup |
| Received same-band signal | Opt-in passive AP→client scans with exact BSSID/frequency/security, two-second age and fail-closed availability |

Traffic profiles permit four non-overlapping phases in 60 seconds: UDP
0.1–12 Mbit/s or bounded ICMP. Requested rate is not measured demand. Received
signal does not claim reciprocal STA→AP reception, native 802.11k, HAL fallback
or a band upgrade; ordinary profiles retain their prior path.

#### Operator preparation and short acceptance

Keep the ordinary twenty-active-client startup room, fixed hundred-client pool
and existing mesh nodes. For native load inspection/balancing, use the additional
`demo/manifests/native-load-room-profile.json` with the existing
`room-demo interactive --manifest ...` launcher and its usual backend-specific
arguments. In RDK the repository-relative prefix is `gen/`; in prplMesh these
paths start at the repository root. Choose `recommend` for observation or the
existing explicitly confirmed `act` mode for steering. Do not start a second
owner alongside the installed room service. The profile selects the existing
`optimizer/configs/load-aware-policy.yaml`; loading a room never silently
changes the optimizer's authority or policy.

The default same-channel `traffic-quieter-ap` run is intentionally a negative
control: inspect `same_channel`, `target_busy`, or an earlier no-overload/
no-fresh-report gate; it must not claim independent spare airtime.
A **positive** quieter-channel test additionally requires two native,
same-band, different-channel fronthaul radios, matching refreshed inventory/
bindings and client permitted frequencies, working WLAN gateway traffic and
fresh native reports. Prepare and read back channel changes outside the measured
run, protect backhaul/control connectivity, then restore them afterward using
the existing native-load qualification procedure. The room deliberately does
not automate retunes or manufacture overload. If the bounded stimulus does not
reach the native threshold, record no overload rather than relaxing policy.

| Room | Short checks in room and topology |
| --- | --- |
| `traffic-low-high-off` / 30 s | Ten clients; low/high/off UDP lifecycle, measured sender/receiver goodput and loss, native load/age and separate modeled activity; no required signal-policy roam |
| `traffic-quieter-ap` / 30 s | Ten clients; safe no-action on default same channel; prepared positive run must pass all native load/signal/hop gates and verify any actual BSSID/traffic change |
| `received-same-band-roam` / 30 s | Ten clients; profiled station gateway → Ext-1 at 16 s checkpoint → gateway after return; stay 5 GHz, fresh received scans and independent native ownership checks |
| `received-discovery-recovery` / 36 s | Ext-1 fronthaul absent at 12 s checkpoint, restored at 24 s; absent target ineligible, missing serving sample not fabricated, fresh rediscovery and eventual ownership/traffic recovery |

Run `pytest` for `demo/tests`, `optimizer/tests` and
`wmediumd/configurator/tests` with
`PYTHONPATH=demo:optimizer:wmediumd/configurator` from the shared root.
Run `node tests/viewer-rf-inspector-test.js` for inspector contracts.

#### September 15 reliability and priority qualification

Hardening evidence: `/home/rev/work/rf-reliability-0913/evidence/` on rev150.
Keep failed attempts; targeted checks are not full-catalog or soak qualification.

**Reporting repairs**

- **prpl 5 GHz:** BWL consumed stale netlink sequences after receive failures.
  Patch 0021 increases the socket buffer from 8 to 256 KiB, bounds send/receive
  waits to one second, rejects failed transactions and reconnects before the
  next request. Sequence checking stays enabled; no synthetic load replaces a
  missing report. The native fault test covers sequence mismatch, buffer loss,
  interrupted dumps, timeout, send/kernel errors and 100 consecutive successful
  transactions. Run `bash tests/prpl-netlink-recovery.sh SOURCE BUILD` in the
  prepared builder. Deployment replaces installed `libbwl`, restarts its native
  users and re-enumerates existing associations; this is maintenance, not a
  steady-state reconnect loop. The subsequent same-channel control reports
  **30/30 BSSes**, including controller/Ext-1 5 GHz, and passes.
- **RDK channel reports:** patch 0188 admits authoritative operating-channel
  updates while an onboarded radio temporarily handles candidate measurements.
  Patch 0190 resets the initial-report latch on accepted autoconfig renew, so
  unchanged radios republish after a controller restart clears its channel rows.
  The native fail-before/pass-after test covers rejected/busy renewals. Live
  renewal recovered all **30 BSS channels in 12.46 s**, agents unchanged;
  this maintenance timing is not post-steer latency.
- **rev140:** the reversible non-turbo profile avoids observed throttling.
  See [physical-host cooling](../observability/monitoring.md#thermally-constrained-physical-hosts).
  Fan operation is confirmed; airflow remains unverified. Reduced clock ceilings
  must be disclosed in performance comparisons.

**Implemented opt-in: bounded access-category admission**

Opt-in `wmediumd -Q` / `WMEDIUMD_PRIORITY_QUEUES=1` retains one active frame
per transmitter/frequency and FIFO within each actual 802.11 access category.
At most eight higher-priority bypasses precede the oldest waiting frame.
Default FIFO, frequency isolation, RF loss, retries and airtime accounting
remain available. This is **not calibrated EDCA/TXOP, collision, demand or
physical-capacity modeling**.

RDK's Rust AL-SAP sender (patch 0008) and alternative raw C++ sender mark
network-control traffic. Socket priority alone was insufficient: [Linux veth forwarding](https://github.com/torvalds/linux/blob/master/include/linux/netdevice.h)
cleared it, and later wireless hops reclassified untagged Ethernet.
The opt-in platform helper `wmdcfg.control_priority` therefore installs one
owned nftables bridge-forward rule per mesh namespace: IEEE 1905 EtherType
0x893a → explicit UP7. It neither drops nor shapes traffic, bypasses the radio,
nor changes other firewall tables. Kernel traces and monitor captures verify
UP7 on **both wireless hops**. The medium remains protocol-agnostic.

Install `nftables` in the lab VM and deploy the rebuilt components first.
From the shared root (`gen/` for RDK; repository root for prpl):

```sh
sudo install -d /etc/systemd/system/LAB.service.d
sudo install -m 0644 wmediumd/priority-queues.conf \
  /etc/systemd/system/LAB.service.d/30-priority-queues.conf
sudo bash wmediumd/install-control-priority.sh STACK
sudo systemctl daemon-reload
```

Use `LAB=easymesh-lab` / `STACK=rdk` or `LAB=prplmesh-lab` / `STACK=prplmesh`.
During maintenance,
stop the room service, then run RDK's `wmediumd/wmediumd-up.sh up` or prpl's
`scripts/radio-lab.sh restart-medium` with `WMEDIUMD_PRIORITY_QUEUES=1`;
restart the room afterward. [Lifecycle persistence](../../../../gen/wmediumd/control-priority.md)
restores classification after container restarts without polling. Native
AP startup remains the platform wrapper's responsibility.
The live RF manifest advertises admission only when enabled.

Rollback: disable classification/subscription as described in the lifecycle
guide; remove the priority drop-in and recover with
`WMEDIUMD_PRIORITY_QUEUES=0`.

**Measured short controls**

| Low/high/off UDP, offered 1 then 8 Mbit/s | RDK | prpl |
| --- | --- | --- |
| Measured receiver goodput, Mbit/s | 1.001 / 7.998 | 1.001 / 7.974 |
| Receiver loss in these samples | 0% | 0% |

These endpoint records measure delivered traffic, not physical capacity.
Restart, cancellation, load/BTM and browser measurements are in the
[bounded follow-up](../testing/room-acceptance.md#demand-and-lifecycle-results).

Verification starts after submission. The mandatory 20-second observation
window is **not measured convergence or metrics delay**. First sampled fresh
serving/candidate/load/activity evidence and observer/policy costs are separate;
missing milestones remain unavailable. Tests reject native/container/medium
identity changes even if services recover. Native reporting cadence and policy
thresholds remain unchanged.

#### September 15 reassessment and next order

Earlier lifecycle, byte-rate and RF14 threshold/query results remain in
[bounded acceptance](../testing/room-acceptance.md#rdk-threshold-and-query-qualification).
They are not performance guarantees or a full-catalog qualification.

Symbolized evidence confirms a cross-thread `dm_sta_t` use-after-free between topology
encoding and disassociation deletion. Patch **0193** shares the topology mutex
and unlocks before dispatch. Its contract, Yocto build and one live disconnect/
reconnect pass; extended ASan churn was intentionally stopped. A dedicated
data-model mutex with immutable snapshots remains the stronger design.

The current counter/inspection work remains observation-only:

- **Retry/error counters:** four eight-second downlink trials cover baseline,
  pulsed data loss, lost ACKs and recovery. Compare native 1905 counters with
  AP driver counters and sequenced UDP delivery. prpl patch 0022 fixes omitted
  TX-failure/RX-drop mappings. Missing/malformed/reset deltas stay unavailable;
  wrap and independent directions have deterministic tests. RX corruption
  remains unqualified; lost ACKs can cause TX failures despite delivered data.
- **AP inspection:** interactive rooms passively collect native reports, without
  enabling load steering. Topology hover shows per-BSS utilization, station
  counts and age. The room separately shows client-heard advertisements with
  receiver/source, scan identity and two-second per-neighbor freshness.
  Stale counters stay hidden; shared-radio utilization is not additive.

Next:

1. **Add backhaul path evidence:** join native backhaul RCPI, radio load and
   traffic into explanations before target ranking consumes it.
2. **Separate noise/interference/CCA:** version received power, noise and sensed
   undecodable energy; this is the next foundational model change.

Modern PHY/aggregation, ESP and full collision/DCF calibration remain later.
