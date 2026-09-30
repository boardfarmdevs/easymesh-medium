from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from . import stacks
from .model import ScenarioError


# The lab's container names come from its stack (wmdcfg.stacks). An adapter-managed
# pod (an OpenSync pod through EMOSA) carries only the bands on which it serves an
# AP; its backhaul station is recorded apart: in the geometry rooms its links to the
# native APs' 5 GHz radios follow the room.


def _run(*args: str, attempts: int = 2, timeout_seconds: float = 5.0) -> str:
    """Run a read-only inventory probe with bounded LXC transport recovery."""
    if attempts < 1:
        raise ValueError("attempts must be positive")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")
    for attempt in range(1, attempts + 1):
        try:
            result = subprocess.run(
                args,
                check=True,
                text=True,
                capture_output=True,
                timeout=timeout_seconds,
            )
            return result.stdout.strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            if attempt == attempts:
                command = " ".join(args)
                raise ScenarioError(
                    f"inventory probe failed after {attempts} attempts: {command}"
                ) from error
            time.sleep(0.5 * attempt)
    raise AssertionError("unreachable")


def _exec(container: str, command: str) -> str:
    return _run("lxc", "exec", container, "--", "sh", "-c", command)


def _tx_mac(permanent: str) -> str:
    raw = bytearray.fromhex(permanent.replace(":", ""))
    if len(raw) != 6:
        raise ScenarioError(f"invalid radio MAC {permanent!r}")
    raw[0] |= 0x40
    return ":".join(f"{value:02x}" for value in raw)


def _band(frequency_mhz: int | None) -> str | None:
    if not frequency_mhz:
        return None
    if frequency_mhz < 2500:
        return "2.4"
    if frequency_mhz < 5925:
        return "5"
    return "6"


def _parse_iw(text: str) -> list[dict[str, Any]]:
    interfaces: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    phy: str | None = None
    for line in text.splitlines():
        value = line.strip()
        if value.startswith("phy#"):
            phy = f"phy{value[4:]}"
            current = None
        elif value.startswith("Interface "):
            current = {"name": value.split(None, 1)[1], "phy": phy}
            interfaces.append(current)
        elif current is not None and value.startswith("addr "):
            current["mac"] = value.split()[1].lower()
        elif current is not None and value.startswith("type "):
            current["type"] = value.split(None, 1)[1]
        elif current is not None and value.startswith("ssid "):
            current["ssid"] = value.split(None, 1)[1]
        elif current is not None and value.startswith("channel "):
            match = re.search(r"\((\d+) MHz\)", value)
            if match:
                current["frequency_mhz"] = int(match.group(1))
    return interfaces


def _permanent_radios(container: str) -> dict[str, str]:
    text = _exec(
        container,
        "for p in /sys/class/ieee80211/phy*; do "
        "[ -r \"$p/macaddress\" ] || continue; "
        "printf '%s %s\\n' \"${p##*/}\" \"$(cat \"$p/macaddress\")\"; done",
    )
    result = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) == 2:
            result[fields[0]] = fields[1].lower()
    return result


def _backhaul_station(
    name: str, interfaces: list[dict[str, Any]], permanent_by_phy: dict[str, str]
) -> dict[str, Any] | None:
    """A pod's backhaul station, or None: its station on the radio that serves no AP
    (OpenSync keeps a bhaul-sta-* on every radio; the fronthaul radio's is idle)."""
    serving = {item.get("phy") for item in interfaces if item.get("type") == "AP" and item.get("ssid")}
    stations = [
        item for item in interfaces
        if item.get("type") == "managed" and item.get("phy") in permanent_by_phy
        and item.get("phy") not in serving
    ]
    if len(stations) != 1:
        return None
    station = stations[0]
    link = _exec(name, f"iw dev {station['name']} link 2>/dev/null || true")
    parent = re.search(r"Connected to ([0-9a-f:]{17})", link, re.I)
    frequency = re.search(r"^\s*freq:\s*(\d+)", link, re.M)
    permanent = permanent_by_phy[station["phy"]]
    return {
        "interface": station["name"],
        "phy": station["phy"],
        "permanent_mac": permanent,
        "tx_mac": _tx_mac(permanent),
        "station_mac": station.get("mac"),
        "parent": parent.group(1).lower() if parent else None,
        "frequency_mhz": int(frequency.group(1)) if frequency else station.get("frequency_mhz"),
    }


