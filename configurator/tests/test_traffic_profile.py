import copy

import pytest

from wmdcfg.traffic_profile import validate_traffic


PHASE = {"role": "client", "mode": "udp", "start_ms": 5000, "end_ms": 10000,
         "offered_mbps": 8, "payload_bytes": 1200}
WORLD = {"roles": {"client": "station"}, "generations": [{"present": {"client": True}}],
         "duration_ms": 30000,
         "traffic_experiment": {"schema": "easymesh.room-traffic.v1", "phases": [PHASE]}}


@pytest.mark.parametrize("change", [
    {"mode": "tcp"}, {"mode": "icmp"}, {"mode": None}, {"offered_mbps": 0}, {"offered_mbps": -1},
    {"offered_mbps": True}, {"offered_mbps": "8"}, {"offered_mbps": 12.1}, {"offered_mbps": float("nan")},
    {"offered_mbps": float("inf")}, {"payload_bytes": 64}, {"packets_per_second": 20},
    {"duration_ms": 5000}, {"end_ms": 26000}, {"start_ms": False}, {"role": "gateway"},
    {"port": 55201}, {"target": "10.0.0.2"}, {"gateway_container": "other"},
    {"parallel": 2}, {"command": "iperf3"}, {"interface": "lo"},
])
def test_udp_rejects_unbounded_ambiguous_or_endpoint_fields(change):
    world = copy.deepcopy(WORLD)
    world["traffic_experiment"]["phases"][0].update(change)
    with pytest.raises(ValueError):
        validate_traffic(world)


def test_udp_and_unchanged_icmp_schema_can_share_a_bounded_profile():
    icmp = {"role": "client", "start_ms": 10000, "end_ms": 20000,
            "packets_per_second": 200, "payload_bytes": 1200}
    world = copy.deepcopy(WORLD)
    world["traffic_experiment"]["phases"].append(icmp)
    profile = validate_traffic(world)
    assert profile == world["traffic_experiment"]
    assert profile is not world["traffic_experiment"]
    assert "mode" not in profile["phases"][1]


@pytest.mark.parametrize("rate", [0.1, 1, 8, 12])
def test_udp_accepts_finite_bounded_offered_rates(rate):
    world = copy.deepcopy(WORLD)
    world["traffic_experiment"]["phases"][0]["offered_mbps"] = rate
    assert validate_traffic(world)["phases"][0]["offered_mbps"] == rate
