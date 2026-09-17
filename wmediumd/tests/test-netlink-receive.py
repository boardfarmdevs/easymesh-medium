#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import tempfile


parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
source = args.source.read_text()
start = source.index("static void sock_event_cb(")
end = source.index("/*\n * Setup netlink socket", start)
function = source[start:end].strip()
fixture = Path(__file__).with_suffix(".c").read_text().replace("@PRODUCTION@", function)
with tempfile.TemporaryDirectory(prefix="wmd-receive-fixture-") as temporary:
    generated = Path(temporary) / "fixture.c"
    binary = Path(temporary) / "fixture"
    generated.write_text(fixture)
    flags = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "--libs", "libnl-3.0"], text=True))
    command = ["cc", "-std=gnu11", "-Wall", "-Wextra", "-Werror", str(generated), "-o", str(binary), *flags]
    compiled = subprocess.run(command, text=True, capture_output=True)
    run = subprocess.run([str(binary)], text=True, capture_output=True, timeout=10) if not compiled.returncode else None
report = {
    "scope": "Full production receive callback, real libnl receive parser, isolated blocking socketpair with no success ACK supplied; no guest traffic",
    "source": str(args.source.resolve()),
    "source_sha256": hashlib.sha256(args.source.read_bytes()).hexdigest(),
    "function_sha256": hashlib.sha256(function.encode()).hexdigest(),
    "compile": {"exit_code": compiled.returncode, "command": command, "stdout": compiled.stdout, "stderr": compiled.stderr},
    "run": None if run is None else {"exit_code": run.returncode, "stdout": run.stdout, "stderr": run.stderr},
}
args.output.write_text(json.dumps(report, indent=2) + "\n")
print(compiled.stderr, end="")
if run:
    print(run.stdout, end="")
    print(run.stderr, end="")
raise SystemExit(compiled.returncode or (run.returncode if run else 1))
