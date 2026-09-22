from __future__ import annotations

from dataclasses import dataclass
import math


SCHEMA = "easymesh.rf-environment.v1"
LEGACY_NOISE_DBM = -91
LEGACY_CCA_DBM = -90


def number(value, name, minimum, maximum):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be finite and between {minimum} and {maximum}")
    return value


@dataclass(frozen=True)
class RadioEnvironment:
    tx_power_offset_db: float = 0
    noise_dbm: float = LEGACY_NOISE_DBM
    cca_threshold_dbm: float = LEGACY_CCA_DBM

    def __post_init__(self):
        number(self.tx_power_offset_db, "tx_power_offset_db", -40, 40)
        number(self.noise_dbm, "noise_dbm", -127, 0)
        number(self.cca_threshold_dbm, "cca_threshold_dbm", -127, 0)


def decode_environment(document):
    if not isinstance(document, dict) or document.get("schema") != SCHEMA:
        raise ValueError("unsupported RF environment schema")
    if set(document) != {"schema", "enabled", "tx_power_offset_db", "noise_dbm", "cca_threshold_dbm"}:
        raise ValueError("RF environment requires explicit fields; unknown properties are rejected")
    if document["enabled"] is not True:
        raise ValueError("independent RF environment requires explicit enabled=true")
    return RadioEnvironment(**{key: document[key] for key in ("tx_power_offset_db", "noise_dbm", "cca_threshold_dbm")})


def predict_link(configured_snr_db, transmitter, receiver):
    configured_snr_db = number(configured_snr_db, "configured_snr_db", -200, 200)
    signal = configured_snr_db + LEGACY_NOISE_DBM + transmitter.tx_power_offset_db
    return {"schema": "easymesh.rf-environment-prediction.v1", "kind": "reference_model_only",
            "applied": False, "native_measurement": False,
            "received_power_dbm": signal, "effective_snr_db": signal - receiver.noise_dbm,
            "frame_above_cca": signal >= receiver.cca_threshold_dbm}


def require_runtime_support(capabilities):
    if "independent_rf_environment_v1" not in capabilities:
        raise ValueError("Independent power/noise/CCA is not supported by this runtime; no RF write was attempted")
    raise NotImplementedError("Actuation, readback, restoration and native reporting are not qualified; reference model only")
