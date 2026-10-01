# RDK and prplMesh LXD monitoring

Run `enable.sh` on the physical LXD host; it runs `setup.sh` inside the Ubuntu
appliance VM. Never run `setup.sh` in a Yocto/Alpine container or on the outer host.

This source-only bundle works for both RDK (`/etc/default/easymesh-lab`) and
prplMesh (`/etc/default/prplmesh-lab`) appliances. It needs their existing LXD
snap and Docker Compose, but does not depend on a mesh stack or add lab nodes.

Both labs use this one copy (easymesh-medium's `lxd-monitoring/`). From a lab checkout run
it through the lab's wrapper, which supplies the VM's ports: `gen/vm/lxd/monitoring.sh
enable VM HOST_IPV4 [LABEL]` (RDK) or `deploy/lxd-vm/monitoring.sh enable ...` (prplMesh);
`disable`, `enable-outer-metrics` and `disable-outer-metrics` likewise. An exported lab
bundle carries it as `observability/`, beside its `instance-config.sh`, as in the commands
below.

## Browser-ready deployment

From the physical LXD host, for an existing running VM:

```sh
LAB_LXD_UI_PORT=48892 LAB_GRAFANA_PORT=48893 LAB_MONITORING_ALLOW_RESTART=1 \
  bash observability/enable.sh "$VM" HOST_IPV4 LAB_LABEL
```

For a future thin release, `bash import.sh --monitoring` invokes
the same helper after normal VM setup. The prplMesh importer supports the
same flag. Omit it to retain the base thin release's offline/no-monitoring
contract. Monitoring requires image downloads or preloaded matching images.
Only source templates are shipped, never an enabled installation's secrets.

If optional setup fails after an import has created the VM, do not import it
again. Fix the reported dependency/configuration, rerun `enable.sh` for that
existing VM, then start `easymesh-lab.service` / `easymesh-room-service.service`
(RDK) or `prplmesh-lab.service` / `prplmesh-room-service.service` (prplMesh) with
`lxc exec VM -- systemctl start ...`.

- LXD UI: `https://HOST_IP:18892/` (inner LXD, not the physical host's LXD).
- Grafana: `https://HOST_IP:18893/` (the LXD dashboard is the home page).
- Override ports with `LAB_LXD_UI_PORT` and `LAB_GRAFANA_PORT` when labs share
  a physical host. Use explicit host IPv4, never wildcard public exposure.
  `18892`/`18893` are the helper defaults.
- Prometheus and the authenticated LXD metrics endpoint remain VM-loopback
  only; no host-facing Prometheus port is created.

First network enablement of an unexposed clone requires a new LXD identity and
a planned lab restart. The explicit variable above permits that maintenance;
allow several minutes for the lab to return. Without it, setup refuses to
restart an active lab. Repeated setup with an already reviewed identity does
not restart the lab. A fresh thin import enables monitoring before starting
the selected lab, avoiding a second provisioning cycle.

The helper reserves NAT proxy devices `lab-lxd-ui` and `lab-grafana`, binds
services to the VM's management IPv4, and leaves VM autostart unchanged.
It refuses conflicting owned proxy settings and existing unrelated LXD
listeners. Repeating it preserves matching credentials and data.

On older RDK appliances, setup also corrects the known Boardfarm checks that
counted every Docker container. They now inspect only `dhcp-cpe1` and `wan-cpe1`,
so adding monitoring does not trigger destructive WAN reconstruction at the
next lab restart. Original scripts are backed up under `state/rdk-boardfarm-backups`.
This compatibility repair is not a mesh-stack change and is not applied to prplMesh.

## First login

The lab generates self-signed server certificates. Verify their fingerprints
through your trusted host shell before accepting/importing them in the browser:

```sh
lxc exec VM -- openssl x509 -in /var/snap/lxd/common/lxd/server.crt -noout -fingerprint -sha256
lxc exec VM -- openssl x509 -in /opt/easymesh-observability/secrets/grafana.crt -noout -fingerprint -sha256
```

For LXD, follow the UI's browser-certificate generation/import instructions.
Create a short-lived enrollment token from the trusted host shell, then paste
it into the UI. Do not publish tokens or private browser certificates:

```sh
lxc exec VM -- lxc auth group show local:admins
lxc exec VM --mode=interactive -- lxc auth identity create local:tls/lab-browser --group admins
```

This grants management access to the inner VM's LXD, including start/stop and
console operations. Use only for trusted lab operators. Other users should
receive deliberately restricted LXD identities rather than this admin token.
On modern LXD, the browser redeems an identity token at
`/1.0/auth/identities/tls`; `lxc config trust add` tokens belong to the older
`/1.0/certificates` flow and must not be substituted. Metrics certificates
still correctly use `config trust add CERT --type=metrics`.

If `admins` is absent, a trusted administrator can run inside the VM:

```sh
lxc auth group create local:admins
lxc auth group permission add local:admins server admin
```

Review an existing group's permissions instead of blindly elevating it.
An identity without group permissions cannot administer LXD. Use a fresh
descriptive identity name for each browser; do not delete an existing working
identity merely because its name is taken.

### Windows PowerShell / Chrome

On the lab's LAN, use the endpoints without an SSH tunnel:
`https://HOST_IP:LXD_UI_PORT/ui/login/certificate-add` and
`https://HOST_IP:GRAFANA_PORT/login`. After checking the group, generating/
importing the browser certificate and selecting it in Chrome:

```powershell
ssh -t "$HOST" "lxc exec local:$VM --mode=interactive -- lxc auth identity create local:tls/windows-chrome-ui --group admins"
ssh "$HOST" "lxc exec local:$VM -- cat /opt/easymesh-observability/secrets/grafana-admin-password"
```

Both terminal options are necessary for interactive enrollment: without them
LXD 6.9 can wait for stdin until EOF. Paste the complete identity token into
the UI privately; already enrolled browsers do not need a token on each visit.
The server's self-signed certificate is separate from the browser's client
identity; verify the server fingerprints over trusted SSH before accepting
Chrome's warning. An expired outer HTTPS CLI certificate does not prevent
this SSH/local-socket enrollment path. Access troubleshooting does not require
rerunning setup or restarting the lab.

For Grafana, sign in as `admin` with the generated per-VM password:

```sh
lxc exec VM -- cat /opt/easymesh-observability/secrets/grafana-admin-password
```

Change it using Grafana after login, and create Viewer-role users for
read-only consumers. No anonymous access or shared default password is enabled.
Use `admin` plus the generated password, not `admin/admin`. The file contains
the initial password only; changing it does not reset an existing account in
Grafana's persistent volume. Use the changed password or the documented account
recovery procedure; do not delete volumes or recreate services to regain access.
The provisioned dashboard has lab/project/container filters, CPU, memory,
network interfaces, disk I/O, filesystem free space, process and OOM panels.
`100%` CPU means one core; memory includes cache. Interface traffic is container
traffic, not an EasyMesh end-to-end throughput or RF-quality measurement.

## Optional outer VM dashboard

Run on the physical host after nested monitoring is running:

```sh
bash observability/enable-outer-metrics.sh VM HOST_IPV4 HOST_CERT_DNS_NAME LAB_LABEL
```

Give it the lab's actual VM and the host certificate's DNS name (SAN). The default outer
project is `default` (`LAB_OUTER_PROJECT` overrides it); the metrics port is
8444 (`LAB_OUTER_METRICS_PORT` overrides it).

The host needs Python 3, LXD CLI/local socket access, OpenSSL, `ss`, a readable
snap LXD public server certificate and a private writable working directory.
The running managed VM needs curl, OpenSSL, Docker Compose and Prometheus.
The helper uses the existing monitoring images; no downloads or extra services
are needed. Run setup/removal sequentially, not concurrently.

Only the explicit host metrics listener is enabled. Existing conflicting
listeners, occupied ports, unauthenticated metrics and mismatched trust are
refused. The host's full LXD API is not exposed or restarted. Restrict TCP 8444
to the VM/management network; prefer an appropriate host bridge/VPN IP where
available. The rev140 certificate covers DNS `rev140`, not its LAN IP, so the
job connects to the IP while verifying that DNS name. Do not use TLS bypasses
or rotate an established host identity merely to add a scrape endpoint.

The VM's existing metrics certificate is separately trusted on the outer host
as metrics-only and restricted to the selected project. Only public certificates
cross the VM boundary; neither private key leaves its machine. The job keeps
only the exact VM/project/type `virtual-machine`, but the certificate can read
metrics for its entire authorized project. Retention filtering is not an
instance-level security boundary.

The managed state `state/outer-metrics.json` survives `setup.sh`/`enable.sh`
reruns, which preserve the outer scrape and refresh its dashboard. The helper
validates with the running `promtool`, checks verified mTLS plus VM CPU metric
availability, updates the bind-mounted config without replacing its inode,
reloads Prometheus with SIGHUP and waits for its target to be UP. Grafana
discovers the dashboard within its 30-second provisioning poll. No LXD,
Grafana, mesh/client or VM restart and no autostart change is made.

Private `lxd-outer-metrics-*` backups retain previous configuration and public
certificates, not private keys/passwords. On enable failure the helper attempts
to restore the prior files/settings and remove only newly added trust. If a
communication failure prevents rollback, inspect the reported backup and errors.
Unmanaged jobs from the supplied old one-off script must be backed up and
deliberately removed/revoked before migration; they are not silently adopted.

For future deployments, explicitly opt in through the existing importer:

```sh
LAB_OUTER_METRICS_ADDRESS=HOST_IPV4 LAB_OUTER_TLS_NAME=HOST_CERT_DNS_NAME \
  bash import.sh --monitoring
```

These variables also work with `enable.sh`. Without the outer address,
monitoring remains nested-only. Do not reimport an existing lab to add metrics.

Open Grafana **Dashboards → EasyMesh → EasyMesh outer LXD VM**, UID
`easymesh-lxd-outer`, using the same login. The nested dashboard stays home.
On the lab host: `https://HOST_IP:GRAFANA_PORT/d/easymesh-lxd-outer`.
Choose Host/Lab/Project/VM; allow 60–90 seconds for rate panels.

- CPU execution excludes idle, I/O wait and steal. 100% means one vCPU;
  normalized CPU uses a count of per-vCPU idle series, not the VM exporter's
  sometimes-zero `lxd_cpu_effective_total` gauge.
- VM memory is guest `MemTotal - MemAvailable`, not the nested cgroup's
  `MemTotal - MemFree` and not the QEMU process's RSS.
- Network/disk panels use guest interface/device counters. Unsupported
  process/filesystem families display No data rather than synthetic zeros.
- These are VM guest metrics, not physical-host totals. Monitoring physical
  hardware needs another exporter. This in-VM collector also stops with its VM;
  continuous outage monitoring needs an independent collector.

Check `/api/v1/targets` on guest-loopback Prometheus 9090 for `lxd`,
`prometheus` and `lxd-outer` UP with no `lastError`. In Grafana Explore use
`count by (name,project,type) (lxd_cpu_seconds_total{job="lxd-outer",mode="idle"})`
to verify only the selected VM is retained and its vCPU count is plausible.
LXD's metric cache and 30-second scraping make this infrastructure monitoring,
not subsecond optimizer instrumentation; there is still some resource cost.

Before disabling monitoring, retargeting or renewing its shared certificate:

```sh
bash observability/disable-outer-metrics.sh VM
```

This removes the outer job/dashboard/state and revokes only its recorded,
matching metrics trust; nested monitoring continues. It retains the authenticated
host listener to avoid disrupting another consumer. Review other scrapers and
the backup's `host-before.json` before unsetting a listener that this setup
originally created. Never disable authentication as cleanup. For renewal,
disable outer first, renew nested credentials, then enable outer again. Disable
outer before planned host certificate rotation, verify the new SAN/fingerprint,
then re-enable. If the VM is lost, revoke its recorded fingerprint on the host.

## Resource and security boundary

Prometheus and Grafana use Docker host networking inside the VM, each capped
at 512 MiB and 0.5 CPU. Grafana also uses `GOMEMLIMIT=256MiB`, a Go runtime
soft target leaving headroom below the hard container cap for mapped binaries
and other memory. Without that target, repeated dashboard loads hit the 512 MiB
cap during rev140 validation. Retention is seven days or 1 GB of TSDB blocks; WAL,
Grafana data and image layers need additional space. The 30-second scrape
interval is shared with dashboard rate queries. No privileged container,
Docker/LXD socket mount or per-client exporter is used.

Prometheus has a metrics-only client certificate and verifies LXD's server
certificate. On the first network-enabled installation, if LXD had no HTTPS
or metrics listener, setup replaces the cloned builder's server identity with
a unique per-VM key/certificate. Its maintenance helper stops active room/lab
units while LXD is still available, restarts LXD, then restores those units.
Do not substitute a plain live daemon reload: the snap's restart can cascade
through `Requires=` dependencies and deadlock lab shutdown. `RestartMode=direct`
did not prevent that on the tested snap, so it is not used as a workaround.
Previously exposed
LXD installations keep their existing identity. Server certificates and the
metrics client certificate expire after one year; renew deliberately before
expiry and update Prometheus's trust anchor if the LXD certificate changes.

## Local-only installation

```sh
sudo bash setup.sh my-lab
cd /opt/easymesh-observability
sudo docker compose config --quiet
sudo docker compose pull
sudo docker compose up -d
```

`setup.sh` alone does not start monitoring. It installs copies
under `/opt/easymesh-observability`, generates local credentials, trusts only
a metrics certificate, and defaults to loopback HTTPS listeners. Docker uses
host networking to reach those listeners without adding a bridge or LXD node.
There is no Docker/LXD socket mount, privileged exporter or nested-container agent.

## Stop and export safely

If outer monitoring is enabled, first run `disable-outer-metrics.sh VM` on the
host. The VM-side removal refuses while outer state remains, preventing an
orphaned host-side trust entry. No installed credentials or state belong in a tar.

```sh
lxc exec VM -- bash /opt/easymesh-observability/disable.sh
lxc config device remove VM lab-lxd-ui
lxc config device remove VM lab-grafana
```

Disable restores only owned listener settings and revokes the metrics
certificate; it keeps data and credentials. It does not restore an old cloned
server key. Export guards reject a managed monitoring installation: it contains
per-installation credentials and persistent time-series data. Disable and clean
it first. For a deliberately clean export, after backing up wanted data,
remove the stopped project's Docker volumes and `/opt/easymesh-observability`,
and revoke browser identities/tokens through `lxc config trust`/`lxc auth`.
Ship these templates only. Do not copy an installed `/opt` directory between labs.

Official references: [LXD UI enrollment](https://documentation.ubuntu.com/lxd/latest/howto/access_ui/),
[LXD metrics](https://documentation.ubuntu.com/lxd/latest/metrics/),
[Grafana HTTPS](https://grafana.com/docs/grafana/latest/setup-grafana/set-up-https/),
[LXD identity versus certificate tokens](https://github.com/canonical/lxd/blob/ab8fad2/doc/howto/server_expose.md),
[Prometheus reload](https://prometheus.io/docs/prometheus/latest/management_api/).

Source validation uses `pytest` and `PyYAML` in the development environment,
not on the deployed host. Run `test_lxd_observability.py` and
`test_lxd_outer_metrics.py` from the repository's test directory. The latter
also checks config, all dashboard expressions and a zero-effective-CPU fixture
using the pinned Prometheus image if already cached locally; tests never pull
images or change a live LXD host. The outer installer itself needs only Python's
standard library and the external commands listed above.
