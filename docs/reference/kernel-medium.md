# Optional kernel medium

[Radio reference](README.md)

Userspace wmediumd remains the default and reference backend. The optional
hwsim kernel medium is an experimental frame-delivery path, not a requirement
for live rooms or a feature-complete replacement for userspace telemetry.

A registered userspace daemon takes precedence. Kernel mode uses atomic debugfs
matrix banks, with the configurator still owning scenario compilation, commits
and restoration. Its compatibility metrics proxy supplies the supported
read-only measurement interface. Installing the patched module does not by
itself enable kernel mode.

The implementation supports directed signal, rate/PER and bounded delivery
delay controls. Do not equate its synthetic fan-out throughput, loss or occupancy
counters with a calibrated physical wireless cell.

## Selection and qualification

Use [hwsim build instructions](../../../../gen/hwsim/README.md) for the module
and [configurator](configurator.md) for the backend contract. Stop the room and
native lab safely before changing the radio backend; never unload a module
while a running container owns its radios.

The appliance selector is `EASYMESH_MEDIUM_BACKEND` in its lab environment;
use `userspace` for release baselines and `kernel` only for deliberate tests.
Inspect the installed startup scripts and preserve the prior configuration.
Return to userspace and rerun baseline health after the comparison.

Hold source, host/kernel, inventory, policy, traffic, RF plan and acceptance
gates constant. Check physical and controller ownership, candidate freshness,
traffic and exact restoration. Report unsupported Console/telemetry features,
drop counters and incomplete results rather than borrowing old qualification.

Historical kernel experiments remain in Git history. They do not qualify the
current image, larger profile or a new duration test.
