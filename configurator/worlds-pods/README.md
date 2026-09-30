# Rooms with OpenSync pods

The lab's standard rooms (`../worlds-wired`: the four Wi-Fi extenders and
`extender_5`, the extender on a wired backhaul) with two OpenSync pods added as
APs; the same world IDs, including the rooms about the wired extender. The
pods are unchanged OpenSync devices that the EMOSA adapter (emosa-lab,
`deploy/rdk-lab`) presents to the RDK controller as EasyMesh agents; in the
room they are ordinary `fronthaul_ap` roles, `pod_1` and `pod_2`, bound to the
containers `pod-1` and `pod-2`.

- `golden/`: one pod variant per standard world, **same world ID**, so a test
  that addresses a room by ID runs the pod variant against this tree.
- `layouts/NAME-pods.json`: the native layout plus the pods at
  `pod-positions.json` and `extender_5` at `../worlds-wired/wired-positions.json`.
  `mobility` is the native mobility tree.
- `build-goldens.py --check|--write` rebuilds both from the native trees and
  the positions; the room tests fail on a stale pod world.

What the wired extender changes is in `../worlds-wired/README.md`; the band
steering check of both applies here.

What the pods change and what they do not:

- A pod serves 2.4 GHz only (its fronthaul radio). Its links on 5 and 6 GHz
  are skipped by the compiler (`adapter` in the inventory). Its backhaul
  station (`backhaul_station` in the inventory) keeps the lab's own links in
  every room: fixed ones to the adapter's tunnel point and, on Wi-Fi backhaul,
  to the gateway's 5 GHz backhaul BSS (`user.wmediumd.links`, see
  `docs/reference/wmediumd-internals.md`), the medium's default
  to the rest. In the geometry rooms, which model the backhaul, its links to
  the native APs' 5 GHz radios follow the room instead, and before such a room
  applies, the room moves each pod to the native AP with its strongest 5 GHz
  backhaul link there (always an extender), through the controller's
  Backhaul Steering (`room_demo.backhaul.PodBackhaul`; EMOSA carries it out).
- A band-steered client's scripted band changes assume the native APs. A pod
  near its path would hold it on 2.4 GHz (the pod is the stronger 2.4 GHz AP,
  and no 5 GHz AP is then a safe band upgrade), so `build-goldens.py` refuses a
  pod world where a pod comes within 3 dB of the best native 2.4 GHz AP of such
  a client at any time. In the band-steering lane the pods stand in the corners
  behind the gateway.
- The controller's model gains one device, one radio and one BSS per operating
  AP interface per pod, and no backhaul station; the compiled plan describes
  them in `expected_lab.adapter_devices`, and every health check adds them.
- The pod variant is selected by manifest only:
  `gen/demo/manifests/private-client-room-walk-pods.json` (`worlds_root`
  points here). Run the room service with
  `EASYMESH_ROOM_MANIFEST=gen/demo/manifests/private-client-room-walk-pods.json`
  (emosa-lab `lab.sh rooms pods`, which needs the wired extender) and the
  suite with `EASYMESH_ROOM_WORLDS_ROOT=configurator/worlds-pods`
  (the suite takes the tree from the room when unset). Without them the room
  service runs the standard rooms.
