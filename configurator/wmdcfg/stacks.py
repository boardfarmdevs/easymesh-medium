"""The optimizer labs this medium serves, and what differs between them.

A stack is an EasyMesh implementation with its lab: ``rdk`` (meta-cmf-bananapi-vcpe:
RDK-B unified-wifi-mesh on OneWifi) and ``prplmesh`` (prplmesh-lab). The medium is the
same for both; what differs is the names of the lab's containers, where the medium's
runtime files are, and how the controller's model is read.

The stack is given explicitly (``--stack``, ``stack=``), else by ``WMDCFG_STACK``,
else found from the lab's running containers. Nothing guesses between two labs.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass

from .model import ScenarioError


@dataclass(frozen=True)
class Stack:
    name: str
    label: str  # in messages
    mesh: re.Pattern  # the lab's own mesh node containers
    client: re.Pattern  # the room's client containers
    # mesh nodes managed through an adapter (OpenSync pods through EMOSA), if any
    adapter: re.Pattern | None
    controller: str  # the controller's container
    runtime: str  # the medium's runtime directory in the lab VM
    control_socket: str  # wmediumd's control socket (atomic scenario updates)
    metrics_socket: str  # the read-only metrics socket
    inventory_backend: str | None  # recorded in the inventory when set
    topology_url: str  # the controller model's topology, as the lab publishes it


STACKS = {
    "rdk": Stack(
        name="rdk",
        label="EasyMesh",
        mesh=re.compile(r"^(bpibroadband|bpiap(?:-\d{3})?)$"),
        client=re.compile(r"^wlan-client(?:-\d{3})?$"),
        # OpenSync pods handed to the controller by the EMOSA adapter (emosa-lab
        # deploy/rdk-lab). They are mesh nodes like the lab's own, but carry only
        # the bands on which they serve an AP.
        adapter=re.compile(r"^pod-\d+$"),
        controller="bpibroadband",
        runtime="/run/meta-cmf-wmediumd",
        control_socket="/run/wmediumd-control.sock",
        metrics_socket="/run/meta-cmf-wmediumd/metrics/control.sock",
        inventory_backend=None,
        topology_url="http://127.0.0.1:8888/api/v1/topology",
    ),
    "prplmesh": Stack(
        name="prplmesh",
        label="prplMesh",
        mesh=re.compile(r"^(prpl-controller|prpl-agent-\d{2})$"),
        client=re.compile(r"^prpl-client-\d{2,}$"),
        adapter=None,
        controller="prpl-controller",
        runtime="/run/prpl-wmediumd",
        control_socket="/run/prpl-wmediumd/control.sock",
        metrics_socket="/run/prpl-wmediumd/metrics.sock",
        inventory_backend="prplmesh-nbapi",
        topology_url="http://127.0.0.1:8092/api/topology",
    ),
}


def _running_containers() -> set[str]:
    try:
        text = subprocess.run(
            ["lxc", "list", "--format", "csv", "-c", "ns"],
            check=True, text=True, capture_output=True, timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return set()
    return {
        line.split(",")[0] for line in text.splitlines()
        if line.upper().endswith(",RUNNING")
    }


def get(name: str | None = None) -> Stack:
    """The stack named, else WMDCFG_STACK's, else the one whose controller runs here."""
    name = name or os.environ.get("WMDCFG_STACK")
    if name:
        if name not in STACKS:
            raise ScenarioError(f"unknown stack {name!r}; one of {sorted(STACKS)}")
        return STACKS[name]
    running = _running_containers()
    found = [stack for stack in STACKS.values() if stack.controller in running]
    if len(found) != 1:
        raise ScenarioError(
            "cannot tell the lab's stack: set WMDCFG_STACK or --stack "
            f"(one of {sorted(STACKS)})"
        )
    return found[0]
