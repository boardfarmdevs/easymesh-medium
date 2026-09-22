OPCODES = dict(enumerate((
    "hello", "status", "apply", "get_link", "dump_links", "apply_frequency", "get_frequency",
    "dump_frequencies", "telemetry_summary", "dump_radio_frequencies", "dump_active_links", "dump_vifs",
    "dump_events", "get_association", "get_channel_survey", "get_observer_surveys", "explorer_detail",
), start=1))
CAPABILITIES = dict(enumerate((
    "radio_pair_snr", "atomic_generations", "readback", "dump_links", "frequency_qualified_snr",
    "read_only", "telemetry", "paged_dumps", "vif_ownership", "event_ring", "association_ownership",
    "paged_link_dumps", "channel_survey", "observer_surveys", "visibility_contention", "priority_queues",
    "explorer_details",
)))


def protocol_registry():
    return {"schema": "easymesh.rf-protocol.v1", "wire_version": 1,
            "opcodes": dict(OPCODES), "capability_bits": dict(CAPABILITIES),
            "rf_mutations": [3, 6], "selected_diagnostic_lease": 17,
            "allocation_note": "Existing IDs are reserved. Negotiate new operations; capability is not activation or qualification."}
