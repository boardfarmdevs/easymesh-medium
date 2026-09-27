# Rooms with OpenSync pods and a wired extender

The pod rooms (`../worlds-pods`) with one more AP: the lab's own extender on a
wired backhaul. It is a `bpiap` image like the other extenders, `bpiap-004`,
whose LAN port is bridged into the controller's LAN (`br-emosa`, a port of
`bpibroadband`'s `brlan0`) instead of a Wi-Fi backhaul station. In the room it
is an ordinary tri-band `fronthaul_ap` role, `extender_5`, marked
`"backhaul": "wired"` in the layout.

- `golden/`: one variant per pod world, **same world ID**.
- `layouts/NAME-pods-wired.json`: the pod layout plus `extender_5` at
  `wired-positions.json`. `mobility` is the native mobility tree.
- `build-goldens.py --check|--write` rebuilds both from the native and pod
  trees; the room tests fail on a stale world.

What the wired extender changes and what it does not:

- It has no Wi-Fi backhaul. The world compiler gives a `"backhaul": "wired"`
  AP no backhaul links, geometry or not, and lists it in the world's
  `wired_backhaul`; the room accepts a wired AP without mesh-peer links; the
  acceptance's `meshConnected` expects no backhaul edge for it; the room's
  OneWifi backhaul adapter leaves it out.
- On the medium it has no RF to the other mesh nodes (gen-config gives a
  container with `user.easymesh.backhaul=wired` -20 dB to each, and the room
  engine sets no AP-pair override that involves it), so its backhaul station
  can never make a second path into the LAN. The extender's unit keeps every
  station interface down as well.
- Its fronthaul is a room AP like the others. A band-steered client's scripted
  band changes assume the native APs, so `build-goldens.py` refuses a world
  where the wired extender comes within 3 dB of such a client's best native AP
  on any band; it stands at an edge or corner the other APs leave free.
- The controller's model gains a device like the other extenders (three radios,
  ten BSSes) but no backhaul station association; the inventory marks it
  `backhaul: wired`, the plan counts it in `expected_lab.wired_devices`, and the
  health checks expect one association fewer. em_cli names it `Extender-N`
  (unified-wifi-mesh 0218): Agent-1 stays the gateway's co-located agent.
- Selected by manifest only:
  `gen/demo/manifests/private-client-room-walk-pods-wired.json`. Run the room
  service with that manifest (emosa-lab `lab.sh rooms pods-wired`) and the
  suite with `EASYMESH_ROOM_WORLDS_ROOT=gen/wmediumd/configurator/worlds-pods-wired`.

## The wired extender itself

`gen/wired-extender.sh up|down|status [INDEX]` (root, in the lab VM) creates
`bpiap-00INDEX` (default 4) from the reference extender's image, or completes
an existing one. The order is the point: a pool radio handed to a new
container is on the medium at once (the medium lists idle pool radios at its
default SNR), so a LAN port bridged before the medium is regenerated lets the
new extender's backhaul station associate too, a second path into the LAN (an
L2 loop). So: no LAN port at creation, marked wired, medium regenerated, then
the reference extender's in-place binaries (OneWifi with its own libraries:
a newer OneWifi with the image's libwifi_bus or libwifi_webconfig never
finishes starting), em_agent's backhaul wait extended to a wired uplink
(unified-wifi-mesh bbappend, `e8682fa`), a unit that keeps `eth1` a port of
`brlan0` (RDK does not bridge it in extender mode), and only then `eth1` on
the LAN bridge.

OneWifi's station selfheal took a wired extender's fronthaul down 5 minutes
after every OneWifi start: a disconnected extender station makes OneWifi disable
and enable every radio after half the selfheal publish time, and only a Wi-Fi
extender gets its APs back (when its station reconnects). OneWifi's own Ethernet
backhaul signal needs `RDKB_EXTENDER_ENABLED`, which the image does not build, so
`up` sets the publish time (`/nvram/selfheal_event_publish_time`) beyond reach.
The unit still restarts OneWifi, then em_agent, if the fronthaul stays down for
30 s (at most once per 3 minutes, logged in `journalctl -u lab-wired-backhaul`),
and keeps every station interface down.

`up` on an existing extender restarts the medium only when it would change: a
restart drops every Wi-Fi backhaul, and on 27 Sep the Wi-Fi extenders lost
their APs and their stations with it and had not recovered 3 minutes later
(restarting OneWifi, then em_agent, on each brought them back).
