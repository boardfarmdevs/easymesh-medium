import subprocess
from unittest.mock import patch

from wmdcfg.inventory import _run, discover
from wmdcfg.stacks import STACKS

CLIENT_NAME = STACKS["prplmesh"].client


def test_client_name_accepts_canonical_two_and_three_digit_ordinals():
    for name in (
        "prpl-client-01",
        "prpl-client-10",
        "prpl-client-99",
        "prpl-client-100",
        "prpl-client-999",
    ):
        assert CLIENT_NAME.fullmatch(name), name


def test_client_name_rejects_malformed_ordinals():
    for name in (
        "prpl-client-1",
        "prpl-client-1a",
        "prpl-client-100-extra",
        "prpl-client--10",
        "prpl-client-",
    ):
        assert not CLIENT_NAME.fullmatch(name), name


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
        assert _run("lxc", "exec", "mesh", attempts=2, timeout_seconds=0.25) == "ready"
    assert run.call_count == 2
    assert all(call.kwargs["timeout"] == 0.25 for call in run.call_args_list)
    sleep.assert_called_once_with(0.5)


def _mesh_iw(first: int) -> str:
    return "\n".join(
        (
            f"phy#{first + 2}\n Interface wlan4\n  addr 02:00:00:00:{first + 2:02x}:00\n  ssid private_ssid\n  channel 5 (5975 MHz)",
            f"phy#{first + 1}\n Interface wlan2\n  addr 02:00:00:00:{first + 1:02x}:00\n  ssid private_ssid\n  channel 36 (5180 MHz)",
            f"phy#{first}\n Interface wlan0\n  addr 02:00:00:00:{first:02x}:00\n  ssid private_ssid\n  channel 6 (2437 MHz)",
        )
    )


def _inspect(container: str, command: str) -> str:
    first = 0 if container == "prpl-controller" else 3
    if "macaddress" in command:
        if container.startswith("prpl-client"):
            return "phy15 02:00:00:00:0f:00"
        return "\n".join(
            f"phy{first + offset} 02:00:00:00:{first + offset:02x}:00"
            for offset in range(3)
        )
    if command == "iw dev 2>/dev/null":
        if container.startswith("prpl-client"):
            return (
                "phy#15\n Interface wlan0\n  addr 02:00:00:20:01:00\n"
                "  ssid iot_ssid\n  channel 36 (5180 MHz)"
            )
        return _mesh_iw(first)
    if command.startswith("iw dev wlan0 link"):
        return "Connected to 02:00:00:00:04:01\n\tSSID: iot_ssid\n\tfreq: 5180"
    return ""


def test_discover_ignores_stopped_matching_containers_and_maps_tri_band_radios():
    listing = "\n".join(
        (
            "prpl-controller,RUNNING",
            "prpl-agent-01,RUNNING",
            "prpl-agent-02,STOPPED",
            "prpl-client-01,RUNNING",
            "prpl-client-02,STOPPED",
        )
    )
    with patch("wmdcfg.inventory._run", return_value=listing), patch(
        "wmdcfg.inventory._exec", side_effect=_inspect
    ):
        inventory = discover()
    assert [radio["container"] for radio in inventory["radios"]] == [
        "prpl-agent-01", "prpl-client-01", "prpl-controller"
    ]
    mesh = next(item for item in inventory["radios"] if item["container"] == "prpl-agent-01")
    assert set(mesh["band_radios"]) == {"2.4", "5", "6"}
    assert mesh["band_radios"]["5"]["tx_mac"] == "42:00:00:00:04:00"
    station = next(item for item in inventory["radios"] if item["kind"] == "station")
    assert station["station_mac"] == "02:00:00:20:01:00"
    assert station["associated_bssid"] == "02:00:00:00:04:01"
    assert station["band"] == "5"
    assert station["cohort"] == "iot"


def test_discover_can_limit_station_probes_without_omitting_mesh_nodes():
    listing = "\n".join(
        (
            "prpl-controller,RUNNING",
            "prpl-agent-01,RUNNING",
            "prpl-client-01,RUNNING",
            "prpl-client-02,RUNNING",
        )
    )
    inspected: set[str] = set()

    def inspect(container: str, command: str) -> str:
        inspected.add(container)
        return _inspect(container, command)

    with patch("wmdcfg.inventory._run", return_value=listing), patch(
        "wmdcfg.inventory._exec", side_effect=inspect
    ):
        inventory = discover({"prpl-client-01"})
    assert [radio["container"] for radio in inventory["radios"]] == [
        "prpl-agent-01", "prpl-client-01", "prpl-controller"
    ]
    assert inspected == {"prpl-controller", "prpl-agent-01", "prpl-client-01"}
