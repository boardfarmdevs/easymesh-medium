# wmediumd console ng manual

Console NG is a **read-only medium explorer**, not an EasyMesh controller.
It combines an interactive 3D view, a collapsible radio/path table and a
properties inspector. Open the existing VM-specific **wmediumd console URL**;
the port does not change. The **Manual** link opens this guide inside the
console, without internet access.

**RF properties** opens the [simulation and observation field guide](../reference/radio/console-rf-properties.md):
every supported RF property, its producer, where to observe it, optional modes
and fidelity limits. The observer itself does not simulate or change RF.

## First look

1. Start with **Observed packet paths**. Expand a radio, then its frequency.
2. Click a device or path. Choose a destination and exact frequency for
   directed RF readback. Forward and reverse values can differ.
3. Open **Traffic** for outcomes and selected frame types; **Load** for
   surveys, native BSS-load reports and observed beacon information.
4. Open **Control services & sources** to inspect collection cost, endpoints,
   generations, runtime modes and configuration/binary hashes.

Names match the identity inventory used by the lab. MACs are hidden by
default; **Show radio MACs** and **Evidence** expose them. A name is a label,
not a join key. Correlation uses radio identities, VIF ownership and containers.

## Three synchronized views

**3D:** drag to orbit, right-drag to pan, wheel to zoom. Click a labeled radio
to inspect it. **Fit view** resets framing. **Medium / band layers** places
mesh radios above a stable client grid; height reflects the displayed frequency
context, not physical elevation. A multi-band radio still has one marker;
the table exposes its separate contexts. **Room coordinates** follows the
matching room's current positions and walls, without controlling that room.
Missing or mismatched room evidence falls back to the medium arrangement.
Excluded radios are parked in a separate grey grid beside the room; those
display positions are not physical/RF coordinates. Use **Room clients** to
hide the parked pool and **Fit view** to enlarge the active scene.

Edges have arrows and show directed medium paths, **not mesh associations**.
Initially only recent paths are drawn. Selection focuses edges; **All filtered
paths** draws at most 200. Multicast fan-out is separately optional. Particles
illustrate measured TX activity, not individual captured packets. Reduced-motion
preferences disable them. Grey denotes unknown/stale SNR; red/yellow/green use
15/25 dB thresholds. Endpoint colors identify device roles, not signal quality.

**Table:** source radio → exact frequency → destination. Search names, MACs
or containers; filter by band, frequency, role, presence, activity, last frame
class and minimum SNR. Sort applies before virtualized rendering. Arrow keys
navigate; left/right collapse/expand; Enter selects. This is also the complete
accessible alternative to 3D. WebGL2 failure provides a 2D fallback.

**Directed RF matrix:** rows transmit, columns receive. Choose one exact
frequency to avoid mixing frequency overrides. Click a cell to inspect both
directions. With all frequencies selected, a cell summarizes one available
override over its pair fallback; use the table for every individual rule.

Drag the left divider or focus it and use arrow keys. **Full screen** enlarges
the workspace. Layout preferences stay in this browser, scoped to its lab URL.

## What the numbers mean

- A **configured pair** is potential directed RF state, not a packet stream.
  An exact-frequency override takes precedence over the current pair fallback.
  The NG daemon also retains a pair baseline from observer initialization,
  labeled with its capture generation. File hashes identify startup inputs.
- An **observed path** is a maintained source/destination/frequency accounting
  record. It can outlive activity and mix unicast with multicast candidates.
  Idle, excluded and unavailable are different states.
- **TX frames/attempts/ACKs** and **RX candidate outcomes** have different
  boundaries. Do not add them as unique packets. A multicast-only candidate can
  have RX injections but zero TX frames. EAPOL is a subset of data frames.
- Last type/subtype, AC, RSSI, SNR and PER describe the last recorded packet;
  they are not a lifetime histogram. The NG detail window separately counts
  TX decisions and RX candidates by type/subtype while selected.
- Detailed collection retains at most eight selected directed frequencies,
  with 16 recent header records each and a 15-second lease. No payload is
  copied. Histories begin on selection, expire, and report ring overwrites.
  Header outcomes: -1 TX ACKed, -2 TX not ACKed/no-ACK; 0 RX injected;
  1 off-channel, 2 CCA, 3 interference, 4 PER, 5 no receiver.
