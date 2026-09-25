# RF property demonstration coverage

[Radio reference](README.md) · [Room catalog](../rooms/catalog.md) ·
[Field guide](console-rf-properties.md)

This is the maintained RDK property-to-room contract, not a declaration that
every room or daemon mode is live-qualified. The complete property inventory
is `PROPERTIES` in [rf_observations.py](../../../../gen/optimizer/optimizer/rf_observations.py).
[rf_coverage.py](../../../../gen/optimizer/optimizer/rf_coverage.py) adds named
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

The new optional [counter-guard policy](../../../../gen/optimizer/configs/load-counter-guard-policy.yaml)
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
[native-counter-guard-room-profile manifest](../../../../gen/demo/manifests/native-counter-guard-room-profile.json)
selects `rf-asymmetric-ack`, its real client binding and the opt-in policy.
Stop the room service before operating it; never start a second actuator:

```sh
gen/demo/room-demo interactive --mode recommend --profiling \
  --manifest gen/demo/manifests/native-counter-guard-room-profile.json
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

Source anchors are the [world compiler](../../../../gen/wmediumd/configurator/wmdcfg/world.py),
[native load provider](../../../../gen/optimizer/optimizer/load_observer.py),
[load policy](../../../../gen/optimizer/optimizer/load_policy.py),
[medium patches](../../../../gen/wmediumd/patches/) and
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

## Native counter pressure qualification

The initial asymmetric room produced partial echo delivery but zero AP
retries/TX failures/RX drops. This is not a Banana Pi HAL mapping stub:
`rdk-wifi-hal/platform/banana-pi/platform.c:1179` maps
`NL80211_STA_INFO_TX_FAILED`, `RX_DROP_MISC` and `TX_RETRIES` to
`cli_ErrorsSent`, `cli_RxErrors` and `cli_RetransCount` respectively.
OneWifi `source/apps/em/wifi_em.c:363` copies these into STA traffic stats;
`source/webconfig/wifi_easymesh_translator.c:1966` exports errors/retransmissions.
`optimizer/load_capture.py` decodes native TLV `0xA2`; `load_observer.py`
derives bounded deltas, not medium counters. Paths/lines identify the inspected
RDK 6.1 build sources; the wifi-emulator platform is not this active HAL.

The medium's `0022-wmediumd-independent-reverse-ack.patch` uses rate index zero
and a ten-byte reverse ACK. The room's approximately 5 dB near-AP reverse SNR
can still carry that robust ACK while long uplink data is lost. Frames never
injected into the AP need not increment kernel RX drops. Held reverse-loss
mode remains unsupported/unqualified; this experiment adds no native
counter-mapping patch.

The bounded [native counter acceptance](../../../../gen/tests/native-retry-counter-acceptance.py)
adds stronger supported *pulsed* downlink/ACK impairment on the currently
associated Default client, independent of room geometry. It compares kernel
and native deltas, confirms ownership before/after each trial, restores exact
frequency overrides and restarts the unchanged room service:

```sh
PYTHONPATH=gen/optimizer:gen/wmediumd/configurator python3 gen/tests/native-retry-counter-acceptance.py \
  --stack rdk --yes-change-lab --seconds 8 \
  --shadow-counter-policy gen/optimizer/configs/load-counter-guard-policy.yaml \
  --output /tmp/native-counter-shadow-new
