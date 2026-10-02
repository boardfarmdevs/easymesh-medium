# The medium's documents

[Repository](../README.md) · [Site](https://vcpe.dev/easymesh-medium/)

The [site](https://vcpe.dev/easymesh-medium/) explains how the medium works,
for a newcomer. These documents go further:

| Document | Kind | What it covers |
| --- | --- | --- |
| [RF simulation](concepts/rf-simulation.md) | concept | how the virtual medium stands in for real RF, and how rooms drive closed-loop experiments |
| [Console manual](guides/console.md) | guide | using wmediumd Console |
| [Lab monitoring](guides/lab-monitoring.md) | guide | a lab VM's LXD UI, Prometheus and Grafana, the outer VM's metrics, a thermally constrained host |
| [wmediumd internals](reference/wmediumd-internals.md) | reference | the daemon: operation, the control and metrics sockets, the simulation model |
| [Configurator](reference/configurator.md) | reference | `wmdcfg`: the room language, the compiler, the runner |
| [Optional kernel medium](reference/kernel-medium.md) | reference | the in-kernel alternative to wmediumd and its limits |
| [Virtual RF assessment](reference/virtual-rf-assessment.md) | reference | what the medium models and how faithfully, and its roadmap |
| [RF property coverage](reference/rf-property-coverage.md) | reference | each RF property, the rooms that show it, and what is qualified live |
| [RF properties: simulation and observation](reference/console-rf-properties.md) | reference | the properties as the console shows them |
| [Console: architecture and operation](reference/console.md) | reference | wmediumd Console, its protocol and API |
| [Console design](reference/console-design.md) | reference | the console's implementation and acceptance contract |
| [Neighbor-network rooms](proposals/neighbor-rooms.md) | proposal | rooms with neighboring networks: external AP actors, discovery and contention, acceptance gates |

Each part of the repository also has a README next to its code: [wmediumd](../wmediumd),
[hwsim](../hwsim/README.md), [the configurator](../configurator/README.md) and its rooms,
[the observer](../observer/README.md), [the topology page](../topology-ui/README.md) and
[LXD monitoring](../lxd-monitoring/README.md).
