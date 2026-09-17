#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import tempfile


def extract(text, start, end):
    return text[text.index(start):text.index(end, text.index(start))].strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.read_text()
    functions = {
        "wmediumd_send_to_client": extract(source, "static void wmediumd_send_to_client(", "static void wmediumd_remove_client("),
        "init_netlink": extract(source, "static int init_netlink(", "/*\n *\tPrint the CLI help"),
    }
    fixture = Path(__file__).with_suffix(".c").read_text()
    fixture = fixture.replace("@PRODUCTION@", "\n".join(functions.values()))
    flags = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "libnl-3.0", "libnl-genl-3.0"], text=True))
    with tempfile.TemporaryDirectory(prefix="wmd-ack-fixture-") as temporary:
        generated = Path(temporary) / "fixture.c"
        binary = Path(temporary) / "fixture"
        generated.write_text(fixture)
        command = ["cc", "-std=gnu11", "-Wall", "-Wextra", "-Werror", str(generated), "-o", str(binary), *flags]
        compiled = subprocess.run(command, text=True, capture_output=True)
        run = subprocess.run([str(binary)], text=True, capture_output=True) if compiled.returncode == 0 else None
    report = {
        "source": str(args.source.resolve()),
        "source_sha256": hashlib.sha256(args.source.read_bytes()).hexdigest(),
        "functions": {name: hashlib.sha256(body.encode()).hexdigest() for name, body in functions.items()},
        "libnl_version": subprocess.check_output(["pkg-config", "--modversion", "libnl-3.0"], text=True).strip(),
        "compile": {"command": command, "exit_code": compiled.returncode, "stdout": compiled.stdout, "stderr": compiled.stderr},
        "run": None if run is None else {"exit_code": run.returncode, "stdout": run.stdout, "stderr": run.stderr},
        "scope": "Extracted production init/send functions and real libnl; kernel socket connection/lookup/send stubbed. No runtime or RF traffic.",
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(compiled.stderr, end="")
    if run:
        print(run.stdout, end="")
        print(run.stderr, end="")
    return compiled.returncode or (run.returncode if run else 1)


if __name__ == "__main__":
    raise SystemExit(main())
