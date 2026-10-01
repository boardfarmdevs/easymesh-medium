from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path


DESTINATION = "/opt/easymesh-observability"
SOURCE = Path(__file__).resolve().parent
HOST_CERTIFICATE = Path("/var/snap/lxd/common/lxd/server.crt")
BEGIN = "# BEGIN lab outer LXD metrics"
END = "# END lab outer LXD metrics"
SETTINGS = "state/outer-metrics.json"
CA = "tls/outer-server.crt"
DASHBOARD = "grafana/dashboards/lxd-outer-vms.json"


def validate(settings):
    address = ipaddress.IPv4Address(settings["address"])
    if address.is_unspecified or address.is_multicast or address.is_loopback:
        raise ValueError("Use an explicit host IPv4 reachable from the VM")
    if not 1024 <= int(settings["port"]) <= 65535:
        raise ValueError("Metrics port must be between 1024 and 65535")
    for field in ("vm", "project", "label", "tls_name"):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,252}", settings[field]):
            raise ValueError(f"Invalid {field}")


def render(configuration, settings=None):
    if configuration.count(BEGIN) != configuration.count(END) or configuration.count(BEGIN) > 1:
        raise ValueError("Unbalanced or duplicated managed outer metrics block")
    if BEGIN in configuration:
        if configuration.index(BEGIN) > configuration.index(END):
            raise ValueError("Reversed outer metrics block markers")
        configuration = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", configuration, flags=re.S)
    if re.search(r"\bjob_name\s*:\s*['\"]?lxd-outer\b", configuration):
        raise ValueError("Unmanaged lxd-outer job: review/remove the old one-off job before enabling")
    if settings is None:
        return configuration.rstrip() + "\n"
    validate(settings)
    if re.findall(r"(?m)^([A-Za-z_][A-Za-z0-9_]*):", configuration)[-1:] != ["scrape_configs"]:
        raise ValueError("Expected scrape_configs as the last top-level YAML section")
    quote = json.dumps
    instance_filter = ";".join(re.escape(settings[field]) for field in ("project", "vm")) + ";virtual-machine"
    block = f'''{BEGIN}
  - job_name: lxd-outer
    scheme: https
    metrics_path: /1.0/metrics
    scrape_interval: 30s
    scrape_timeout: 10s
    params:
      project: [{quote(settings["project"])}]
    static_configs:
      - targets: [{quote(f'{settings["address"]}:{settings["port"]}')}]
        labels:
          lab: {quote(settings["label"])}
          layer: outer
          host: {quote(settings["tls_name"])}
    tls_config:
      ca_file: /etc/prometheus/tls/outer-server.crt
      cert_file: /etc/prometheus/tls/metrics.crt
      key_file: /etc/prometheus/tls/metrics.key
      server_name: {quote(settings["tls_name"])}
      insecure_skip_verify: false
    metric_relabel_configs:
      - source_labels: [project, name, type]
        regex: {quote(instance_filter)}
        action: keep
{END}
'''
    return configuration.rstrip() + "\n\n" + block


def run(*command, timeout=60):
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=timeout).stdout


