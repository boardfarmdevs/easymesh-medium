#!/usr/bin/env python3
"""Build or check the rooms with the two OpenSync pods (EMOSA adapter): the lab's
standard rooms (../worlds-wired: the four Wi-Fi extenders and extender_5 on a wired
backhaul) with the pods added as APs.

    python3 worlds-pods/build-goldens.py [--check|--write]

Each native golden (../worlds/golden/ID.world.json) names its layout and mobility,
and the rooms about the wired extender (worlds-wired WIRED_ROOMS) name theirs. The
pod variant uses the same mobility, the layout plus the pods at pod-positions.json
and extender_5 where it stands in the standard rooms, as layout NAME-pods, and keeps
the world ID: the same rooms as ../worlds-wired, under the same IDs.

The rooms about the pods themselves (POD_ROOMS) have no standard room: a native
layout with the pods and the wired extender where the room puts them, as layout
NAME, and a mobility of the shared tree.
"""
import copy
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from wmdcfg.world import compile_world, load_json  # noqa: E402

NATIVE = HERE.parent / "worlds"
# A band-steered client's scripted band changes assume the native APs: a pod
# (2.4 GHz only) near its path would hold it on 2.4 GHz. No pod may come within
# this many dB of the best native 2.4 GHz AP of such a client, at any time.
BAND_STEERING_MARGIN_DB = 3
# A backhaul link in reach: SNR at least this in both directions (the room
# service's native planner and its pod parents, easymesh-optimizer
# room_service.backhaul).
USABLE_SNR_DB = 5

# The rooms about the pods: (native layout, mobility, world ID, layout name,
# positions of the pods and the wired extender).
# backhaul-pod-chain: pod_2 behind the courtyard's partition, out of every native
# AP's reach, pod_1 just in front of it, within the extenders' reach and pod_2's.
# The room's first generation puts pod_2 under pod_1 on 2.4 GHz, two hops from a
# native AP (pod_chain). The wired extender stands beside the gateway, away from
# pod_2: it serves the room and is no parent to pod_2.
POD_ROOMS = (
    ("backhaul-courtyard", "backhaul-pod-chain", "backhaul-pod-chain", "backhaul-courtyard-pod-chain",
     {"pod_1": [29, 18], "pod_2": [37, 18], "extender_5": [4, 30]}),
)


def pod_layout(native: dict, positions: dict) -> dict:
    layout = copy.deepcopy(native)
    layout["name"] = native["name"] + "-pods"
    layout["tags"] = sorted(set(native.get("tags", [])) | {"opensync-pods"})
    for role in ("pod_1", "pod_2"):
        layout["nodes"].append({"role": role, "kind": "fronthaul_ap", "position": positions[role]})
    return layout


def pods_off_band_paths(world: dict) -> list[str]:
    """Band-steered clients a pod would pull onto 2.4 GHz (empty when none)."""
    problems = []
    for index, generation in enumerate(world["generations"]):
        for role in world.get("band_steering", {}):
            snr = {}
            for link in generation["links"]:
                if role in (link["source_role"], link["destination_role"]):
                    other = link["destination_role"] if link["source_role"] == role else link["source_role"]
                    snr[other] = link["snr_db_by_band"]["2.4"]
            native = max(v for k, v in snr.items() if not k.startswith(("pod_", "sta_")))
            pod = max((v for k, v in snr.items() if k.startswith("pod_")), default=None)
            if pod is not None and pod > native - BAND_STEERING_MARGIN_DB:
                problems.append(f"{world['name']} generation {index}: {role} pod {pod} dB, native {native} dB")
    return problems


def pod_chain(world: dict) -> list[str]:
    """Problems with a pod chain room (empty when none): at its start pod_1 in reach
    of a native AP on 5 GHz, pod_2 of none and of pod_1 on 2.4 GHz."""
    links = {}
    for link in world["generations"][0]["links"]:
        if link.get("link_class") == "backhaul":
            links[(link["source_role"], link["destination_role"])] = link["snr_db_by_band"]

    def usable(a, b, band):
        values = [links.get((a, b), {}).get(band), links.get((b, a), {}).get(band)]
        return None not in values and min(values) >= USABLE_SNR_DB

    natives = [role for role, kind in world["roles"].items()
               if kind == "fronthaul_ap" and not role.startswith("pod_")]
    problems = []
    if not any(usable("pod_1", native, "5") for native in natives):
        problems.append(f"{world['name']}: pod_1 out of every native AP's reach")
    near = [native for native in natives if usable("pod_2", native, "5")]
    if near:
        problems.append(f"{world['name']}: pod_2 in reach of {', '.join(near)}")
    if not usable("pod_2", "pod_1", "2.4"):
        problems.append(f"{world['name']}: pod_2 out of pod_1's reach on 2.4 GHz")
    return problems


def _wired():
    """The standard rooms' wired extender: positions, layout and band-steering check."""
    spec = importlib.util.spec_from_file_location("wired_goldens", HERE.parent / "worlds-wired" / "build-goldens.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build() -> dict[str, str]:
    positions = load_json(HERE / "pod-positions.json")["layouts"]
    wired = _wired()
    wired_positions = wired.positions()
    rooms = [(load_json(path)["layout"], load_json(path)["mobility"], path.name)
             for path in sorted((NATIVE / "golden").glob("*.world.json"))]
    rooms += [(name, mobility, f"{output}.world.json") for name, mobility, output in wired.WIRED_ROOMS]
    files = {}
    for name, mobility, output in rooms:
        layout = wired.wired_layout(pod_layout(load_json(NATIVE / "layouts" / f"{name}.json"), positions[name]),
                                    wired_positions[name], "-pods")
        files[f"layouts/{layout['name']}.json"] = json.dumps(layout, indent=2) + "\n"
        world = compile_world(layout, load_json(NATIVE / "mobility" / f"{mobility}.json"))
        problems = pods_off_band_paths(world) + wired.wired_off_band_paths(world)
        if problems:
            raise SystemExit("APs on a band-steered path:\n  " + "\n  ".join(problems[:5]))
        files[f"golden/{output}"] = json.dumps(world, separators=(",", ":"), sort_keys=True) + "\n"
    for name, mobility, output, layout_name, room in POD_ROOMS:
        pods = {role: room[role] for role in ("pod_1", "pod_2")}
        layout = wired.wired_layout(pod_layout(load_json(NATIVE / "layouts" / f"{name}.json"), pods),
                                    {"extender_5": room["extender_5"]}, "-pods")
        layout["name"] = layout_name
        files[f"layouts/{layout_name}.json"] = json.dumps(layout, indent=2) + "\n"
        world = compile_world(layout, load_json(NATIVE / "mobility" / f"{mobility}.json"))
        problems = pod_chain(world) + pods_off_band_paths(world) + wired.wired_off_band_paths(world)
        if problems:
            raise SystemExit(f"pod room {output}:\n  " + "\n  ".join(problems[:5]))
        files[f"golden/{output}.world.json"] = json.dumps(world, separators=(",", ":"), sort_keys=True) + "\n"
    return files


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if mode not in ("--check", "--write"):
        print(__doc__, file=sys.stderr)
        return 2
    stale = []
    for name, text in build().items():
        target = HERE / name
        if mode == "--write":
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        elif not target.exists() or target.read_text(encoding="utf-8") != text:
            stale.append(name)
    for name in stale:
        print(f"stale pod world: {name}", file=sys.stderr)
    print(f"pod rooms: {mode[2:]} {'failed' if stale else 'passed'}")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
