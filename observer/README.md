# wmediumd Console

`wmediumd Console` is a standalone Go observer for the EasyMesh hwsim medium.
It reads wmediumd's host-only `-O` Unix socket and serves an embedded live UI,
immutable REST snapshots, a WebSocket update stream and low-cardinality
Prometheus metrics. It is not part of a BPI container, EasyMesh, the Python
configurator or the optimizer.

The Console shows:

- daemon identity, control generation, configured pair SNR and exact-frequency
  overrides;
- optional human labels, roles, LXD owners and interface names supplied by a
  generated inventory (the service never queries LXD itself);
- lifetime and windowed frame/byte/type, EAPOL, unicast/multicast, retry,
  delivery, drop and netlink counters;
- current client-to-infrastructure associations inferred from the freshest
  observed non-multicast packet path, with band and channel;
- radio/frequency activity and learned VIF-to-radio ownership;
- raw active source/destination/frequency packet paths with signal, SNR, PER
  and outcome counters, kept as a separate diagnostic view because multicast
  receiver candidates are medium fan-out, not EasyMesh associations;
- a bounded event timeline and explicit event-ring gap indication;
- queue depth/delay and factual health warnings; and
- startup-config and running-binary SHA-256 identities. The root launcher
  publishes a PID-qualified hash manifest in `/run`; this keeps the hardened
  non-root service from needing `CAP_SYS_PTRACE` merely to dereference the
  daemon's `/proc/PID/exe` entry.

No packet payload is copied, stored or exposed. If the Console is pointed at an
older `-R` read-only endpoint, configured state remains visible and packet
metrics are clearly marked unavailable.

The process boundaries and correlation model are described in
[the wmediumd Console reference](../../../doc/easymesh/reference/wmediumd-console.md).

## Build and test

Go 1.22 or newer is required. The module uses only the Go standard library.

```sh
cd gen/wmediumd/observer
go test ./...
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags='-s -w' \
  -o wmediumd-console ./cmd/wmediumd-observer
```

The resulting binary is static. A VM recipient can use a supplied release
binary and `install.sh`; Go is only a build-time dependency.

## Read-only operation (default)

Start the lab's patched wmediumd and verify the dedicated telemetry socket:

```sh
test -S /run/meta-cmf-wmediumd/observer/telemetry.sock

./wmediumd-console \
  --listen 127.0.0.1:8890 \
  --socket /run/meta-cmf-wmediumd/observer/telemetry.sock \
  --identity-inventory /run/meta-cmf-wmediumd/identity-inventory.json
```

Open `http://127.0.0.1:8890/` or use an SSH forward. The collector recovers
when wmediumd is restarted. Read-only is the default: the process never opens
the writable scenario socket and every HTTP mutation returns 405.

The primary rev130 installation binds this read-only service to the lab LAN at
`http://192.168.2.130:8890/`. Typed controls remain disabled unless explicitly
enabled for a bounded diagnostic session.

Important flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--listen` | `127.0.0.1:8890` | HTTP/UI listener |
| `--socket` | `/run/meta-cmf-wmediumd/observer/telemetry.sock` | `-O` read-only telemetry socket |
| `--identity-inventory` | `/run/meta-cmf-wmediumd/identity-inventory.json` | optional generated identity overlay |
| `--poll` | `2s` | snapshot interval; minimum 250 ms |
| `--timeout` | `2s` | Unix-socket request deadline |
| `--config` | `/run/meta-cmf-wmediumd/wmediumd.cfg` | startup configuration to hash |
| `--pid-file` | `/run/meta-cmf-wmediumd/wmediumd.pid` | PID used to hash the running binary |

## Identity inventory

wmediumd identities are radio MAC addresses; it cannot infer that a radio is
`Agent-1`, belongs to `bpiap-1`, or represents `sta-03`. The normal
`wmediumd-up.sh up` workflow runs `generate-identity-inventory.sh` after hwsim
assignment and atomically creates the JSON handoff file. The Console only reads
that file. It has no LXD socket access and runs no discovery commands.

For mesh radios the generator correlates the hwsim transmitter identity with
the EasyMesh topology node ID and uses the controller's current `Agent-1` or
`Extender-N` label. This avoids assigning extender numbers from LXD enumeration
order. If the controller topology is unavailable, stable container-order labels
are used until the inventory is regenerated.

Each `mac` must be the radio identity present in the generated wmediumd station
matrix, not a BSS/VIF address. A learned VIF is a virtual-interface MAC seen in
an 802.11 frame header, such as an AP BSSID/VAP or client interface. wmediumd
maps that VIF to the hwsim physical radio that owns it and its observed
frequency so it can deliver addressed frames correctly. A radio can own several
VIFs; these mappings are not association edges. They are displayed under their
owning enriched radio as medium diagnostics.

See [`identity-inventory.example.json`](identity-inventory.example.json). The
schema is deliberately small:

```json
{
  "schema_version": 1,
  "generated_at": "2026-08-23T12:00:00Z",
  "stations": [
    {
      "mac": "42:00:00:00:01:00",
      "label": "Agent-1",
      "role": "controller-agent",
      "owner": "bpibroadband",
      "interface": ""
    }
  ]
}
```

The supplied generator writes a temporary file and atomically renames it into
place. Mesh entries intentionally leave `interface` empty because one hwsim
radio identity owns multiple VIFs and bands; client entries identify `wlan0`.
The Console reloads it with each snapshot. Input is limited to 1 MiB and
512 unique six-octet MAC identities; unknown fields, control characters,
duplicates and oversized labels are rejected. Invalid or absent inventory is
reported through the API/UI without interrupting telemetry.

## Install a prebuilt binary as a service

Place the static release binary next to this directory or pass its path. The
installer does not invoke Go:

```sh
cd gen/wmediumd/observer
chmod +x wmediumd-console
./install.sh --binary ./wmediumd-console --start

