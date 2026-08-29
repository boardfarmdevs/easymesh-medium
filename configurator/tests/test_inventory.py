import subprocess
from unittest.mock import patch

from wmdcfg.inventory import _run, discover


def test_inventory_probe_retries_a_lost_lxc_exec_transport():
    failed = subprocess.CalledProcessError(-15, ["lxc", "exec"])
    completed = subprocess.CompletedProcess(["lxc", "exec"], 0, "ready\n", "")
    with patch("wmdcfg.inventory.subprocess.run", side_effect=[failed, completed]) as run, patch(
        "wmdcfg.inventory.time.sleep"
    ) as sleep:
        assert _run("lxc", "exec", "mesh", attempts=2) == "ready"

    assert run.call_count == 2
    sleep.assert_called_once_with(0.5)


def test_inventory_probe_retries_a_bounded_timeout():
    failed = subprocess.TimeoutExpired(["lxc", "exec"], 0.25)
    completed = subprocess.CompletedProcess(["lxc", "exec"], 0, "ready\n", "")
    with patch("wmdcfg.inventory.subprocess.run", side_effect=[failed, completed]) as run, patch(
        "wmdcfg.inventory.time.sleep"
    ) as sleep:
        assert _run(
            "lxc", "exec", "mesh", attempts=2, timeout_seconds=0.25
        ) == "ready"

    assert run.call_count == 2
    assert all(call.kwargs["timeout"] == 0.25 for call in run.call_args_list)
    sleep.assert_called_once_with(0.5)


def _mesh_iw(first: int) -> str:
    return "\n".join(
        (
            f"phy#{first}\n Interface wifi2.1\n  addr 02:00:00:10:{first + 2:02x}:01\n  ssid private_ssid\n  channel 5 (5975 MHz)",
            f" Interface wifi1.1\n  addr 02:00:00:10:{first + 1:02x}:01\n  ssid private_ssid\n  channel 36 (5180 MHz)",
            f" Interface wifi0.1\n  addr 02:00:00:10:{first:02x}:01\n  ssid private_ssid\n  channel 6 (2437 MHz)",
        )
    )


def _inspect(container: str, command: str) -> str:
    first = 0 if container == "bpibroadband" else 3
    if "macaddress" in command:
        if container.startswith("wlan-client"):
            return "phy15 02:00:00:00:0f:00"
        return f"phy{first} 02:00:00:00:{first:02x}:00"
    if command == "iw dev 2>/dev/null":
        if container.startswith("wlan-client"):
            return (
                "phy#15\n Interface wlan0\n  addr 02:00:00:20:01:00\n"
                "  ssid iot_ssid\n  channel 36 (5180 MHz)"
            )
        return _mesh_iw(first)
    if command.startswith("iw dev wlan0 link"):
        return "Connected to 02:00:00:10:04:01\n\tSSID: iot_ssid\n\tfreq: 5180"
    return ""


def test_discover_ignores_stopped_matching_containers_and_maps_tri_band_radios():
    listing = "\n".join(
        (
            "bpibroadband,RUNNING",
            "bpiap,RUNNING",
            "bpiap-001,STOPPED",
            "wlan-client,RUNNING",
            "wlan-client-001,STOPPED",
        )
    )

    with patch("wmdcfg.inventory._run", return_value=listing), patch(
        "wmdcfg.inventory._exec", side_effect=_inspect
    ):
        inventory = discover()

    assert [radio["container"] for radio in inventory["radios"]] == [
        "bpiap",
        "bpibroadband",
        "wlan-client",
    ]
    mesh = next(item for item in inventory["radios"] if item["container"] == "bpiap")
    assert set(mesh["band_radios"]) == {"2.4", "5", "6"}
    assert mesh["band_radios"]["5"]["tx_mac"] == "42:00:00:00:03:00"
    assert len({entry["phy"] for entry in mesh["band_radios"].values()}) == 1
    station = next(item for item in inventory["radios"] if item["kind"] == "station")
    assert station["station_mac"] == "02:00:00:20:01:00"
    assert station["associated_bssid"] == "02:00:00:10:04:01"
    assert station["band"] == "5"
    assert station["ssid"] == "iot_ssid"
    assert station["cohort"] == "iot"


def test_discover_can_limit_station_probes_without_omitting_mesh_radios():
    listing = "\n".join(
        (
            "bpibroadband,RUNNING",
            "bpiap,RUNNING",
            "wlan-client,RUNNING",
            "wlan-client-001,RUNNING",
        )
    )
    inspected: set[str] = set()

    def inspect(container: str, command: str) -> str:
        inspected.add(container)
        return _inspect(container, command)

    with patch("wmdcfg.inventory._run", return_value=listing), patch(
        "wmdcfg.inventory._exec", side_effect=inspect
    ):
        inventory = discover({"wlan-client-001"})

    assert [radio["container"] for radio in inventory["radios"]] == [
        "bpiap",
        "bpibroadband",
        "wlan-client-001",
    ]
    assert inspected == {"bpiap", "bpibroadband", "wlan-client-001"}
