# wmediumd console ng

Read-only 3D medium explorer with a synchronized virtualized radio/path table,
directed RF matrix, selected RF/traffic/load inspector, source/service status
and embedded manual. The existing binary name, systemd unit and port remain
`wmediumd-console`, `wmediumd-console.service` and guest port 8890.

- [Operator manual](../../../doc/easymesh/guide/wmediumd-console-ng.md)
- [Implementation and acceptance contract](../../../doc/easymesh/concepts/wmediumd-console-design.md)
- [RF property field guide](../../../doc/easymesh/reference/radio/console-rf-properties.md)
- [Protocol reference](../../../doc/easymesh/reference/radio/console.md)

## Build

Go 1.22+, Python 3 and Linux are required. The Go service has no third-party
runtime dependencies. Vendored Three.js 0.180.0 and OrbitControls are embedded;
the browser downloads nothing from a CDN.

```sh
bash gen/wmediumd/observer/build.sh
```

To regenerate the pinned browser bundle, additionally install Node 20.19+
and npm, then run `bash gen/wmediumd/observer/build.sh --vendor`.
`package-lock.json` pins Three.js and esbuild. This build also regenerates
the embedded manual from its Markdown source. It runs no tests.

## Install or update an existing VM

Run **inside the lab VM**, from its updated repository checkout:

```sh
bash gen/wmediumd/observer/install.sh --start
systemctl status wmediumd-console.service
```

This installs the supplied static binary and restarts only the console. It
does not rebuild/reprovision the VM or restart the room/medium.
Update the room-service checkout and restart that service separately when
ready; NG uses its new, read-only `GET /api/demo/observer` endpoint.

Older wmediumd binaries still provide their existing telemetry. NG's selected
subtype/header/BSS-IE windows, startup pair baseline and control-service accounting
require patch `0032-wmediumd-console-ng-detail.patch`. Build it with
`bash gen/wmediumd/build-wmediumd.sh` or use the updated supplied
`gen/wmediumd/wmediumd.patched`. Replacing a running daemon does not activate it:
schedule a normal lab/medium restart, which disrupts radio traffic. There is
no BPI image, kernel module or full VM rebuild requirement.

Compilation-only artifacts are supplied; run the qualification below before
accepting them for performance comparisons.

### Activate the complete integration

Fresh VM builds install everything automatically. Existing VMs need the
**updated guest checkout**, not merely a copied console binary. From that
checkout, inside the VM, run:

```sh
sudo python3 gen/wmediumd/observer/activate.py --restart-medium
```

This maintenance operation interrupts RF, preserves the current `-F`/`-Q`
modes and CPU affinity, backs up the running binaries/configuration/recovery
journal, replaces the medium through its normal launcher, restarts the survey
bridge and console, and restarts an enabled room service into its default room.
It does not rebuild or restart containers. The launcher runs its usual bounded
binary self-check; this is not a room/traffic acceptance campaign.

An already failed/contaminated recovery journal is refused unless the operator
explicitly adds `--reset-room`. That option replaces the RF session, verifies
a new daemon instance, reconnects journaled clients belonging to the new
inventory, and archives the old journal. It never replays contaminated RF
values. Saved client band-profile changes must be restored before activation.
Backups and completion receipts live in `/var/lib/wmediumd-console/upgrades/`.
An interrupted activation reports that location and does not claim rollback
or silently bypass recovery ownership checks.

Check integration readiness without generating traffic or changing RF:

```sh
python3 gen/wmediumd/observer/check-ready.py --require-room --require-survey
```

The bounded check requires the NG extension, compiled RF model description,
identity inventory, same-instance room intent and fresh survey publications.
It does not qualify client convergence, native AP reports or beacon content.

## Configuration

`/etc/default/wmediumd-console` retains existing listener and socket settings.
The new unit supplies backward-compatible defaults for older environment files.

