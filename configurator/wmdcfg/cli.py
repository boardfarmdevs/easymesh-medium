from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from . import __version__
from .actuator import ActuatorError, ControlClient
from .kernel_actuator import KernelMediumClient
from .compiler import compile_scenario, validate_scenario
from .inventory import discover
from .model import ScenarioError
from .parser import parse
from .runner import Runner
from .world import compile_world, export_wmd, load_json, verify_world_plan


def _bindings(values: list[str]) -> dict[str, str]:
    result = {}
    for value in values:
        if "=" not in value:
            raise ScenarioError(f"invalid binding {value!r}; use role=container")
        role, container = value.split("=", 1)
        if not role or not container or role in result:
            raise ScenarioError(f"invalid or duplicate binding {value!r}")
        result[role] = container
    return result


def _write(value: object, output: str | None) -> None:
    text = json.dumps(value, indent=2, sort_keys=True) + "\n"
    if output:
        Path(output).write_text(text)
    else:
        sys.stdout.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wmdcfg")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command", required=True)

    inventory_cmd = commands.add_parser("inventory", help="capture the live LXD radio inventory")
    inventory_cmd.add_argument("-o", "--output")

    validate_cmd = commands.add_parser("validate", help="parse and semantically validate source")
    validate_cmd.add_argument("scenario")

    compile_cmd = commands.add_parser("compile", help="bind and compile an event plan")
    compile_cmd.add_argument("scenario")
    compile_cmd.add_argument("--inventory", help="inventory JSON; live discovery when omitted")
    compile_cmd.add_argument("--bind", action="append", default=[], metavar="ROLE=CONTAINER")
    compile_cmd.add_argument("-o", "--output")

    status_cmd = commands.add_parser("status", help="query the live control actuator")
    status_cmd.add_argument("--socket", default="/run/wmediumd-control.sock")
    status_cmd.add_argument(
        "--backend", choices=["userspace", "kernel"], default="userspace"
    )
    status_cmd.add_argument(
        "--kernel-root", default="/sys/kernel/debug/ieee80211"
    )
    status_cmd.add_argument("--noise-floor-dbm", type=int, default=-91)

    run_cmd = commands.add_parser("run", help="run and restore a compiled event plan")
    run_cmd.add_argument("plan")
    run_cmd.add_argument("--socket", default="/run/wmediumd-control.sock")
    run_cmd.add_argument(
        "--backend", choices=["userspace", "kernel"], default="userspace"
    )
    run_cmd.add_argument("--kernel-root", default="/sys/kernel/debug/ieee80211")
    run_cmd.add_argument("--noise-floor-dbm", type=int, default=-91)
    run_cmd.add_argument(
        "--output-root", default="/tmp/wmdcfg-runs", help="run artifact directory"
    )

    world_compile_cmd = commands.add_parser(
        "world-compile", help="compile a deterministic 2D layout and mobility plan"
    )
    world_compile_cmd.add_argument("--layout", required=True)
    world_compile_cmd.add_argument("scenario")
    world_compile_cmd.add_argument("-o", "--output", required=True)

    world_export_cmd = commands.add_parser(
        "world-export", help="project one golden world band into a runnable .wmd scenario"
    )
    world_export_cmd.add_argument("plan")
    world_export_cmd.add_argument(
        "--band", required=True, choices=["2.4", "5", "6", "all"]
    )
    world_export_cmd.add_argument("-o", "--output", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            client = (
                ControlClient(args.socket)
                if args.backend == "userspace"
                else KernelMediumClient(
                    args.kernel_root, noise_floor_dbm=args.noise_floor_dbm
                )
            )
            with client:
                status = client.status()
                _write(
                    {
                        "instance_id": status.instance_id,
                        "generation": status.generation,
                        "capabilities": sorted(status.capabilities),
                        "max_updates": status.max_updates,
                        "num_stations": status.num_stations,
                    },
                    None,
                )
            return 0
        if args.command == "run":
            plan = json.loads(Path(args.plan).read_text())
            run_dir = Runner(
                plan,
                args.socket,
                Path(args.output_root),
                backend=args.backend,
                kernel_root=args.kernel_root,
                noise_floor_dbm=args.noise_floor_dbm,
            ).execute()
            print(run_dir)
            return 0
        if args.command == "inventory":
            _write(discover(), args.output)
            return 0
        if args.command == "world-compile":
            plan = compile_world(load_json(args.layout), load_json(args.scenario))
            _write(plan, args.output)
            return 0
        if args.command == "world-export":
            plan = load_json(args.plan)
            verify_world_plan(plan)
            Path(args.output).write_text(export_wmd(plan, args.band), encoding="utf-8")
            return 0
        source = Path(args.scenario).read_text()
        scenario = parse(source)
        if args.command == "validate":
            # Full semantics that do not require bindings are also exercised by
            # compile; validate intentionally reports the parsed public shape.
            validate_scenario(scenario)
            _write(
                {
                    "scenario": scenario.name,
                    "language": scenario.language,
                    "roles": scenario.roles,
                    "phases": [phase.name for phase in scenario.phases],
                    "status": "valid",
                },
                None,
            )
            return 0
        inventory = (
            json.loads(Path(args.inventory).read_text()) if args.inventory else discover()
        )
        plan = compile_scenario(scenario, source, inventory, _bindings(args.bind))
        _write(plan, args.output)
        return 0
    except (
        OSError, json.JSONDecodeError, ScenarioError, subprocess.SubprocessError,
        ActuatorError, InterruptedError,
    ) as error:
        print(f"wmdcfg: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
