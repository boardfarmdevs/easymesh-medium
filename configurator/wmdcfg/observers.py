"""What the controller's model says about the room: the stations' associations
(snapshot) and the mesh's completeness (mesh_health). Each stack reads its own
controller: RDK its topology API and OneWifiMesh database, prplMesh its NBAPI
topology (wmdcfg.stacks)."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import time
from pathlib import Path

from .stacks import STACKS, get as _stack

# prplmesh-lab's room service reads this name; new code uses the stack's topology_url.
TOPOLOGY_URL = STACKS["prplmesh"].topology_url

# Mesh devices on the lab's controller that the room does not own, by AL MAC, one per line
# (# comments): a physical OpenSync pod joined to the RDK lab (opensync-rpi). Left out of
# the mesh's health, so the lab's own nodes are counted as the room expects them.
FOREIGN_DEVICES = "/etc/easymesh-lab/foreign-devices"
_MAC = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")


def foreign_devices() -> set[str]:
    """The AL MACs in EASYMESH_FOREIGN_DEVICES (a file, default FOREIGN_DEVICES); none
    when it is absent. A line that is not a MAC address is an error."""
    path = Path(os.environ.get("EASYMESH_FOREIGN_DEVICES", FOREIGN_DEVICES))
    try:
        text = path.read_text()
    except FileNotFoundError:
        return set()
    macs = {line.split("#", 1)[0].strip().lower() for line in text.splitlines()} - {""}
    malformed = sorted(mac for mac in macs if not _MAC.match(mac))
    if malformed:
        raise ValueError(f"{path}: not an AL MAC: {', '.join(malformed)}")
    return macs


def snapshot(plan: dict, stack: str | None = None) -> dict:
    """The room stations' associations as the controller's model has them."""
    if _stack(stack).name == "prplmesh":
        return _prplmesh_snapshot(plan)
    return _rdk_snapshot(plan)


def mesh_health(
    expected_agents: int | None = None,
    expected_clients: int | None = None,
    adapters: list[dict] | None = None,
    wired: int = 0,
    stack: str | None = None,
) -> dict:
    """Topology and controller-model completeness (see _rdk_mesh_health for the
    counts). The prplMesh lab has no adapter-managed nodes."""
    if _stack(stack).name == "prplmesh":
        if adapters:
            raise ValueError("adapter-managed mesh nodes are counted on the rdk stack only")
        return _prplmesh_mesh_health(expected_agents, expected_clients)
    return _rdk_mesh_health(expected_agents, expected_clients, adapters, wired)


def _run(*args: str) -> str:
    return subprocess.run(
        args, check=True, text=True, capture_output=True, timeout=10
    ).stdout.strip()


def _rdk_snapshot(plan: dict) -> dict:
    started = time.monotonic()
    query = (
        "select lower(MACAddress),lower(BSSID),RCPI "
        "from STAList where Associated=1;"
    )
    text = _run(
        "lxc", "exec", STACKS["rdk"].controller, "--", "sh", "-c",
        f"mysql -N -ubpi -proot OneWifiMesh -e '{query}' 2>/dev/null",
    )
    associated = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) == 3:
            associated[fields[0]] = {
                "bssid": fields[1],
                "rcpi": int(fields[2]),
            }
    stations = []
    for role, binding in plan["bindings"].items():
        if binding["role_type"] != "station":
            continue
        container = binding["container"]
        mac = binding["radio_permanent_mac"].lower()
        value = associated.get(mac, {})
        stations.append(
            {
                "role": role,
                "container": container,
                "mac": mac,
                "bssid": value.get("bssid"),
                "rcpi": value.get("rcpi"),
            }
        )
    return {
        "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "capture_elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        "stations": stations,
    }


def _rdk_mesh_health(
    expected_agents: int | None = None,
    expected_clients: int | None = None,
    adapters: list[dict] | None = None,
    wired: int = 0,
) -> dict:
    """Topology and controller-model completeness. ``expected_agents`` counts the
    lab's own mesh nodes (tri-band, ten BSSes, a backhaul station below the
    gateway); ``adapters`` (compiler.adapter_devices) adds mesh nodes managed
    through an adapter with their own radio and BSS counts. An adapter node
    on a wired path has no backhaul station in the controller's model; one on
    a Wi-Fi backhaul (the topology's backhaulMedia) has one, which is also a
    station associated with its parent's backhaul BSS. ``wired`` counts the
    lab's own extenders on a wired backhaul (among ``expected_agents``): no
    backhaul station associated anywhere."""
    adapters = adapters or []
    foreign = foreign_devices()
    topology = json.loads(_run("curl", "-fsS", STACKS["rdk"].topology_url))
    nodes = [node for node in topology.get("nodes", [])
             if str(node.get("id") or "").lower() not in foreign]
    clients = {
        station.get("staMAC")
        for node in nodes
        for station in (node.get("STAList") or [])
        if station.get("staMAC")
    }
    result = {
        # Retain the public keys for compatibility. Both now represent the
        # unique live associations in the topology; /api/v1/clients is a
        # packaged WebUI demonstration inventory, not controller state.
        "api_active": len(clients),
        "api_total": expected_clients if expected_clients is not None else len(clients),
        "topology_nodes": len(nodes),
        "complete_nodes": sum(
            1 for node in nodes
            if node.get("name") == "Controller"
            or sum(
                len(haul.get("BSSList") or [])
                for haul in (node.get("haulTypes") or [])
            ) == 10
        ),
    }
    wifi_adapters = sum(
        1 for node in nodes
        if node.get("kind") == "opensync-pod" and node.get("backhaulMedia") == "Wireless LAN"
    )
    if expected_agents is not None and expected_clients is not None:
        if foreign:
            # each row's device is its ID's second field (OneWifiMesh@<AL MAC>@...); a
            # foreign device's stations are those on its BSSes and its backhaul station
            al = "substring_index(substring_index(ID,'@',2),'@',-1)"
            macs = ",".join(f"'{mac}'" for mac in sorted(foreign))
            query = (
                f"select (select count(*) from DeviceList where {al} not in ({macs})),"
                f"(select count(*) from RadioList where {al} not in ({macs})),"
                f"(select count(*) from BSSList where {al} not in ({macs})),"
                "(select count(*) from STAList where Associated=1"
                f" and coalesce(BSSID,'') not in (select BSSID from BSSList where {al} in ({macs})"
                " and BSSID is not null)"
                f" and coalesce(MACAddress,'') not in (select BackhaulSTA from DeviceList where {al} in ({macs})"
                " and BackhaulSTA is not null));"
            )
        else:
            query = (
                "select (select count(*) from DeviceList),"
                "(select count(*) from RadioList),"
                "(select count(*) from BSSList),"
                "(select count(*) from STAList where Associated=1);"
            )
        # the query as an argument, not in the shell's words: it may quote strings
        text = _run(
            "lxc", "exec", STACKS["rdk"].controller, "--", "sh", "-c",
            'mysql -N -ubpi -proot OneWifiMesh -e "$1" 2>/dev/null', "sh", query,
        )
        values = [int(value) for value in text.split()]
        if len(values) != 4:
            raise RuntimeError(f"unexpected EasyMesh model counts: {text!r}")
        result.update(
            {
                "expected_topology_nodes": expected_agents + len(adapters) + 1,
                "model_devices": values[0],
                "model_radios": values[1],
                "model_bsses": values[2],
                "model_associated": values[3],
                "expected_model_devices": expected_agents + len(adapters),
                "expected_model_radios": expected_agents * 3 + sum(item["radios"] for item in adapters),
                "expected_model_bsses": expected_agents * 10 + sum(item["bsses"] for item in adapters)
                + wifi_adapters,
                "expected_model_associated": expected_clients + expected_agents - 1 - wired + wifi_adapters,
            }
        )
        # The WebUI is allowed to use its compact topology response profile.
        # Controller completeness comes from the authoritative model counts.
        if (
            result["topology_nodes"] == result["expected_topology_nodes"]
            and result["model_devices"] == result["expected_model_devices"]
            and result["model_radios"] == result["expected_model_radios"]
            and result["model_bsses"] == result["expected_model_bsses"]
            and result["model_associated"] == result["expected_model_associated"]
        ):
            result["complete_nodes"] = result["topology_nodes"]
    return result


def _prplmesh_topology() -> dict:
    return json.loads(_run("curl", "-fsS", STACKS["prplmesh"].topology_url))


def _prplmesh_associations(topology: dict) -> dict[str, dict]:
    result = {}
    for device in topology.get("devices", []):
        for radio in device.get("radios", []):
            for bss in radio.get("bsses", []):
                for client in bss.get("clients", []):
                    result[str(client["id"]).lower()] = {
                        "bssid": str(bss["bssid"]).lower(),
                        "rcpi": int(client.get("signal_raw") or 0),
                        "device": device.get("name"),
                        "band": radio.get("band"),
                    }
    return result


def _prplmesh_snapshot(plan: dict) -> dict:
    started = time.monotonic()
    topology = _prplmesh_topology()
    associated = _prplmesh_associations(topology)
    stations = []
    for role, binding in plan["bindings"].items():
        if binding["role_type"] != "station":
            continue
        mac = str(
            binding.get("station_mac") or binding["radio_permanent_mac"]
        ).lower()
        value = associated.get(mac, {})
        stations.append(
            {
                "role": role,
                "container": binding["container"],
                "mac": mac,
                "bssid": value.get("bssid"),
                "rcpi": value.get("rcpi"),
                "device": value.get("device"),
                "band": value.get("band"),
            }
        )
    return {
        "captured_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "capture_elapsed_ms": round((time.monotonic() - started) * 1000, 3),
        "source": topology.get("source", "prplMesh NBAPI"),
        "stations": stations,
    }


def _prplmesh_mesh_health(
    expected_agents: int | None = None,
    expected_clients: int | None = None,
) -> dict:
    topology = _prplmesh_topology()
    devices = topology.get("devices", [])
    associations = _prplmesh_associations(topology)
    complete = sum(
        1
        for device in devices
        if len(device.get("radios", [])) == 3
        and all(
            len(radio.get("bsses", [])) >= 3
            for radio in device.get("radios", [])
        )
    )
    result = {
        "source": topology.get("source", "prplMesh NBAPI"),
        "api_active": len(associations),
        "api_total": (
            expected_clients if expected_clients is not None else len(associations)
        ),
        "topology_nodes": len(devices),
        "complete_nodes": complete,
    }
    if expected_agents is not None:
        # The compiler's mesh_devices count includes the controller/colocated
        # Agent, so prplMesh expects exactly this many NBAPI Device objects.
        result["expected_topology_nodes"] = expected_agents
    return result