def discover(client_names: set[str] | None = None, stack: str | None = None) -> dict[str, Any]:
    lab = stacks.get(stack)
    # A scaled lab intentionally retains stopped containers across cold-start
    # reconstruction and extender-outage tests.  ``lxc exec`` cannot inspect a
    # stopped instance, so inventory must describe the active RF world rather
    # than every matching name in LXD's persistent database.
    names = sorted(
        [
            name
            for line in _run("lxc", "list", "-c", "ns", "--format", "csv").splitlines()
            for name, _, state in [line.partition(",")]
            if state.strip().upper() == "RUNNING"
            and (
                lab.mesh.fullmatch(name)
                or (lab.adapter is not None and lab.adapter.fullmatch(name))
                or (
                    lab.client.fullmatch(name)
                    and (client_names is None or name in client_names)
                )
            )
        ],
        key=lambda name: [int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name)],
    )
    if not names:
        raise ScenarioError(f"no active {lab.label} or WLAN client containers found")

    def inspect(name: str) -> dict[str, Any]:
        permanent_by_phy = _permanent_radios(name)
        if not permanent_by_phy:
            raise ScenarioError(f"{name}: no hwsim radio found")
        interfaces = _parse_iw(_exec(name, "iw dev 2>/dev/null"))
        if lab.client.fullmatch(name):
            permanent = next(iter(permanent_by_phy.values()))
            wlan = next(
                (item for item in interfaces if item.get("name") == "wlan0"),
                None,
            )
            if wlan is None or not wlan.get("mac"):
                raise ScenarioError(f"{name}: wlan0 station interface is absent")
            link = _exec(name, "iw dev wlan0 link 2>/dev/null || true")
            match = re.search(r"Connected to ([0-9a-f:]{17})", link, re.I)
            ssid_match = re.search(r"^\s*SSID:\s*(.+?)\s*$", link, re.M)
            frequency_match = re.search(r"^\s*freq:\s*(\d+)\s*$", link, re.M)
            frequency = (
                int(frequency_match.group(1))
                if frequency_match
                else wlan.get("frequency_mhz")
            )
            ssid = ssid_match.group(1) if ssid_match else wlan.get("ssid")
            return {
                "container": name,
                "kind": "station",
                "permanent_mac": permanent,
                "tx_mac": _tx_mac(permanent),
                "station_mac": wlan["mac"],
                "interfaces": interfaces,
                "associated_bssid": match.group(1).lower() if match else None,
                "frequency_mhz": frequency,
                "band": _band(frequency),
                "ssid": ssid,
                "cohort": (
                    "iot" if ssid == "iot_ssid"
                    else "private" if ssid == "private_ssid"
                    else "other"
                ),
            }

        # RDK's hwsim HAL deliberately presents all three logical radios as
        # VIFs of one passed-through hwsim PHY. Preserve that single stable
        # station identity while recording the one live frequency per band.
        adapter = bool(lab.adapter is not None and lab.adapter.fullmatch(name))
        band_radios: dict[str, dict[str, Any]] = {}
        for phy, permanent in permanent_by_phy.items():
            phy_interfaces = [
                item for item in interfaces if item.get("phy") == phy
                and (not adapter or item.get("type") == "AP")
            ]
            frequencies_by_band: dict[str, set[int]] = {}
            for item in phy_interfaces:
                frequency = item.get("frequency_mhz")
                band = _band(int(frequency)) if frequency else None
                if band:
                    frequencies_by_band.setdefault(band, set()).add(int(frequency))
            for band, frequencies in frequencies_by_band.items():
                if len(frequencies) != 1 or band in band_radios:
                    raise ScenarioError(
                        f"{name}: {phy} has ambiguous {band}GHz frequencies"
                    )
                frequency = next(iter(frequencies))
                band_radios[band] = {
                    "phy": phy,
                    "permanent_mac": permanent,
                    "tx_mac": _tx_mac(permanent),
                    "frequency_mhz": frequency,
                    "interfaces": [
                        item for item in phy_interfaces
                        if _band(item.get("frequency_mhz")) == band
                    ],
                }
        backhaul_station = None
        if adapter:
            # An adapter-managed pod: only the bands it serves as an AP.
            if not band_radios:
                raise ScenarioError(f"{name}: no operating AP radio")
            default = band_radios[sorted(band_radios)[0]]
            backhaul_station = _backhaul_station(name, interfaces, permanent_by_phy)
        elif set(band_radios) != {"2.4", "5", "6"}:
            raise ScenarioError(
                f"{name}: expected tri-band radio inventory, found {sorted(band_radios)}"
            )
        else:
            default = band_radios["5"]
        # A lab extender on a wired backhaul (gen/wired-extender.sh): its LAN port on the
        # controller's LAN, no backhaul station.
        wired = not adapter and _run(
            "lxc", "config", "get", name, "user.easymesh.backhaul").strip() == "wired"
        # Its HAL never connects its backhaul station (rdk-wifi-hal 0045), which
        # gen/wired-extender.sh records: only then may it have RF to the other mesh nodes.
        guarded = wired and _run(
            "lxc", "config", "get", name, "user.easymesh.wired_guard").strip() == "hal"
        return {
            "container": name,
            "kind": "mesh",
            **({"adapter": "emosa"} if adapter else {}),
            **({"backhaul_station": backhaul_station} if backhaul_station else {}),
            **({"backhaul": "wired"} if wired else {}),
            **({"wired_guard": "hal"} if guarded else {}),
            "permanent_mac": default["permanent_mac"],
            "tx_mac": default["tx_mac"],
            "interfaces": interfaces,
            "band_radios": band_radios,
        }

    # LXC process startup dominates discovery at scale. Container probes are
    # independent and read-only, while executor.map retains deterministic name
    # order. Eight workers avoids turning a 50/100-client inventory into a
    # serial minute-long operation without flooding the LXD daemon.
    with ThreadPoolExecutor(max_workers=min(8, len(names))) as executor:
        radios = list(executor.map(inspect, names))
    return {
        "schema": "wmdcfg.inventory.v1",
        **({"backend": lab.inventory_backend} if lab.inventory_backend else {}),
        "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "radios": radios,
    }


def save(inventory: dict[str, Any], path: Path) -> None:
    path.write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n")
