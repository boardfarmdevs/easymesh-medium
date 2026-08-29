from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Any

from .model import HoldAction, LinkAction, MarkAction, Scenario, ScenarioError


ROLE_TYPES = {"station", "fronthaul_ap"}
CAPABILITIES = {
    "radio_pair_snr", "frequency_qualified_snr", "atomic_generations", "readback"
}


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def validate_scenario(scenario: Scenario) -> None:
    if not scenario.roles:
        raise ScenarioError("scenario defines no roles")
    unknown_types = set(scenario.roles.values()) - ROLE_TYPES
    if unknown_types:
        raise ScenarioError(f"unsupported role types: {sorted(unknown_types)}")
    if not scenario.phases:
        raise ScenarioError("scenario defines no phases")
    if scenario.restore != "captured":
        raise ScenarioError("v1 requires 'restore captured'")
    if "backhaul" not in scenario.protections:
        raise ScenarioError("v1 requires 'protect backhaul'")
    missing = scenario.requirements - CAPABILITIES
    if missing:
        raise ScenarioError(f"unsupported capabilities: {sorted(missing)}")
    if not 100 <= scenario.tick_ms <= 60_000:
        raise ScenarioError("tick must be between 100ms and 60s")
    links = [
        action for phase in scenario.phases for action in phase.actions
        if isinstance(action, LinkAction)
    ]
    qualified = [link for link in links if link.band is not None]
    if qualified and len(qualified) != len(links):
        raise ScenarioError("a scenario cannot mix radio-pair and band-qualified links")
    if qualified and "frequency_qualified_snr" not in scenario.requirements:
        raise ScenarioError("band-qualified links require frequency_qualified_snr")
    for phase in scenario.phases:
        holds = [action for action in phase.actions if isinstance(action, HoldAction)]
        links = [action for action in phase.actions if isinstance(action, LinkAction)]
        if holds and links:
            raise ScenarioError(f"phase {phase.name}: hold cannot be combined with link actions")
        for link in links:
            for role in (link.source, link.destination):
                if role not in scenario.roles:
                    raise ScenarioError(f"line {link.line}: undefined role {role}")
            types = {scenario.roles[link.source], scenario.roles[link.destination]}
            if types != {"station", "fronthaul_ap"}:
                raise ScenarioError(
                    f"line {link.line}: v1 links require one station and one fronthaul_ap"
                )


def _bind(
    scenario: Scenario, inventory: dict[str, Any], requested: dict[str, str]
) -> dict[str, dict[str, Any]]:
    if set(requested) != set(scenario.roles):
        missing = sorted(set(scenario.roles) - set(requested))
        extra = sorted(set(requested) - set(scenario.roles))
        raise ScenarioError(f"bindings must cover every role; missing={missing} extra={extra}")
    by_name = {item["container"]: item for item in inventory.get("radios", [])}
    result: dict[str, dict[str, Any]] = {}
    used: set[str] = set()
    for role, role_type in scenario.roles.items():
        container = requested[role]
        if container in used:
            raise ScenarioError(f"container {container} is bound more than once")
        item = by_name.get(container)
        if item is None:
            raise ScenarioError(f"role {role}: container {container} not in inventory")
        expected_kind = "station" if role_type == "station" else "mesh"
        if item.get("kind") != expected_kind:
            raise ScenarioError(
                f"role {role}: {container} is {item.get('kind')}, expected {expected_kind}"
            )
        if role_type == "fronthaul_ap":
            candidates = [
                iface for iface in item.get("interfaces", [])
                if iface.get("ssid") in {"private_ssid", "iot_ssid"}
                and iface.get("frequency_mhz")
            ]
            if not candidates:
                raise ScenarioError(
                    f"role {role}: {container} has no live private or IoT fronthaul"
                )
            frequencies = {}
            for candidate in candidates:
                frequency = int(candidate["frequency_mhz"])
                band = "2.4" if frequency < 2500 else "5" if frequency < 5925 else "6"
                if band in frequencies and frequencies[band] != frequency:
                    raise ScenarioError(
                        f"role {role}: {container} has ambiguous {band}GHz fronthaul frequencies"
                    )
                frequencies[band] = frequency
        result[role] = {
            "role_type": role_type,
            "container": container,
            "radio_tx_mac": item["tx_mac"],
            "radio_permanent_mac": item["permanent_mac"],
        }
        if role_type == "fronthaul_ap":
            result[role]["fronthaul_frequencies_mhz"] = frequencies
            if item.get("band_radios"):
                result[role]["band_radios"] = item["band_radios"]
        else:
            result[role]["station_mac"] = item.get(
                "station_mac", item["permanent_mac"]
            )
            result[role]["band"] = item.get("band")
            result[role]["ssid"] = item.get("ssid")
        used.add(container)
    return result


