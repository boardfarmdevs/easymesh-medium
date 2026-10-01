import shlex
from pathlib import Path
import subprocess

import pytest


UNIT = Path(__file__).resolve().parents[1] / "easymesh-host-cooling.service"


def run_unit_command(operation, temporary):
    line = next(line for line in UNIT.read_text().splitlines()
                if line.startswith(operation + "="))
    command = shlex.split(line.split("=", 1)[1])
    command[-1] = command[-1].replace(
        "/sys/devices/system/cpu/intel_pstate/no_turbo", str(temporary / "current")
    ).replace("/run/easymesh-host-cooling/no_turbo", str(temporary / "saved"))
    subprocess.run(command, check=True)


@pytest.mark.parametrize("original", ["0", "1"])
def test_profile_restores_the_prior_setting(tmp_path, original):
    (tmp_path / "current").write_text(original + "\n")
    run_unit_command("ExecStart", tmp_path)
    assert (tmp_path / "current").read_text().strip() == "1"
    assert (tmp_path / "saved").read_text().strip() == original
    run_unit_command("ExecStop", tmp_path)
    assert (tmp_path / "current").read_text().strip() == original


def test_profile_does_not_overwrite_an_external_change(tmp_path):
    (tmp_path / "current").write_text("1\n")
    run_unit_command("ExecStart", tmp_path)
    (tmp_path / "current").write_text("0\n")
    run_unit_command("ExecStop", tmp_path)
    assert (tmp_path / "current").read_text().strip() == "0"


def test_profile_is_opt_in_on_a_physical_intel_pstate_host():
    text = UNIT.read_text()
    assert "ConditionVirtualization=no" in text
    assert "ConditionPathExists=/sys/devices/system/cpu/intel_pstate/no_turbo" in text
    assert "RemainAfterExit=yes" in text
    assert "lxc" not in text and "thermald" not in text
