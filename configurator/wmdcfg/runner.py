from __future__ import annotations

import datetime as dt
import json
import os
import signal
import time
from pathlib import Path

from .actuator import ActuatorError, ControlClient
from .kernel_actuator import KernelMediumClient
from .observers import mesh_health, snapshot


COMMON_CAPABILITIES = {"atomic_generations", "readback", "dump_links"}
PAIR_CAPABILITIES = COMMON_CAPABILITIES | {"radio_pair_snr"}
FREQUENCY_CAPABILITIES = COMMON_CAPABILITIES | {"frequency_qualified_snr"}
# Compatibility name used by older callers and tests.
REQUIRED_CAPABILITIES = PAIR_CAPABILITIES


def _append(path: Path, value: dict) -> None:
    with path.open("a") as stream:
        stream.write(json.dumps(value, sort_keys=True) + "\n")


class Runner:
    def __init__(
        self,
        plan: dict,
        socket_path: str,
        output_root: Path,
        *,
        backend: str = "userspace",
        kernel_root: str = "/sys/kernel/debug/ieee80211",
        noise_floor_dbm: int = -91,
    ):
        self.plan = plan
        self.socket_path = socket_path
        timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.run_dir = output_root / f"{timestamp}-{plan['scenario']}-{os.getpid()}"
        self.stop_requested = False
        self.backend = backend
        self.kernel_root = kernel_root
        self.noise_floor_dbm = noise_floor_dbm

    def _client(self):
        if self.backend == "userspace":
            return ControlClient(self.socket_path)
        if self.backend == "kernel":
            return KernelMediumClient(
                self.kernel_root, noise_floor_dbm=self.noise_floor_dbm
            )
        raise ActuatorError(f"unknown medium backend {self.backend!r}")

    def _signal(self, signum, frame) -> None:
        self.stop_requested = True

    @staticmethod
    def _apply_generation(
        client: ControlClient,
        previous_generation: int,
        updates: list[dict],
        frequency_mode: bool,
        *,
        attempts: int = 4,
    ) -> tuple[int, list[dict]]:
        """Apply one atomic generation without assuming exclusive socket use.

        A steering actuator may temporarily bias the same medium while a timed
        scenario is running.  That legitimate second writer advances the
        daemon generation and makes a locally precomputed value stale.  Read
        the current generation for every transaction and retry only the
        daemon's explicit generation-conflict response.  Other actuator
        failures remain fatal.
        """
        for attempt in range(attempts):
            generation = max(previous_generation, client.status().generation) + 1
            try:
                applied = (
                    client.apply_frequency(generation, updates)
                    if frequency_mode
                    else client.apply(generation, updates)
                )
                return generation, applied
            except ActuatorError as error:
                if "generation" not in str(error).lower() or attempt + 1 == attempts:
                    raise
        raise AssertionError("unreachable")

    @staticmethod
    def _require_healthy(health: dict, stage: str) -> None:
        if health["api_active"] != health["api_total"]:
            raise ActuatorError(f"mesh {stage} has inactive clients")
        if health["complete_nodes"] != health["topology_nodes"]:
            raise ActuatorError(f"mesh {stage} has incomplete topology nodes")
        comparisons = (
            ("topology_nodes", "expected_topology_nodes"),
            ("model_devices", "expected_model_devices"),
            ("model_radios", "expected_model_radios"),
            ("model_bsses", "expected_model_bsses"),
            ("model_associated", "expected_model_associated"),
        )
        for actual, expected in comparisons:
            if expected in health and health.get(actual) != health[expected]:
                raise ActuatorError(
                    f"mesh {stage} {actual}={health.get(actual)}, "
                    f"expected {health[expected]}"
                )

    def execute(self) -> Path:
        self.run_dir.mkdir(parents=True, exist_ok=False)
        (self.run_dir / "event-plan.json").write_text(
            json.dumps(self.plan, indent=2, sort_keys=True) + "\n"
        )
        event_log = self.run_dir / "medium-events.jsonl"
        health_log = self.run_dir / "health-events.jsonl"
        old_handlers = {
            signum: signal.signal(signum, self._signal)
            for signum in (signal.SIGINT, signal.SIGTERM)
        }
        outcome = "failed"
        error_text = None
        restored = False
        overall_started = time.monotonic()
        execution_started = None
        try:
            with self._client() as client:
                status = client.status()
                plan_updates = [
                    update for event in self.plan["events"] for update in event["updates"]
                ]
                frequency_mode = any("frequency_mhz" in item for item in plan_updates)
                if frequency_mode and any(
                    "frequency_mhz" not in item for item in plan_updates
                ):
                    raise ActuatorError("event plan mixes pair and frequency updates")
                required = FREQUENCY_CAPABILITIES if frequency_mode else PAIR_CAPABILITIES
                missing = required - status.capabilities
                if missing:
                    raise ActuatorError(f"daemon lacks capabilities {sorted(missing)}")
                _, dumped = client.dump_links()
                pair_baseline = {
                    (item["source"], item["destination"]): item["value"]
                    for item in dumped
                }
                touched_pairs = {
                    (update["source"], update["destination"])
                    for update in plan_updates
                }
                unknown = sorted(touched_pairs - set(pair_baseline))
                if unknown:
                    raise ActuatorError(f"plan identities are absent from daemon: {unknown}")
                if frequency_mode:
                    touched = {
                        (item["source"], item["destination"], item["frequency_mhz"])
                        for item in plan_updates
                    }
                    restore_updates = []
                    for source, destination, frequency in sorted(touched):
                        _, value, overridden = client.get_frequency_link(
                            source, destination, frequency
                        )
                        restore_updates.append(
                            {
                                "source": source,
                                "destination": destination,
                                "frequency_mhz": frequency,
                                "value": value if overridden else 0,
                                "override": overridden,
                            }
                        )
                else:
                    restore_updates = [
                        {"source": source, "destination": destination,
                         "value": pair_baseline[(source, destination)]}
                        for source, destination in sorted(touched_pairs)
                    ]
                expected_lab = self.plan.get("expected_lab") or {}
                expected_agents = int(expected_lab.get(
                    "mesh_devices",
                    sum(
                        binding["role_type"] == "fronthaul_ap"
                        for binding in self.plan["bindings"].values()
                    ),
                ))
                expected_clients = int(expected_lab.get(
                    "clients",
                    sum(
                        binding["role_type"] == "station"
                        for binding in self.plan["bindings"].values()
                    ),
                ))
                initial_health = mesh_health(expected_agents, expected_clients)
                _append(health_log, {"event": "preflight", **initial_health})
                self._require_healthy(initial_health, "preflight")
                execution_started = time.monotonic()
                generation = status.generation
                try:
                    for event in self.plan["events"]:
                        deadline = execution_started + event["time_ms"] / 1000
                        while True:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                break
                            if self.stop_requested:
                                raise InterruptedError("run interrupted")
                            time.sleep(min(remaining, 0.1))
                        if not event["updates"]:
                            _append(event_log, {"event": "mark", **event})
                            continue
                        desired_at = execution_started + event["time_ms"] / 1000
                        generation, applied = self._apply_generation(
                            client,
                            generation,
                            event["updates"],
                            frequency_mode,
                        )
                        if frequency_mode:
                            readback = []
                            for item in applied:
                                _, value, overridden = client.get_frequency_link(
                                    item["source"], item["destination"],
                                    item["frequency_mhz"],
                                )
                                readback.append(
                                    {
                                        "source": item["source"],
                                        "destination": item["destination"],
                                        "frequency_mhz": item["frequency_mhz"],
                                        "value": value,
                                        "override": overridden,
                                    }
                                )
                        else:
                            readback = [
                                {
                                    "source": item["source"],
                                    "destination": item["destination"],
                                    "value": client.get_link(
                                        item["source"], item["destination"]
                                    )[1],
                                }
                                for item in applied
                            ]
                        if readback != applied:
                            raise ActuatorError("generation readback mismatch")
                        _append(
                            event_log,
                            {
                                "event": "generation",
                                "plan_generation": event["generation"],
                                "daemon_generation": generation,
                                "time_ms": event["time_ms"],
                                "deadline_lateness_ms": round(
                                    (time.monotonic() - desired_at) * 1000, 3
                                ),
                                "updates": applied,
                                "observation": snapshot(self.plan),
                            },
                        )
                    end_deadline = execution_started + self.plan["duration_ms"] / 1000
                    while time.monotonic() < end_deadline:
                        if self.stop_requested:
                            raise InterruptedError("run interrupted")
                        time.sleep(min(end_deadline - time.monotonic(), 0.1))
                finally:
                    if restore_updates:
                        generation, _ = self._apply_generation(
                            client,
                            generation,
                            restore_updates,
                            frequency_mode,
                        )
                        if frequency_mode:
                            restored = all(
                                client.get_frequency_link(
                                    item["source"], item["destination"],
                                    item["frequency_mhz"],
                                )[1:] == (item["value"] if item["override"] else
                                          pair_baseline[(item["source"], item["destination"])],
                                          item["override"])
                                for item in restore_updates
                            )
                        else:
                            restored = all(
                                client.get_link(item["source"], item["destination"])[1]
                                == item["value"]
                                for item in restore_updates
                            )
                        _append(
                            event_log,
                            {"event": "restore", "daemon_generation": generation,
                             "verified": restored, "updates": restore_updates},
                        )
                        if not restored:
                            raise ActuatorError("baseline restoration readback failed")
                final_health = mesh_health(expected_agents, expected_clients)
                _append(health_log, {"event": "postflight", **final_health})
                self._require_healthy(final_health, "postflight")
                outcome = "passed"
        except Exception as error:
            outcome = "failed"
            error_text = str(error)
            raise
        finally:
            for signum, handler in old_handlers.items():
                signal.signal(signum, handler)
            summary = {
                "scenario": self.plan["scenario"],
                "medium_backend": self.backend,
                "outcome": outcome,
                "restored": restored,
                "error": error_text,
                "elapsed_ms": round((time.monotonic() - overall_started) * 1000, 3),
                "execution_elapsed_ms": (
                    round((time.monotonic() - execution_started) * 1000, 3)
                    if execution_started is not None else None
                ),
            }
            (self.run_dir / "summary.json").write_text(
                json.dumps(summary, indent=2, sort_keys=True) + "\n"
            )
        return self.run_dir
