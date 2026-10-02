# easymesh-medium: the RF medium of the EasyMesh labs

<!-- labs block: the same in every repository of the EasyMesh labs, but for the Site line -->
**Site:** <https://vcpe.dev/easymesh-medium/>
The [EasyMesh labs](https://mesh.vcpe.dev/) serve three
goals: EasyMesh optimizer development
([easymesh-optimizer](https://vcpe.dev/easymesh-optimizer/)) in a rich
virtual lab, on both stacks
([RDK EasyMesh](https://vcpe.dev/meta-cmf-bananapi-vcpe/),
[prplMesh](https://vcpe.dev/prplmesh-lab/)); unchanged OpenSync
pods as EasyMesh agents under a local controller, without the OpenSync cloud
([EMOSA](https://vcpe.dev/emosa-lab/), with the
[OpenSync lab](https://vcpe.dev/opensync-lab/)'s pods); and
EasyMesh on physical hardware
([Protocol lab](https://vcpe.dev/easymesh-lab/)). Two core
components carry them: the RF medium
([easymesh-medium](https://vcpe.dev/easymesh-medium/)) and EMOSA's
OVSDB ⇄ EasyMesh conversion. The rest is infrastructure, tools (the
[room builder](https://vcpe.dev/easymesh-room-builder/)) and learning
around them.
<!-- /labs block -->

The virtual radio medium both optimizer labs run on: `mac80211_hwsim` radios whose
frames pass through **wmediumd**, which decides for every frame, from a room model,
what each receiver hears. The RDK lab and the prplMesh lab build it from this
repository at a pinned commit, so the two stacks run on the same medium and in the
same rooms. What differs between the labs is named in one place,
[configurator/wmdcfg/stacks.py](configurator/wmdcfg/stacks.py): the labs' container
names, where the medium's runtime files are, and how the controller's model is read.

## Components

| Part | What it is |
| --- | --- |
| [wmediumd/](wmediumd) | upstream wmediumd at a pinned commit ([upstream.env](wmediumd/upstream.env)) and one patch series: per-frequency scheduling and interference, the atomic scenario-control socket, frequency-qualified SNR, the metrics and observer sockets, airtime and surveys, association ownership; its build, launcher and tests |
| [hwsim/](hwsim/README.md) | the `mac80211_hwsim` patches (multichannel, 6 GHz, surveys, receive contexts, the optional kernel medium), its build, the cfg80211 companion, the backend evaluators |
| [configurator/](configurator/README.md) | `wmdcfg`: the room language (layouts, mobility, scenarios), the compiler to the medium's plans, the runner and actuators, the inventory of a lab's radios; the rooms: [worlds](configurator/worlds/README.md) (standard), [worlds-wired](configurator/worlds-wired/README.md) (with the wired extender), [worlds-pods](configurator/worlds-pods/README.md) (with OpenSync pods) and their golden plans; the room viewer |
| [observer/](observer/README.md) | wmediumd Console: a read-only live view of the medium (Go, and its web pages) |
| [topology-ui/](topology-ui/README.md) | the controller's topology page both labs serve, one page with a profile per stack |
| [lxd-monitoring/](lxd-monitoring/README.md) | optional monitoring of a lab VM (inner LXD UI, Grafana, Prometheus, outer-VM metrics) |
| [site/](site) | the explainer site: how the medium works |

## Getting started

```sh
wmediumd/build-wmediumd.sh            # -> wmediumd/build/wmediumd and its provenance
wmediumd/build/wmediumd -T            # the daemon's self-test
(cd configurator && python3 -m pytest -q tests)
(cd configurator && sh worlds/build-goldens.sh --check &&
    python3 worlds-wired/build-goldens.py --check && python3 worlds-pods/build-goldens.py --check)
for t in configurator/tests/viewer/*-test.js; do node "$t"; done   # the room viewer
topology-ui/tests/run.sh && python3 -m pytest -q topology-ui/tests  # the topology page
(cd observer && go test ./...) && bash observer/build.sh
hwsim/build-hwsim.sh --6ghz           # the kernel module, for the running kernel
```

wmediumd needs `libnl-3`, `libnl-genl-3` and `libconfig` headers; the configurator only
Python 3 (and pytest for its tests); the viewer's and the page's tests Node, and
Playwright for their `*browser-test.js` ones, which the labs' suites run; the console Go.
[CI](.github/workflows/checks.yml) runs all of it except the kernel module and the browser
tests. No built binary is committed: a lab builds the daemon and the console from its
pinned commit, and the provenance file says which.

The patches to wmediumd and to Linux's `mac80211_hwsim` are GPL-2.0, as their upstreams
require.

## Documentation

The [site](https://vcpe.dev/easymesh-medium/) explains how the medium works.
The documents, indexed in [docs/README.md](docs/README.md), go further: the daemon's
internals, the room language, the console, and how faithfully each RF property is modelled.
