from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import random
import re
from typing import Any

from .model import ScenarioError


BANDS = ("2.4", "5", "6")
KINDS = {"station", "fronthaul_ap"}


def _normalize_numbers(value: Any) -> Any:
    # JSON has one number type. Keep hashes stable when a serializer rewrites
    # an exact value such as 5.0 as 5.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_normalize_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_numbers(item) for key, item in value.items()}
    return value


def _canonical(value: Any) -> bytes:
    return json.dumps(
        _normalize_numbers(value), sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _point(value: Any, label: str) -> tuple[float, float]:
    if not isinstance(value, list) or len(value) != 2:
        raise ScenarioError(f"{label} must be [x, y]")
    point = (float(value[0]), float(value[1]))
    if not all(math.isfinite(item) for item in point):
        raise ScenarioError(f"{label} must contain finite coordinates")
    return point


def _orientation(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_cross(a, b, c, d) -> bool:
    # Proper crossings are sufficient for the pseudo-world wall model. Nodes
    # placed exactly on a wall are rejected by review rather than assigned an
    # ambiguous half-wall loss.
    ab_c = _orientation(a, b, c)
    ab_d = _orientation(a, b, d)
    cd_a = _orientation(c, d, a)
    cd_b = _orientation(c, d, b)
    return (ab_c > 0 > ab_d or ab_d > 0 > ab_c) and (
        cd_a > 0 > cd_b or cd_b > 0 > cd_a
    )


def _validate_layout(layout: dict[str, Any]) -> None:
    if layout.get("schema") != "wmdcfg.world-layout.v1":
        raise ScenarioError("layout schema must be wmdcfg.world-layout.v1")
    space = layout.get("space") or {}
    width = float(space.get("width_m", 0))
    height = float(space.get("height_m", 0))
    if width <= 0 or height <= 0:
        raise ScenarioError("layout space must have positive width_m and height_m")
    if not isinstance(layout.get("name"), str) or not layout["name"]:
        raise ScenarioError("layout requires a non-empty name")
    propagation = layout.get("propagation") or {}
    references = propagation.get("reference_snr_db_by_band") or {}
    if set(references) != set(BANDS):
        raise ScenarioError(f"reference_snr_db_by_band must define {list(BANDS)}")
    if float(propagation.get("reference_distance_m", 0)) <= 0:
        raise ScenarioError("reference_distance_m must be positive")
    if float(propagation.get("path_loss_exponent", 0)) <= 0:
        raise ScenarioError("path_loss_exponent must be positive")
    minimum = int(propagation.get("minimum_snr_db", -20))
    maximum = int(propagation.get("maximum_snr_db", 60))
    if minimum < -20 or maximum > 60 or minimum > maximum:
        raise ScenarioError("SNR clamp must remain inside [-20, 60]")

    roles: set[str] = set()
    for index, node in enumerate(layout.get("nodes", [])):
        role = node.get("role")
        if not isinstance(role, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", role):
            raise ScenarioError(f"layout node {index} has invalid role")
        if role in roles:
            raise ScenarioError(f"duplicate layout role {role}")
        roles.add(role)
        if node.get("kind") not in KINDS:
            raise ScenarioError(f"role {role} has unsupported kind {node.get('kind')!r}")
        x, y = _point(node.get("position"), f"role {role} position")
        if not (0 <= x <= width and 0 <= y <= height):
            raise ScenarioError(f"role {role} lies outside the world")

    if not any(node.get("kind") == "fronthaul_ap" for node in layout.get("nodes", [])):
        raise ScenarioError("layout defines no agents")
    for index, wall in enumerate(layout.get("walls", [])):
        start = _point(wall.get("start"), f"wall {index} start")
        end = _point(wall.get("end"), f"wall {index} end")
        if start == end:
            raise ScenarioError(f"wall {index} has zero length")
        if not all(0 <= point[0] <= width and 0 <= point[1] <= height for point in (start, end)):
            raise ScenarioError(f"wall {index} lies outside the world")
        if float(wall.get("loss_db", 0)) < 0:
            raise ScenarioError(f"wall {index} loss cannot be negative")


def _validate_mobility(mobility: dict[str, Any]) -> None:
    if mobility.get("schema") != "wmdcfg.mobility.v1":
        raise ScenarioError("mobility schema must be wmdcfg.mobility.v1")
    duration = int(mobility.get("duration_ms", 0))
    tick = int(mobility.get("tick_ms", 0))
    if duration <= 0 or not 100 <= tick <= 60_000:
        raise ScenarioError("mobility duration must be positive and tick must be 100ms..60s")
    if duration % tick:
        raise ScenarioError("mobility duration_ms must be an exact multiple of tick_ms")
    if not isinstance(mobility.get("name"), str) or not mobility["name"]:
        raise ScenarioError("mobility requires a non-empty name")
    roles: set[str] = set()
    for index, node in enumerate(mobility.get("nodes", [])):
        role = node.get("role")
        if not isinstance(role, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", role):
            raise ScenarioError(f"mobility node {index} has invalid role")
        if role in roles:
            raise ScenarioError(f"duplicate mobility role {role}")
        roles.add(role)
        if node.get("kind", "station") not in KINDS:
            raise ScenarioError(f"role {role} has unsupported kind")
        path = node.get("path")
        if path:
            times = []
            for waypoint in path:
                time_ms = int(waypoint.get("time_ms", -1))
                _point(waypoint.get("position"), f"role {role} waypoint")
                times.append(time_ms)
            if times != sorted(set(times)) or times[0] != 0 or times[-1] > duration:
                raise ScenarioError(
                    f"role {role} waypoints must be unique, ordered, start at zero and fit duration"
                )
        elif "position" not in node:
            raise ScenarioError(f"role {role} requires position or path")
        else:
            _point(node["position"], f"role {role} position")
        intervals = node.get("presence", [[0, duration]])
        previous_end = -1
        for interval in intervals:
            if (
                not isinstance(interval, list)
                or len(interval) != 2
                or not 0 <= int(interval[0]) < int(interval[1]) <= duration
            ):
                raise ScenarioError(f"role {role} has invalid presence interval")
            if int(interval[0]) < previous_end:
                raise ScenarioError(f"role {role} has overlapping presence intervals")
            previous_end = int(interval[1])


def load_json(path: str | Path) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ScenarioError(f"{path}: invalid JSON: {error}") from error


def _merge_nodes(layout: dict[str, Any], mobility: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = {item["role"]: dict(item) for item in layout.get("nodes", [])}
    for moving in mobility.get("nodes", []):
        role = moving["role"]
        merged = dict(nodes.get(role, {}))
        merged.update(moving)
        merged.setdefault("kind", "station")
        nodes[role] = merged
    return [nodes[role] for role in sorted(nodes)]


def _position(node: dict[str, Any], time_ms: int) -> tuple[float, float]:
    path = node.get("path")
    if not path:
        return _point(node["position"], f"role {node['role']} position")
    if time_ms <= int(path[0]["time_ms"]):
        return _point(path[0]["position"], "waypoint")
    for left, right in zip(path, path[1:]):
        start = int(left["time_ms"])
        end = int(right["time_ms"])
        if start <= time_ms <= end:
            a = _point(left["position"], "waypoint")
            b = _point(right["position"], "waypoint")
            fraction = (time_ms - start) / (end - start)
            return (a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction)
    return _point(path[-1]["position"], "waypoint")


def _present(node: dict[str, Any], time_ms: int, duration_ms: int) -> bool:
    return any(
        int(start) <= time_ms < int(end)
        for start, end in node.get("presence", [[0, duration_ms]])
    )


def _wall_loss(a, b, walls: list[dict[str, Any]]) -> float:
    result = 0.0
    for wall in walls:
        if _segments_cross(a, b, _point(wall["start"], "wall"), _point(wall["end"], "wall")):
            result += float(wall["loss_db"])
    return result


def _shadow(seed: int, time_ms: int, source: str, destination: str, band: str, sigma: float) -> float:
    if sigma == 0:
        return 0.0
    pair = sorted((source, destination))
    material = f"{seed}:{time_ms}:{pair[0]}:{pair[1]}:{band}".encode()
    local_seed = int.from_bytes(hashlib.sha256(material).digest()[:8], "big")
    return random.Random(local_seed).gauss(0, sigma)


def _link(
    source: dict[str, Any],
    destination: dict[str, Any],
    positions: dict[str, tuple[float, float]],
    present: dict[str, bool],
    layout: dict[str, Any],
    mobility: dict[str, Any],
    time_ms: int,
    link_class: str,
) -> dict[str, Any]:
    propagation = layout["propagation"]
    a = positions[source["role"]]
    b = positions[destination["role"]]
    distance = math.dist(a, b)
    wall_loss = _wall_loss(a, b, layout.get("walls", []))
    minimum = int(propagation.get("minimum_snr_db", -20))
    maximum = int(propagation.get("maximum_snr_db", 60))
    reference_distance = float(propagation["reference_distance_m"])
    exponent = float(propagation["path_loss_exponent"])
    sigma = float(propagation.get("shadowing_stddev_db", 0))
    seed = int(mobility.get("seed", 0))
    values = {}
    for band in BANDS:
        if not present[source["role"]] or not present[destination["role"]]:
            value = minimum
        else:
            path_loss = 10 * exponent * math.log10(max(distance, reference_distance) / reference_distance)
            source_gain = float((source.get("tx_gain_db_by_band") or {}).get(band, 0))
            value = round(
                float(propagation["reference_snr_db_by_band"][band])
                - path_loss
                - wall_loss
                + source_gain
                + _shadow(seed, time_ms, source["role"], destination["role"], band, sigma)
            )
            value = max(minimum, min(maximum, value))
        values[band] = value
    return {
        "link_class": link_class,
        "source_role": source["role"],
        "destination_role": destination["role"],
        "distance_m": round(distance, 3),
        "wall_loss_db": wall_loss,
        "snr_db_by_band": values,
    }


def compile_world(layout: dict[str, Any], mobility: dict[str, Any]) -> dict[str, Any]:
    _validate_layout(layout)
    _validate_mobility(mobility)
    nodes = _merge_nodes(layout, mobility)
    width = float(layout["space"]["width_m"])
    height = float(layout["space"]["height_m"])
    duration = int(mobility["duration_ms"])
    tick = int(mobility["tick_ms"])
    agents = [item for item in nodes if item["kind"] == "fronthaul_ap"]
    stations = [item for item in nodes if item["kind"] == "station"]
    if not stations:
        raise ScenarioError("world defines no stations")

    generations = []
    for time_ms in range(0, duration, tick):
        positions = {item["role"]: _position(item, time_ms) for item in nodes}
        for role, (x, y) in positions.items():
            if not (0 <= x <= width and 0 <= y <= height):
                raise ScenarioError(f"role {role} leaves the world at {time_ms}ms")
        presence = {item["role"]: _present(item, time_ms, duration) for item in nodes}
        links = []
        for station in stations:
            for agent in agents:
                links.append(
                    _link(station, agent, positions, presence, layout, mobility, time_ms, "fronthaul")
                )
                links.append(
                    _link(agent, station, positions, presence, layout, mobility, time_ms, "fronthaul")
                )
        for index, left in enumerate(agents):
            for right in agents[index + 1 :]:
                links.append(
                    _link(left, right, positions, presence, layout, mobility, time_ms, "backhaul")
                )
                links.append(
                    _link(right, left, positions, presence, layout, mobility, time_ms, "backhaul")
                )
        generations.append(
            {
                "time_ms": time_ms,
                "positions": {
                    role: [round(point[0], 3), round(point[1], 3)]
                    for role, point in sorted(positions.items())
                },
                "present": {role: presence[role] for role in sorted(presence)},
                "links": sorted(
                    links,
                    key=lambda item: (
                        item["link_class"], item["source_role"], item["destination_role"]
                    ),
                ),
            }
        )
    result = {
        "schema": "wmdcfg.world-plan.v1",
        "name": f"{layout['name']}--{mobility['name']}",
        "layout": layout["name"],
        "mobility": mobility["name"],
        "tags": sorted(set(layout.get("tags", [])) | set(mobility.get("tags", []))),
        "layout_sha256": _hash(layout),
        "mobility_sha256": _hash(mobility),
        "tick_ms": tick,
        "duration_ms": duration,
        "bands": list(BANDS),
        "counts": {"agents": len(agents), "stations": len(stations)},
        "roles": {item["role"]: item["kind"] for item in nodes},
        "walls": layout.get("walls", []),
        "generations": generations,
    }
    result["golden_sha256"] = _hash(result)
    # Keep the serialized artifact byte-stable across jq/Python versions.
    # Some serializers preserve an exact float as ``5.0`` while others emit
    # the equivalent JSON number as ``5``.  Hashing already normalizes this
    # distinction; return the same canonical numeric shape to the writer.
    return _normalize_numbers(result)


def verify_world_plan(plan: dict[str, Any]) -> None:
    if plan.get("schema") != "wmdcfg.world-plan.v1":
        raise ScenarioError("world plan schema must be wmdcfg.world-plan.v1")
    claimed = plan.get("golden_sha256")
    unsigned = dict(plan)
    unsigned.pop("golden_sha256", None)
    if claimed != _hash(unsigned):
        raise ScenarioError("world plan golden_sha256 does not match its contents")


def _role_lines(plan: dict[str, Any]) -> list[str]:
    return [f"    role {role} : {kind}" for role, kind in sorted(plan["roles"].items())]


def export_wmd(plan: dict[str, Any], band: str) -> str:
    """Export one pair projection or simultaneous band-qualified links.

    A one-band projection applies to the whole pair. ``all`` uses the daemon's
    frequency-qualified capability, but remains RF stimulus rather than an
    optimizer decision.
    """
    verify_world_plan(plan)
    if band not in (*BANDS, "all"):
        raise ScenarioError(f"projection band must be one of {list(BANDS)} or all")
    safe_name = re.sub(r"[^A-Za-z0-9_]", "_", plan["name"])
    all_bands = band == "all"
    lines = [
        f"# generated from world golden {plan['golden_sha256']}",
        (
            "# simultaneous 2.4/5/6GHz frequency-qualified values"
            if all_bands else
            f"# projection-band {band}GHz; current actuator is radio-pair, not per-frequency"
        ),
        f"scenario {safe_name}_{band.replace('.', '_')} {{",
        "    language 1",
        f"    tick {plan['tick_ms']}ms",
        (
            "    require frequency_qualified_snr"
            if all_bands else "    require radio_pair_snr"
        ),
        "    require atomic_generations",
        "    require readback",
        "    protect backhaul",
        "    restore captured",
        "",
        *_role_lines(plan),
        "",
    ]
    previous: dict[tuple[str, str, str | None], int] = {}
    for generation in plan["generations"]:
        current = {
            (item["source_role"], item["destination_role"], selected_band): int(
                item["snr_db_by_band"][selected_band]
            )
            for item in generation["links"]
            if item["link_class"] == "fronthaul"
            for selected_band in (BANDS if all_bands else (band,))
        }
        changed = current if not previous else {
            key: value for key, value in current.items() if previous.get(key) != value
        }
        lines.append(
            f"    phase t_{generation['time_ms']:08d} for {plan['tick_ms']}ms {{"
        )
        if changed:
            lines.append("        parallel {")
            emitted: set[tuple[str, str]] = set()
            for key in sorted(changed):
                if key in emitted:
                    continue
                source, destination, selected_band = key
                reverse = (destination, source, selected_band)
                qualification = (
                    f" band {selected_band}GHz" if selected_band is not None and all_bands
                    else ""
                )
                if reverse in changed and changed[reverse] == changed[key]:
                    lines.append(
                        f"            link {source} <-> {destination}{qualification} "
                        f"snr = {changed[key]}dB"
                    )
                    emitted.add(reverse)
                else:
                    lines.append(
                        f"            link {source} -> {destination}{qualification} "
                        f"snr = {changed[key]}dB"
                    )
                emitted.add(key)
            lines.append("        }")
        else:
            lines.append("        hold")
        lines.append("    }")
        previous = current
    lines.append("}")
    return "\n".join(lines) + "\n"
