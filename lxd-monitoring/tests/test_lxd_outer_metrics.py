from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml


BUNDLE = Path(__file__).resolve().parents[1]


@pytest.fixture
def module():
    specification = importlib.util.spec_from_file_location("outer_metrics", BUNDLE / "outer-metrics.py")
    result = importlib.util.module_from_spec(specification)
    exec(compile((BUNDLE / "outer-metrics.py").read_text(), str(BUNDLE / "outer-metrics.py"), "exec"), result.__dict__)
    return result


@pytest.fixture
def settings():
    return dict(vm="lab-vm", project="default", address="192.0.2.10", port=8444, tls_name="lab-host", label="test-lab")


@pytest.fixture
def base():
    return (BUNDLE / "prometheus.yml").read_text().replace("@LAB_LABEL@", "test-lab")


def test_render_verified_project_scoped_job_is_idempotent(module, settings, base):
    rendered = module.render(base, settings)
    jobs = yaml.safe_load(rendered)["scrape_configs"]
    assert [job["job_name"] for job in jobs] == ["lxd", "prometheus", "lxd-outer"]
    outer = jobs[-1]
    assert outer["params"] == {"project": ["default"]}
    assert outer["tls_config"]["server_name"] == "lab-host"
    assert outer["tls_config"]["insecure_skip_verify"] is False
    assert outer["tls_config"]["ca_file"].endswith("/outer-server.crt")
    assert outer["metric_relabel_configs"][0]["source_labels"] == ["project", "name", "type"]
    pattern = outer["metric_relabel_configs"][0]["regex"]
    assert re.fullmatch(pattern, "default;lab-vm;virtual-machine")
    for candidate in ("default;lab-vm-2;virtual-machine", "other;lab-vm;virtual-machine", "default;lab-vm;container"):
        assert not re.fullmatch(pattern, candidate)
    assert module.render(rendered, settings) == rendered
    assert module.render(rendered) == base.rstrip() + "\n"


def test_regex_metacharacters_are_literal_after_yaml_parsing(module, settings, base):
    settings.update(vm="lab.vm-1", project="demo.project")
    pattern = yaml.safe_load(module.render(base, settings))["scrape_configs"][-1]["metric_relabel_configs"][0]["regex"]
    assert re.fullmatch(pattern, "demo.project;lab.vm-1;virtual-machine")
    assert not re.fullmatch(pattern, "demoxproject;labxvm-1;virtual-machine")


@pytest.mark.parametrize("field,value", (("address", "0.0.0.0"), ("address", "127.0.0.1"), ("address", "224.0.0.1"), ("port", 80), ("port", 65536), ("vm", "-bad"), ("label", 'bad"\njob_name: injected'), ("tls_name", "https://host"), ("project", "one,two")))
def test_invalid_settings_refused(module, settings, base, field, value):
    settings[field] = value
    with pytest.raises(ValueError):
        module.render(base, settings)


@pytest.mark.parametrize("extra", ("# BEGIN lab outer LXD metrics\n", "# END lab outer LXD metrics\n# BEGIN lab outer LXD metrics\n", "  - job_name: lxd-outer\n", "alerting:\n  alertmanagers: []\n"))
def test_malformed_or_unmanaged_configuration_refused(module, settings, base, extra):
    with pytest.raises(ValueError):
        module.render(base + extra, settings)


def test_setup_renderer_preserves_outer_job_and_bind_inode(tmp_path, settings):
    state = tmp_path / "state.json"
    output = tmp_path / "prometheus.yml"
    command = ["python3", str(BUNDLE / "outer-metrics.py"), "render", str(BUNDLE / "prometheus.yml"), str(output), "--label", "test-lab", "--settings", str(state)]
    subprocess.run(command, check=True)
    original_inode = output.stat().st_ino
    assert "lxd-outer" not in output.read_text()
    state.write_text(json.dumps(settings))
    for attempt in range(2):
        subprocess.run(command, check=True)
        assert output.stat().st_ino == original_inode
        assert output.read_text().count("job_name: lxd-outer") == 1
    previous = output.read_text()
    state.write_text("invalid JSON")
    assert subprocess.run(command, capture_output=True).returncode != 0
    assert output.read_text() == previous