class Host:
    def __init__(self, vm, project):
        self.vm = vm
        self.project = project
        self.backup = Path(tempfile.mkdtemp(prefix="lxd-outer-metrics-", dir=Path.cwd()))
        self.saved = {}
        print(f"Private backup/diagnostics: {self.backup}", flush=True)

    def lxc(self, *arguments):
        if arguments and arguments[0] == "query":
            return run("lxc", "--force-local", *arguments)
        return run("lxc", "--force-local", "--project", self.project, *arguments)

    def guest(self, *arguments):
        return self.lxc("exec", self.vm, "--", *arguments)

    def compose(self, *arguments):
        return self.guest("docker", "compose", "--project-directory", DESTINATION, *arguments)

    def read(self, relative):
        return self.guest("cat", f"{DESTINATION}/{relative}")

    def exists(self, relative):
        try:
            self.guest("test", "-e", f"{DESTINATION}/{relative}")
            return True
        except subprocess.CalledProcessError:
            return False

    def save(self, relative):
        contents = self.read(relative) if self.exists(relative) else None
        self.saved[relative] = contents
        if contents is not None:
            (self.backup / relative.replace("/", "--")).write_text(contents)
        return contents

    def put(self, relative, contents, atomic=True):
        local = self.backup / "upload"
        local.write_text(contents)
        target = f"{DESTINATION}/{relative}"
        staged = f"{DESTINATION}/state/outer-upload"
        self.lxc("file", "push", str(local), f"{self.vm}{staged}")
        self.guest("chmod", "0644" if relative != SETTINGS else "0600", staged)
        if atomic:
            self.guest("mv", staged, target)
        else:
            self.guest("sh", "-c", 'cat "$1" > "$2"', "sh", staged, target)
            self.guest("rm", "-f", staged)

    def restore(self):
        errors = []
        for relative, contents in self.saved.items():
            try:
                if contents is None:
                    self.guest("rm", "-f", f"{DESTINATION}/{relative}")
                else:
                    self.put(relative, contents, atomic=relative != "prometheus.yml")
            except Exception as error:
                errors.append(f"{relative}: {error}")
        try:
            self.compose("kill", "--signal", "SIGHUP", "prometheus")
        except Exception as error:
            errors.append(str(error))
        if errors:
            raise RuntimeError("; ".join(errors))

    def check_config(self, configuration):
        self.put("tls/outer-candidate.yml", configuration)
        self.compose("exec", "-T", "prometheus", "promtool", "check", "config", "/etc/prometheus/tls/outer-candidate.yml")

    def reload(self, configuration):
        self.put("prometheus.yml", configuration, atomic=False)
        self.compose("kill", "--signal", "SIGHUP", "prometheus")

    def wait_target(self, settings, present=True):
        for attempt in range(15):
            response = self.guest("curl", "--noproxy", "*", "-fsS", "--max-time", "5", "http://127.0.0.1:9090/api/v1/targets")
            (self.backup / "targets.json").write_text(response)
            targets = [target for target in json.loads(response)["data"]["activeTargets"] if target.get("labels", {}).get("job") == "lxd-outer"]
            if not present and not targets:
                return
            if present and len(targets) == 1:
                target = targets[0]
                labels = target["labels"]
                if target["health"] == "up" and labels.get("instance") == f'{settings["address"]}:{settings["port"]}' and labels.get("lab") == settings["label"]:
                    return
            time.sleep(5)
        raise RuntimeError("Prometheus target did not reach the requested state; see targets.json")


def fingerprint(certificate):
    return run("openssl", "x509", "-in", str(certificate), "-noout", "-fingerprint", "-sha256").split("=", 1)[1].strip().replace(":", "").lower()


def trust_entry(host, settings):
    entries = json.loads(host.lxc("config", "trust", "list", "--format", "json"))
    entry = next((entry for entry in entries if entry["fingerprint"] == settings["fingerprint"]), None)
    if entry and (entry["type"] != "metrics" or not entry.get("restricted") or entry.get("projects") != [settings["project"]] or entry.get("name") != f'lab-outer-{settings["label"]}'):
        raise ValueError("Existing outer certificate trust is not the expected managed metrics-only project trust")
    return entry


