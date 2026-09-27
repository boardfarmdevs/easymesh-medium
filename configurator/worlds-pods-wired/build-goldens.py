#!/usr/bin/env python3
"""Build or check the rooms with the two OpenSync pods and the lab's extender on a
wired backhaul: every pod-variant world (../worlds-pods) plus extender_5, a
tri-band fronthaul_ap with backhaul "wired" (no backhaul links, geometry or not).

    python3 worlds-pods-wired/build-goldens.py [--check|--write]

Same world IDs, layouts NAME-pods-wired, mobility as the native world.
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
_spec = importlib.util.spec_from_file_location("pod_goldens", HERE.parent / "worlds-pods" / "build-goldens.py")
pods = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pods)
# A band-steered client's scripted band changes assume the native APs: the wired
# extender may come no closer than this to its best native AP, on any band.
BAND_STEERING_MARGIN_DB = 3


def wired_layout(pod_layout: dict, positions: dict) -> dict:
    layout = copy.deepcopy(pod_layout)
    layout["name"] = pod_layout["name"].removesuffix("-pods") + "-pods-wired"
    layout["tags"] = sorted(set(layout.get("tags", [])) | {"wired-extender"})
    for role, position in positions.items():
        layout["nodes"].append({"role": role, "kind": "fronthaul_ap", "position": position, "backhaul": "wired"})
    return layout


def wired_off_band_paths(world: dict) -> list[str]:
    """Band-steered clients the wired extender would pull onto its band (empty when none)."""
    problems = []
    wired = set(world.get("wired_backhaul", []))
    for index, generation in enumerate(world["generations"]):
        for role in world.get("band_steering", {}):
            by_band = {}
            for link in generation["links"]:
                if role in (link["source_role"], link["destination_role"]):
                    other = link["destination_role"] if link["source_role"] == role else link["source_role"]
                    for band, snr in link["snr_db_by_band"].items():
                        by_band.setdefault(band, {})[other] = snr
            for band, snr in by_band.items():
                native = max((v for k, v in snr.items()
                              if not k.startswith(("pod_", "sta_")) and k not in wired), default=None)
                ours = max((v for k, v in snr.items() if k in wired), default=None)
                if native is not None and ours is not None and ours > native - BAND_STEERING_MARGIN_DB:
                    problems.append(f"{world['name']} generation {index} {band} GHz: {role} wired {ours} dB, native {native} dB")
    return problems


def build() -> dict[str, str]:
    pod_positions = load_json(HERE.parent / "worlds-pods" / "pod-positions.json")["layouts"]
    positions = load_json(HERE / "wired-positions.json")["layouts"]
    files = {}
    for path in sorted((NATIVE / "golden").glob("*.world.json")):
        native = load_json(path)
        name = native["layout"]
        layout = wired_layout(pods.pod_layout(load_json(NATIVE / "layouts" / f"{name}.json"), pod_positions[name]),
                              positions[name])
        files[f"layouts/{layout['name']}.json"] = json.dumps(layout, indent=2) + "\n"
        world = compile_world(layout, load_json(NATIVE / "mobility" / f"{native['mobility']}.json"))
        problems = pods.pods_off_band_paths(world) + wired_off_band_paths(world)
        if problems:
            raise SystemExit("APs on a band-steered path:\n  " + "\n  ".join(problems[:5]))
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
        print(f"stale wired-extender world: {name}", file=sys.stderr)
    print(f"pod and wired-extender rooms: {mode[2:]} {'failed' if stale else 'passed'}")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
