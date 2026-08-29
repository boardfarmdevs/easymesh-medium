from __future__ import annotations

import fcntl
import hashlib
import re
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .actuator import ActuatorError, DaemonStatus


RADIO = re.compile(
    r"^radio (?P<mac>[0-9a-f:]{17}) idx (?P<idx>\d+) active_bank (?P<bank>[01])$",
    re.I,
)
DEFAULT = re.compile(
    r"^default signal (?P<signal>-?\d+) loss_pct (?P<loss>\d+) cutoff (?P<cutoff>-?\d+)$"
)
LINK = re.compile(
    r"^set (?P<bank>[01]) (?P<source>[0-9a-f:]{17}) "
    r"(?P<band>2\.4|5|6) (?P<signal>-?\d+) (?P<loss>\d+)$",
    re.I,
)

BAND_FREQUENCY = {"2.4": 2437, "5": 5180, "6": 5975}
CAPABILITIES = frozenset(
    {
        "radio_pair_snr",
        "atomic_generations",
        "readback",
        "dump_links",
        "frequency_qualified_snr",
        "kernel_data_path",
    }
)


@dataclass(frozen=True)
class _Radio:
    mac: str
    idx: int
    active_bank: int
    default_signal: int
    path: Path
    links: dict[tuple[int, str, str], tuple[int, int]]


def _band(frequency_mhz: int) -> str:
    if frequency_mhz < 2500:
        return "2.4"
    if frequency_mhz < 5925:
        return "5"
    if frequency_mhz < 7125:
        return "6"
    raise ActuatorError(f"unsupported kernel-medium frequency {frequency_mhz}")


