# Control-priority restart persistence

Run these commands as root inside the appropriate lab VM after deploying these
source files and installing the host `nftables` package. The installer references
this checkout, so keep it at the installed path. Python uses only its standard
library. Startup wrappers opt nodes in when `WMEDIUMD_PRIORITY_QUEUES=1` and
clear persisted intent and owned tables when starting with the value `0`.
Both VM service installation paths install and enable the subscriber for future
boots without starting or restarting any service. The subscriber's startup
condition skips VMs without persisted intent; opted-in lab startup starts it.
Installing the subscriber alone enables no nodes.

From the prplMesh repository root:

```sh
sudo python3 wmediumd/configurator/wmdcfg/control_priority.py --stack prplmesh --enable
sudo bash wmediumd/install-control-priority.sh prplmesh
sudo systemctl restart wmdcfg-control-priority.service
```

From the RDK repository root:

```sh
sudo python3 gen/wmediumd/configurator/wmdcfg/control_priority.py --stack rdk --enable
sudo bash gen/wmediumd/install-control-priority.sh rdk
sudo systemctl restart wmdcfg-control-priority.service
```

Use repeated `--node NAME` arguments with `--enable` or `--disable` to select a
subset. Stopped or absent mesh nodes retain their desired state and are skipped.
Both commands are safe to repeat. To pick up a deployed Python update:

```sh
sudo systemctl restart wmdcfg-control-priority.service
sudo journalctl -u wmdcfg-control-priority.service -n 30 --no-pager
```

## Design

Repository inspection found startup wrappers and lab orchestration services,
but no host subscription or container lifecycle hook covering direct LXC
restarts. One host systemd service subscribes to the local LXD lifecycle
WebSocket. It completes the subscription handshake before discovering opted-in
nodes, then consumes events buffered during discovery. Each reconnect starts a
fresh discovery. LXD disconnects, namespace races and reconciliation errors
exit the process; systemd retries after five seconds, with no start-rate limit.
Idle operation blocks on the socket; there is no periodic inventory scan,
per-container process or extra Python dependency.

Per-stack intent is stored atomically in
`/var/lib/wmdcfg-control-priority/{prplmesh,rdk}.json`. A shared file lock
serializes enable, disable and reconciliation. Disable removes intent before
touching nftables, preventing a racing event or service restart from restoring
the table. Clearing the last opt-in removes the intent file, so future service
starts skip reconciliation. Enable records intent after successful nft preflight/application;
stopped nodes need no table until they start. An unavailable LXD daemon or nft
failure during disable can require retrying removal, but intent stays disabled.

The reconciler queries the current PID, opens the process directory and its
network namespace, and rechecks LXD state and namespace identity. All nft
commands use a passed namespace descriptor. A bounded cache pins at most one
namespace descriptor per opted-in node, compares device/inode identity and
skips repeated events without resetting counters. Pins prevent inode reuse
from masquerading as an already configured namespace. Stops, changed intent,
replacement namespaces and reconnects release obsolete pins. After reconnect,
an existing owned table is preserved. Unowned name collisions are refused;
unrelated nft tables are never modified.

## Rollback

For prplMesh, from its repository root:

```sh
sudo python3 wmediumd/configurator/wmdcfg/control_priority.py --stack prplmesh --disable
sudo systemctl disable --now wmdcfg-control-priority.service
```

For RDK, use `gen/wmediumd/configurator/wmdcfg/control_priority.py --stack rdk
--disable` with the same service command. Remove the existing priority-queues
drop-in and restart the medium with `WMEDIUMD_PRIORITY_QUEUES=0` through normal
lab recovery, as before. Otherwise a later opted-in startup deliberately enables
classification again. Stopping the subscriber alone preserves intent and tables.

## Validation and limits

Outside a measurement window, pause or stop the room, then restart one leaf in
its respective VM:

```sh
lxc --force-local --project default restart prpl-agent-04
lxc --force-local --project default restart bpiap-003
```

Run only the command matching that VM. Await LXD completion and inspect the
service journal plus the owned table in the new namespace, using a bounded
condition-based check rather than a fixed sleep. Verify native radio attachment
and room health; use normal lab recovery if required before resuming measurement.

Direct prplMesh container restart restores classification but does not autostart
the native APs or beerocks processes. In the observed `prpl-agent-04` restart,
`wlan0`, `wlan2` and `wlan4` remained managed interfaces without AP frequencies,
and room preflight refused the ambiguous PHY frequency. This is a separate
native startup limitation; the classification subscriber does not own recovery.
After a direct restart, recover only that leaf from the prplMesh repository root:

```sh
sudo env WMEDIUMD_PRIORITY_QUEUES=1 scripts/radio-lab.sh start-agent 4
```

For a managed leaf restart that runs both native setup and classification, use:

```sh
sudo env WMEDIUMD_PRIORITY_QUEUES=1 scripts/radio-lab.sh restart-agent 4
```

These wrappers leave the medium daemon running. Keep the room paused or stopped
until native AP frequency, beerocks readiness and room preflight checks pass.

RDK starts its native services after a direct leaf restart, but its reporting
policy is volatile. If the restarted leaf's associated clients have no native
RCPI, replay the same complete policy used by normal lab startup, inside the VM:

```sh
curl --fail --max-time 45 -X POST http://127.0.0.1:8888/api/v1/metricsreporting/enable
```

Require success for five devices and fifteen radios, then await fresh metrics
for every online client and default-room readiness before measurement. The
normal runtime already performs bounded policy replay during cold startup.
Do not conflate this native recovery with priority-rule restoration or a
post-steer timing sample. If the room exhausted its startup retry limit while
APs were unavailable, reset its failed state and start it after native recovery.

Classification is eventual after a lifecycle event, not a pre-network-start
barrier: early frames may precede reconciliation. The subscriber supports the
local LXD daemon's default project and the existing fixed mesh-node allowlists,
one stack per VM. It does not repair unrelated native mesh startup or change
medium admission. It assumes its owned table is not edited externally: duplicate
events preserve counters, and owned tables are retained on reconnect. Run
`--enable` explicitly to repair or upgrade that table's rules. A permanently
invalid table or permission failure is logged and retried by systemd; other
opted-in nodes are still visited during each discovery. Native timing and radio
reattachment require the live checks above.
