import shutil
import sys
from pathlib import Path


def repair(root, backup):
    original = "docker ps --format '{{.Names}}' | sort | paste -sd, -"
    replacement = "docker ps --filter 'name=^/dhcp-cpe1$' --filter 'name=^/wan-cpe1$' --format '{{.Names}}' | sort | paste -sd, -"
    paths = (
        'usr/local/sbin/boardfarm-lab-rebuild',
        'home/easymesh/git/meta-cmf-bananapi-vcpe/gen/vm/scripts/30-boardfarm-wan.sh',
        'home/easymesh/git/meta-cmf-bananapi-vcpe/gen/vm/scripts/70-health-audit.sh',
    )
    changed = []
    for relative in paths:
        path = root / relative
        if not path.is_file():
            continue
        content = path.read_text()
        if original not in content:
            continue
        saved = backup / relative
        if not saved.exists():
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, saved)
        path.write_text(content.replace(original, replacement))
        changed.append(relative)
    return changed


if __name__ == '__main__':
    for changed in repair(Path('/'), Path(sys.argv[1]) / 'rdk-boardfarm-backups'):
        print('Updated Boardfarm-only container inventory check: ' + changed)