- Protocol-positive ownership is separate evidence. Fetch age does not mean
  the association itself just occurred; an idle association may remain valid.

Rates use counter deltas, not lifetime totals divided by process age. Resets,
evictions and daemon restarts restart their baselines. The local selected-path
chart retains at most five minutes; freezing stops console collection interest,
**not** the lab or room.

## A 20-client room in a 100-client lab

The pool card distinguishes bound, present, room-excluded and unknown clients.
**Excluded pool** filters clients the matching room marks absent. Select one
and inspect its disconnect journal and directed AP-frequency RF readbacks.

Room exclusion retains containers and hwsim radios. The room requests low-SNR
gating and client disconnection; it does not guarantee zero frames. Management
traffic, retries or receiver candidates can remain visible. A stale room source
means **unknown**, never “offline.” Spare, unbound host radios are not silently
counted as client containers. Bound count comes from the generated inventory;
it is not a fresh LXD-container health audit.

## Channel utilization and BSS load

The Load tab keeps three evidence sources separate:

1. **Modeled medium/driver survey:** cached survey-bridge publication, source,
   profile, radio-local contexts, provider/epoch, active/busy counters and global
   channel observation windows. Supported provider contexts are currently
   20 MHz. Synthetic field tests are labeled separately. The bridge's publication
   TTL is one second; reading its cache does not query driver consumption.
2. **Native EasyMesh BSS load:** already-cached, correlated reports with BSSID,
   age, utilization byte, percentage (`byte × 100 / 255`) and station count.
   No new AP metric queries are issued by the console.
3. **Beacon BSS Load:** the NG daemon can extract the actual IE from a beacon
   processed within the selected AP→receiver/frequency window. This proves
   observed advertised fields, not successful reception. Missing/stale IEs are
   unavailable, not zero. Admission capacity uses 32-microsecond units per second.

These are simulated observables, not a certification of physical capacity.
No extra hwsim polling or active packet capture is started by a hover.

## Freshness, cost and exports

Collection is shared across browsers: status sampling continues every five
seconds when idle; visible telemetry uses bounded pages and a two-second
target. Large scans take longer. The scheduler permits at most ten socket
requests/second and reserves a 256-KiB/second wire budget. Room/survey cache
reads are separately capped at once/second. Hidden/frozen/disconnected tabs
release detailed demand. Collection is not zero-cost; performance qualification
must compare the same workload with and without the observer.

Coverage shows complete, collecting, changing, unsupported or unavailable.
Traffic rows appear progressively, without waiting for the full scan. Each
browser receives at most 512 changed path rows per update; coverage distinguishes
daemon collection from browser delivery. Counter sample age is separate from
last-packet age. Large maintained tables can take minutes to refresh completely;
selected RF readbacks and frame windows update independently of that scan.
Traffic pages span a sequence interval, not an atomic instant. During room
movement the RF generation may change too quickly for a complete matrix;
selected readbacks remain preferable. Never treat missing rows as zero.

**Table CSV** exports the filtered cached rows, including provenance. **Export
evidence** requires complete pair/frequency coverage for one current generation;
otherwise it refuses. Pause movement in the room if a coherent RF export is
needed. Counters retain their full 64-bit precision. V2 JSON represents integer
values as decimal strings; subscription frequency arguments remain JSON numbers.

## Installation and troubleshooting

The source/build/install instructions are in
[the observer README](../../../gen/wmediumd/observer/README.md).
No BPI image or full VM rebuild is required for this observer update. The NG
telemetry extension requires replacing and restarting wmediumd in a maintenance
window; the upgraded UI also works with older daemons and labels absent details.
Room correlation needs the matching room-service observer endpoint.

Keep access on the trusted lab network or use an authenticated TLS proxy.
There are no NG RF mutations, shell commands, LXD queries or browser-selected
proxy targets. The classic UI is retired: `/classic/` redirects to NG.
Legacy `--classic`, `--enable-control` and `--control-socket` flags no longer
enable another collector or RF writes. Read-only v1 APIs remain compatible;
new integrations use v2 and `/api/v2/health` for NG telemetry readiness.

Compilation is not acceptance. Run the focused checks and bounded lab comparison
listed in the observer README before treating an updated deployment as qualified.
