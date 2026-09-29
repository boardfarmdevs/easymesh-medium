#!/usr/bin/env python3
"""Build or check the rooms with the two OpenSync pods and the lab's extender on a
wired backhaul: every pod-variant world (../worlds-pods) plus extender_5, a
tri-band fronthaul_ap with backhaul "wired" (no backhaul links, geometry or not).

    python3 worlds-pods-wired/build-goldens.py [--check|--write]

Same world IDs, layouts NAME-pods-wired, mobility as the native world.
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from wmdcfg.world import compile_world, load_json  # noqa: E402

NATIVE = HERE.parent / "worlds"


def _module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pods = _module("pod_goldens", HERE.parent / "worlds-pods" / "build-goldens.py")
# the wired extender's positions, layout and band-steering check: the lab's own rooms with it
wired = _module("wired_goldens", HERE.parent / "worlds-wired" / "build-goldens.py")


def build() -> dict[str, str]:
    pod_positions = load_json(HERE.parent / "worlds-pods" / "pod-positions.json")["layouts"]
    positions = wired.positions()
    files = {}
    for path in sorted((NATIVE / "golden").glob("*.world.json")):
        native = load_json(path)
        name = native["layout"]
        layout = wired.wired_layout(pods.pod_layout(load_json(NATIVE / "layouts" / f"{name}.json"), pod_positions[name]),
                                    positions[name], "-pods-wired")
        files[f"layouts/{layout['name']}.json"] = json.dumps(layout, indent=2) + "\n"
        world = compile_world(layout, load_json(NATIVE / "mobility" / f"{native['mobility']}.json"))
        problems = pods.pods_off_band_paths(world) + wired.wired_off_band_paths(world)
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
