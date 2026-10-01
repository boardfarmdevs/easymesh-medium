from __future__ import annotations

import json
import os
import re
import runpy
import shutil
import subprocess
from pathlib import Path

import pytest


BUNDLE = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def dashboard():
    return json.loads((BUNDLE / "grafana/dashboards/lxd-containers.json").read_text())


@pytest.fixture(scope="module")
def compose():
    if not shutil.which("docker"):
        pytest.skip("Docker Compose is required for configuration validation")
    version = subprocess.run(
        ["docker", "compose", "version"], capture_output=True, timeout=20
    )
    if version.returncode:
        pytest.skip("Docker Compose v2 is not installed")
    environment = os.environ.copy()
    for variable in ("PROMETHEUS_IMAGE", "GRAFANA_IMAGE", "GRAFANA_PUBLIC_URL", "GRAFANA_BIND_ADDRESS"):
        environment.pop(variable, None)
    result = subprocess.run(
        ["docker", "compose", "-f", str(BUNDLE / "compose.yaml"), "config", "--format", "json"],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
        timeout=20,
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize("script", ("setup.sh", "disable.sh", "enable.sh", "reload-lxd.sh"))
def test_shell_syntax(script):
    subprocess.run(["bash", "-n", str(BUNDLE / script)], check=True)


def test_monitoring_is_unprivileged_and_loopback_only(compose):
    assert compose["name"] == "easymesh-observability"
    assert set(compose["services"]) == {"prometheus", "grafana"}
    for name, service in compose["services"].items():
        assert service["network_mode"] == "host"
        assert not service.get("ports")
        assert not service.get("privileged", False)
        assert service["read_only"] is True
        assert service["cap_drop"] == ["ALL"]
        assert service["security_opt"] == ["no-new-privileges:true"]
        assert service["user"] == ("65534:65534" if name == "prometheus" else "472:472")
        assert int(service["mem_limit"]) == 512 * 1024 * 1024
        assert service["cpus"] == 0.5
        assert ":latest" not in service["image"]
        for volume in service["volumes"]:
            assert not volume["source"].endswith(".sock")
            if volume["type"] == "bind":
                assert volume["read_only"] is True
    assert "--web.listen-address=127.0.0.1:9090" in compose["services"]["prometheus"]["command"]
    environment = compose["services"]["grafana"]["environment"]
    assert environment["GOMEMLIMIT"] == "256MiB"
    assert environment["GF_SERVER_HTTP_ADDR"] == "127.0.0.1"
    assert environment["GF_AUTH_ANONYMOUS_ENABLED"] == "false"
    assert environment["GF_USERS_ALLOW_SIGN_UP"] == "false"
    assert "GF_SECURITY_ADMIN_PASSWORD" not in environment
    assert environment["GF_SECURITY_ADMIN_PASSWORD__FILE"] == "/run/secrets/grafana-admin-password"
    assert environment["GF_SERVER_PROTOCOL"] == "https"
    assert environment["GF_SECURITY_COOKIE_SECURE"] == "true"
    assert environment["GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH"].endswith("/lxd-containers.json")


def test_both_backends_and_explicit_browser_ports_are_supported():
    setup = (BUNDLE / "setup.sh").read_text()
    assert "/etc/default/easymesh-lab" in setup and "/etc/default/prplmesh-lab" in setup
    enable = (BUNDLE / "enable.sh").read_text()
    assert 'instance-config.sh' in enable
    assert 'LAB_LXD_UI_PORT:-$((port_base + 3))' in enable
    assert 'LAB_GRAFANA_PORT:-$((port_base + 4))' in enable
    assert 'lab-lxd-ui proxy nat=true' in enable and 'lab-grafana proxy nat=true' in enable
    assert 'boot.autostart' not in enable
    assert 'reload-lxd.sh' in setup and 'server-identity-reviewed' in setup
    reload_script = (BUNDLE / "reload-lxd.sh").read_text()
    assert 'LAB_MONITORING_ALLOW_RESTART:-0' in reload_script
    assert 'timeout 3 lxc' in reload_script
    assert 'trap restore_lab EXIT' in reload_script
    assert reload_script.index('systemctl stop') < reload_script.index('systemctl restart snap.lxd.daemon')
    assert 'systemctl reload snap.lxd.daemon' not in reload_script


def test_dashboard_filters_and_datasource_are_consistent(dashboard):
    assert dashboard["uid"] == "easymesh-lxd"
    assert dashboard["editable"] is False
    assert dashboard["refresh"] == "30s"
    variables = dashboard["templating"]["list"]
    assert [variable["name"] for variable in variables] == ["lab", "project", "name"]
    for variable in variables:
        assert variable["includeAll"] and variable["multi"]
        assert variable["allValue"] == ".*"
        assert variable["datasource"]["uid"] == "lxd-prometheus"
        assert 'type="container"' in variable["query"]["query"]
    panels = dashboard["panels"]
    assert len({panel["id"] for panel in panels}) == len(panels)
    for panel in panels:
        assert panel["datasource"]["uid"] == "lxd-prometheus"
        for target in panel["targets"]:
            expression = target["expr"]
            assert 'job="lxd"' in expression
            assert 'lab=~"$lab"' in expression
            if "up{" not in expression:
                for selector in ('type="container"', 'project=~"$project"', 'name=~"$name"'):
                    assert selector in expression
            if "rate(" in expression or "increase(" in expression:
                assert "[$__rate_interval]" in expression
    datasource = (BUNDLE / "grafana/provisioning/datasources/prometheus.yml").read_text()
    assert "uid: lxd-prometheus" in datasource
    assert "timeInterval: 30s" in datasource


def test_scrape_uses_verified_metrics_only_credentials():
    configuration = (BUNDLE / "prometheus.yml").read_text()
    for required in (
        "scrape_interval: 30s", "scheme: https", "metrics_path: /1.0/metrics",
        "targets: [127.0.0.1:8444]", 'lab: "@LAB_LABEL@"',
        "ca_file: /etc/prometheus/tls/server.crt",
        "cert_file: /etc/prometheus/tls/metrics.crt",
        "key_file: /etc/prometheus/tls/metrics.key",
        "server_name: 127.0.0.1", "insecure_skip_verify: false",
    ):
        assert required in configuration
    setup = (BUNDLE / "setup.sh").read_text()
    assert "--type=metrics" in setup
    assert "config set core.metrics_authentication true" in setup
    assert "openssl rand -hex 24" in setup
    assert not list(BUNDLE.rglob("*.key"))
    assert not list(BUNDLE.rglob("*.crt"))
    assert not (BUNDLE / ".env").exists()


def test_memory_panel_uses_available_cgroup_v2_metrics(dashboard):
    panel = next(panel for panel in dashboard["panels"] if panel["id"] == 4)
    expression = panel["targets"][0]["expr"]
    assert expression.startswith("lxd_memory_MemTotal_bytes{")
    assert " - lxd_memory_MemFree_bytes{" in expression
    assert "RSS_bytes" not in expression
    assert "including cache" in panel["title"]


def test_host_enable_consumes_long_lxd_output_and_keeps_services_private(tmp_path):
    executable = tmp_path / "lxc"
    actions = tmp_path / "actions"
    executable.write_text('''#!/usr/bin/env python3
import json
import os
import sys
with open(os.environ["MONITORING_ACTIONS"], "a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
arguments = sys.argv[1:]
if arguments[0] == "info":
    print("Type: virtual-machine\\n" + "Details: " + "x" * 300000)
elif arguments[:3] == ["config", "device", "show"]:
    print("eth0:\\n  type: nic")
elif arguments[0] == "exec":
    command = arguments[3:]
    if command[:2] == ["ip", "-4"]:
        print("1.1.1.1 via 10.20.30.1 dev enp5s0 src 10.20.30.250 uid 0")
    elif command[0] in ("tar", "python3"):
        sys.stdin.buffer.read()
''')
    executable.chmod(0o755)
    environment = {**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"], "MONITORING_ACTIONS": str(actions), "EASYMESH_PORT_BASE": "18889"}
    for variable in ("LAB_LXD_UI_PORT", "LAB_GRAFANA_PORT"):
        environment.pop(variable, None)
    subprocess.run(["bash", str(BUNDLE / "enable.sh"), "lab-vm", "192.0.2.10"], env=environment, check=True, capture_output=True, timeout=20)
    commands = [json.loads(line) for line in actions.read_text().splitlines()]
    proxies = [command for command in commands if command[:3] == ["config", "device", "add"]]
    assert len(proxies) == 2
    assert "listen=tcp:192.0.2.10:18892" in proxies[0]
    assert "connect=tcp:10.20.30.250:8443" in proxies[0]
    assert "listen=tcp:192.0.2.10:18893" in proxies[1]
    assert "connect=tcp:10.20.30.250:3000" in proxies[1]
    assert not any("boot.autostart" in command for command in commands)


@pytest.mark.parametrize("host,port", (("0.0.0.0", "18893"), ("not-an-ip", "18893"), ("192.0.2.10", "18892")))
def test_host_enable_rejects_unsafe_or_colliding_addresses(host, port):
    result = subprocess.run(["bash", str(BUNDLE / "enable.sh"), "unused", host],
                            env={**os.environ, "LAB_LXD_UI_PORT": "18892", "LAB_GRAFANA_PORT": port}, capture_output=True, timeout=10)
    assert result.returncode != 0


@pytest.mark.parametrize("allowed", (False, True))
def test_identity_restart_requires_maintenance_and_stops_lab_before_lxd(tmp_path, allowed):
    actions = tmp_path / "actions"
    systemctl = tmp_path / "systemctl"
    systemctl.write_text('''#!/usr/bin/env python3
import os
import sys
with open(os.environ["MONITORING_ACTIONS"], "a") as stream:
    stream.write(" ".join(sys.argv[1:]) + "\\n")
if sys.argv[1] == "is-active":
    print("active" if sys.argv[2] in ("easymesh-lab.service", "easymesh-room-service.service") else "inactive")
''')
    systemctl.chmod(0o755)
    client = tmp_path / "lxc"
    client.write_text('#!/bin/sh\nexit 0\n')
    client.chmod(0o755)
    environment = {**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"], "MONITORING_ACTIONS": str(actions), "LAB_MONITORING_ALLOW_RESTART": "1" if allowed else "0"}
    result = subprocess.run(["bash", str(BUNDLE / "reload-lxd.sh")], env=environment, capture_output=True, timeout=15)
    commands = actions.read_text().splitlines()
    if allowed:
        assert result.returncode == 0, result.stderr
        assert commands[-3:] == ['stop easymesh-room-service.service easymesh-lab.service', 'restart snap.lxd.daemon', 'start easymesh-room-service.service easymesh-lab.service']
    else:
        assert result.returncode != 0
        assert all(command.startswith('is-active ') for command in commands)


def test_older_rdk_inventory_checks_ignore_monitoring_without_rebuilding_wan(tmp_path):
    path = tmp_path / 'usr/local/sbin/boardfarm-lab-rebuild'
    path.parent.mkdir(parents=True)
    original = "test \"$(docker ps --format '{{.Names}}' | sort | paste -sd, -)\" = dhcp-cpe1,wan-cpe1\n"
    path.write_text(original)
    path.chmod(0o755)
    backup = tmp_path / 'backup'
    repair = runpy.run_path(str(BUNDLE / 'prepare-rdk.py'))['repair']
    assert repair(tmp_path, backup) == ['usr/local/sbin/boardfarm-lab-rebuild']
    assert "--filter 'name=^/dhcp-cpe1$' --filter 'name=^/wan-cpe1$'" in path.read_text()
    assert path.stat().st_mode & 0o777 == 0o755
    assert (backup / 'usr/local/sbin/boardfarm-lab-rebuild').read_text() == original
    assert repair(tmp_path, backup) == []


@pytest.mark.parametrize("document", (BUNDLE / "README.md",))
def test_reference_links_resolve(document):
    for target in re.findall(r"\]\(([^)]+)\)", document.read_text()):
        if not target.startswith(("https://", "http://", "#")):
            assert (document.parent / target.split("#", 1)[0]).exists(), target