systemctl status wmediumd-console.service
journalctl -u wmediumd-console.service -f
curl -fsS http://127.0.0.1:8890/api/v1/status
```

The installed unit runs as the unprivileged `wmediumd-console` user. The lab's
`lxd` group gates the host-only wmediumd sockets, but known LXD and Incus daemon
sockets are explicitly hidden from the service's mount namespace. It cannot
query LXD, has no Linux capabilities, and uses systemd filesystem, device,
namespace and kernel hardening. Runtime defaults live in
`/etc/default/wmediumd-console` and default to read-only operation.

To remove it:

```sh
sudo systemctl disable --now wmediumd-console.service
sudo rm -f /etc/systemd/system/wmediumd-console.service \
  /etc/default/wmediumd-console /usr/local/bin/wmediumd-console
sudo rm -rf /usr/local/share/doc/wmediumd-console
sudo systemctl daemon-reload
sudo userdel wmediumd-console
sudo groupdel wmediumd-console
```

## Optional typed controls

Controls require an explicit startup opt-in:

```sh
./wmediumd-console \
  --listen 127.0.0.1:8890 \
  --socket /run/meta-cmf-wmediumd/observer/telemetry.sock \
  --enable-control \
  --control-socket /run/wmediumd-control.sock
```

For the managed service, explicitly set the following in
`/etc/default/wmediumd-console`, then restart it:

```sh
WMEDIUMD_CONSOLE_EXTRA_ARGS=--enable-control --control-socket=/run/wmediumd-control.sock
sudo systemctl restart wmediumd-console.service
```

The writable socket is used only for these typed operations:

- atomic pair-SNR set;
- atomic exact-frequency override set;
- atomic exact-frequency override clear; and
- one-step undo of the most recent successful Console transaction.

Every request must name the observed 128-bit daemon instance and current
generation. The Console rechecks both on the writable socket immediately before
reading prior values and applying generation `N+1`. Undo is held only in memory,
is invalid after a daemon restart or intervening generation, and restores the
exact previous pair value or previous frequency-override presence/value. A pair
has no protocol-level delete operation; it always has a configured matrix
value. Pair and frequency batches are individually atomic, but cannot be mixed
in one cross-opcode transaction.

The browser additionally requires a same-origin request, JSON content type and
the per-process `X-Wmediumd-CSRF` token. There is deliberately no shell runner,
generic HTTP/Unix-socket proxy or arbitrary-opcode endpoint. Keep the HTTP
listener on loopback, or put authentication and TLS at a trusted reverse proxy.

## API

```text
GET /api/v1/status
GET /api/v1/snapshot
GET /api/v1/stations
GET /api/v1/identities
GET /api/v1/links?kind=all|pair|frequency
GET /api/v1/telemetry
GET /api/v1/radio-frequencies
GET /api/v1/active-links
GET /api/v1/vifs
GET /api/v1/events?limit=100
GET /api/v1/health
GET /api/v1/artifacts
GET /api/v1/controls
WS  /api/v1/stream
GET /metrics
```

When controls are enabled, obtain `csrf_token`, `daemon.instance_id` and
`daemon.generation` from the immutable APIs, then use only the following JSON
routes:

```text
POST /api/v1/controls/pairs/set
POST /api/v1/controls/frequencies/set
POST /api/v1/controls/frequencies/clear
POST /api/v1/controls/undo
```

Example pair batch:

```json
{
  "expected_instance_id": "0123456789abcdeffedcba9876543210",
  "expected_generation": 17,
  "updates": [
    {
      "source": "42:00:00:00:01:00",
      "destination": "42:00:00:00:02:00",
      "snr_db": 28
    }
  ]
}
```

The full pair matrix is potential medium state, not proof of an association.
Use `active_links` for traffic wmediumd has actually processed, and use the
EasyMesh UI/event stream to interpret association and steering state.
