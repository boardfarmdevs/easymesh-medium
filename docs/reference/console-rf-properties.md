# RF properties: simulation and observation

This is the Console NG field guide, also available offline through **RF
properties** in the console header. The console **observes**, never changes RF.
Open **Control services & sources** to see which optional modes this daemon
actually runs. A supported capability does not mean its mode is enabled.

For each property below, **Model** identifies its producer, **Observe** gives
the console location, and **Boundary** explains what the observation cannot
prove. Configured inputs, medium outcomes, driver surveys, native reports and
controller decisions are different evidence; missing or stale is never zero.

## Shared RF observations

The room's **RF inspector → RF property catalog** and Console NG's **RF**
details use the same generated property definitions: scope, units, source
category, activation requirements and potential policy usage. Definitions are
not proof that a running feature is enabled. Actual modes remain in Services.

The room publishes native BSS load and client activity from the existing
receiver independently of candidate queries, coalesced to at most two updates
per second. No browser read starts a scan, AP query or RF write. The collector
does not depend on Console NG or an open browser. Load-aware steering remains
opt-in; **Optimizer decision** shows the historical values actually used,
not the latest inspection sample.

- Room `GET /api/demo/rf-catalog` returns property and wire-allocation metadata.
- Room `GET /api/demo/rf-observations` returns the cached inspection with an
  `easymesh.rf-observations.v1` envelope. Records carry units, identity,
  provider epoch, source/transport, receipt time, age and explicit validity.
  This normalized projection is built from cached rows on demand, outside
  the event lock; live events retain compact rows rather than repeated metadata.
- Room `GET /api/demo/mesh-layout` and `/api/demo/observer` carry the same
  AP-load projection for topology and Console NG; they omit client-activity
  records to keep these frequent reads bounded.
- Console `GET /api/v2/rf-catalog` serves embedded metadata without collection;
  `/api/v2/overview` exposes the existing cached room source. Rebuild the
  Console binary after changing embedded assets.

Reports expire after five seconds. A fresh native BSSID/device report can
remain visible while the inventory join is unavailable: radio, channel and
frequency then say **unverified**, and client activity is withheld. Such a
report is not valid policy evidence. Native report windows are unknown; receipt
time is not measurement duration. Native packet/byte/retry/error rates retain
their actual counter-delta window. Valid zero remains zero; unknown is not zero.
Record validity describes publication time; readers must also check current
receipt age, including when replaying or inspecting a stopped session.

Snapshots 1/2 remain compatible. The optimizer's `Snapshot.rf_observations()`
accessor projects existing load/activity for inspection without changing
policy state. The envelope does not yet unify signal, scans, modeled surveys
or backhaul paths; their existing configured/native/decision views remain
authoritative. The protocol registry reserves existing IDs, including detail
opcode 17/capability bit 16; it allocates no new medium operation.

This integration is implemented in both source trees; runtime deployment and
room acceptance are separate gates. No current room-test result is claimed.

## Frequency, band and channel

- **Model:** hwsim supplies the transmitting channel context. The patched
  medium schedules independent frequencies and rejects off-channel receiver
  candidates. One RDK radio can have several concurrent frequency contexts.
- **Observe:** table Band/MHz filters, expanded radio/frequency rows and RF
  context details; Traffic reports off-channel drops. MAC addresses identify
  radios, while VIF/BSSID aliases appear in Evidence.
- **Boundary:** a maintained context is historical activity, not proof that
  every VIF is currently tuned there. A band label does not prove capacity.

## Channel width and PHY fidelity

- **Model:** the qualified airtime/survey provider uses **legacy 20 MHz**
  contexts. Modeled selected-rate metadata is returned to hwsim; Linux rate
  flags are handled without claiming calibrated modern PHY behavior.
- **Observe:** Load lists published radio contexts, provider and epoch;
  Services lists the medium fidelity profile. Traffic shows outcomes rather
  than an invented negotiated PHY speed.
