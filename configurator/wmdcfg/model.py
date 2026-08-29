from __future__ import annotations

from dataclasses import dataclass, field
from typing import Union


class ScenarioError(ValueError):
    """A source, binding, or semantic validation error."""


@dataclass(frozen=True)
class LinkAction:
    source: str
    direction: str
    destination: str
    start_snr_db: int
    end_snr_db: int | None = None
    interpolation: str = "step"
    line: int = 0
    band: str | None = None


@dataclass(frozen=True)
class MarkAction:
    text: str


@dataclass(frozen=True)
class HoldAction:
    pass


Action = Union[LinkAction, MarkAction, HoldAction]


@dataclass
class Phase:
    name: str
    duration_ms: int
    actions: list[Action] = field(default_factory=list)


@dataclass
class Scenario:
    name: str
    language: int = 1
    tick_ms: int = 1000
    requirements: set[str] = field(default_factory=set)
    protections: set[str] = field(default_factory=set)
    restore: str = "captured"
    roles: dict[str, str] = field(default_factory=dict)
    phases: list[Phase] = field(default_factory=list)
