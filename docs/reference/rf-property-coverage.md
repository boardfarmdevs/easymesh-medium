# RF property demonstration coverage

[Radio reference](README.md) · [Room catalog](https://github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/blob/main/doc/easymesh/reference/rooms/catalog.md) ·
[Field guide](console-rf-properties.md)

This is the maintained RDK property-to-room contract, not a declaration that
every room or daemon mode is live-qualified. The complete property inventory
is `PROPERTIES` in [rf_observations.py](https://github.com/boardfarmdevs/easymesh-optimizer/blob/main/optimizer/rf_observations.py).
[rf_coverage.py](https://github.com/boardfarmdevs/easymesh-optimizer/blob/main/optimizer/rf_coverage.py) adds named
rooms, machine-readable check categories and expectations to both generated
catalogs and the room catalog API. Coverage tests require exact property-set
equality, signed existing rooms and this document. A catalog entry neither
activates a policy nor provides a measurement.

## Evidence and policy contract

Default signal policy is unchanged. It consumes fresh serving/candidate RCPI,
eligibility, identity, dwell, gain, hold, cooldown and observed ownership.
Ordinary same-band candidate RCPI currently comes through native reporting
from the HAL's configured-matrix lookup; it is not independent reception.
Received-scan profiles instead require fresh AP→client passive reception.
Geometry, intended APs, room names, traffic schedules and modeled busy time
never select a target. Presence can remove eligibility; it cannot manufacture
native ownership or a successful association.

The RF inspector separately reports whether load policy and the native counter
guard are configured. Configuration does not prove decision use: weak-signal
rescue bypasses load balancing. Individual decision evidence and native counter
shadow checks distinguish these cases.

Native load remains explicitly enabled by a policy file. Verified inventory,
provider epoch, BSSID/device/radio/channel context, ownership floors and
bounded counter windows remain required. Missing or stale is unavailable,
never idle. Native AP report timestamps identify receipt, not a known
measurement window. A report visible with unverified inventory is inspection
only; it cannot become a typed policy load sample. Retunes, reassociation,
provider replacement, counter resets and implausible deltas invalidate the
affected windows. Existing native path validation rejects unknown parents,
cycles and conflicting topology; room geometry never fills a missing hop.

The new optional [counter-guard policy](https://github.com/boardfarmdevs/easymesh-optimizer/blob/main/configs/load-counter-guard-policy.yaml)
requires `load_aware_enabled` and `load_counter_guard_enabled`. For an otherwise
overloaded strong serving link it checks three native AP counter rates:
retries ≤100/s, TX failures ≤10/s and RX drops ≤10/s by default. These are
configurable conservative experiment limits, not calibrated RF thresholds.
All three counters must exist; zero and equality with the limit are valid.
Activity must match the current load transport, owner and provider epoch,
remain within five seconds and satisfy the configured report skew. The
guard adds `counter_checks` and actual sample values/times to decision
evidence. Bytes/s remains observational. It never divides retries by combined
TX/RX packets, adds TX and RX errors into a loss fraction, estimates capacity,
or claims that a quieter target fixes reverse-link impairment.

| Condition | Expected decision/check |
| --- | --- |
| Missing, stale, future, wrong-owner or wrong-epoch activity | `native_load_activity_unavailable`; no balancing |
| Activity transport or report skew mismatch | `native_load_activity_context_mismatch`; no balancing |
| Any retry/TX-failure/RX-drop rate unavailable | `native_load_counter_evidence_unavailable`; no balancing |
| Any measured rate exceeds its configured limit | `native_load_counter_pressure`; no balancing, reset hold |
| Current utilization below threshold | `native_load_current_acceptable`; no balancing; counters need not be queried |
| Idle client | `native_load_client_idle`; no balancing |
| Same radio/channel, busy/weak target, extra/unknown wireless hops, stale/skewed/foreign-epoch target | Excluded with individual reasons in `candidate_assessments` |
| Safe target and good counters persist | Normal load hold; both AP reports and the counter report must advance past its start |
| All load gates and sustained hold pass | `native_load_margin_hold_satisfied`; one client per batch, then settling and native verification |
| Weak serving link | Existing signal rescue and its guards; high counters do not suppress rescue |

Selecting a room alone does not enable this policy. The checked-in
[native-counter-guard-room-profile manifest](https://github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/blob/main/gen/rooms/manifests/native-counter-guard-room-profile.json)
selects `rf-asymmetric-ack`, its real client binding and the opt-in policy.
Stop the room service before operating it; never start a second actuator:

```sh
gen/rooms/room-service interactive --mode recommend --profiling \
  --manifest gen/rooms/manifests/native-counter-guard-room-profile.json
```

On exit, restart the unchanged room service for default signal-only operation.
Received-band profiles retain their existing
received-signal policy with load and counter guards disabled. Counter pressure
and unavailable evidence cannot mark the load fleet converged. A live
positive load move still requires a separately prepared different-channel
target; these rooms never retune a radio.

## Property inventory

Every row specifies a named stimulus, expected optimizer behavior or explicit
observation/abstention check, and the evidence boundary. Check categories are
metadata for these contracts, not a claim of automatic live qualification.

| Property | Stimulus and named rooms | Inputs and expected decision/no-action check | Observe and limitation |
| --- | --- | --- | --- |
| `rcpi` | `received-same-band-roam`, `home-a-border-hover`: movement and sustained/marginal gain | Fresh eligible received/current RCPI, gain and hold; missing/stale samples abstain; small gains hold | Native BSSID plus decision source/time; receiving direction and synthetic HAL candidates remain distinct |
| `configured_snr` | `rf-asymmetric-ack`: station transmit-gain offset | Diagnostic only; read back both directions at the exact frequency and same daemon generation; never use room target truth | Room RF inspector / Console RF matrix; pair fallback and exact-frequency override differ |
| `received_signal` | `rf-asymmetric-ack`, `received-same-band-roam`: directional reception | Last medium signal is observation only; received-profile policy requires its own fresh native scan | Console Traffic dBm/SNR and scan source/time; last packet may predate current matrix |
| `noise_reference` | `home-a-stationary`: baseline model | Observe compiled −91 dBm profile; no noise/power action | Console Services; fixed reference, not independently measured noise |
| `cca_threshold` | `received-discovery-recovery`: fronthaul visibility loss/return | Observe compiled −90 dBm threshold and classified CCA drops; no threshold steering/control | Services and selected Traffic; no adjustable or calibrated CCA model |
| `noise` | `home-a-stationary`: negative control | Explicit `unsupported`; never infer noise by subtracting SNR from signal | Catalog/field-state contract; no independent noise observation or noise generator |
| `native_utilization` | `traffic-low-high-off`, `traffic-quieter-ap`: bounded offered UDP | Opt-in native utilization byte, activity, signal and path gates; same-channel targets abstain | RF Native observations and decision evidence; offered bitrate does not guarantee overload |
| `station_count` | `home-a-flash-crowd`: 10→20→10 clients | Observe native per-BSS count after ownership settles; count never substitutes for load or chooses AP | AP Metrics and topology; pool size differs from associated population; do not sum radio utilization per BSS |
| `beacon_utilization` | `rf-packet-size-counters`: two real UDP phases | Observation only: require fresh received BSS Load IE, exact source/receiver/frequency and successful receive evidence; absent IE stays unavailable | Selected Console Load/Traffic; AP Metrics alone does not prove a beacon IE or reception |
| `modeled_busy` | `traffic-low-high-off`: low/high/off | Observe nonnegative identified active/busy windows; no direct ranking or capacity inference | Console global channel and radio-local survey; distinct scopes, background frames persist when experiment is off |
| `packets_per_second` | `rf-packet-size-counters`: equal offered bitrate, different payload sizes | Native owner/epoch-matched bounded delta window gates activity in load policy; reset/stale/idle abstain | Native rate/window and traffic results; aggregate AP TX+RX events are not attempts or offered packets |
| `bytes_per_second` | `rf-packet-size-counters`: 256 vs 1200-byte datagrams | Observation only, with native byte-unit conversion and same window/owner safeguards | Native deltas and independent sender/receiver results; not application goodput or capacity |
| `retries_per_second` | `rf-asymmetric-ack`, `rf-packet-size-counters`: directional impairment and control | Optional counter guard checks absolute native AP retry rate; missing abstains, excess vetoes balancing | Native counters and medium ACK/no-ACK separately; retransmissions not guaranteed, no invented retry fraction |
| `tx_errors_per_second` | `rf-asymmetric-ack`: same stimulus | Optional counter guard checks native AP TX failure rate; zero valid, unavailable abstains | Native counter windows; different boundary from medium receiver drops |
| `rx_errors_per_second` | `rf-asymmetric-ack`: same stimulus | Optional counter guard checks native AP RX drops; never substitute zero for unavailable | Native counters; dropped received packets do not count all unseen over-the-air frames |
| `backhaul_hops` | `backhaul-branch-formation`, `backhaul-isolation-recovery`, `traffic-quieter-ap`: parent opportunity/outage/load comparison | Native valid path required; load rejects unknown/additional wireless hops, no geometry-based parent assignment | Shared backhaul explanation, actual uplink BSSID and traffic; repeated frequency is contention risk, not additive capacity |
| `receive_context` | `received-discovery-recovery`: lost and rediscovered beacons | Fresh exact-frequency receive evidence qualifies candidates; not-received/stale abstains, no modeled fallback | Passive scan ID, age, source and rejected BSSID; maintained context may be historical activity |
| `room_presence` | `home-a-disappear-reappear`, `received-discovery-recovery`: offline clients/fronthaul | Exclude absent roles; returning presence requires fresh native evidence before use | Room identity/epoch, disconnect status, topology and BSSID; exclusion neither destroys radios nor guarantees silence |
| `frequency` | `band-upgrade-24-5`, `band-upgrade-5-6`, `traffic-quieter-ap` | Native band/channel and capability eligibility; retune floors discard old context; same-channel load targets excluded | Actual frequency/BSSID, AP context and directed override; AP name alone cannot prove a band change |
| `channel_width` | `rf-packet-size-counters`: unchanged configured contexts | Observe configured native width; survey qualification is legacy 20 MHz; unsupported widths stay unavailable | Console Load/profile; wider configured channels do not prove calibrated bonded PHY behavior |
| `packet_types` | `rf-asymmetric-ack`, `received-discovery-recovery`: ICMP/ACK, beacon and discovery frames | Observation only: bounded selected header/subtype counters; no policy from frame class | Selected Traffic management/data/control, EAPOL and fan-out; receiver candidates differ from injections, header history starts at selection |
| `frame_loss` | `rf-asymmetric-ack`: strong forward/weak reverse opportunity | Observation only: distinguish PER, CCA, off-channel, no-receiver and ACK outcomes; no loss-truth target selection | Console Traffic and independent echo replies; last PER is not interval loss; counters have different boundaries |
| `queue_delay` | `rf-packet-size-counters`: differing offered datagram rates | Diagnostic queue/deadline/netlink observation only; host scheduling delay never becomes low RCPI | Console Summary/Services; host cost is not calibrated physical latency or EDCA |
| `active_rf_modes` | `home-a-stationary`, `rf-packet-size-counters`: idle/activity baseline | Read actual daemon mode flags; disabled fading/interference/visibility/priority means that mode is not exercised | Services/profile; compiled capability alone does not prove activation or qualification |
| `physical_capacity` | `rf-packet-size-counters`: explicit negative control | `unsupported`; no policy capacity score and no throughput claim from a band/rate label | Separate offered, sender actual and receiver goodput; modern PHY capacity unqualified |

## Source properties beyond the catalog

The field guide and daemon contain sub-properties grouped by the catalog.
These must also retain named observation checks, including disabled modes.

| Sub-property/source | Room stimulus and expected check | Boundary and regression coverage |
| --- | --- | --- |
| Distance, path-loss exponent, per-band reference, walls, seeded shadowing; world compiler and geometry model | `home-a-one-client-handover`, `home-a-asymmetric-link`, `home-a-stationary`: verify signed deterministic matrices and wall/direction changes; policy uses reports, never coordinates | Not ray tracing, multipath or Doppler; configurator world/geometry tests |
| Per-node transmit gain | `rf-asymmetric-ack`: only station→AP links change by −45 dB, clipped at the model floor; reverse remains unchanged | Scenario SNR offset, not HAL TX-power control; new exact directional compiler contract |
| Pair fallback, per-frequency overrides, generation, VIF aliases/ownership | `band-upgrade-24-5`, `received-discovery-recovery`: exact-context readback and real ownership; stale/wrong context abstains | Frequency-control, VIF and observer tests; no inference from MAC aliases alone |
| Legacy rate, frame length, PER, forward delivery and independent reverse ACK | `rf-packet-size-counters`, `rf-asymmetric-ack`: selected length/rate/PER and ACK/injection observations | Medium patches 0021/0022; selected detail tests; no modern PHY rate or guaranteed failure-rate claim |
| Optional fading coefficient, per-frequency interference, SNR/error-probability/path-loss daemon modes | `home-a-stationary`, `rf-asymmetric-ack`: record actual profile; zero/disabled is the negative control, enabled outcomes require separate evidence | Patch 0033 profile; Console tests; rooms do not enable daemon modes or model thermal noise/spectral leakage |
| Global occupancy, radio-local active/busy, survey provider/epoch, synthetic utilization fixture | `traffic-low-high-off`, `traffic-quieter-ap`: distinguish actual modeled-airtime provenance from `synthetic-field-test`; fixture load cannot qualify policy | Survey/provenance tests; fixture tests field encoding only, not congestion |
| Visibility reservation/spatial reuse (`-F`) | `traffic-quieter-ap`: observe actual enabled flag and local/global survey scopes; disabled mode is observation-only | Patches 0023/0025 and RF spatial tests; no receiver-local collision/capture physics |
| Access category/priority admission (`-Q`), queue heads, scheduler deadlines/netlink rejection | `rf-packet-size-counters`: differing packet-rate stimulus; inspect enabled flag, category, queue and infrastructure counters | Patches 0026–0031 and scheduler/latency tests; no WMM admission, calibrated EDCA or guaranteed latency |
| Multicast fan-out, management/control/data, EAPOL, selected-window lease and ring overwrites | `received-discovery-recovery`, `rf-asymmetric-ack`: observe discovery/echo traffic within selected-window budget; missing history remains missing | Patch 0032 and Console detail tests; no payload capture or assumption that every modeled ACK is captured |
| Beacon station count, utilization, available admission capacity | `rf-packet-size-counters`, `home-a-flash-crowd`: fresh received IE and exact context; capacity stays diagnostic in 32 µs/s units | Console BSS Load parsing tests; AP Metrics is not beacon proof; no ESP/free-bandwidth inference |

Source anchors are the [world compiler](../../configurator/wmdcfg/world.py),
[native load provider](https://github.com/boardfarmdevs/easymesh-optimizer/blob/main/optimizer/load_observer.py),
[load policy](https://github.com/boardfarmdevs/easymesh-optimizer/blob/main/optimizer/load_policy.py),
[medium patches](../../wmediumd/patches) and
[field guide](console-rf-properties.md). Independent TX power, noise and CCA
controls, adjacent-channel spectra, receiver collision/capture, MIMO,
OFDMA/MLO and calibrated HT/VHT/HE/EHT capacity remain unsupported. Named
negative controls make these omissions visible; they do not simulate them.

## New room procedure

Both new rooms retain five APs, ten already-bound clients, fixed protected
backhaul, unchanged channels and a 30-second script. The compact golden files
need only start/end geometry frames; playback still advances each second and
runs the intermediate traffic phases. Start paused and let ownership/metrics
settle. Select `sta_static_03` in the RF inspector, then play at 1×.

- `rf-packet-size-counters`: 1 offered UDP Mbps, 256-byte payloads at 5–13 s,
  off at 13–15 s, 1200-byte payloads at 15–23 s, then off. Compare actual
  sender/receiver records and native packet/byte windows. Smaller payloads
  request more datagrams; setup, background traffic and report windows prevent
  an exact ratio requirement. Off stops experimental traffic, not beacons.
- `rf-asymmetric-ack`: a −45 dB station transmit-gain offset across all bands;
  30 ICMP echoes/s, 1200-byte payloads at 5–23 s. Verify forward/reverse applied
  SNR, then correlate real ACK/no-ACK, AP counters and replies. The exact retry
  rate is stochastic; zero is a valid observation. Missing native counters
  cannot qualify the counter guard. Ending playback does not remove the gain;
  loading Default restores the original RF.

## Lab qualification records

The labs' live qualification of these properties is theirs: the RDK lab's native counter
pressure, native load action, room catalog and native recovery records are in its
[RF property qualification records](https://github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/blob/main/doc/easymesh/reference/testing/rf-qualification.md), prplMesh's in its
[RF property coverage](https://github.com/boardfarmdevs/prplmesh-lab/blob/main/reference/radio/rf-property-coverage.md).

## Cold room initialization

The native recovery a cold room exposed in the RDK lab is in its
[qualification records](https://github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/blob/main/doc/easymesh/reference/testing/rf-qualification.md#native-recovery-during-cold-room-initialization).

### Medium initialization cost

Initializing 3,060 frequency overrides exposed a shared medium defect: its
free-slot reservation repeatedly scanned all earlier reservations, taking
cubic work in wmediumd's single event loop. On prpl this blocked a control
handler for 2,669,387 µs, caused beacon loss and left native APs reporting old
peers during the first room switch. Startup and Default reload compute the
same RF matrix; neither room geometry nor a native steering policy caused it.

Medium patch 0034 (prpl 0035) uses one monotonic free-slot cursor. Existing
slots remain unchanged until validation completes; duplicate/invalid updates
still reject the entire generation. No SNR, native policy, AP inactivity
timer, ownership filter or convergence deadline changes. Only free-slot
reservation becomes linear; duplicate validation and key lookup retain their
existing bounds. Compiled regression includes original-code negative controls.

The immediate post-startup prpl check now passes both new 30-second rooms,
seven native properties, real traffic and healthy Default restoration.
Its first ten-client roster settles in 5.12 s; the fresh daemon's maximum
control-handler time is 7,339 µs. These are bounded observations, not a
worst-case latency guarantee or a full-catalog/soak qualification.

RDK's immediate post-startup check also passes both rooms, their native RF and
traffic assertions, and healthy Default restoration. The first ten-client
roster settles in 9.32 s within the unchanged 60-second gate; the observed
maximum control handler is 7,968 µs. Evidence:
`test-results/rdk-rf-counter-followup/slot-first-rooms.json` and
`slot-services.json`. A second cold prpl service start passes again (8.19 s
first roster). These are native roster timings, not optimal-AP proof.

## Validation and live limits

### Test accounting and diagnostics

RF action cases after a failure remain individually listed as blocked, not
silently omitted. A failed counter-manifest blocks counter-shadow. Soak
subprocess failures preserve the command, exit status or timeout, stdout and
stderr in `command-failure.json`, referenced by the summary and printed in the
log. Zero churn workloads following a failed preflight is not a completed soak.

UDP room reports retain both endpoint measurements. They accept and explicitly
label one exact datagram of excess receiver bytes only when packet counts
agree, receiver loss is zero, receiver bytes equal packets times payload, and
sender bytes equal one fewer payload. Larger or inconsistent differences fail;
no measured counter is rewritten and loss is never inferred from that byte
difference. iperf maintains byte and sequence counters separately and resets
measurement windows independently at the two endpoints; see its
[statistics implementation](https://github.com/esnet/iperf/blob/3.9/src/iperf_api.c).
The archived failure stays failed; replay or rerun evidence is separate.

Guarded-load fixtures choose two native extender radios with known hop counts
and a target with no additional backhaul hop. They prefer the original target
when valid, otherwise select a compatible pair rather than requiring a star.
They never force backhaul parents or alter the production steering policy.

Pressure-only selection prefers the shallowest available native source, then
equal-depth pairs, before historical AP preferences. Reports retain
`pair_selection` and both actual hop counts. This avoids an unnecessary
backhaul bottleneck without requiring a star or manufacturing overload;
deeper-only labs still must meet every original qualification gate. Clear and
rescue selection is unchanged. Both stacks pass 130 focused fixture tests.
The synchronized RDK `pressure/report.json` chooses one-hop source and target,
but remains **unqualified**: native utilization peaks at 199/255 and pressure
lasts at most 5.056 s, below the unchanged 10-second hold. Five counter-pressure
decisions are not five causal veto witnesses against a fully held unguarded
opportunity. The test correctly fails; original RF/channels/associations,
fresh Default-20 metrics and native identities restore. The prpl counterpart
passes 22 causal veto witnesses with its independently recorded workload.
The separate RDK `rescue/report.json` passes with two-hop source and target:
native BTM verification takes 8.428 s and observed settling takes 25.001 s.
The first sampled complete fresh snapshot is 19.245 s after verification;
this is sampling/collection evidence, not the native metric arrival time.
Restoration verifies fresh Default-20 metrics and unchanged native identities.
This is a correctness pass, not proof of near-instant reporting or a fair
cross-stack latency comparison under these host conditions.
The synchronized `rf-rooms.json` passes both 30-second RF-property rooms,
all seven native observations, real traffic and healthy Default restoration.
Default-20 is also observed converged afterward. These targeted passes do
not close the separate geometry or held-pressure failures above.

The bounded `rf-continuation/pressure-held-1400/` experiment increases the
ordinary workload/broadcast payload from 1200 to 1400 bytes, retaining the
1000 packet/s cap, 1400-byte pressure stream and production policy. Utilization
reaches 220/255, but a native candidate HTTP 504 interrupts qualification.
It remains failed, not a pressure-veto pass; Default-20 RF, associations,
fresh metrics and native identities restore. No higher packet-rate default
or relaxed pressure hold is adopted from this experiment.

Geometry reports retain browser/lab identities and a bounded host
CPU/load/temperature/process trace. Use a separate browser machine with `--host`
and reachable room/topology URLs to separate software-rendering overhead from
lab work. Keep `host-monitor.jsonl` with the report; sampling errors fail the
diagnostic gate, without changing native policy or convergence assertions.

Load-action reports also retain production thresholds, evaluated and missing
subject cycle counts, decision-reason counts, peak decision-evidence utilization
and the last subject decision. Failures print these diagnostics: an unmet load
precondition must not be confused with a failed native steering request. These
observations never change the pass/fail gates.

The load fixture optionally adds real non-IP broadcast frames using
`--background-packets-per-second 200` (bounded to 1000/s, 1400-byte payloads,
105 seconds). Frames traverse an existing AP's wireless interface; no metric
value or PHY-rate mask is written. The source AP is the default. Experimental
`--background-ap gateway` uses a separate co-channel AP and a recorded,
restorable 35 dB gateway/source radio link at 2437 MHz, without changing
backhaul or target-channel RF. Optional `--pressure-snr`, `--rescue-snr`,
`--pressure-payload-bytes`, `--pressure-access-category` and `--pressure-pattern`
control only the real workload/RF stimulus, never policy thresholds. Periodic
endpoint progress survives failed runs without claiming completed traffic.
Workload failure, missing pressure and native-policy failure remain distinct.

The recommend-only counter-manifest explicitly prepares its traffic subject's
physical association before Play, verifies the controller agrees, and restores
the original association. That setup is recorded as a fixture, not optimizer
steering evidence; echo delivery and native counter checks still must pass.

`gen/tests/run-easymesh-suite.sh rf --yes-act` runs the focused contracts,
viewer coverage, documentation, the bounded two-room live check, named-manifest
recommend-only operation and native counter shadow acceptance. The
existing static section also discovers the new pytest tests. The rooms
section includes the same live check alongside its broader catalog tests;
use `rf` alone for this work, not a full catalog/soak.

The standalone [live runner](https://github.com/boardfarmdevs/meta-cmf-bananapi-vcpe/blob/main/gen/tests/rf-property-rooms-smoke.py)
uses the normal lease/revision protocol, refuses a held lease or suite room
guard, saves timestamped samples and traffic phase results, and restores the
paused Default in `finally`. It never starts another optimizer, retunes radios
or changes daemon modes. A timeout, missing native activity, failed traffic
phase or failed restoration is a failure, not a skipped pass. All raw samples
and failures belong under `test-results/`, outside this documentation tree.

Focused regression covers counter thresholds, zero/missing distinctions,
transport/skew/age/owner/epoch exclusions, hold reset and advancing counter
reports, default signal rescue, band-profile separation, provider ownership
and reset handling, reproducible room compilation, asymmetric direction,
traffic phase scheduling, generated catalog equality, viewer coverage and
documentation navigation. Existing RF contract/survey, native capture,
backhaul and Console tests cover the other observation boundaries.

Live qualification is deliberately narrower than this inventory: room load,
playback, native observations, bounded traffic and restoration. Positive
different-channel balancing with the counter guard, all selected Console
diagnostics, optional fading/interference/`-F`/`-Q` modes and every catalog room
still require their own live evidence. Unit fixtures prove policy behavior,
not congestion or live steering. No all-properties-live-qualified claim is
made here; consult each saved check's per-room failures and observations.