- **Boundary:** HT/VHT/HE/EHT capacity, bonding, MIMO streams, OFDMA and MLO
  are not faithfully simulated by these legacy airtime numbers.

## Directed SNR

- **Model:** each source→destination pair has an SNR input in dB. A matching
  exact-frequency override wins over the pair fallback. Reverse-direction
  values can differ. Atomic writes advance the medium generation.
- **Observe:** Configured RF pairs or Directed RF matrix; select a destination
  and frequency for forward/reverse readbacks. RF separately lists the
  observer-start baseline, current pair and effective-frequency value.
- **Boundary:** last-packet SNR is not necessarily the current input. Matrix
  pages from different generations cannot form one verified snapshot.

## Distance, walls and movement

- **Model:** the room/configurator converts distance, per-band reference SNR,
  path-loss exponent, crossed-wall attenuation and optional seeded shadowing
  into bounded SNR values.
  Motion generates new frequency-qualified values; wmediumd consumes those
  values, not the room geometry itself.
- **Observe:** Room coordinates arrangement, RF readbacks and Services writer
  generation. The room viewer remains the place to edit positions.
- **Boundary:** walls are an attenuation model, not ray tracing, diffraction,
  multipath, Doppler or a calibrated building propagation measurement.

## RSSI and RCPI

- **Model:** the medium derives receive signal from link SNR plus its fixed
  noise reference, with optional fading/interference adjustments. Patched
  hwsim/native reporting paths expose signal to the mesh stack. RCPI is the
  stack's normalized representation, not another independently measured RF input.
- **Observe:** Traffic shows last signal in dBm and last SNR in dB; RF shows
  the configured SNR. Use topology/room metrics for native RCPI reports.
- **Boundary:** received signal, candidate matrix lookup and native report
  freshness must not be conflated. The console does not issue candidate queries.

## Noise reference and CCA

- **Model:** current daemon constants are **−91 dBm noise reference** and
  **−90 dBm CCA threshold**. The threshold gates candidate reception and
  radio-local visibility. These are fixed model references, not measurements.
- **Observe:** Services reports the compiled constants; Traffic distinguishes
  CCA drops from PER and off-channel drops.
- **Boundary:** there is no independently calibrated noise-floor generator,
  adjacent-channel spectral leakage or noise survey. Do not derive a measured
  noise floor by subtracting reported SNR from signal.

## Packet error probability and loss

- **Model:** in the normal SNR model, frame length, modeled legacy rate and
  effective SNR determine error probability. Random delivery decisions produce
  actual failed attempts. Upstream error-probability/path-loss modes are
  identified separately by the daemon; rooms normally use the SNR matrix.
- **Observe:** Traffic shows last PER, attempts, retries, ACK/no-ACK, injections
  and separate PER/CCA/interference/off-channel/no-receiver drop counts.
- **Boundary:** last PER is not a measured average loss percentage; TX attempts
  and receiver candidates are different counting boundaries. Packet loss alone
  does not establish why an application stalled.

## Fading and interference

- **Model:** optional daemon fading perturbs effective signal. Optional
  per-frequency interference accounting affects modeled receive outcomes.
  Neither feature should be assumed enabled merely because its code exists.
- **Observe:** Services exposes fading coefficient and interference-enabled
  state. Traffic shows last effective signal/SNR and interference outcomes.
- **Boundary:** this is not a spectrum analyzer, independently adjustable
  thermal noise, calibrated hidden-terminal collision model or physical fading
  trace. A zero coefficient means no configured fading perturbation.

## Airtime, busy time and spatial visibility

- **Model:** actual submitted frames, retry attempts and modeled legacy
  transmission durations feed occupied-time accounting. Wait/backoff is not
  counted as transmitted airtime. Global frequency occupancy and each radio's
  sensed busy time have different scopes.
