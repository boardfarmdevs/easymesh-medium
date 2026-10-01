# The lab's own rooms with a wired extender

The native rooms (`../worlds`) with one more AP: the lab's own extender on a
wired backhaul, `bpiap-004`, whose LAN port is bridged into the controller's
LAN instead of a Wi-Fi backhaul station. In the room it is an ordinary tri-band
`fronthaul_ap` role, `extender_5`, marked `"backhaul": "wired"` in the layout.
Nothing else differs: no OpenSync pods, no EMOSA. These are the lab's standard
rooms; with the OpenSync pods as well, they are `../worlds-pods`, which takes
the wired extender's positions and checks from here.

- `golden/`: one world per native world, **same world ID**.
- `layouts/NAME-wired.json`: the native layout plus `extender_5` at
  `wired-positions.json`. `mobility` is the native mobility tree.
- `build-goldens.py --check|--write` rebuilds both from the native tree and the
  positions; the room tests fail on a stale world.

The wired extender stands where the native APs leave room: `build-goldens.py`
refuses a world where it comes within 3 dB of a band-steered client's best
native AP on any band, because those clients' scripted band changes assume the
native APs.

Selected by manifest only:
`gen/rooms/manifests/private-client-room-walk-wired.json`. Run the room service
with that manifest (`EASYMESH_ROOM_MANIFEST`) and the suite with
`EASYMESH_ROOM_WORLDS_ROOT=configurator/worlds-wired` (the suite
takes the tree from the room when unset). `gen/wired-extender.sh up` writes the
room service's drop-in for it.

What the wired extender changes and what it does not:

- It has no Wi-Fi backhaul of its own: the world lists it in `wired_backhaul`,
  the acceptance's `meshConnected` wants it as an Ethernet child of the gateway
  in the controller's topology and never a Wi-Fi child, and the room's OneWifi
  backhaul adapter leaves it out. The world compiler gives it backhaul links
  like any AP, so a Wi-Fi extender may take it as its parent.
- On the medium it gets RF to the other mesh nodes only when its HAL never
  connects its backhaul station (rdk-wifi-hal 0045, which `gen/wired-extender.sh`
  records as `user.easymesh.wired_guard=hal`): then no station of it can make a
  second path into the LAN, and its backhaul BSSs stay open to children. With
  an older image it keeps no RF to the other mesh nodes (gen-config gives it
  -20 dB to each, and the room engine sets no AP-pair override that involves
  it), as before. The extender's unit keeps every station interface down in
  both cases.
- Its fronthaul is a room AP like the others. A band-steered client's scripted
  band changes assume the native APs, so `build-goldens.py` refuses a world
  where the wired extender comes within 3 dB of such a client's best native AP
  on any band; it stands at an edge or corner the other APs leave free.
- The controller's model gains a device like the other extenders (three radios,
  ten BSSes) but no backhaul station association; the inventory marks it
  `backhaul: wired`, the plan counts it in `expected_lab.wired_devices`, and the
  health checks expect one association fewer. em_cli names it `Extender-N`
  (unified-wifi-mesh 0218): Agent-1 stays the gateway's co-located agent.

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

OneWifi never creates the wired extender's own 5 GHz backhaul BSS: in EasyMesh
node mode it starts only the station, and the controller's settings match what
it has stored ("same, not applying"). The unit disables and enables that SSID
in the data model (`rbuscli`, the SSID found by the name `mesh_backhaul_5g`)
whenever the fronthaul is up and the backhaul BSS is not, which makes OneWifi
create it, so Wi-Fi extenders can take the wired extender as their parent
(`backhaul-wired-parent`). It also gives `brlan0` its address from the gateway
(`udhcpc` once `eth1` is in `brlan0`): a Wi-Fi extender's `setup_ext_pre.sh`
runs `udhcpc` before ieee1905 starts, when a wired extender's `brlan0` has no
uplink yet.
