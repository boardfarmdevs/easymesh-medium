"""The stack a test runs under (wmdcfg.stacks): tests/prplmesh/ are the prplMesh lab's,
every other test is the RDK lab's. A test that needs another stack sets it itself."""

import pytest


@pytest.fixture(autouse=True)
def _stack(request, monkeypatch):
    stack = "prplmesh" if "/tests/prplmesh/" in str(request.path) else "rdk"
    monkeypatch.setenv("WMDCFG_STACK", stack)
