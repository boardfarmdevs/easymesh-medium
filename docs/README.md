# The medium's documents

[Repository](../README.md)

| Document | Kind | What it covers |
| --- | --- | --- |
| [RF simulation](concepts/rf-simulation.md) | concept | how the virtual medium stands in for real RF, and how rooms drive closed-loop experiments |
| [wmediumd internals](reference/wmediumd-internals.md) | reference | the daemon: operation, the control and metrics sockets, the simulation model |
| [Configurator](reference/configurator.md) | reference | `wmdcfg`: the room language, the compiler, the runner |
| [Optional kernel medium](reference/kernel-medium.md) | reference | the in-kernel alternative to wmediumd and its limits |
| [Virtual RF assessment](reference/virtual-rf-assessment.md) | reference | what the medium models and how faithfully, with the roadmap |
| [RF property coverage](reference/rf-property-coverage.md) | reference | each RF property, the rooms that show it, and what is not yet qualified live |
| [RF properties: simulation and observation](reference/console-rf-properties.md) | reference | the properties as the console shows them |
| [Console: architecture and operation](reference/console.md) | reference | wmediumd Console, its protocol and API |
| [Console design](console/design.md) | design | the console's implementation and acceptance contract |
| [Console manual](console/guide.md) | guide | using the console |
| [Radio reference index](reference/README.md) | index | the reference documents above, as they were grouped in the RDK lab |
| [RF assessment and development plan](proposals/rf-assessment-and-development-plan.md) | proposal | a prioritized plan for the RF laboratory |

The documents came from meta-cmf-bananapi-vcpe's `doc/easymesh` with the
medium; links to the labs' own code (the room service, the optimizer, the lab
tests) point there. They are revised for this repository in the alignment
plan's documentation phase (7.3).
