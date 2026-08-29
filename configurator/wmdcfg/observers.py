from __future__ import annotations

import datetime as dt
import json
import subprocess
import time


def _run(*args: str) -> str:
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout.strip()


def snapshot(plan: dict) -> dict:
    started = time.monotonic()
    query = (
        "select lower(MACAddress),lower(BSSID),RCPI "
        "from STAList where Associated=1;"
    )
    text = _run(
        "lxc", "exec", "bpibroadband", "--", "sh", "-c",
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


def mesh_health(expected_agents: int | None = None, expected_clients: int | None = None) -> dict:
    topology = json.loads(_run("curl", "-fsS", "http://127.0.0.1:8888/api/v1/topology"))
    nodes = topology.get("nodes", [])
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
    if expected_agents is not None and expected_clients is not None:
        query = (
            "select (select count(*) from DeviceList),"
            "(select count(*) from RadioList),"
            "(select count(*) from BSSList),"
            "(select count(*) from STAList where Associated=1);"
        )
        text = _run(
            "lxc", "exec", "bpibroadband", "--", "sh", "-c",
            f"mysql -N -ubpi -proot OneWifiMesh -e '{query}' 2>/dev/null",
        )
        values = [int(value) for value in text.split()]
        if len(values) != 4:
            raise RuntimeError(f"unexpected EasyMesh model counts: {text!r}")
        result.update(
            {
                "expected_topology_nodes": expected_agents + 1,
                "model_devices": values[0],
                "model_radios": values[1],
                "model_bsses": values[2],
                "model_associated": values[3],
                "expected_model_devices": expected_agents,
                "expected_model_radios": expected_agents * 3,
                "expected_model_bsses": expected_agents * 10,
                "expected_model_associated": expected_clients + expected_agents - 1,
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