def test_raw_lxd_queries_carry_project_only_in_url(module, monkeypatch):
    host = module.Host.__new__(module.Host)
    host.project = "isolated"
    calls = []
    monkeypatch.setattr(module, "run", lambda *command: calls.append(command) or "{}")
    host.lxc("query", "/1.0/instances/lab?project=isolated")
    assert calls[-1] == ("lxc", "--force-local", "query", "/1.0/instances/lab?project=isolated")
    host.lxc("exec", "lab", "--", "true")
    assert calls[-1][:4] == ("lxc", "--force-local", "--project", "isolated")


def test_explicit_monitoring_enable_installs_missing_compose_dependencies():
    setup = (BUNDLE / "enable.sh").read_text()
    assert setup.index("prepare-dependencies.sh") < setup.index("setup.sh")
    dependencies = (BUNDLE / "prepare-dependencies.sh").read_text()
    assert "docker compose version" in dependencies
    assert "docker-compose-v2" in dependencies
    assert "--no-install-recommends" in dependencies


def test_outer_dashboard_uses_vm_capacity_and_guest_memory():
    dashboard = json.loads((BUNDLE / "grafana/dashboards/lxd-outer-vms.json").read_text())
    assert dashboard["uid"] == "easymesh-lxd-outer"
    assert [variable["name"] for variable in dashboard["templating"]["list"]] == ["host", "lab", "project", "name"]
    assert "$host" not in dashboard["templating"]["list"][0]["query"]["query"]
    panels = {panel["id"]: panel for panel in dashboard["panels"]}
    assert len(panels) == 11
    for panel in panels.values():
        for target in panel["targets"]:
            assert 'job="lxd-outer"' in target["expr"]
            assert 'host=~"$host"' in target["expr"]
            assert "lxd_cpu_effective_total" not in target["expr"]
            if "up{" not in target["expr"]:
                assert 'type="virtual-machine"' in target["expr"]
    memory = panels[4]["targets"][0]["expr"]
    assert "MemTotal_bytes" in memory and "MemAvailable_bytes" in memory
    assert "MemFree_bytes" not in memory
    normalized = panels[10]["targets"][0]["expr"]
    assert "user|nice|system|irq|softirq" in normalized
    assert 'count by (host,lab,project,name)' in normalized
    assert 'mode="idle"' in normalized
    assert ' or vector(0)' not in json.dumps(dashboard)


def test_put_updates_live_config_in_place_and_dashboard_atomically(module, tmp_path):
    class LocalHost(module.Host):
        def lxc(self, *arguments):
            assert arguments[:2] == ("file", "push")
            shutil.copyfile(arguments[2], str(tmp_path / "guest") + arguments[3].removeprefix(self.vm))

        def guest(self, *arguments):
            translated = [str(tmp_path / "guest") + argument if argument.startswith(module.DESTINATION) else argument for argument in arguments]
            return subprocess.run(translated, check=True, capture_output=True, text=True).stdout

    host = LocalHost("lab-vm", "default")
    host.backup.rmdir()
    host.backup = tmp_path
    destination = tmp_path / "guest" / module.DESTINATION.lstrip("/")
    (destination / "state").mkdir(parents=True)
    configuration = destination / "prometheus.yml"
    configuration.write_text("before")
    original_inode = configuration.stat().st_ino
    host.put("prometheus.yml", "after", atomic=False)
    assert configuration.stat().st_ino == original_inode
    assert configuration.read_text() == "after"
    host.put("prometheus.yml", "atomic")
    assert configuration.stat().st_ino != original_inode
    host.put(module.SETTINGS, "{}")
    assert (destination / module.SETTINGS).stat().st_mode & 0o777 == 0o600