def enable(host, settings):
    host.saved.clear()
    validate(settings)
    listener = f'{settings["address"]}:{settings["port"]}'
    certificate = HOST_CERTIFICATE
    run("openssl", "x509", "-in", str(certificate), "-checkend", "86400", "-noout")
    run("openssl", "verify", "-partial_chain", "-CAfile", str(certificate),
        "-verify_hostname", settings["tls_name"], str(certificate))
    previous_address = host.lxc("config", "get", "core.metrics_address").strip()
    previous_auth = host.lxc("config", "get", "core.metrics_authentication").strip()
    if previous_address not in ("", listener) or previous_auth not in ("", "true"):
        raise ValueError("Refusing an unrelated listener or unauthenticated outer metrics configuration")
    if not previous_address and run("ss", "-H", "-ltn", f'sport = :{settings["port"]}').strip():
        raise ValueError("Metrics port is already occupied")
    host.guest("test", "-f", f"{DESTINATION}/.managed-by-easymesh")
    instance = json.loads(host.lxc("query", f'/1.0/instances/{host.vm}?project={host.project}'))
    if instance["type"] != "virtual-machine" or instance["status"] != "Running":
        raise ValueError("A running lab VM is required")
    host.compose("exec", "-T", "prometheus", "promtool", "--version")
    configuration = host.save("prometheus.yml")
    previous_settings = host.save(SETTINGS)
    host.save(CA)
    host.save(DASHBOARD)
    metrics_certificate = host.backup / "metrics.crt"
    metrics_certificate.write_text(host.read("tls/metrics.crt"))
    run("openssl", "x509", "-in", str(metrics_certificate), "-checkend", "86400", "-noout")
    if run("openssl", "x509", "-in", str(metrics_certificate), "-pubkey", "-noout") != host.guest("openssl", "pkey", "-in", f"{DESTINATION}/tls/metrics.key", "-pubout"):
        raise ValueError("Metrics certificate/key mismatch")
    settings["fingerprint"] = fingerprint(metrics_certificate)
    settings["server_fingerprint"] = fingerprint(certificate)
    settings["previous_address"] = previous_address
    settings["previous_auth"] = previous_auth
    if previous_settings:
        previous = json.loads(previous_settings)
        if any(previous[field] != settings[field] for field in ("vm", "project", "address", "port", "tls_name", "label", "fingerprint", "server_fingerprint")):
            raise ValueError("Outer settings/identity changed: disable the previous integration before retargeting or renewal")
        settings.update(previous)
    candidate = render(configuration, settings)
    existing_trust = trust_entry(host, settings)
    (host.backup / "host-before.json").write_text(json.dumps({"address": previous_address, "authentication": previous_auth}))
    added_trust = False
    changed_address = False
    changed_auth = False
    try:
        host.put(CA, certificate.read_text())
        host.check_config(candidate)
        if not existing_trust:
            host.lxc("config", "trust", "add", str(metrics_certificate), "--type=metrics", "--restricted", f'--projects={host.project}', f'--name=lab-outer-{settings["label"]}')
            added_trust = True
        if previous_auth != "true":
            host.lxc("config", "set", "core.metrics_authentication", "true")
            changed_auth = True
        if previous_address != listener:
            host.lxc("config", "set", "core.metrics_address", listener)
            changed_address = True
        metrics = host.guest("curl", "--noproxy", "*", "--fail", "--silent", "--show-error", "--max-time", "20", "--cacert", f"{DESTINATION}/{CA}", "--cert", f"{DESTINATION}/tls/metrics.crt", "--key", f"{DESTINATION}/tls/metrics.key", "--resolve", f'{settings["tls_name"]}:{settings["port"]}:{settings["address"]}', f'https://{settings["tls_name"]}:{settings["port"]}/1.0/metrics?project={host.project}')
        families = {line.split("{", 1)[0] for line in metrics.splitlines() if all(f'{field}="{value}"' in line for field, value in (("name", host.vm), ("project", host.project), ("type", "virtual-machine")))}
        if "lxd_cpu_seconds_total" not in families:
            raise RuntimeError("TLS succeeded but this VM has no CPU series; check its LXD agent")
        print("Exported VM metric families: " + ", ".join(sorted(families)))
        host.reload(candidate)
        host.wait_target(settings)
        host.put(DASHBOARD, (SOURCE / DASHBOARD).read_text())
        host.put(SETTINGS, json.dumps(settings, indent=2) + "\n")
    except BaseException:
        cleanup_errors = []
        actions = [host.restore]
        if changed_address:
            actions.append(lambda: restore_setting(host, "core.metrics_address", listener, previous_address))
        if changed_auth:
            actions.append(lambda: restore_setting(host, "core.metrics_authentication", "true", previous_auth))
        if added_trust:
            actions.append(lambda: host.lxc("config", "trust", "remove", settings["fingerprint"]))
        for action in actions:
            try:
                action()
            except Exception as error:
                cleanup_errors.append(str(error))
        if cleanup_errors:
            print("Rollback needs manual review: " + "; ".join(cleanup_errors), flush=True)
        raise
    finally:
        host.guest("rm", "-f", f"{DESTINATION}/tls/outer-candidate.yml", f"{DESTINATION}/state/outer-upload")
    print("Outer LXD target is UP. Open Grafana /d/easymesh-lxd-outer; allow 60–90 seconds for rate panels.")
    print("The host listener is authenticated metrics-only; restrict its reachability to the lab VM/LAN.")