def _directions(action: LinkAction) -> list[tuple[str, str]]:
    if action.direction == "->":
        return [(action.source, action.destination)]
    if action.direction == "<-":
        return [(action.destination, action.source)]
    return [(action.source, action.destination), (action.destination, action.source)]


def _frequency(
    action: LinkAction, scenario: Scenario, bindings: dict[str, dict[str, Any]]
) -> int | None:
    # On RDK one hwsim PHY carries all three logical Wi-Fi radios. Resolve an
    # unqualified station/AP link to the station's current band so both actual
    # frame delivery and the HAL's frequency-qualified candidate provider see
    # the same dynamic medium value.
    band = _action_band(action, scenario, bindings)
    if band is None:
        return None
    ap_role = (
        action.source
        if scenario.roles[action.source] == "fronthaul_ap"
        else action.destination
    )
    frequency = bindings[ap_role].get("fronthaul_frequencies_mhz", {}).get(band)
    if frequency is None:
        raise ScenarioError(
            f"line {action.line}: role {ap_role} has no live {band}GHz fronthaul"
        )
    return int(frequency)


def _action_band(
    action: LinkAction, scenario: Scenario, bindings: dict[str, dict[str, Any]]
) -> str | None:
    if action.band is not None:
        return action.band
    station_role = (
        action.source
        if scenario.roles[action.source] == "station"
        else action.destination
    )
    return bindings[station_role].get("band")


def _role_tx_mac(
    role: str,
    band: str | None,
    scenario: Scenario,
    bindings: dict[str, dict[str, Any]],
) -> str:
    binding = bindings[role]
    if scenario.roles[role] == "fronthaul_ap" and binding.get("band_radios"):
        radio = binding["band_radios"].get(band)
        if radio is None:
            raise ScenarioError(
                f"role {role}: no physical radio is available for band {band}"
            )
        return str(radio["tx_mac"])
    return str(binding["radio_tx_mac"])


