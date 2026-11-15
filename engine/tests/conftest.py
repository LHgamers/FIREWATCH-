"""Test fixtures: an isolated SQLite database seeded with deterministic rows.

The scientific functions are pure SQL + NumPy over `observations`, so we can
seed a tiny, fully controlled dataset and assert exact expectations instead of
comparing against the live NASA ingest.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="firewatch-test-")
os.environ["FIREWATCH_DB"] = os.path.join(_TMP, "test.db")
# No background warm-up thread in tests: it writes coverage rows on its own
# connection and can collide with the tests' transactions.
os.environ["FIREWATCH_NO_WARM"] = "1"


def _ts(day: str, hour: int) -> int:
    return int(datetime.strptime(f"{day}T{hour:02d}:00:00", "%Y-%m-%dT%H:%M:%S")
               .replace(tzinfo=timezone.utc).timestamp() * 1000)


def obs(idx: int, sensor: str, lat: float, lon: float, day: str, frp: float,
        confidence: str, hour: int = 12) -> dict:
    pct, cls = (None, confidence) if sensor == "viirs" else (float(confidence), None)
    if sensor == "modis":
        pct = float(confidence)
        cls = "high" if pct >= 80 else ("nominal" if pct >= 30 else "low")
    return {
        "id": f"T{idx}", "sensor": sensor,
        "instrument": "MODIS Terra" if sensor == "modis" else "VIIRS 375 m",
        "satellite": "Terra" if sensor == "modis" else "NOAA-20",
        "lat": lat, "lon": lon, "ts": _ts(day, hour),
        "acq_date": day, "acq_time": f"{hour:02d}:00",
        "confidence_raw": confidence, "confidence_pct": pct, "confidence_class": cls,
        "frp": frp, "brightness": 340.0, "bright_t31": 290.0, "scan": 1.0, "track": 1.0,
        "daynight": "D", "version": "test", "source": "test", "cycle": "test",
        "ingested_at": int(time.time() * 1000),
    }


@pytest.fixture(scope="session", autouse=True)
def seeded_db():
    from engine.app import db

    db.init_db()
    rows: list[dict] = []
    i = 0
    # Two sensors over five days in a 1-degree box. MODIS FRP is exactly twice
    # VIIRS FRP on the same cell-day -> the harmonization ratio must be 2.0.
    for d in range(5):
        day = f"2025-03-{d + 1:02d}"
        for c in range(4):
            i += 1
            rows.append(obs(i, "modis", 10.0 + c, 20.5, day, 40.0, "90"))
            i += 1
            rows.append(obs(i, "viirs", 10.0 + c, 20.5, day, 20.0, "high"))
    # A day observed by MODIS only.
    i += 1
    rows.append(obs(i, "modis", 10.5, 20.5, "2025-03-06", 10.0, "50"))
    # A VIIRS-only day far from the box (must be excluded by bbox).
    i += 1
    rows.append(obs(i, "viirs", -30.0, 120.0, "2025-03-07", 5.0, "low"))
    # Duplicate id must be ignored.
    rows.append(obs(1, "modis", 10.0, 20.5, "2025-03-01", 40.0, "90"))
    db.upsert_observations(rows)
    yield
