#!/usr/bin/env python3
import argparse
from pathlib import Path
import shutil
import subprocess


def stage(destination):
    source = Path(__file__).resolve().parent
    target = Path(destination).resolve()
    def git(*arguments):
        return subprocess.check_output(["git", "-C", str(target), *arguments], text=True).strip()
    if git("branch", "--show-current") != "gh-pages" or Path(git("rev-parse", "--show-toplevel")) != target:
        raise SystemExit("Use the root of an existing gh-pages checkout.")
    if git("status", "--porcelain"):
        raise SystemExit("The gh-pages checkout must be clean before staging.")
    html = (source / "viewer/index.html").read_text()
    if '<meta name="room-viewer-mode" content="no-connect">' not in html:
        raise SystemExit("Public hosting must default to the disconnected sandbox.")
    for name in ("viewer", "golden"):
        if (target / name).exists():
            shutil.rmtree(target / name)
        shutil.copytree(source / name, target / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    print("Staged viewer and golden rooms; preserved the landing page and explorer.")
    print("Review and test the site before publishing gh-pages.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stage the disconnected room viewer for GitHub Pages.")
    parser.add_argument("destination")
    stage(parser.parse_args().destination)
