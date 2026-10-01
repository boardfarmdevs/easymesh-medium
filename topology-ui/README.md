# topology-ui: the controller's topology page

The web page both optimizer labs show at their topology WebUI: the network
topology with live client signal, steering cues and the room it follows, plus
the mesh devices, connected clients and networks. One page, served by two
backends that answer the same `/api/v1` contract:

| Lab | Backend | Profile |
| --- | --- | --- |
| RDK ([meta-cmf-bananapi-vcpe](https://github.com/boardfarmdevs/meta-cmf-bananapi-vcpe)) | `onewifi_em_cli` (unified-wifi-mesh's Go helper), from `/nvram/static` | [profiles/rdk.js](profiles/rdk.js): every tab, charts, the WebSocket |
| prplMesh ([prplmesh-lab](https://github.com/boardfarmdevs/prplmesh-lab)) | `controller-ui`, which embeds the page | [profiles/prplmesh.js](profiles/prplmesh.js): topology first, four tabs, no charts or WebSocket |

## What is here

- [static/](static): the page (`index.html`, `script.js`, `style.css`, the room
  topology, steering cues, map, wireless settings, icons).
- [shared-modules](shared-modules): the room viewer's modules the page loads,
  taken from [configurator/worlds/viewer](../configurator/worlds/viewer) (the
  signal meter, room name and projection, fullscreen control, pane divider).
- [web-vendor.tar.gz](web-vendor.tar.gz): D3, Chart.js, Animate.css and Font
  Awesome, offline ([web-vendor.md](web-vendor.md)).
- [profiles/](profiles): what differs per backend: the page's names, its first
  tab, the tabs the backend serves (the rest show a placeholder), charts, the
  WebSocket. A profile is installed as `ui-profile.js`; without one the page is
  RDK's.
- [assemble.sh](assemble.sh): `assemble.sh rdk|prplmesh OUT_DIR [VIEWER_DIR]`
  builds the served directory from all of the above.

## How the labs build it

- RDK: the unified-wifi-mesh recipe fetches this directory and the viewer from
  `gen/medium` and installs `assemble.sh rdk` into
  `/usr/ccsp/EasyMesh/static`. The recipe's patches no longer touch
  `src/rdkb-cli/static`; the helper archive carries only the binary and its
  canned data. A change here reaches an RDK lab with the next controller image.
- prplMesh: `controller-ui/prepare-web-assets.sh` runs `assemble.sh prplmesh`
  into `controller-ui/web/static`, which Go embeds. A change here reaches a
  prplMesh lab with its next VM build (`build.sh update` refuses it).

## Tests

```sh
topology-ui/tests/run.sh                 # the page assembled for RDK
topology-ui/tests/run.sh OUT_DIR         # an assembled or installed page
python3 -m pytest -q topology-ui/tests   # the vendor bundle
```

`run.sh` runs the tests without a browser: each loads `script.js`, the room
topology or the steering cues with a mocked DOM. The `*browser-test.js` ones
need Playwright and run in the labs' suites: the steering cues and room follow
against an assembled page, the RF hover against a live lab. CI runs the rest.
[tests/README.md](tests/README.md) says what each holds.

## Where it came from

unified-wifi-mesh's `src/rdkb-cli/static` at upstream `1ef3cfd3`, with the page
hunks of meta-cmf-bananapi-vcpe's unified-wifi-mesh patches as built at
`96188ea` (the September controller image), and the room viewer's modules,
which the recipe already took from the medium. prplmesh-lab's copy
(`controller-ui/web/static` at `111c506`) differed in three ways, merged here:
its names and tab set (now its profile), no WebSocket (its profile), and the
room service's recent steering actions as roam cues next to the controller's
(`topologySteeringActions`). RDK's later work (the OpenSync pod kind, Wi-Fi
reset) is kept. The upstream files keep their Apache-2.0 RDK headers.
