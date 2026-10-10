#!/usr/bin/env python3
"""Verify every file in a Chrome Web Store upload ZIP matches the audited source."""
from pathlib import Path
from zipfile import ZipFile
import hashlib
import json
import struct
import sys

FILES = [
    "manifest.json", "background.js", "panel.html", "panel.js",
    "onboarding-bridge.js", "icons/bico-16.png", "icons/bico-48.png",
    "icons/bico-128.png"
]
def digest(b): return hashlib.sha256(b).hexdigest()
def check(source: Path, uploaded: Path):
    report = {"zip": str(uploaded), "zip_sha256": digest(uploaded.read_bytes()), "entries": []}
    with ZipFile(uploaded) as z:
        assert z.testzip() is None, "ZIP integrity error"
        names = z.namelist()
        assert len(names) == len(set(names)), "ZIP has duplicate entries"
        assert set(names) == set(FILES), f"Unexpected or missing entries: {set(names) ^ set(FILES)}"
        for name in FILES:
            source_bytes = (source / name).read_bytes()
            if name.endswith((".json", ".html", ".js")):
                source_bytes = source_bytes.replace(b"\r\n", b"\n")
            zip_bytes = z.read(name)
            assert source_bytes == zip_bytes, f"ZIP content mismatch: {name}"
            record = {"path": name, "sha256": digest(zip_bytes), "bytes": len(zip_bytes)}
            if name.startswith("icons/"):
                assert zip_bytes[:8] == b"\x89PNG\r\n\x1a\n", f"Not PNG: {name}"
                w, h = struct.unpack(">II", zip_bytes[16:24])
                assert w == h == int(name.split("-")[-1].split(".")[0]), f"Invalid icon dimensions: {name}"
                record["size"] = f"{w}x{h}"
            report["entries"].append(record)
        manifest = json.loads(z.read("manifest.json"))
        assert manifest["manifest_version"] == 3
        assert manifest["version"] == json.loads((source / "manifest.json").read_text(encoding="utf-8"))["version"]
        assert set(manifest["host_permissions"]) == {"http://localhost/*","http://127.0.0.1/*"}
        report.update({"name": manifest["name"], "version": manifest["version"], "status": "PASS", "manifest_at_zip_root": True})
    print(json.dumps(report, indent=2))
if __name__ == "__main__":
    if len(sys.argv) != 3: raise SystemExit("Usage: python verify-browser-store-zip.py browser-extension switchboard-chrome.zip")
    check(Path(sys.argv[1]), Path(sys.argv[2]))
