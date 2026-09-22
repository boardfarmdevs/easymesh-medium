from dataclasses import replace

import pytest

from wmdcfg.rf_environment import RadioEnvironment, decode_environment, predict_link, require_runtime_support, SCHEMA


@pytest.mark.parametrize("snr", [-20, 0, 1, 24, 60, 100])
def test_legacy_reference_is_unchanged(snr):
    baseline = RadioEnvironment()
    result = predict_link(snr, baseline, baseline)
    assert result["effective_snr_db"] == snr
    assert result["received_power_dbm"] == snr - 91
    assert not result["applied"] and not result["native_measurement"]


def test_power_noise_and_frame_sensing_are_independent_and_directional():
    baseline = RadioEnvironment()
    original = predict_link(30, baseline, baseline)
    noisy = predict_link(30, baseline, replace(baseline, noise_dbm=-81))
    quieter = predict_link(30, replace(baseline, tx_power_offset_db=-10), baseline)
    threshold = predict_link(30, baseline, replace(baseline, cca_threshold_dbm=-50))
    assert noisy["received_power_dbm"] == original["received_power_dbm"]
    assert noisy["effective_snr_db"] == original["effective_snr_db"] - 10
    assert quieter["received_power_dbm"] == original["received_power_dbm"] - 10
    assert threshold["effective_snr_db"] == original["effective_snr_db"]
    assert original["frame_above_cca"] and not threshold["frame_above_cca"]
    assert predict_link(30, replace(baseline, noise_dbm=-81), baseline) == original


@pytest.mark.parametrize("value", [True, None, "-91", float("inf"), float("nan"), -128, 1])
def test_invalid_noise_is_not_silently_coerced(value):
    with pytest.raises(ValueError):
        RadioEnvironment(noise_dbm=value)


def test_explicit_opt_in_and_unknown_properties_fail_closed():
    document = {"schema": SCHEMA, "enabled": True, "tx_power_offset_db": 0,
                "noise_dbm": -91, "cca_threshold_dbm": -90}
    assert decode_environment(document) == RadioEnvironment()
    for invalid in ({**document, "enabled": False}, {**document, "extra": 0},
                    {**document, "schema": "future"}, {}):
        with pytest.raises(ValueError):
            decode_environment(invalid)
    with pytest.raises(ValueError, match="not supported"):
        require_runtime_support({"explorer_details"})
    with pytest.raises(NotImplementedError, match="not qualified"):
        require_runtime_support({"independent_rf_environment_v1"})
