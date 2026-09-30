#!/usr/bin/env python3
"""Build or check the lab's own rooms with its extender on a wired backhaul: every
native world (../worlds) plus extender_5, a tri-band fronthaul_ap with backhaul
"wired" (its LAN port on the controller's LAN, no Wi-Fi backhaul station).

    python3 worlds-wired/build-goldens.py [--check|--write]

Same world IDs, layouts NAME-wired, mobility as the native world; and the rooms
about the wired extender itself (WIRED_ROOMS), whose scripts are in the shared
mobility tree. The rooms with the OpenSync pods (../worlds-pods) take
its position and checks from here.
"""
import copy
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from wmdcfg.world import compile_world, load_json  # noqa: E402

NATIVE = HERE.parent / "worlds"
POSITIONS = HERE / "wired-positions.json"
# Rooms about the wired extender itself, only in this set: (native layout, mobility in the
# shared tree, world file). A client steered onto and off it, its loss and recovery, and a
# Wi-Fi extender taking it as its backhaul parent (geometry).
WIRED_ROOMS = (
    ("home-five-agent", "wired-walk-in", "home-a-wired-walk-in"),
    ("home-five-agent", "wired-walk-out", "home-a-wired-walk-out"),
    ("home-five-agent", "wired-extender-loss-recovery", "home-a-wired-extender-loss-recovery"),
    ("backhaul-branches", "backhaul-wired-parent", "backhaul-wired-parent"),
)
# A band-steered client's scripted band changes assume the native APs: the wired
# extender may come no closer than this to its best native AP, on any band.
BAND_STEERING_MARGIN_DB = 3


def wired_layout(layout: dict, positions: dict, suffix: str = "-wired") -> dict:
    """The layout with the wired extender(s) added; suffix replaces a -pods suffix."""
    wired = copy.deepcopy(layout)
    wired["name"] = layout["name"].removesuffix("-pods") + suffix
    wired["tags"] = sorted(set(layout.get("tags", [])) | {"wired-extender"})
    for role, position in positions.items():
        wired["nodes"].append({"role": role, "kind": "fronthaul_ap", "position": position, "backhaul": "wired"})
    return wired


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


def positions() -> dict:
    return load_json(POSITIONS)["layouts"]


def build() -> dict[str, str]:
    where = positions()
    files = {}
    for path in sorted((NATIVE / "golden").glob("*.world.json")):
        native = load_json(path)
        name = native["layout"]
        layout = wired_layout(load_json(NATIVE / "layouts" / f"{name}.json"), where[name])
        files[f"layouts/{layout['name']}.json"] = json.dumps(layout, indent=2) + "\n"
        world = compile_world(layout, load_json(NATIVE / "mobility" / f"{native['mobility']}.json"))
        problems = wired_off_band_paths(world)
        if problems:
            raise SystemExit("the wired extender on a band-steered path:\n  " + "\n  ".join(problems[:5]))
        files[f"golden/{path.name}"] = json.dumps(world, separators=(",", ":"), sort_keys=True) + "\n"
    for name, mobility, output in WIRED_ROOMS:
        layout = wired_layout(load_json(NATIVE / "layouts" / f"{name}.json"), where[name])
        world = compile_world(layout, load_json(NATIVE / "mobility" / f"{mobility}.json"))
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
        print(f"stale wired-extender world: {name}", file=sys.stderr)
    print(f"wired-extender rooms: {mode[2:]} {'failed' if stale else 'passed'}")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