class KernelMediumClient:
    """Control the optional hwsim in-kernel medium through debugfs.

    The public methods intentionally mirror ``ControlClient`` so the existing
    scenario runner can select either data path without changing event plans.
    Scenario values remain SNR dB; the kernel ABI uses dBm and this adapter
    applies one explicit noise floor for the conversion.
    """

    def __init__(
        self,
        root: str = "/sys/kernel/debug/ieee80211",
        *,
        noise_floor_dbm: int = -91,
        lock_path: str = "/run/hwsim-kernel-medium.lock",
        parameters_root: str = "/sys/module/mac80211_hwsim/parameters",
        locking: bool = True,
    ):
        self.root = Path(root)
        self.noise_floor_dbm = noise_floor_dbm
        self.lock_path = Path(lock_path)
        self.parameters_root = Path(parameters_root)
        self.locking = locking
        self._connected = False
        self.instance_id: str | None = None

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    @property
    def _parameters(self) -> Path:
        return self.parameters_root

    def connect(self) -> DaemonStatus:
        if self._connected:
            raise ActuatorError("kernel-medium client is already connected")
        try:
            if self._read_parameter("kernel_medium").lower() not in {"y", "1"}:
                raise ActuatorError("hwsim kernel medium is not enabled")
            self.instance_id = self._instance_id()
            status = self.status()
            self._connected = True
            return status
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        self._connected = False

    @contextmanager
    def _writer_lock(self):
        if not self.locking:
            yield
            return
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _read_parameter(self, name: str) -> str:
        try:
            return (self._parameters / name).read_text().strip()
        except OSError as error:
            raise ActuatorError(f"cannot read hwsim kernel-medium parameter {name}") from error

    def _instance_id(self) -> str:
        try:
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            source = Path("/sys/module/mac80211_hwsim/srcversion").read_text().strip()
        except OSError as error:
            raise ActuatorError("cannot identify the loaded hwsim module") from error
        return hashlib.sha256(f"{boot}:{source}".encode()).hexdigest()[:32]

    def _radios(self) -> dict[str, _Radio]:
        result: dict[str, _Radio] = {}
        for path in sorted(self.root.glob("phy*/hwsim/kernel_medium_links")):
            mac = None
            idx = bank = default_signal = None
            links: dict[tuple[int, str, str], tuple[int, int]] = {}
            try:
                lines = path.read_text().splitlines()
            except OSError as error:
                raise ActuatorError(f"cannot read {path}") from error
            for line in lines:
                match = RADIO.fullmatch(line)
                if match:
                    mac = match.group("mac").lower()
                    idx = int(match.group("idx"))
                    bank = int(match.group("bank"))
                    continue
                match = DEFAULT.fullmatch(line)
                if match:
                    default_signal = int(match.group("signal"))
                    continue
                match = LINK.fullmatch(line)
                if match:
                    links[
                        (
                            int(match.group("bank")),
                            match.group("source").lower(),
                            match.group("band"),
                        )
                    ] = (int(match.group("signal")), int(match.group("loss")))
            if mac is None or idx is None or bank is None or default_signal is None:
                raise ActuatorError(f"invalid kernel-medium control data in {path}")
            if mac in result:
                raise ActuatorError(f"duplicate hwsim kernel-medium identity {mac}")
            result[mac] = _Radio(mac, idx, bank, default_signal, path, links)
        if len(result) < 2:
            raise ActuatorError("fewer than two hwsim kernel-medium radios are visible")
        banks = {radio.active_bank for radio in result.values()}
        if len(banks) != 1:
            raise ActuatorError("hwsim kernel-medium controls disagree on active bank")
        return result

    def status(self) -> DaemonStatus:
        identity = self._instance_id()
        if self.instance_id is not None and identity != self.instance_id:
            raise ActuatorError("hwsim kernel-medium instance changed during the run")
        radios = self._radios()
        generation = int(self._read_parameter("kernel_medium_generation"))
        return DaemonStatus(
            instance_id=identity,
            generation=generation,
            capabilities=CAPABILITIES,
            max_updates=len(radios) * (len(radios) - 1) * 3,
            num_stations=len(radios),
        )

    def _default_snr(self, radio: _Radio) -> int:
        return radio.default_signal - self.noise_floor_dbm

    def _signal(self, snr_db: int) -> int:
        signal = int(snr_db) + self.noise_floor_dbm
        if signal >= 0 or signal < -127:
            raise ActuatorError(
                f"SNR {snr_db} is outside the kernel-medium signal range "
                f"for noise floor {self.noise_floor_dbm} dBm"
            )
        return signal

    def dump_links(self) -> tuple[int, list[dict]]:
        radios = self._radios()
        generation = int(self._read_parameter("kernel_medium_generation"))
        links = []
        for source in sorted(radios):
            for destination, receiver in sorted(radios.items()):
                if source == destination:
                    continue
                links.append(
                    {
                        "source": source,
                        "destination": destination,
                        "value": self._default_snr(receiver),
                    }
                )
        return generation, links

    def get_link(self, source: str, destination: str) -> tuple[int, int]:
        values = [
            self.get_frequency_link(source, destination, frequency)[1]
            for frequency in BAND_FREQUENCY.values()
        ]
        return int(self._read_parameter("kernel_medium_generation")), min(values)

    def _active_overrides(
        self, radios: dict[str, _Radio]
    ) -> dict[tuple[str, str, str], tuple[int, int]]:
        active = next(iter(radios.values())).active_bank
        result = {}
        for destination, receiver in radios.items():
            for (bank, source, band), value in receiver.links.items():
                if bank == active:
                    result[(source, destination, band)] = value
        return result

    def _commit(
        self,
        generation: int,
        desired: dict[tuple[str, str, str], tuple[int, int]],
    ) -> None:
        radios = self._radios()
        current_generation = int(self._read_parameter("kernel_medium_generation"))
        if generation != current_generation + 1:
            raise ActuatorError(
                f"kernel medium generation conflict: current {current_generation}, "
                f"requested {generation}"
            )
        active = next(iter(radios.values())).active_bank
        inactive = 1 - active
        for receiver in radios.values():
            receiver.path.write_text(f"clear-bank {inactive}\n")
        for (source, destination, band), (signal, loss) in sorted(desired.items()):
            if source not in radios or destination not in radios:
                raise ActuatorError(
                    f"kernel-medium identity absent: {source} -> {destination}"
                )
            radios[destination].path.write_text(
                f"set {inactive} {source} {band} {signal} {loss}\n"
            )
        (self._parameters / "kernel_medium_bank").write_text(f"{inactive}\n")
        if int(self._read_parameter("kernel_medium_generation")) != generation:
            raise ActuatorError("kernel-medium commit generation did not advance")

    def get_frequency_link(
        self, source: str, destination: str, frequency_mhz: int
    ) -> tuple[int, int, bool]:
        radios = self._radios()
        if source not in radios or destination not in radios:
            raise ActuatorError(f"kernel-medium identity absent: {source} -> {destination}")
        band = _band(int(frequency_mhz))
        overrides = self._active_overrides(radios)
        key = (source, destination, band)
        generation = int(self._read_parameter("kernel_medium_generation"))
        if key not in overrides:
            return generation, self._default_snr(radios[destination]), False
        signal, _ = overrides[key]
        return generation, signal - self.noise_floor_dbm, True

    def dump_frequency_links(self) -> tuple[int, list[dict]]:
        radios = self._radios()
        generation = int(self._read_parameter("kernel_medium_generation"))
        result = [
            {
                "source": source,
                "destination": destination,
                "frequency_mhz": BAND_FREQUENCY[band],
                "value": signal - self.noise_floor_dbm,
                "override": True,
            }
            for (source, destination, band), (signal, _) in sorted(
                self._active_overrides(radios).items()
            )
        ]
        return generation, result

    def apply_frequency(self, generation: int, updates: list[dict]) -> list[dict]:
        if not updates:
            raise ActuatorError("an atomic generation requires at least one update")
        with self._writer_lock():
            radios = self._radios()
            desired = self._active_overrides(radios)
            normalized = []
            for item in updates:
                update = {
                    "source": item["source"].lower(),
                    "destination": item["destination"].lower(),
                    "frequency_mhz": int(item["frequency_mhz"]),
                    "value": int(item.get("value", 0)),
                    "override": bool(item.get("override", True)),
                }
                key = (
                    update["source"],
                    update["destination"],
                    _band(update["frequency_mhz"]),
                )
                if update["override"]:
                    desired[key] = (self._signal(update["value"]), 0)
                else:
                    desired.pop(key, None)
                normalized.append(update)
            self._commit(generation, desired)
        return normalized

    def apply(self, generation: int, updates: list[dict]) -> list[dict]:
        normalized = [
            {
                "source": item["source"].lower(),
                "destination": item["destination"].lower(),
                "value": int(item["value"]),
            }
            for item in updates
        ]
        frequency_updates = [
            {
                **item,
                "frequency_mhz": frequency,
                "override": True,
            }
            for item in normalized
            for frequency in BAND_FREQUENCY.values()
        ]
        self.apply_frequency(generation, frequency_updates)
        return normalized
