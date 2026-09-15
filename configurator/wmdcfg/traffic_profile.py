from __future__ import annotations

import copy
from .model import ScenarioError


def validate_traffic(world):
    profile = world.get("traffic_experiment")
    if profile is None:
        return None
    if (not isinstance(profile, dict) or set(profile) != {"schema", "phases"}
            or profile["schema"] != "easymesh.room-traffic.v1"):
        raise ScenarioError("traffic_experiment requires schema and phases")
    phases = profile["phases"]
    if not isinstance(phases, list) or not 1 <= len(phases) <= 4:
        raise ScenarioError("traffic experiments require one to four non-overlapping phases")
    previous_end = 0
    for phase in phases:
        fields = {"role", "start_ms", "end_ms", "packets_per_second", "payload_bytes"}
        if not isinstance(phase, dict) or set(phase) != fields:
            raise ScenarioError("invalid traffic phase fields")
        if any(type(phase[field]) is not int for field in fields - {"role"}):
            raise ScenarioError("traffic timing, packet rate and size must be integers")
        role = phase["role"]
        if (not isinstance(role, str) or world["roles"].get(role) != "station"
                or not world["generations"][0]["present"].get(role)):
            raise ScenarioError("traffic source must be an initially present bound station")
        if not previous_end <= phase["start_ms"] < phase["end_ms"] <= min(60000, world["duration_ms"]):
            raise ScenarioError("traffic phases must be ordered and end within the first 60 seconds")
        if (phase["end_ms"] - phase["start_ms"] > 20000 or not 1 <= phase["packets_per_second"] <= 200
                or not 64 <= phase["payload_bytes"] <= 1200):
            raise ScenarioError("traffic is bounded to 20 seconds per phase, 200 packets/s and 1200-byte payloads")
        previous_end = phase["end_ms"]
    return copy.deepcopy(profile)