| CLI flag | Default |
| --- | --- |
| `--listen` | `127.0.0.1:8890` |
| `--socket` | `/run/meta-cmf-wmediumd/observer/telemetry.sock` |
| `--room-url` | `http://127.0.0.1:8891` |
| `--survey-status` | `/run/wmdcfg-survey.json` |
| `--identity-inventory` | `/run/meta-cmf-wmediumd/identity-inventory.json` |
| `--poll` | `2s`; NG minimum `1s` |
| `--timeout` | `2s` |

Service variables are `WMEDIUMD_CONSOLE_ROOM_URL` and
`WMEDIUMD_CONSOLE_SURVEY_STATUS`; empty values disable those adapters.
Set `WMEDIUMD_CONSOLE_EXTRA_ARGS` for additional CLI options.
The unprivileged service has no capabilities or LXD socket access.

NG is the only served presentation and collector. `/classic/` permanently
redirects to `/`. Deprecated `--classic`, `--enable-control` and
`--control-socket` options cannot enable the old UI or write access. Existing
read-only v1 clients and `/metrics` remain supported, with v1 deprecation
headers; the compatibility HTTP health/status routes do not trigger matrix scans.
The service sandbox hides the writable scenario socket as well as LXD sockets.

## API and accounting

`/api/v2/overview`, `radios`, `paths`, `pairs`, `pair`, `services`,
`events`, `export` and WebSocket `stream` share one collector.
`/api/v2/health` returns 503 until live NG telemetry and named radios are ready.
REST pages accept `limit` (1–512), `cursor`, `token`, `q`, `sort`,
`direction`, `source`, `destination`, `band`, `frequency_mhz`.
Page tokens expire after 30 seconds; eight immutable page snapshots are cached.
V2 integer JSON values are decimal strings, including counters and cursors.

WebSocket messages use `subscribe`, `unsubscribe` or `resync`, a `topics`
array, optional radio `source`/`destination`, and numeric `frequency_mhz`.
Renew subscriptions every five seconds. Leases expire after 15 seconds;
16 connections and 64 merged interests are bounded. Deltas name their baseline.
Slow/disconnected readers cannot build unbounded queues. V1 and `/metrics`
remain available.

Traffic pages are published progressively with per-row `sampled_at`, retaining
previous rows until the next scan establishes evictions. The WebSocket uses
`path_updates`, `path_removed` and `paths_reset`, with at most 512 updated rows
and 512 removals per message, instead of resending the whole maintained table.
`paths_delivered`/`paths_cached` distinguish browser catch-up from daemon scan
coverage. Counter rates use actual row sample times, not unrelated page arrivals.
Selected RF/detail windows do not wait for a full traffic scan.

Daemon opcode 17, capability bit 16, uses a 16-byte request:
source MAC (6), destination MAC (6), big-endian MHz (4). All-zero requests
return services. A zero frequency with radio identities returns the pair
baseline captured at observer start. A selected exact frequency renews one
of eight 15-second metadata windows. Responses are bounded JSON, schema
`wmediumd.explorer.v1`; old wire records are unchanged. Endpoint counters
start with observer initialization. Peer PID/UID is not a verified service name.
No subscriber means no detailed frame classification or retained payload.

## Operator-run qualification

No runtime acceptance is implied by compilation. Focused checks:

```sh
(cd gen/wmediumd/observer && go test ./... && go test -race ./...)
node --test gen/wmediumd/observer/web/ng/model.test.mjs
NODE_PATH=/path/to/browser-tools/node_modules \
CHROMIUM_PATH=/path/to/chromium \
  node gen/tests/wmediumd-console-ng-browser-test.js
gen/wmediumd/wmediumd.patched -T
```

The browser fixture requires `playwright-core` and Chromium; use the top-level
suite's `--install-browser-deps`. It tests a recorded/mock transport, not live RF.
The top-level suite includes NG model and browser checks.

On the real lab compare observer closed/open/selected against identical bounded
idle/ping workloads; inspect generation changes, 20-of-100 exclusion, restart,
lease expiry, stale-source handling, RF export refusal, and beacon/native/survey
provenance. Follow the design's acceptance checklist; do not weaken room tests.