- **Observe:** Load shows global channel windows plus published radio-local
  active/busy microseconds, source, provider and context epoch.
- **Boundary:** a radio-local value cannot be replaced by a global percentage.
  Occupancy is modeled airtime, not calibrated goodput or available capacity.

## Visibility-aware contention

- **Model:** optional `-F` enables conservative visibility reservations and
  spatial reuse. Reception visibility derives from directed RF state; the
  normal scheduler remains distinguishable from this opt-in behavior.
- **Observe:** Services reports Visibility contention and the survey fidelity
  profile; Load provides the resulting radio-local survey publication.
- **Boundary:** not receiver-local collision/capture physics or full EDCA.
  Opening the console never enables this mode.

## Channel utilization

- **Model:** the survey bridge publishes valid active/busy counter contexts
  into the hwsim RF survey ABI. Native HAL/OneWifi consumes these observations.
  Utilization is busy/active over an identified interval; native AP reports
  encode a byte from 0 to 255.
- **Observe:** Load keeps global occupancy, radio-local published counters and
  native BSS-load records separate. A native byte is displayed as
  `100 × byte / 255` percent. The bridge's cache expires after one second;
  the inspector does not query whether the driver consumed it.
- **Boundary:** a valid zero means idle in that window; missing, resetting,
  unsupported-width or stale means unavailable. Native receipt time does not
  reveal the stack's exact measurement window.

## Synthetic utilization fixtures

- **Model:** an explicitly configured fixed-utilization bridge fixture can
  publish a selected byte independently of offered traffic. This tests field
  propagation, encoding, queries and thresholds, not congestion performance.
- **Observe:** Load identifies `synthetic-field-test` rather than modeled
  airtime, alongside the actual provider contexts and native reports.
- **Boundary:** high fixture utilization must not be described as a congested
  RF medium or as throughput pressure created by wmediumd.

## Native BSS load and station count

- **Model:** the mesh agent builds native AP Metrics reports from its platform
  observations and association state. The room's existing RF collector caches
  these; Console NG does not send additional AP-metric queries.
- **Observe:** select an AP radio, then Load: BSSID, utilization byte/percent,
  station count, report age, source and epoch. VIF/BSSID correlation matters
  because several BSSs share one underlying radio.
- **Boundary:** station count is per BSS, not channel airtime or the size of
  the configured container pool. Counts from several BSSs must not multiply
  one shared radio's utilization. Disabled native collection stays unavailable.

## Advertised beacon BSS Load

- **Model:** hostapd produces the actual beacon IE. A selected AP→receiver
  frequency window parses the bounded header/IE data already processed by
  wmediumd; no capture process is spawned. It retains BSSID, station count,
  utilization byte and available admission capacity.
- **Observe:** choose an AP source, receiver and exact MHz; open Load and
  wait for a fresh beacon. Traffic lists beacon subtype counts and recent
  header outcomes. Admission capacity is in **32 µs/s units**.
- **Boundary:** a native AP Metrics report is not proof of a beacon IE.
  Processing a beacon candidate is not proof of successful reception.
  Admission capacity may be an unqualified platform value, not free bandwidth.

## ACK direction, retries and rate outcomes

- **Model:** the reverse ACK link has its own RF success decision, so data
  delivery can succeed while the sender retries after a lost ACK. Rate/retry
  information originates with mac80211 and is consumed by the medium.
- **Observe:** RF forward/reverse values; Traffic ACK/no-ACK, attempts/retries
  and RX injections. Correlate native counters separately in the topology.
- **Boundary:** summed TX and RX counters double-count different events.
  A monitor trace, modeled legacy rate or successful ACK does not prove modern
  PHY throughput, nor does every modeled ACK appear as a captured radio frame.

## Frame classes, multicast and discovery

- **Model:** real hwsim management/data/control submissions are forwarded
  according to frequency and learned VIF/radio receive eligibility. A multicast
  submission can produce many directed receiver-candidate records.
