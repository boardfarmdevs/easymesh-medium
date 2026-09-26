#!/usr/bin/env python3
"""Build or check the pod-variant rooms: every native Golden World with two
OpenSync pods (EMOSA adapter) added as APs.

    python3 worlds-pods/build-goldens.py [--check|--write]

Each native golden (../worlds/golden/ID.world.json) names its layout and
mobility. The pod variant uses the same mobility, the native layout plus the
pods at pod-positions.json, as layout NAME-pods, and keeps the world ID, so a
test that addresses a room by ID runs the pod variant when pointed at this root.
"""
import copy
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


def build() -> dict[str, str]:
    positions = load_json(HERE / "pod-positions.json")["layouts"]
    files = {}
    for path in sorted((NATIVE / "golden").glob("*.world.json")):
        native = load_json(path)
        layout = pod_layout(load_json(NATIVE / "layouts" / f"{native['layout']}.json"), positions[native["layout"]])
        files[f"layouts/{layout['name']}.json"] = json.dumps(layout, indent=2) + "\n"
        world = compile_world(layout, load_json(NATIVE / "mobility" / f"{native['mobility']}.json"))
        problems = pods_off_band_paths(world)
        if problems:
            raise SystemExit("pods on a band-steered path:\n  " + "\n  ".join(problems[:5]))
        files[f"golden/{path.name}"] = json.dumps(world, separators=(",", ":"), sort_keys=True) + "\n"
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