def compile_scenario(
    scenario: Scenario,
    source: str,
    inventory: dict[str, Any],
    requested_bindings: dict[str, str],
) -> dict[str, Any]:
    validate_scenario(scenario)
    bindings = _bind(scenario, inventory, requested_bindings)

    station_roles = {name for name, kind in scenario.roles.items() if kind == "station"}
    ap_roles = {name for name, kind in scenario.roles.items() if kind == "fronthaul_ap"}
    baseline_pairs: set[tuple[frozenset[str], str | None]] = set()
    for action in scenario.phases[0].actions:
        if isinstance(action, LinkAction):
            baseline_pairs.add(
                (frozenset((action.source, action.destination)), action.band)
            )
    bands = {
        action.band for phase in scenario.phases for action in phase.actions
        if isinstance(action, LinkAction)
    }
    if not bands:
        bands = {None}
    required_pairs = {
        (frozenset((sta, ap)), band)
        for sta in station_roles for ap in ap_roles for band in bands
    }
    if not required_pairs.issubset(baseline_pairs):
        missing = sorted(
            "<->".join(sorted(pair)) + (f"@{band}GHz" if band else "")
            for pair, band in required_pairs - baseline_pairs
        )
        raise ScenarioError(f"first phase must define every station/AP link: {missing}")

    events_by_time: dict[
        int, dict[tuple[str, str, int | None], dict[str, Any]]
    ] = defaultdict(dict)
    marks_by_time: dict[int, list[str]] = defaultdict(list)
    phase_records = []
    cursor_ms = 0
    for phase in scenario.phases:
        phase_start = cursor_ms
        for action in phase.actions:
            if isinstance(action, MarkAction):
                marks_by_time[phase_start].append(action.text)
                continue
            if not isinstance(action, LinkAction):
                continue
            sample_offsets = [0]
            if action.end_snr_db is not None:
                sample_offsets = list(range(0, phase.duration_ms, scenario.tick_ms))
                if not sample_offsets or sample_offsets[-1] != phase.duration_ms:
                    sample_offsets.append(phase.duration_ms)
            for offset in sample_offsets:
                if action.end_snr_db is None:
                    value = action.start_snr_db
                else:
                    fraction = offset / phase.duration_ms
                    value = round(
                        action.start_snr_db
                        + (action.end_snr_db - action.start_snr_db) * fraction
                    )
                for source_role, destination_role in _directions(action):
                    action_band = _action_band(action, scenario, bindings)
                    source_mac = _role_tx_mac(
                        source_role, action_band, scenario, bindings
                    )
                    destination_mac = _role_tx_mac(
                        destination_role, action_band, scenario, bindings
                    )
                    frequency_mhz = _frequency(action, scenario, bindings)
                    key = (source_mac, destination_mac, frequency_mhz)
                    update = {
                        "property": "snr_db",
                        "source": source_mac,
                        "destination": destination_mac,
                        "value": value,
                        "source_role": source_role,
                        "destination_role": destination_role,
                    }
                    if frequency_mhz is not None:
                        update["frequency_mhz"] = frequency_mhz
                    existing = events_by_time[phase_start + offset].get(key)
                    if existing is not None and existing["value"] != value:
                        raise ScenarioError(
                            f"phase {phase.name}: conflicting values for {source_role}->{destination_role}"
                        )
                    events_by_time[phase_start + offset][key] = update
        cursor_ms += phase.duration_ms
        phase_records.append(
            {"name": phase.name, "start_ms": phase_start, "end_ms": cursor_ms}
        )

    events = []
    generation = 0
    all_times = sorted(set(events_by_time) | set(marks_by_time))
    for time_ms in all_times:
        updates = sorted(
            events_by_time[time_ms].values(),
            key=lambda item: (
                item["source"], item["destination"], item.get("frequency_mhz", 0)
            ),
        )
        if updates:
            generation += 1
        events.append(
            {
                "time_ms": time_ms,
                "generation": generation if updates else None,
                "updates": updates,
                "marks": marks_by_time[time_ms],
            }
        )

    inventory_radios = inventory.get("radios", [])
    expected_lab = {
        "mesh_devices": sum(item.get("kind") == "mesh" for item in inventory_radios),
        "clients": sum(item.get("kind") == "station" for item in inventory_radios),
    }

    return {
        "schema": "wmdcfg.event-plan.v1",
        "scenario": scenario.name,
        "language": scenario.language,
        "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
        "inventory_sha256": _canonical_hash(inventory),
        "capabilities": sorted(CAPABILITIES),
        "tick_ms": scenario.tick_ms,
        "duration_ms": cursor_ms,
        "restore": scenario.restore,
        "protections": sorted(scenario.protections),
        # Health acceptance describes the complete frozen inventory, not just
        # the small subset of radios assigned scenario roles. A two-AP
        # crossover in the five-agent lab must still prove 5/15/50/14 and all
        # ten clients before and after applying its two touched links.
        "expected_lab": expected_lab,
        "bindings": bindings,
        "phases": phase_records,
        "events": events,
    }