- **Observe:** table frame-class filter, fan-out toggle, per-radio counters;
  select a path for leased TX/RX subtype histograms, EAPOL counts and recent
  header metadata. There are at most eight 15-second selected windows, each
  retaining 16 headers without payload.
- **Boundary:** a maintained path is not a connection or an association.
  No detailed history exists before selection; header-ring overwrites and
  unavailable observations must remain visible.

## Access categories and scheduling delay

- **Model:** optional `-Q` priority admission plus the lab's classification
  support prioritizes bounded control traffic. Per-frequency queueing and
  scheduler deadlines remain host processes, not physical RF clocks.
- **Observe:** Services shows Priority queues and endpoint handler cost;
  Traffic shows last access category. Summary exposes queue depth and
  scheduler/netlink counters through Evidence/Services.
- **Boundary:** not calibrated EDCA, WMM admission, ESP or a zero-overhead
  timing guarantee. CPU contention/netlink rejection is infrastructure evidence,
  not an RF impairment to hide as a weak signal.

## Room exclusion and fronthaul availability

- **Model:** a room with 20 clients still has 100 bound client containers and
  hwsim radios. Excluded clients receive low-SNR gating plus explicit client
  disconnection. Extender fronthaul presence is distinct from its backhaul.
- **Observe:** Client pool counts and Excluded pool filter; RF shows requested
  disconnection, fresh room presence and directed readback. Traffic may still
  show management submissions, retries and receiver candidates.
- **Boundary:** exclusion does not delete a radio or guarantee silence. A stale
  or mismatched room instance is unknown, never automatically offline.

## Steering and properties not simulated

### Native backhaul explanations

The room RF inspector, topology node hover and Console NG Load tab share
`easymesh.backhaul-observations.v1` under `rf_observations.backhaul`.
They show the actual controller parent/path, wireless hops, frequency and
fresh native signal/load where an exact parent-BSSID/device/context join exists.
Missing parents, cycles, conflicting parents and stale topology invalidate the
path. Retunes invalidate load joins until a new report arrives. Geometry and
configured SNR never fill missing native measurements.

RDK `/api/v1/bsses` now includes backhaul AP radio/channel identity. Only known
AP-mode records qualify; station-mode copies cannot establish an AP context.
This changes observation coverage, not client steering eligibility.

Repeated same-frequency hops flag potential contention, not additive utilization
or an inferred capacity/bottleneck score. Backhaul traffic remains unavailable
until a qualified backhaul counter window exists; client traffic is not a
substitute. These cached joins issue no additional native queries and never
change optimizer ranking. Signal values without measurement timestamps remain
unknown even when the topology itself was just polled.

BTM/non-BTM actions, roaming, parent choice and band steering are native mesh
or optimizer decisions, not RF properties invented by the observer. Use the
room/topology views for decisions and actual associations. Console NG explains
the medium inputs and outcomes that accompany them, not optimality by itself.

Independent transmit-power/noise calibration, receiver-local collisions,
realistic interference spectra, ESP/service capacity, modern PHY capacity and
physical-radio measurements remain outside the qualified legacy RF model.
Consult the [RF assessment](virtual-rf-assessment.md) for development scope,
not as a claim that every planned feature is active.

## Implementation sources

- [Medium patch series](../../../../gen/wmediumd/patches/) implements channel,
  signal, ACK, airtime, visibility, priority and read-only observer behavior.
- [World compiler](../../../../gen/wmediumd/configurator/wmdcfg/world.py)
  generates room RF inputs; [survey bridge](../../../../gen/wmediumd/configurator/wmdcfg/survey_bridge.py)
  publishes the driver-facing modeled observations.
- [Room integration](../../../../gen/demo/room_demo/interactions.py) exposes
  read-only intent and exclusion; [Console manual](../../guide/wmediumd-console-ng.md)
  describes collection limits, freshness and navigation.
