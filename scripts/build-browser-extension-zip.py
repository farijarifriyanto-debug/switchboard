#!/usr/bin/env python3
"""Build reproducible Chrome/Edge MV3 extension ZIP files from checked-in source.

All package entries are explicit and rooted at manifest.json. Python stdlib only.
"""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import json
import sys

FILES = (
    "manifest.json",
    "background.js",
    "panel.html",
    "panel.js",
    "onboarding-bridge.js",
    "icons/bico-16.png",
    "icons/bico-48.png",
    "icons/bico-128.png",
)

def build(source: Path, dest: Path) -> None:
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    assert manifest.get("manifest_version") == 3
    dest.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(dest, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in FILES:
            info = ZipInfo(relative, date_time=(2026, 10, 10, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (0o100644 << 16)
            archive.writestr(info, (source / relative).read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
    print(f"BUILT {dest} manifest={manifest['version']} entries={len(FILES)}")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python3 scripts/build-browser-extension-zip.py browser-extension output.zip")
    build(Path(sys.argv[1]), Path(sys.argv[2]))
