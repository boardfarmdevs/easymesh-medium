from __future__ import annotations

import math


SCHEMA = "easymesh.rf-capabilities.v1"
MEASUREMENT_SCHEMA = "easymesh.rf-measurement.v1"
STATES = ("valid", "unsupported", "missing", "warming_up", "partial", "stale", "invalid")
IDENTITY_FIELDS = ("instance_id", "radio_id", "frequency_mhz", "width_mhz", "context_epoch")
UNITS = {
    "channel_utilization": "percent",
    "bss_load_utilization": "uint8/255",
    "noise": "dBm",
    "rcpi": "RCPI",
    "rx_rate": "Mbit/s",
}
LIMITS = {
    "channel_utilization": (0, 100),
    "bss_load_utilization": (0, 255),
    "noise": (-127, 0),
    "rcpi": (0, 220),
    "rx_rate": (0, None),
}


def capability_manifest(backend: str, status=None) -> dict:
    if backend not in ("userspace", "kernel"):
        raise ValueError(f"unknown RF backend: {backend!r}")
    wire = sorted(status.capabilities) if status is not None else []
    modeled = backend == "userspace" and "channel_survey" in wire
    return {
        "schema": SCHEMA,
        "profile": ("visibility-reservation-legacy20" if "visibility_contention" in wire else
                    "single-contention-domain-legacy20" if modeled else "signal-only-unqualified-airtime"),
        "backend": backend,
        "wire": {
            "state": "valid" if status is not None else "missing",
            "instance_id": getattr(status, "instance_id", None),
            "generation": getattr(status, "generation", None),
            "capabilities": wire,
        },
        "capabilities": {
            "modeled_channel_survey": {
                "state": "available" if modeled else "unsupported",
                "unit": "us", "source_kind": "modeled_interval_union",
                "reason": "Counter API only; each native context still needs a fresh qualified provider.",
            },
            "configured_snr": {
                "state": "valid" if "radio_pair_snr" in wire else "missing",
                "unit": "dB", "source_kind": "scenario_model",
            },
            "frequency_qualified_snr": {
                "state": "valid" if "frequency_qualified_snr" in wire else "missing",
                "unit": "dB", "source_kind": "scenario_model",
            },
            "candidate_rcpi": {
                "state": "model_derived", "unit": "RCPI",
                "source_kind": "hal_matrix",
                "reason": "Not a reception-backed sample; native query availability is separate.",
            },
            "channel_utilization": {
                "state": "missing" if modeled else "unsupported", "unit": "percent",
                "reason": ("Check native context/provider identity and freshness; a wire capability is not a sample."
                           if modeled else "No qualified operating-channel survey provider."),
            },
            "noise": {
                "state": "unsupported", "unit": "dBm",
                "reason": "Configured noise reference and scan/HAL placeholders are not measured noise.",
            },
            "rx_rate": {
                "state": "unsupported", "unit": "Mbit/s",
                "reason": "Injected RX rate and modeled PHY airtime are not qualified.",
            },
            "bss_load_utilization": {
                "state": "missing" if modeled else "unsupported", "unit": "uint8/255",
                "reason": ("Read the native beacon/scan/report; never derive an advertised value from capabilities."
                           if modeled else "Measured beacon/scan/report round-trip not qualified."),
            },
        },
        "measurement_contract": {
            "schema": MEASUREMENT_SCHEMA, "states": list(STATES),
            "unavailable_value": None,
            "clock": "monotonic_ns within one boot",
            "survey_counter_unit": "ms",
            "identity_fields": list(IDENTITY_FIELDS),
            "raw_is_diagnostic_only": True,
        },
        "qualification": {
            "modeled_airtime_api": modeled,
            "measured_airtime": False, "spatial_reuse": False,
            "reverse_ack": False, "physical_capacity": False,
            "kernel_backend_parity": False,
        },
    }