@pytest.fixture
def fake_host(module, tmp_path, monkeypatch, base, settings):
    certificate = tmp_path / "server.crt"
    certificate.write_text("public host certificate")
    monkeypatch.setattr(module, "HOST_CERTIFICATE", certificate)

    def fake_run(*command, **kwargs):
        if "-fingerprint" in command:
            return "sha256 Fingerprint=AA:BB\n"
        if "-pubkey" in command:
            return "public client key"
        return ""

    monkeypatch.setattr(module, "run", fake_run)

    class FakeHost(module.Host):
        def __init__(self):
            self.vm = settings["vm"]
            self.project = settings["project"]
            self.backup = tmp_path
            self.saved = {}
            self.files = {"prometheus.yml": base, "tls/metrics.crt": "public client certificate"}
            self.host_settings = {"core.metrics_address": "", "core.metrics_authentication": ""}
            self.trust = []
            self.calls = []
            self.failure = None

        def maybe_fail(self, stage):
            if self.failure == stage:
                self.failure = None
                raise RuntimeError(f"injected {stage} failure")

        def exists(self, relative):
            return relative in self.files

        def read(self, relative):
            return self.files[relative]

        def put(self, relative, contents, atomic=True):
            self.maybe_fail(relative)
            self.calls.append(("put", relative, atomic))
            self.files[relative] = contents

        def lxc(self, *arguments):
            self.calls.append(arguments)
            if arguments[:2] == ("config", "get"):
                return self.host_settings[arguments[2]]
            if arguments[:2] == ("config", "set"):
                self.host_settings[arguments[2]] = arguments[3]
            elif arguments[:2] == ("config", "unset"):
                self.host_settings[arguments[2]] = ""
            elif arguments[0] == "query":
                return json.dumps({"type": "virtual-machine", "status": "Running"})
            elif arguments[:3] == ("config", "trust", "list"):
                return json.dumps(self.trust)
            elif arguments[:3] == ("config", "trust", "add"):
                assert "--type=metrics" in arguments and "--restricted" in arguments
                assert f"--projects={self.project}" in arguments
                self.trust.append(dict(fingerprint="aabb", type="metrics", restricted=True, projects=[self.project], name=f'lab-outer-{settings["label"]}'))
            elif arguments[:3] == ("config", "trust", "remove"):
                self.trust = [entry for entry in self.trust if entry["fingerprint"] != arguments[3]]
            return ""

        def guest(self, *arguments):
            self.calls.append(arguments)
            if arguments[0] == "openssl":
                return "public client key"
            if arguments[0] == "curl":
                self.maybe_fail("tls")
                return f'lxd_cpu_seconds_total{{name="{self.vm}",project="{self.project}",type="virtual-machine",cpu="0",mode="idle"}} 123\n'
            if arguments[:2] == ("rm", "-f"):
                for target in arguments[2:]:
                    self.files.pop(target.removeprefix(module.DESTINATION + "/"), None)
            return ""

        def compose(self, *arguments):
            self.calls.append(arguments)
            if "check" in arguments:
                self.maybe_fail("promtool")
            if "SIGHUP" in arguments:
                self.maybe_fail("reload")
            return ""

        def wait_target(self, configuration, present=True):
            self.maybe_fail("target")

    return FakeHost()


def test_enable_repeat_and_disable_preserve_nested_stack(module, settings, fake_host, base):
    module.enable(fake_host, settings.copy())
    assert fake_host.host_settings["core.metrics_address"] == "192.0.2.10:8444"
    assert fake_host.host_settings["core.metrics_authentication"] == "true"
    assert len(fake_host.trust) == 1
    assert module.DASHBOARD in fake_host.files and module.SETTINGS in fake_host.files
    after_first = fake_host.files.copy()
    module.enable(fake_host, settings.copy())
    assert after_first == fake_host.files
    assert len([call for call in fake_host.calls if call[:3] == ("config", "trust", "add")]) == 1
    module.disable(fake_host)
    assert not fake_host.trust
    assert fake_host.files["prometheus.yml"] == base.rstrip() + "\n"
    assert module.SETTINGS not in fake_host.files and module.DASHBOARD not in fake_host.files
    assert fake_host.files["tls/metrics.crt"] == "public client certificate"
    assert fake_host.host_settings["core.metrics_address"] == "192.0.2.10:8444"
    assert not any("restart" in call or "boot.autostart" in call or "down" in call for call in fake_host.calls)
    module.disable(fake_host)


