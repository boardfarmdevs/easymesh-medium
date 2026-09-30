# easymesh-medium: the RF medium of the EasyMesh labs

The virtual radio medium every EasyMesh lab runs on: `mac80211_hwsim` radios
whose frames pass through **wmediumd**, which decides for every frame, from a
room model, what each receiver hears. It is one of the two core components of
the [EasyMesh labs](https://boardfarmdevs.github.io/easymesh-labs/); the other
is EMOSA, the OpenSync adapter. The optimizer labs on RDK
([meta-cmf-bananapi-vcpe](https://github.com/boardfarmdevs/meta-cmf-bananapi-vcpe))
and prplMesh ([prplmesh-lab](https://github.com/boardfarmdevs/prplmesh-lab))
both use this repository at a pinned commit, so the two stacks run on the same
medium and in the same rooms.

| Part | What it is |
| --- | --- |
| [wmediumd/](wmediumd) | upstream wmediumd at a pinned commit ([upstream.env](wmediumd/upstream.env)) and one patch series: per-frequency scheduling and interference, the atomic scenario-control socket, frequency-qualified SNR, the metrics and observer endpoints, airtime and surveys, association ownership; [build-wmediumd.sh](wmediumd/build-wmediumd.sh), the launcher and its tests |
| [hwsim/](hwsim) | the `mac80211_hwsim` patches (multichannel, 6 GHz, the optional kernel medium, surveys, receive contexts), its build, the cfg80211 note, the backend evaluators |
| [configurator/](configurator) | `wmdcfg`: the room language (layouts, mobility, scenarios), the compiler to the medium's plans, the runner and actuators, the inventory of a lab's radios; the rooms themselves: [worlds](configurator/worlds) (the standard rooms), [worlds-wired](configurator/worlds-wired) (with the wired extender), [worlds-pods](configurator/worlds-pods) (with OpenSync pods) and their golden plans; the room viewer |
| [observer/](observer) | wmediumd Console: a read-only live view of the medium (Go, and its web pages) |
| [docs/](docs) | how the medium works and how far it can be trusted: [docs/README.md](docs/README.md) |

## Two labs, one medium

What differs between the labs is named in one place,
[configurator/wmdcfg/stacks.py](configurator/wmdcfg/stacks.py): the lab's
container names, where the medium's runtime files are, and how the controller's
model is read. A tool takes the stack from `--stack`, else `WMDCFG_STACK`
(`rdk` or `prplmesh`), else from the controller container running in the lab.
Everything else, the daemon, the patches, the room language and the rooms, is
the same for both.

## Build and check

```sh
wmediumd/build-wmediumd.sh            # -> wmediumd/build/wmediumd and its provenance
wmediumd/build/wmediumd -T            # the daemon's self-test
(cd configurator && python3 -m pytest -q tests)
(cd configurator && sh worlds/build-goldens.sh --check &&
    python3 worlds-wired/build-goldens.py --check && python3 worlds-pods/build-goldens.py --check)
(cd observer && go test ./...) && bash observer/build.sh
hwsim/build-hwsim.sh --6ghz           # the kernel module, for the running kernel (see hwsim/README.md)
```

wmediumd needs `libnl-3`, `libnl-genl-3` and `libconfig` headers; the
configurator only Python 3 (and pytest for its tests); the console Go.
[CI](.github/workflows/checks.yml) runs all of it except the kernel module.
No built binary is ever committed: a lab builds the daemon and the console
from its pinned commit, and the provenance file says which.

## Where it came from

The history is meta-cmf-bananapi-vcpe's (`gen/wmediumd`, `gen/hwsim` and its
radio documents) up to 29 Sep 2026, when the medium existed twice, in that
repository and in prplmesh-lab, changed independently. They were merged here
from meta-cmf-bananapi-vcpe `2ce6e9b` (the medium last changed in `521c3a3`) and
prplmesh-lab `2187d4a` (last changed in `9fb9017`); a later change to either
lab's copy is ported here until the labs consume this repository:
- wmediumd: RDK's 35 patches plus the one prplMesh feature they lacked
  (resolve learned VIF identities on readback, 0036). The series reproduces
  prplmesh-lab's patched sources exactly.
- hwsim: the 11 patches were the same.
- configurator: RDK's, which was ahead (the OpenSync pods, the wired
  extender), with prplMesh's lab behind the stack profile and its own
  features (kernel-medium identity aliases, a stricter atomic apply); the
  rooms are RDK's, whose goldens regenerate identically.
- console: the same code; both labs' packaging.

## Status

Being formed (alignment plan phase 6, easymesh-labs `docs/alignment-plan.md`):
the labs still carry their own copies until they consume this repository and
are requalified from scratch.

License: the patches to wmediumd and to Linux's `mac80211_hwsim` are GPL-2.0,
as their upstreams require. The rest carries no separate license, as in the
labs it came from.
