"""Build the downloadable FIREWATCH AI Local Edition archive + manifest.

Output:
  public/downloads/FIREWATCH_AI_Local_Edition_v0.2.zip
  public/downloads/FIREWATCH_AI_Local_Edition.json   (read by /download)
  public/downloads/SHA256SUMS.txt

The manifest is generated from the archive bytes, never written by hand, so the
size and hash shown on the website cannot drift from the file a visitor gets.
Model weights are deliberately excluded (they are pulled from the Ollama
registry under their own licence).
"""
from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "local_ai"
OUT = ROOT / "public" / "downloads"
VERSION = "0.2.0"
ARCHIVE = f"FIREWATCH_AI_Local_Edition_v{VERSION}.zip"

EXCLUDE_DIRS = {"__pycache__", "data", ".pytest_cache", ".venv", "node_modules"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db"}


def collect() -> list[Path]:
    files: list[Path] = []
    for path in sorted(SRC.rglob("*")):
        if not path.is_file():
            continue
        if any(part in EXCLUDE_DIRS for part in path.parts):
            continue
        if path.name in EXCLUDE_FILES or path.suffix == ".pyc":
            continue
        files.append(path)
    return files


def main() -> int:
    if not SRC.is_dir():
        print(f"source not found: {SRC}")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / ARCHIVE
    files = collect()
    if not files:
        print("nothing to package")
        return 1

    uncompressed = sum(p.stat().st_size for p in files)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            arcname = Path("FIREWATCH_AI_Local_Edition") / path.relative_to(SRC)
            zf.write(path, arcname.as_posix())

    digest = hashlib.sha256()
    with target.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    sha = digest.hexdigest()
    size = target.stat().st_size

    manifest = {
        "name": "FIREWATCH AI — Local Edition",
        "archive": ARCHIVE,
        "version": VERSION,
        "sizeBytes": size,
        "sizeMB": round(size / 1024 / 1024, 2),
        "sha256": sha,
        "fileCount": len(files),
        "uncompressedBytes": uncompressed,
        "included": "Python application (stdlib only), FIREWATCH system instructions, "
                    "6-document knowledge base, SQLite FTS5 retrieval, branded local chat UI, "
                    "installer/diagnostic scripts, offline tests, README",
        "excluded": [".venv", "data", "exports", "__pycache__", "model weights"],
        "containsModelWeights": False,
        "fineTuned": False,
        "baseModel": {
            "tag": "qwen2.5:7b-instruct",
            "license": "Apache 2.0",
            "sizeGB": 4.7,
        },
    }
    (OUT / "FIREWATCH_AI_Local_Edition.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    (OUT / "SHA256SUMS.txt").write_text(f"{sha}  {ARCHIVE}\n", encoding="utf-8")

    # Verify the archive is readable and contains the files we intended.
    with zipfile.ZipFile(target) as zf:
        bad = zf.testzip()
        if bad:
            print(f"archive integrity failure at {bad}")
            return 1
        names = zf.namelist()
        missing = [
            n for n in (
                "FIREWATCH_AI_Local_Edition/start.bat",
                "FIREWATCH_AI_Local_Edition/firewatch_ai/persona.py",
                "FIREWATCH_AI_Local_Edition/web/index.html",
            )
            if n not in names
        ]
        if missing:
            print("missing required entries:", missing)
            return 1

    print(f"archive   {target.relative_to(ROOT)}")
    print(f"files     {len(files)}")
    print(f"size      {manifest['sizeMB']} MB ({size} bytes)")
    print(f"sha256    {sha}")
    print(f"contents  verified ({len(names)} entries, testzip ok)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
