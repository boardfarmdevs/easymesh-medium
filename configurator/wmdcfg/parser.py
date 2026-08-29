from __future__ import annotations

import re
from dataclasses import dataclass

from .model import HoldAction, LinkAction, MarkAction, Phase, Scenario, ScenarioError


_TOKEN = re.compile(
    r'(?P<string>"(?:[^"\\]|\\.)*")|'
    r'(?P<arrow><->|->|<-)|'
    r'(?P<number>-?\d+(?:\.\d+)?(?:ms|s|dB|GHz)?)|'
    r'(?P<ident>[A-Za-z_][A-Za-z0-9_-]*)|'
    r'(?P<symbol>[{}:=])'
)


@dataclass(frozen=True)
class Token:
    value: str
    line: int


def _tokens(source: str) -> list[Token]:
    result: list[Token] = []
    for line_no, raw in enumerate(source.splitlines(), 1):
        line = raw.split("#", 1)[0]
        pos = 0
        while pos < len(line):
            if line[pos].isspace():
                pos += 1
                continue
            match = _TOKEN.match(line, pos)
            if not match:
                raise ScenarioError(f"line {line_no}: unexpected text {line[pos:]!r}")
            result.append(Token(match.group(0), line_no))
            pos = match.end()
    return result


class Parser:
    def __init__(self, source: str):
        self.items = _tokens(source)
        self.pos = 0

    def peek(self) -> Token | None:
        return self.items[self.pos] if self.pos < len(self.items) else None

    def take(self, expected: str | None = None) -> Token:
        token = self.peek()
        if token is None:
            raise ScenarioError("unexpected end of scenario")
        if expected is not None and token.value != expected:
            raise ScenarioError(
                f"line {token.line}: expected {expected!r}, found {token.value!r}"
            )
        self.pos += 1
        return token

    def duration(self) -> int:
        token = self.take()
        match = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s)", token.value)
        if not match:
            raise ScenarioError(f"line {token.line}: duration requires ms or s")
        value = float(match.group(1))
        millis = round(value * (1000 if match.group(2) == "s" else 1))
        if millis <= 0:
            raise ScenarioError(f"line {token.line}: duration must be positive")
        return millis

    def snr(self) -> int:
        token = self.take()
        match = re.fullmatch(r"(-?\d+)dB", token.value)
        if not match:
            raise ScenarioError(f"line {token.line}: SNR requires an integer dB value")
        value = int(match.group(1))
        if not -20 <= value <= 60:
            raise ScenarioError(f"line {token.line}: SNR {value}dB is outside [-20, 60]")
        return value

    def parse(self) -> Scenario:
        self.take("scenario")
        scenario = Scenario(name=self.take().value)
        self.take("{")
        while self.peek() and self.peek().value != "}":
            keyword = self.take()
            if keyword.value == "language":
                version = self.take()
                if version.value != "1":
                    raise ScenarioError(f"line {version.line}: only language 1 is supported")
                scenario.language = 1
            elif keyword.value == "tick":
                scenario.tick_ms = self.duration()
            elif keyword.value == "require":
                scenario.requirements.add(self.take().value)
            elif keyword.value == "protect":
                scenario.protections.add(self.take().value)
            elif keyword.value == "restore":
                scenario.restore = self.take().value
            elif keyword.value == "role":
                name = self.take()
                self.take(":")
                role_type = self.take().value
                if name.value in scenario.roles:
                    raise ScenarioError(f"line {name.line}: duplicate role {name.value}")
                scenario.roles[name.value] = role_type
            elif keyword.value == "phase":
                scenario.phases.append(self.phase())
            else:
                raise ScenarioError(f"line {keyword.line}: unknown statement {keyword.value!r}")
        self.take("}")
        if self.peek() is not None:
            token = self.peek()
            raise ScenarioError(f"line {token.line}: trailing token {token.value!r}")
        return scenario

    def phase(self) -> Phase:
        name = self.take().value
        self.take("for")
        phase = Phase(name=name, duration_ms=self.duration())
        self.take("{")
        while self.peek() and self.peek().value != "}":
            token = self.take()
            if token.value == "parallel":
                self.take("{")
                while self.peek() and self.peek().value != "}":
                    phase.actions.append(self.action())
                self.take("}")
            else:
                self.pos -= 1
                phase.actions.append(self.action())
        self.take("}")
        return phase

    def action(self):
        keyword = self.take()
        if keyword.value == "hold":
            return HoldAction()
        if keyword.value == "mark":
            text = self.take()
            if not text.value.startswith('"'):
                raise ScenarioError(f"line {text.line}: mark requires a quoted string")
            return MarkAction(bytes(text.value[1:-1], "utf-8").decode("unicode_escape"))
        if keyword.value != "link":
            raise ScenarioError(f"line {keyword.line}: unknown phase action {keyword.value!r}")
        source = self.take().value
        direction = self.take().value
        if direction not in {"->", "<-", "<->"}:
            raise ScenarioError(f"line {keyword.line}: invalid link direction {direction!r}")
        destination = self.take().value
        band = None
        if self.peek() and self.peek().value == "band":
            self.take("band")
            value = self.take()
            match = re.fullmatch(r"(2\.4|5|6)GHz", value.value)
            if not match:
                raise ScenarioError(
                    f"line {value.line}: band must be 2.4GHz, 5GHz or 6GHz"
                )
            band = match.group(1)
        self.take("snr")
        if self.peek() and self.peek().value == "=":
            self.take("=")
            return LinkAction(
                source, direction, destination, self.snr(), line=keyword.line,
                band=band,
            )
        start = self.snr()
        self.take("->")
        end = self.snr()
        interpolation = self.take().value
        if interpolation != "linear":
            raise ScenarioError(
                f"line {keyword.line}: only linear interpolation is supported"
            )
        return LinkAction(
            source, direction, destination, start, end, interpolation, keyword.line,
            band,
        )


def parse(source: str) -> Scenario:
    return Parser(source).parse()