@pytest.mark.parametrize("stage", ("promtool", "tls", "reload", "target", "grafana/dashboards/lxd-outer-vms.json", "state/outer-metrics.json"))
def test_enable_failure_rolls_back_all_owned_changes(module, settings, fake_host, stage):
    before = fake_host.files.copy()
    fake_host.failure = stage
    with pytest.raises(RuntimeError, match="injected"):
        module.enable(fake_host, settings.copy())
    assert fake_host.files == before
    assert fake_host.host_settings == {"core.metrics_address": "", "core.metrics_authentication": ""}
    assert fake_host.trust == []


def test_repeat_failure_keeps_existing_outer_listener_and_trust(module, settings, fake_host):
    module.enable(fake_host, settings.copy())
    before = fake_host.files.copy()
    fake_host.failure = "target"
    with pytest.raises(RuntimeError):
        module.enable(fake_host, settings.copy())
    assert fake_host.files == before
    assert len(fake_host.trust) == 1
    assert fake_host.host_settings["core.metrics_address"] == "192.0.2.10:8444"


def test_foreign_trust_and_listener_are_not_overwritten(module, settings, fake_host):
    fake_host.host_settings["core.metrics_address"] = "0.0.0.0:8444"
    with pytest.raises(ValueError, match="unrelated"):
        module.enable(fake_host, settings.copy())
    fake_host.host_settings["core.metrics_address"] = ""
    fake_host.trust = [dict(fingerprint="aabb", type="client")]
    with pytest.raises(ValueError, match="trust"):
        module.enable(fake_host, settings.copy())
    assert fake_host.trust[0]["type"] == "client"


def test_disable_failed_reload_restores_outer_job_and_retains_trust(module, settings, fake_host):
    module.enable(fake_host, settings.copy())
    before = fake_host.files.copy()
    fake_host.failure = "reload"
    with pytest.raises(RuntimeError):
        module.disable(fake_host)
    assert fake_host.files == before
    assert len(fake_host.trust) == 1


def test_wait_target_requires_matching_outer_endpoint_and_health(module, settings, fake_host, monkeypatch):
    def target(job="lxd-outer", address="192.0.2.10:8444", health="up"):
        return dict(labels=dict(job=job, instance=address, lab="test-lab"), health=health)

    replies = iter([[target(job="lxd")], [target(address="192.0.2.11:8444")], [target(health="down")], [target()]])
    waits = []
    monkeypatch.setattr(fake_host, "guest", lambda *arguments: json.dumps({"data": {"activeTargets": next(replies)}}))
    monkeypatch.setattr(module.time, "sleep", waits.append)
    module.Host.wait_target(fake_host, settings)
    assert waits == [5, 5, 5]


def test_missing_vm_metrics_rolls_back_without_changing_prometheus(module, settings, fake_host, monkeypatch):
    original = fake_host.guest
    monkeypatch.setattr(fake_host, "guest", lambda *arguments: "" if arguments[0] == "curl" else original(*arguments))
    before = fake_host.files.copy()
    with pytest.raises(RuntimeError, match="no CPU series"):
        module.enable(fake_host, settings.copy())
    assert fake_host.files == before
    assert not fake_host.trust
    assert fake_host.host_settings["core.metrics_address"] == ""


def test_rollback_refuses_operator_modified_host_setting(module, fake_host):
    fake_host.host_settings["core.metrics_address"] = "192.0.2.20:9444"
    with pytest.raises(RuntimeError, match="operator-modified"):
        module.restore_setting(fake_host, "core.metrics_address", "192.0.2.10:8444", "")
    assert fake_host.host_settings["core.metrics_address"] == "192.0.2.20:9444"


@pytest.mark.parametrize("script", ("enable-outer-metrics.sh", "disable-outer-metrics.sh"))
def test_new_shell_syntax(script):
    subprocess.run(["bash", "-n", str(BUNDLE / script)], check=True)