def measurement(
    attribute: str, raw_value, *, source: str, supported: bool = False,
    sampled_at_ns: int | None = None, now_ns: int | None = None,
    max_age_ns: int | None = None, state: str | None = None, reason: str = "",
) -> dict:
    if attribute not in UNITS:
        raise ValueError(f"unknown RF attribute: {attribute}")
    if state is not None and state not in STATES:
        raise ValueError(f"unknown measurement state: {state}")
    if state == "valid" and not supported:
        raise ValueError("an unsupported provider cannot publish a valid measurement")
    if not supported:
        state = "unsupported"
        reason = reason or "Provider is not qualified for this attribute."
    elif state is None or state == "valid":
        if raw_value is None:
            state, reason = "missing", "Provider supplied no value."
        elif isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
            state, reason = "invalid", "Value must be a finite number."
        elif not math.isfinite(raw_value):
            state, reason = "invalid", "Value must be a finite number."
        else:
            lower, upper = LIMITS[attribute]
            if raw_value < lower or (upper is not None and raw_value > upper):
                state, reason = "invalid", "Value outside the declared unit range."
            elif attribute in ("rcpi", "bss_load_utilization") and int(raw_value) != raw_value:
                state, reason = "invalid", "Protocol encoding must be an integer."
            elif any(type(value) is not int for value in (sampled_at_ns, now_ns, max_age_ns)):
                state, reason = "missing", "Sample time and freshness budget are required."
            elif sampled_at_ns < 0 or now_ns < sampled_at_ns or max_age_ns < 0:
                state, reason = "invalid", "Invalid monotonic sample time or freshness budget."
            elif now_ns - sampled_at_ns > max_age_ns:
                state, reason = "stale", "Sample exceeds the declared freshness budget."
            else:
                state = "valid"
    diagnostic = raw_value
    if isinstance(raw_value, float) and not math.isfinite(raw_value):
        diagnostic = repr(raw_value)
    return {
        "schema": MEASUREMENT_SCHEMA,
        "attribute": attribute, "unit": UNITS[attribute], "source": source,
        "state": state, "value": raw_value if state == "valid" else None,
        "raw_value": diagnostic, "sampled_at_ns": sampled_at_ns,
        "max_age_ns": max_age_ns, "reason": reason,
    }


def survey_utilization(
    previous: dict | None, current: dict, *, now_ns: int, max_age_ns: int,
    qualified: bool = False,
) -> dict:
    source = current.get("source", "nl80211-survey")

    def result(state, reason, value=None):
        return measurement(
            "channel_utilization", value, source=source, supported=qualified,
            state=state, reason=reason, sampled_at_ns=current.get("sampled_at_ns"),
            now_ns=now_ns, max_age_ns=max_age_ns,
        )

    if not qualified:
        return result("unsupported", "This backend has no qualified operating-channel survey.")
    if previous is None:
        return result("warming_up", "Two counter samples are required.")
    for sample in (previous, current):
        if any(sample.get(field) is None for field in IDENTITY_FIELDS):
            return result("missing", "Radio/context identity is incomplete.")
        if sample.get("counter_unit") != "ms":
            return result("invalid", "Linux survey counters must be in milliseconds.")
        if not {"active_ms", "busy_ms"} <= set(sample.get("valid_fields", [])):
            return result("partial", "Active and busy support flags are required.")
        if any(type(sample.get(field)) is not int or sample[field] < 0
               for field in ("active_ms", "busy_ms", "sampled_at_ns")):
            return result("invalid", "Counters and monotonic timestamps must be nonnegative integers.")
        if sample["busy_ms"] > sample["active_ms"]:
            return result("invalid", "Busy counter exceeds active counter.")
    if any(previous[field] != current[field] for field in IDENTITY_FIELDS):
        return result("warming_up", "Context changed; never difference counters across epochs.")
    if current["sampled_at_ns"] <= previous["sampled_at_ns"]:
        return result("invalid", "Counter samples must advance monotonically.")
    active = current["active_ms"] - previous["active_ms"]
    busy = current["busy_ms"] - previous["busy_ms"]
    if active < 0 or busy < 0:
        return result("invalid", "Counters reset without a new context epoch.")
    if busy > active:
        return result("invalid", "Busy delta exceeds active delta.")
    if active == 0:
        return result("warming_up", "Zero observation window is not measured idle.")
    observation = result("valid", "", 100 * busy / active)
    observation["window"] = {
        "start_ns": previous["sampled_at_ns"], "end_ns": current["sampled_at_ns"],
        "active_ms": active, "busy_ms": busy,
    }
    observation["bss_load_byte"] = (
        (255 * busy + active // 2) // active if observation["state"] == "valid" else None
    )
    return observation