```

Shadow checks replay consecutive actual native reports at receipt time through
the **same** counter evaluator used by load policy. They retain message IDs,
monotonic windows, raw deltas, transport, actual medium instance and association.
No utilization, RCPI, hop count or target is invented. `clear` means only
counter eligibility; `pressure` vetoes load balancing. This is not a complete
load-steer qualification or proof that a quieter AP repairs the impairment.

The helper records counter qualification, RF/association/service restoration
and final room health separately. Its bounded read-only health check must
recover the initial expected client count; starting a service alone is not
proof of healthy ownership. The tested association is checked before resuming
the room optimizer, which may legitimately steer afterward.

RDK demo-a follow-up observed kernel-matched ACK-loss deltas of 1,229 retries
and 63 TX failures; a native 157/s retry window exceeded the unchanged 100/s
limit. Data-loss also produced pressure; baseline/recovery checks were clear.
RX drops remained zero; its positive-pressure case is unit-only. TX failures
were nonzero but below the configured 10/s veto. Raw evidence is retained in
`test-results/rdk-rf-counter-followup/native-2.json`, not embedded here.

## Native load action qualification

The `rf-actions` suite section runs three separate bounded cases on healthy
paused Default-20: guarded load balancing, retry-pressure suppression with an
otherwise eligible quieter target, and weak-signal rescue despite pressure.
Use `gen/tests/load-policy-acceptance.py --help` for direct diagnostics.
The optional `--policy` selects the checked-in counter-guard policy;
`--counter-case clear|pressure|rescue` selects the case.

Only the target private 2.4 GHz radio changes channel. Real UDP demand and
read-back-verified pulsed downlink loss provide stimuli, never fabricated
native utilization/counters. Thresholds and hold times remain unchanged.
The driver requires fresh native evidence, captured source/target-specific
BTM transitions, native ownership and receiver data after verified steering.
Pressure must veto an otherwise safe target across advancing counter reports.
Missing evidence or insufficient load cannot pass.

The action deadline and the following twenty-second settling observation are
separate bounded windows. Cleanup restores channel, exact RF overrides,
client frequency lists/associations, owned traffic/routing and room service;
fresh Default-20 and unchanged native process identities are required.
Detailed JSON/JSONL remains in guest `test-results/rf-actions-*` when run by
the suite. Earlier failed runs remain separate evidence.

### Current action evidence and remaining gates

These bounded diagnostics preserve production policy thresholds and are not
clean-source release acceptance. Clear-case suite traffic uses
two real 12 Mbps senders with 1,400-byte payloads; actual native occupancy,
not requested traffic, determines eligibility.

| Case | RDK | prpl |
| --- | --- | --- |
| Clear counters, quieter different-channel target | Pass with actual source-AP broadcast demand: utilization 213 versus target 9, unchanged ten-second hold, clear counters, matching BTM, 3.419 s target verification, delivered traffic and fresh Default restoration. | Pass: utilization 213→16, RCPI 148→144, matching BTM, 0.681 s native verification, 74 positive post-verification receiver intervals and 20.68 s settling. |
| Retry-pressure veto | Earlier pass: utilization 241/11, 182 retries/s, three causal vetoes, no BTM and 21.99 s settling. Latest two-hop repeat fails stimulus qualification; see follow-up below. | Two 1400-byte repeats pass: first qualified source/target loads 215/13 and 210/14, retries 128/s and 132/s; 14/15 causal vetoes, no BTM and twenty-second settling. The 512-byte repeat fails stimulus qualification. |
| Weak-signal rescue during pressure | Latest repeat passes: RCPI 102→144, 7.849 s observed hold against the unchanged five-second minimum, matching BTM, 3.489 s target verification and 20.25 s settling. | Repeat passes: RCPI 102→144, unchanged 5.041 s signal hold, matching BTM, 2.033 s target verification and 20.56 s settling. |

All action runs restored RF, channels, associations and Default-20 without
native process changes. prpl's subsequent 90-second traffic/memory check,
after 20 seconds warm-up, measured zero controller or fronthaul RSS growth:
controller 43.07 MiB, fifteen fronthauls at most 14.36 MiB. This check had
20 active clients, not a new 100-client qualification.

Raw evidence is under `test-results/guarded-load-followup/` in each checkout.
`rdk-clear-2-read-only-audit.json` replays the saved decisions and hashes the
original evidence; it is not a fresh rerun. Next isolate background occupancy
from the impaired subject and preserve its ownership long enough to observe
the production hold. Never lower thresholds, fabricate load or credit an
uncommanded roam. `rf-actions` remains a qualification gate with known failures,
not an all-green regression claim.

## Room catalog qualification and open failures

Current bounded RDK fixes and preserved failures are listed in
[room acceptance](../testing/room-acceptance.md#candidate-admission-and-isolated-beacons).
All three geometry rooms now pass together with enabled HAL 0044, including
isolated backhaul beacons, traffic, Default restoration and unchanged native
identities. Counter-manifest and guarded clear also pass; the latter uses
actual source-AP broadcast traffic and verifies native BTM in 3.419 seconds.
The original full suite remains **81 passed, six failed, one skipped**;
targeted fixes do not rewrite its results. Cold candidate completeness and
cross-run repeatability remain open. Both failed
ordinary RF rooms now pass a fresh load/Play/convergence rerun, including healthy
Default restoration and unchanged native identities. The failed soak ran zero
churn workloads; its subprocess diagnostics are now retained.

prpl's newer suite passes all geometry rooms. Its five ordinary-room loading
failures pass a targeted rerun after adding the trusted `/usr/local/bin` client
tool path. Its new pressure/rescue qualification passes with real source-AP
broadcast demand and partial-loss voice traffic; this is not RDK qualification.

### Bounded qualification follow-up

Evidence lives under `test-results/qualification-followup/` on each canonical
checkout; older failed reports are retained unchanged.

- Browser cue expiry passes ten offline repetitions per stack. Each expired
  cue is removed immediately; one animation-frame relayout replaces repeated
  synchronous layouts. The six-second lifetime and eight-second test bound
  are unchanged. Run headless browser tests with `DISPLAY` unset.
- RDK's explicit 100-client preflight passes initial/final full health,
  ownership, traffic, native RCPI and process checks without native restarts.
  The repeat after native 0208 deployment takes 154.755 seconds, with 100/100
  traffic success, zero added medium drops and a converged Default-20 afterward.
  Evidence: `qualification-followup-final-preflight/20260924T170721Z-p0-preflight/`.
  The new `--soak-preflight-only` suite option records `soak/p0-preflight`,
  zero churn workloads and `acceptance_eligible:false`; it cannot claim a soak.
- Native 0208 reports terminal partial/empty candidate responses separately
  from transport loss. Existing receipt timestamp/MID/RUID identify completion;
  no new data-model members or fabricated measurements are added. The CLI
  returns HTTP 503, `native_completed:true`, valid rows and missing keys rather
  than waiting for absent rows after native completion. Genuine transport loss
  retains the eight-second HTTP 504 bound. Extracted native/HTTP fixtures pass;
  native and CLI builds pass and are hot-installed with verified rollback
  copies. One live partial response reports its missing keys in 604 ms.
  The underlying intermittent HAL omission remains unproven. 0193 is preserved
  and retry candidate 0206 remains held.
- After controller replacement, the first room service attempts encounter
  inactive-client preflight while the model repopulates. The first HTTP-ready
  branch test reaches ten healthy clients but complete candidates for only
  nine (38 measurements); no clients exceed the policy margin. It correctly
  fails before Play and restores Default successfully. This is not a cold
  convergence pass. Both stacks' topology UIs serve the corrected expiry asset.
  The incomplete client is `sta_static_04` (`02:00:00:00:06:00`), still associated
  to Ext-1 with RCPI 134. The prompt partial reply demonstrates the contract fix;
  it does not establish the cause of that client's missing candidate coverage.

The newer `test-results/cold-metrics-followup/` repeats remain red. Branch
initial convergence eventually passes, but moving the leaf extenders leaves
all four backhaul stations disconnected during the observation window, despite
operating backhaul/fronthaul APs. The earlier warm three-room pass therefore
does not establish repeatability. Isolation and parent-handover repeats stop
before Play with only 9/10 and 8/10 clients candidate-complete; both restore
Default within the unchanged gate. All native process identities are unchanged.
The branch run misses its restoration gate but later returns to healthy,
converged Default-20; that later recovery does not rewrite the failed verdict.
Native logs and `rdk-candidate-failures.json` separate admission-busy/not-ready
503s, a terminal partial response and real 504s. Backhaul disconnection is a
separate failure from incomplete initial measurements, not a rendering delay.
The intended 13-dB branch links exceed the native candidate floor (RCPI 50),
so lowering native thresholds or changing the room again is not justified by
these observations. Rev140 also runs two unrelated VMs with elevated host load;
they remain untouched, and contention is context rather than a proven cause.

The pressure harness compares the real policy with a non-actuating shadow on
identical snapshots, changing only counter-guard enablement. A causal witness
requires fresh native pressure to veto the same otherwise eligible target that
the shadow would select after the unchanged ten-second load hold. Unexecuted
proposals never become pending; actual steering/BTM remains forbidden throughout
the twenty-second negative settling window. Continuous pressure for ten seconds
is not a production-policy requirement: intermittent pressure resets its hold.
The subject must remain on the source AP throughout; disappearance or an
uncommanded roam fails the negative check rather than counting as a veto.

prpl's repeat-qualified fixture uses two offered 12-Mbps, 1200-byte uplinks,
300 offered source-AP broadcasts/s and alternating 2-dB/healthy RF every 250 ms.
Its 512-byte pressure repeat fails stimulus qualification before actuation;
1400-byte CS6 downlink pressure passes twice with 14/15 causal veto witnesses,
no BTM, twenty-second settling and 5,179/5,127 delivered datagrams. The prpl
suite now uses 1400 bytes for pressure only. Rescue retains 512 bytes and a
usable 32-dB serving link, passing again with 2.033-second target verification.
Actual packet rates can be substantially lower than offered demand; only
native measurements qualify the policy. Evidence is in prpl's
`test-results/qualification-repeat/`, including the failed 512-byte attempt.
AQM/Console NG confirm TID7/voice; PHY retry-rate chains were not captured.
No native utilization, counters, thresholds or rate masks are injected. Both
checks restore Default-20, fresh metrics and unchanged native identities.
RDK rescue previously passed the same partial-loss/voice stimulus with 500 source-AP
broadcasts/s. Pressure-only qualification passes with 1400-byte voice payloads
and 1000 broadcasts/s; merely increasing broadcast demand with 512-byte
payloads did not establish the held opportunity. The successful trial records
three causal veto witnesses, stable medium RSS and no additional netlink drops
(76,482 before and after). The suite now supplies these stack-specific fixtures.
A preceding pressure attempt fails source association before any workload and
restores cleanly; such preparation failures are not native-policy failures.
The later `qualification-repeat/qualification-repeat-pressure-2/` does not
repeat that pass: source utilization peaks at 204/255, with only two pressure
decisions in 22 cycles and no fully held shadow opportunity. Its source has
two backhaul hops versus one in the passing trial; the target has one. This
is insufficient stimulus under a different native path, not a demonstrated
policy regression or a controlled latency comparison. No BTM is submitted;
RF, Default-20 and native identities restore successfully. Host contention
and path differences need separate control before making a causal claim.
The first rescue repeat verifies native reassociation in 2.717 seconds, then
fails immediately on post-steer `Error_Not_Ready`. The action driver now uses
the room's existing one-second bounded admission retry for explicitly refused,
unsubmitted requests. It records `native_admission_wait_seconds`; transaction
timings include any wait. HTTP 504, generic 503 and terminal partial results
are not safe admission retries. Policy, action and observation gates are unchanged.
The next `qualification-repeat-rescue-admission/` passes: 3.489-second native
verification, 20.25-second settling and the first complete fresh snapshot
sampled 16.856 seconds after verification. This two-hop-to-one-hop run has
49 successful queries and no busy response, so it does not itself demonstrate
live recovery through the new retry branch. Unit tests cover both explicit
refusal codes and rejection of other errors. Cleanup restores all native
identities, RF and fresh Default-20; no native binary is changed by this fix.
Stopping the room restores the full provisioned pool: saved setup snapshots
contain 100 native clients, not twenty. Only two generate explicit unicast
workloads. New reports expose `native_clients_at_workload_setup`; these are not
isolated two-station RF environments.

### Earlier campaign evidence

The earlier bounded campaign checks **24 ordinary rooms plus three
geometry/backhaul rooms** on each stack. Ordinary rooms exercise load, initial
policy convergence, Play, native associations/traffic and the two browser views.
Passing the configured steering policy does not mean every client must be on
the mathematically strongest AP: hysteresis, eligibility and dwell still apply.

| Gate | RDK | prpl |
| --- | --- | --- |
| Ordinary catalog | 24/24 passed in `catalog-rdk-2/report.json`, with healthy Default-20 restoration and unchanged native identities. Recovered native 503 queries remain recorded performance events. | 19/24 passed initially in `catalog-prpl/report.json`; all five failures then passed in `band-prpl-fixed/report.json`, including Default restoration and unchanged native identities. This is combined evidence, not one clean full-catalog pass. |
| `backhaul-branch-formation` | Failed initial 60-second convergence **before Play**: ten clients present, only 36/40 candidate observations and nine clients checked at the deadline. Default restoration passed. | Feature checks passed in the combined geometry run. |
| `backhaul-parent-handover` | Scenario and Default restoration passed. | Feature checks passed in the combined geometry run. |
| `backhaul-isolation-recovery` | Failed initial convergence **before the outage was played**: incomplete candidate coverage (34/40, seven clients checked). Default restoration passed. This does not establish an outage-recovery failure. | Failed after return: nine of ten room clients reported; later Default only 17/20. Ext-4's reported 6 GHz inventory was absent and final recovery failed. |

The prpl ordinary-room load failures affected `band-ap-counter-roam`,
`band-upgrade-24-5`, `band-upgrade-5-6`,
`received-discovery-recovery` and `received-same-band-roam`.
Privileged clients share the guest's user namespace; blindly re-entering it
with `nsenter --user` returns `EINVAL`. The shared band-settings fix compares
namespace identities, omits that flag only for a verified shared namespace,
and retains it for RDK's unprivileged clients. Missing identity fails closed;
PID/start-time checks and mount/net/PID/root/working-directory entry remain.

Both browser drivers now await completed fullscreen entry/exit. This prevents
selecting the hidden Play button or toggling fullscreen back on during cleanup.
The original prpl catalog also failed restoration through that harness race;
a separate restoration receipt and targeted rerun record recovery. Original
reports are not rewritten as passes.

The prpl geometry failure is distinct from the repaired band-settings issue.
All mesh nodes recovered connectivity and their fronthaul APs remained present.
The three missing Default clients still had kernel links on Ext-4's 6 GHz BSSs
and each passed three probes; reporting nevertheless omitted them. Native
inventory versus adapter reconciliation was unresolved in that run, not an
assumed RF/association loss. Manual restart of **Ext-4's native processes only** followed
the failed run; subsequent room startup failed its inactive-client preflight.
That manual action is not automatic recovery or test acceptance.
The newer synchronized prpl run passes all three geometry rooms and Default
restoration without changing native identities; it does not rewrite this failure.

Evidence in each checkout remains under `test-results/guarded-load-followup/`:
ordinary reports above; RDK `backhaul-rdk/`,
`backhaul-parent-handover-rdk/`, `backhaul-isolation-recovery-rdk/`;
prpl `backhaul-prpl/`, `catalog-prpl-restoration.json`,
`prpl-isolation-topology.json` and `prpl-manual-recovery.log`.
These diagnostics used recorded working-tree fixes and are **not fresh-import,
clean-source VM acceptance**. Preserve their identities and failed evidence.

### Next build and test gates

1. Runtime sources are synchronized to RDK `2d64df1` and prpl `76b8569`, with
   previous guest edits preserved in named stashes. New working-tree changes
   still need a committed checkpoint before clean-suite acceptance. RDK's
   hot-installed native components require newly built BPI images for future
   reproducible VMs; current diagnosis reuses the existing VM.
2. The synchronized prpl run passes all three geometry rooms, pressure and
   rescue. RDK's native recovery/reporting qualification remains separate;
   do not substitute those prpl passes for RDK evidence.
3. Qualify RDK cold candidate completeness with the terminal-response contract;
   keep policy/deadlines unchanged. Browser expiry and full-roster preflight
   now pass bounded checks, not a new catalog or soak campaign.
4. Retain prpl's two repeat-qualified 1400-byte pressure fixtures and passing
   512-byte rescue. Recheck RDK pressure/rescue repeatability without
   manufacturing utilization, relaxing thresholds or crediting an unsolicited
   roam as an optimizer action. Keep each stack's qualified workload explicit.
5. Only after those gates, qualify optional medium visibility `-F` and priority
   `-Q` modes separately. Both deployed binaries passed their isolated `-T`
   selftests, but those do not enable or live-qualify either mode.

The new checkpoint and optional remote-access tooling do not fix these remaining
native/fixture issues. Full-suite failures remain visible; no known-failure
exemptions, longer convergence windows or relaxed assertions are added here.

## Cold room initialization

### Native backhaul recovery follow-up

The synchronized branch playback exposes a separate OneWifi recovery defect:
an unrooted former parent and a usable gateway can tie at scan RSSI. After
two timed-out connections, the global retry budget discarded the complete
scan. Rescanning reset all per-candidate counters, repeatedly selecting the
same unusable parent without trying the gateway. Root admission correctly
rejected the former parent; disabling that protection is not the fix.

OneWifi patch `0039-preserve-backhaul-recovery-candidate-budget.patch` retains
the scan during autonomous reconnect timeouts. Existing per-candidate limits
still bound attempts and exhaustion triggers a fresh scan. Explicit preferred
parent/fallback transactions retain their existing limits and timers. Extracted
native regressions fail four new cases before the patch and pass 30/30 after it.
The extender binary builds and is installed on the four test extenders, but
live recovery qualification is not yet complete. One follow-up fails initial
fresh-candidate convergence before Play; the next passes initial readiness
and plays, but only Ext-1/2/3 have rooted paths at the unchanged recovery gate.
Ext-4 remains parentless. Do not credit partial recovery or unit coverage as
successful live branch recovery.

Restarting native extender processes also loses applied reporting policy.
Controller policy readback remains populated, and posting identical policy
through `/api/v1/wifipolicy` skips native dispatch: HTTP success is not proof
of renewed agent delivery. During explicit baseline recovery, the AP reporting
interval was temporarily changed from 5 to 6 seconds and restored to 5;
steering thresholds were untouched. Native serving reports then return.
The patched controller binary was retained; a deliberate controller restart
during recovery changes its process identity, not its code. Held patch 0192
was not enabled. Automatic restart-policy recovery remains a separate gap.

Evidence is under `test-results/synchronized-rf/`: `branch-offhost/` records
the original root-loss failure; `onewifi-recovery-before.json` and
`onewifi-recovery-after.json` record native regressions;
`geometry-recovery-policy-restored/` records the post-patch initial candidate
failure with healthy ten-client links/APs, unchanged native identities during
the check and successful converged Default-20 restoration. Its host trace
averages 80.87% CPU busy (peak 88.47%) at at most 73 °C, with the browser on
another host. Shared-host contention is recorded, not asserted as the sole
cause or hidden by longer deadlines. Unrelated VMs remain untouched.
`branch-recovery-ready-baseline/` records the subsequent partial branch recovery
and missed Default convergence gate; native identities remain unchanged during
that run. Default later has twenty active clients and six nodes, but this does
not retroactively pass the candidate-completeness deadline.

The next bounded checks are retained in `test-results/rf-continuation/`.
`branch-checkpoint/` again stops before Play because fresh candidates are
incomplete. `branch-full/` passes initial readiness and recovers Ext-4 through
Ext-2, but Ext-3 remains parentless at the unchanged gate. Both restore a
converged Default-20 without native process changes during their checks.
Thus the remaining recovery defect is not specific to Ext-4. Native logs show
Ext-3 exhausting its two attempts at Ext-1 immediately before Ext-1 becomes
rooted, then spending full timeouts on other candidates. Faster propagation
of actual authentication/association failure is an investigation, not yet a
qualified fix. Admission, beacons and convergence deadlines remain unchanged.

### Candidate transport retry qualification

The bounded branch packet capture proves that some client candidate queries
receive neither ACK nor response during native backhaul disconnection. Do not
attribute those timeouts to rendering or infer a missing response from
rate-limited journal gaps alone. Backhaul-owned queries and all-rejected ACKs
must be distinguished from missing client-query replies.

Held retry patch 0206 additionally needed cancellation repair: after four
local send failures its MID remained zero, so cancellation skipped clearing
the exhausted retry counter and left the radio pending. The extracted native
regression reproduces that failure and now passes cancellation/reset after
both transmitted and unsent queries, while preserving unrelated radio states.
The four-send/two-second bound, original command deadline and freshness gates
are unchanged; this does not extend an HTTP request's eight-second deadline.

An incremental diagnostic controller build missed header-dependent objects
after the metrics class layout changed. Its handover report is an invalid
artifact qualification attempt, not evidence about retry correctness. The
known-good UAF-patched controller was restored and Default-20 reconverged.
Use a clean native rebuild for header/ABI changes: this Yocto configuration
disables automatic header dependency tracking. Keep 0206 out of normal image
builds until a consistently rebuilt controller passes bounded coexistence
qualification. No ASan campaign or VM rebuild is required for that check.

The subsequent clean build recompiles all 106 controller objects and its
AL-SAP dependency, retains UAF 0193, and passes Default-20 readiness before
`rf-continuation/retry-clean-handover/`. That check still fails initial room
readiness before Play: all mesh nodes have parent/root traffic and operating
APs, but the model shows nine clients and only four complete client candidate
sets. Default RF restores, but full recovery also misses its 60-second gate.
Native identities remain unchanged throughout the check. This does not prove
retry causality or return-handover safety; 0206 remains held, and the previously
qualified UAF-patched controller is restored afterward. Retry/cancellation,
admission, terminal completion/HTTP and documentation regressions all pass.
After rollback, Default-20 again has a healthy complete model and converged
fresh candidate coverage. That later recovery does not change the failed
test verdict. Diagnostic source changes are reverted to the enabled recipe;
clean rebuilding removes objects compiled against the held retry class layout.

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

The standalone [live runner](../../../../gen/tests/rf-property-rooms-smoke.py)
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
