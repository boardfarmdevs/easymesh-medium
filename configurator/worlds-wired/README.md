# The lab's own rooms with a wired extender

The native rooms (`../worlds`) with one more AP: the lab's own extender on a
wired backhaul, `bpiap-004`, whose LAN port is bridged into the controller's
LAN instead of a Wi-Fi backhaul station. In the room it is an ordinary tri-band
`fronthaul_ap` role, `extender_5`, marked `"backhaul": "wired"` in the layout.
Nothing else differs: no OpenSync pods, no EMOSA. With the pods as well, the
rooms are `../worlds-pods-wired`, which takes the wired extender's positions and
checks from here.

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
`gen/demo/manifests/private-client-room-walk-wired.json`. Run the room service
with that manifest (`EASYMESH_ROOM_MANIFEST`) and the suite with
`EASYMESH_ROOM_WORLDS_ROOT=gen/wmediumd/configurator/worlds-wired`. The wired
extender itself, and what it changes in the controller's model and the room's
checks, are in `../worlds-pods-wired/README.md`.
