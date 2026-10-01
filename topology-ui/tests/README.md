# The topology page's tests

`run.sh [STATIC_DIR]` runs the tests that need no browser against an assembled
page (by default this page assembled for RDK); the labs' suites run them against
the page they serve. Each loads the page's code with mocked browser and API
objects:

| Test | Loads | What it holds |
| --- | --- | --- |
| `ui-profile-test.js` | `script.js` | Without a profile, and with RDK's, the page is RDK's (its names are the ones in `index.html`, every tab, charts, the WebSocket); prplMesh's profile sets its names, opens the topology, shows a placeholder for a tab its backend does not serve without calling it, and opens no WebSocket. |
| `webui-extender-signal-test.js` | `script.js` | Topology-edge fresh, stale and unknown signal; RCPI `0`; legacy and future timestamps; band, channel and signal labels; no meter on Ethernet; the extender meter's strength, direction and parent label; a metric-only refresh in place without a D3 relayout. Stale and unknown meters stay unlit; a real parent/child change still rebuilds the graph. |
| `webui-mesh-device-signal-test.js` | `script.js` | Mesh Devices shows fresh, stale, unknown and Ethernet backhaul signal; its two-second refresh updates cards and badges without overlapping a request in flight. |
| `webui-metrics-reporting-test.js` | `script.js` | **Enable All Metrics** sends the activation request, reloads policy state, refreshes clients, restores the button and reports success. |
| `webui-topology-layout-test.js` | `script.js` | BSS band labels, SSID and client geometry, color-matched cohort titles clear of client RF paths, edge placement, draggable clients, steering pulse and trail (drawn by the shared steering cues), signal bars, channels, the exact backhaul parent, resize, compact star layouts centered on Agent-1, branch and chain layouts kept, cached positions, Optimize Layout keeping the operator's positions; a metric-only poll never rebuilds or moves the graph, and rendering never changes the API model. |
| `webui-topology-fit-test.js` | `script.js` | The largest uniform fit with a six-pixel border, the resize and drag hooks, deferral while the pointer is down. |
| `webui-topology-label-test.js` | `script.js` | Larger client labels clear of icons, SSID titles and each other in cohorts of 1 to 20 clients, without moving nodes. |
| `webui-independent-refresh-test.js` | `script.js` (as text) | Topology and metrics render independently, one bounded request per stream. |
| `webui-room-follow-test.js` | `script.js` | Every bundled room generation: identity mapping, collision spacing and packed footprints, orientation, current association owner, same-AP band changes, steering-method evidence; the room name format. |
| `webui-rf-hover-test.js` | `room-topology.js` | The AP hover's RF table: raw and percent load, stations, bands, age; missing, stale and invalid reports; isolation and escaping. |
| `steering-cues-test.js` | `steering-cues.js` | Obstacle routing, simultaneous paths, 100 non-overlapping labels, same-position band changes, purple BTM. |

The `*browser-test.js` ones need Playwright and run in the labs' suites:

- `steering-cues-browser-test.js STEERING_CUES_JS D3_JS [SCREENSHOT_PNG]`: 24
  concurrent cues, entity and text clearance masks, label collisions, repeated
  ticks, moved APs and six-second expiry.
- `webui-room-follow-browser-test.js STATIC_DIR`: the assembled page with its
  offline libraries and fixture APIs: continuous coordinates despite slow
  metrics, no pose-only SVG replacement, manual dragging, outage and reconnect,
  world switches and room headings, the one-row heading, fullscreen, the three
  cue colors from both the room's and the controller's steering actions, source
  labels and expiry, without delaying the client or writing to the lab.
- `webui-rf-hover-browser-test.js URL OUTPUT_PREFIX`: a live lab's topology page:
  every AP's tooltip (an OpenSync pod's 2.4 GHz rows), after the layout settles,
  and the stale and error states, without lab writes.
