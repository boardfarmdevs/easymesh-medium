"""The topology page's offline browser libraries (web-vendor.md): the pinned archive, every
checked asset, the licenses and every Font Awesome font its stylesheet names."""
import hashlib
from pathlib import Path
import re
import tarfile


HERE = Path(__file__).resolve().parents[1]
BUNDLE = HERE / "web-vendor.tar.gz"


def test_offline_browser_bundle_has_verified_assets_and_licenses():
    digest = hashlib.sha256(BUNDLE.read_bytes()).hexdigest()
    assert digest == "699a85cca2578c7d1563ab7e0544f934ca3b2292fef42b85022a1fca89139e08"
    assert (HERE / "web-vendor.tar.gz.sha256").read_text().split()[0] == digest
    with tarfile.open(BUNDLE) as archive:
        names = archive.getnames()
        assert all(name.startswith("vendor") and ".." not in Path(name).parts for name in names)
        for line in archive.extractfile("vendor/SHA256SUMS").read().decode().splitlines():
            digest, name = line.split(None, 1)
            assert hashlib.sha256(archive.extractfile(name).read()).hexdigest() == digest
        for name in ("d3-LICENSE", "chart-LICENSE.md", "animate-LICENSE", "fontawesome/LICENSE.txt"):
            assert archive.extractfile("vendor/" + name).read()
        stylesheet = archive.extractfile("vendor/fontawesome/css/all.min.css").read().decode()
        for font in re.findall(r"url\((?:['\"])?\.\./webfonts/([^)'\"]+)", stylesheet):
            assert "vendor/fontawesome/webfonts/" + font in names
        for asset in ("d3-7.9.0.min.js", "chart-3.9.1.min.js", "animate-4.1.1.min.css"):
            assert archive.extractfile("vendor/" + asset).read()
