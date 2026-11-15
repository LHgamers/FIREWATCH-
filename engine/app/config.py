"""Engine configuration.

Loaded once at import of this module's :func:`bootstrap`, and safe to call
again. There is no external dependency: ``.env`` is parsed here so a local
Windows run does not require exporting variables into a shell (which is how
secrets end up in shell history and screenshots).

Rules enforced:
* an existing environment variable always wins over the file;
* nothing here ever prints, logs or returns a secret value;
* ``FIRMS_MAP_KEY`` is registered with :mod:`sources` so every error path
  redacts it.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from . import sources

ROOT = Path(__file__).resolve().parents[2]
ENV_FILES = (ROOT / ".env.local", ROOT / ".env")

_loaded = False


def _parse_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            out[key] = value
    return out


def load_env() -> list[str]:
    """Load .env.local then .env without overriding the real environment."""
    global _loaded
    files: list[str] = []
    for path in ENV_FILES:
        values = _parse_env(path)
        if values:
            files.append(path.name)
        for key, value in values.items():
            if key not in os.environ:
                os.environ[key] = value
    _loaded = True
    sources.register_secret(os.environ.get("FIRMS_MAP_KEY"))
    return files


def _looks_like_key(value: str) -> bool:
    """FIRMS keys are long opaque tokens; reject obvious placeholders."""
    if not value or len(value) < 20:
        return False
    lowered = value.lower()
    return not any(bad in lowered for bad in ("your", "example", "changeme", "placeholder", "xxx"))


def map_key_status() -> dict[str, Any]:
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    sources.register_secret(key)
    if not key:
        return {
            "configured": False,
            "valid": False,
            "note": "Not configured. Open NRT feeds are used; archive dates are unavailable.",
        }
    if not _looks_like_key(key):
        return {
            "configured": True,
            "valid": False,
            "note": "A value is set but it does not look like a FIRMS key (too short or a placeholder). "
                    "Archive requests will fail with an authentication error.",
        }
    return {"configured": True, "valid": True, "note": "Configured (value never exposed)."}


def bootstrap() -> dict[str, Any]:
    files = load_env() if not _loaded else []
    return {"envFiles": files, "mapKey": map_key_status()}


def report() -> dict[str, Any]:
    """Non-secret configuration summary for /api/health and /api/sources/status."""
    return {
        "envFiles": [p.name for p in ENV_FILES if p.is_file()],
        "mapKey": map_key_status(),
        "db": os.environ.get("FIREWATCH_DB") or "data/firewatch.db",
    }