def test_default_remains_opt_in_and_browser_tokens_use_interactive_identity():
    enable = (BUNDLE / "enable.sh").read_text()
    assert '${LAB_OUTER_METRICS_ADDRESS:-}' in enable
    assert 'lxc auth identity create local:tls/' in enable
    assert '--mode=interactive' in enable and 'ssh -t' in enable
    assert 'config trust add --name=lab-browser' not in enable
    assert 'state/outer-metrics.json' in (BUNDLE / "setup.sh").read_text()
    disable = (BUNDLE / "disable.sh").read_text()
    assert disable.index('state/outer-metrics.json') < disable.index(' down')


def test_real_promtool_config_queries_and_zero_effective_cpu(module, settings, base, tmp_path):
    if not shutil.which("docker"):
        pytest.skip("Docker is required for offline promtool validation")
    image = "prom/prometheus:v3.14.0"
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode:
        pytest.skip("Pinned Prometheus image is not cached; validation never pulls images")
    tls = tmp_path / "tls"
    tls.mkdir()
    subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=test-only", "-keyout", str(tls / "metrics.key"), "-out", str(tls / "metrics.crt")], check=True, capture_output=True)
    for name in ("server.crt", "outer-server.crt"):
        shutil.copyfile(tls / "metrics.crt", tls / name)
    (tmp_path / "prometheus.yml").write_text(module.render(base, settings))
    dashboard = json.loads((BUNDLE / "grafana/dashboards/lxd-outer-vms.json").read_text())
    expressions = {panel["id"]: [target["expr"].replace("$__rate_interval", "2m").replace("$host", "lab-host").replace("$lab", "test-lab").replace("$project", "default").replace("$name", "lab-vm") for target in panel["targets"]] for panel in dashboard["panels"]}
    rules = [{"record": f"test:panel_{panel_id}_{target_index}", "expr": expression} for panel_id, targets in expressions.items() for target_index, expression in enumerate(targets)]
    (tmp_path / "rules.yml").write_text(yaml.safe_dump({"groups": [{"name": "outer-dashboard", "rules": rules}]}))
    labels = 'job="lxd-outer",host="lab-host",lab="test-lab",project="default",name="lab-vm",type="virtual-machine"'
    grouped_labels = '{host="lab-host",lab="test-lab",project="default",name="lab-vm"}'
    series = [{"series": f'lxd_cpu_seconds_total{{{labels},cpu="{cpu}",mode="{mode}"}}', "values": "0+15x4"} for cpu in (0, 1) for mode in ("user", "idle")]
    series.extend([
        {"series": f"lxd_cpu_effective_total{{{labels}}}", "values": "0+0x4"},
        {"series": f"lxd_memory_MemTotal_bytes{{{labels}}}", "values": "1024+0x4"},
        {"series": f"lxd_memory_MemAvailable_bytes{{{labels}}}", "values": "256+0x4"},
    ])
    checks = [{"expr": f"round({expressions[panel_id][0]}, 0.000001)", "eval_time": "2m", "exp_samples": [{"labels": expected_labels, "value": value}]} for panel_id, value, expected_labels in ((3, 100, grouped_labels), (10, 50, grouped_labels), (11, 2, grouped_labels), (4, 768, "{" + labels + "}"))]
    (tmp_path / "unit.yml").write_text(yaml.safe_dump({"rule_files": [], "evaluation_interval": "30s", "tests": [{"interval": "30s", "input_series": series, "promql_expr_test": checks}]}))
    docker = ["docker", "run", "--rm", "--pull=never", "--network=none", "--user", "0:0", "--entrypoint", "promtool", "-v", f"{tmp_path}:/fixtures:ro", "-v", f"{tls}:/etc/prometheus/tls:ro", image]
    for command in (["check", "config", "/fixtures/prometheus.yml"], ["check", "rules", "/fixtures/rules.yml"], ["test", "rules", "/fixtures/unit.yml"]):
        result = subprocess.run(docker + command, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stdout + result.stderr