def restore_setting(host, key, expected, previous):
    if host.lxc("config", "get", key).strip() != expected:
        raise RuntimeError(f"Preserving operator-modified {key}")
    if previous:
        host.lxc("config", "set", key, previous)
    else:
        host.lxc("config", "unset", key)


def disable(host):
    host.saved.clear()
    if not host.exists(SETTINGS):
        print("No managed outer metrics settings found; nothing changed.")
        return
    settings = json.loads(host.read(SETTINGS))
    validate(settings)
    if settings["vm"] != host.vm or settings["project"] != host.project or settings["server_fingerprint"] != fingerprint(HOST_CERTIFICATE):
        raise ValueError("Stored integration belongs to a different VM/project/host identity")
    entry = trust_entry(host, settings)
    configuration = host.save("prometheus.yml")
    candidate = render(configuration)
    try:
        host.check_config(candidate)
        host.reload(candidate)
        host.wait_target(settings, present=False)
    except BaseException:
        host.restore()
        raise
    finally:
        host.guest("rm", "-f", f"{DESTINATION}/tls/outer-candidate.yml")
    if entry:
        host.lxc("config", "trust", "remove", settings["fingerprint"])
    host.guest("rm", "-f", *(f"{DESTINATION}/{relative}" for relative in (SETTINGS, CA, DASHBOARD)))
    print("Outer job/dashboard removed and outer certificate trust revoked. Nested monitoring is unchanged.")
    print("Host listener/authentication retained to avoid disrupting other consumers. Review before removing the listener.")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="Opt-in outer LXD VM metrics using the existing in-VM monitoring stack")
    commands = parser.add_subparsers(dest="command", required=True)
    renderer = commands.add_parser("render")
    renderer.add_argument("base", type=Path)
    renderer.add_argument("output", type=Path)
    renderer.add_argument("--settings", type=Path, required=True)
    renderer.add_argument("--label", required=True)
    installer = commands.add_parser("enable")
    installer.add_argument("vm")
    installer.add_argument("address")
    installer.add_argument("tls_name")
    installer.add_argument("label", nargs="?")
    remover = commands.add_parser("disable")
    remover.add_argument("vm")
    arguments = parser.parse_args()
    if arguments.command == "render":
        settings = json.loads(arguments.settings.read_text()) if arguments.settings.exists() else None
        configuration = arguments.base.read_text().replace("@LAB_LABEL@", arguments.label)
        candidate = render(configuration, settings)
        arguments.output.write_text(candidate)
        return
    project = os.environ.get("LAB_OUTER_PROJECT", "default")
    if not all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", value) for value in (arguments.vm, project)):
        parser.error("Invalid VM/project name")
    settings = None
    if arguments.command == "enable":
        settings = dict(vm=arguments.vm, project=project, address=arguments.address, tls_name=arguments.tls_name, label=arguments.label or arguments.vm, port=int(os.environ.get("LAB_OUTER_METRICS_PORT", "8444")))
        validate(settings)
    host = Host(arguments.vm, project)
    if settings:
        enable(host, settings)
    else:
        disable(host)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        if getattr(error, "stderr", None):
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
