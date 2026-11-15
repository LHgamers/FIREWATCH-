"""FIREWATCH AI scientific engine — FastAPI surface.

Run:  python engine/run.py     (default http://127.0.0.1:8010)
"""
from __future__ import annotations

import csv
import io
import json
import os
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import analyst, baseline, compare, config, coverage, db, freshness, geo, geo_search, harmonize, platform
from . import scientific as sci
from .ingest import ingest_all, ingest_archive, parse_bbox
from .knowledge import KB
from .regions import REGIONS, InvalidArea, get_region, resolve_bbox
from .sources import SOURCES

VERSION = "1.0.0"
STARTED_AT = int(time.time() * 1000)

# Load .env.local/.env (never overriding the real environment) before any module
# reads FIRMS_MAP_KEY. The key is registered as a secret for redaction here.
_BOOT = config.bootstrap()

app = FastAPI(title="FIREWATCH AI Engine", version=VERSION,
              description="Satellite fire harmonization and evidence engine (LH Studios).")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in os.environ.get("CORS_ORIGINS", "*").split(",")],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.exception_handler(InvalidArea)
def _invalid_area(_request, exc: InvalidArea):
    """A request that names an area we cannot honour is a client error.

    Returning 400 here is the whole point: the previous behaviour answered an
    unknown region or a malformed bbox with Global totals and an impossible box
    with a confident zero.
    """
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def _bbox(bbox: str | None, region: str | None):
    return resolve_bbox(bbox, region)


def _target(bbox: str | None, region: str | None,
            polygon: str | None = None) -> dict[str, Any]:
    """Resolve the AOI, keeping polygon/bbox/region distinguishable in every payload."""
    try:
        return geo.aoi(get_region(region) if region else None, bbox, polygon)
    except InvalidArea:
        raise
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, f"invalid area of interest: {exc}") from exc


def _cached(key: Any, compute):
    """900 s TTL cache shared with the scientific layer; invalidated by ingestion."""
    hit = sci._cache_get(key)
    if hit is not None:
        return hit
    value = compute()
    sci._cache_put(key, value)
    return value


def _sensors(sensor: str | None) -> list[str]:
    if not sensor or sensor == "both":
        return list(sci.SENSORS)
    return [s for s in sensor.split(",") if s in sci.SENSORS]


def _filter_kwargs(sensor: str | None, satellites: str | None, confidence: str | None,
                   min_frp: float | None, daynight: str | None) -> dict[str, Any]:
    return {
        "sensors": _sensors(sensor),
        "satellites": [s.strip() for s in satellites.split(",")] if satellites else None,
        "confidence": [c.strip() for c in confidence.split(",")] if confidence else None,
        "min_frp": min_frp,
        "daynight": daynight,
    }


# --------------------------------------------------------------------------- #
# Status
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict[str, Any]:
    counts = db.table_counts()
    return {
        "status": "ok" if counts["observations"] > 0 else "empty",
        "engine": VERSION,
        "uptimeSeconds": int((time.time() * 1000 - STARTED_AT) / 1000),
        "observations": counts["observations"],
        "db": db.DB_PATH,
        "ai": analyst.ai_status(),
        "warm": dict(_WARM, done=len(_WARM["done"]), failed=_WARM["failed"][:3]),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/ai/status")
def ai_status() -> dict[str, Any]:
    return analyst.ai_status()


@app.get("/api/ai/models")
def ai_models() -> dict[str, Any]:
    return analyst.ai_models()


@app.get("/api/meta")
def meta() -> dict[str, Any]:
    cov = sci.coverage()
    counts = db.table_counts()
    archive = coverage.archive_enabled()
    with db.session() as conn:
        runs = [dict(r) for r in conn.execute(
            "SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 8").fetchall()]
    return {
        "engine": {"version": VERSION, "observations": counts["observations"],
                   "modis": counts["modis"], "viirs": counts["viirs"]},
        "coverage": cov,
        "sources": SOURCES,
        "regions": REGIONS,
        "runs": runs,
        "ai": analyst.ai_status(),
        "config": config.report(),
        "archive": {
            "enabled": archive,
            "note": ("FIRMS archive access is configured: arbitrary historical windows are available."
                     if archive else
                     "No FIRMS MAP_KEY is configured, so the platform runs on the open near-real-time "
                     "feeds. Historical requests outside this window are reported as unavailable rather "
                     "than estimated."),
        },
        "freshness": freshness.status(),
        "attribution": [
            {"label": "Active fire detections", "value": "NASA FIRMS (MODIS C6.1, VIIRS 375 m)"},
            {"label": "Imagery", "value": "NASA EOSDIS GIBS / Worldview"},
        ],
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


# --------------------------------------------------------------------------- #
# Place search (Ask the Earth)
# --------------------------------------------------------------------------- #
@app.get("/api/geocode")
def geocode(q: str = Query(..., min_length=2, max_length=80), limit: int = 8) -> dict[str, Any]:
    """Proxy place-name lookup through this engine.

    The browser never talks to a third-party geocoder directly: the User-Agent,
    the 1 request/second upstream limit and the attribution stay server-side.
    Failures are explicit (400 / 429 / 503); no coordinate is ever invented.
    """
    try:
        return geo_search.search(q, limit)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except geo_search.GeocodeRateLimited as exc:
        raise HTTPException(429, str(exc)) from exc
    except geo_search.GeocodeUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


@app.get("/api/freshness")
def freshness_status() -> dict[str, Any]:
    """Observation window, last successful check, scheduler state and per-source runs."""
    return freshness.status()


@app.post("/api/freshness/check")
def freshness_check(synchronous: bool = False) -> dict[str, Any]:
    """Trigger one refresh check now (bounded, de-duplicated, tracked)."""
    if synchronous:
        return freshness.run_check(manual=True)
    if _ingest_state.running:
        return {"status": "busy", "note": "an ingest is already running"}

    def worker() -> None:
        freshness.run_check(manual=True)

    threading.Thread(target=worker, name="firewatch-refresh-manual", daemon=True).start()
    return {"status": "started", "note": "progress is visible at /api/freshness"}


@app.get("/api/knowledge")
def knowledge(q: str = Query("", min_length=0), k: int = 4) -> dict[str, Any]:
    hits = KB.search(q, k) if q else [(d, 0.0) for d in KB.docs]
    return {"query": q, "results": [
        {"id": d.id, "title": d.title, "text": d.text, "source": d.source, "url": d.url, "score": s}
        for d, s in hits]}


# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #
@app.get("/api/summary")
def summary(bbox: str | None = None, region: str | None = None,
            start: str | None = None, end: str | None = None,
            sensor: str | None = None, satellites: str | None = None,
            confidence: str | None = None, min_frp: float | None = None,
            polygon: str | None = None,
            daynight: str | None = None) -> dict[str, Any]:
    target = _target(bbox, region, polygon)
    box = tuple(target["bbox"])
    data = sci.summary(
        box, start, end, target=target,
        **_filter_kwargs(sensor, satellites, confidence, min_frp, daynight),
    )
    data["region"] = target["label"]
    data["coverage"] = sci.coverage()
    return data


@app.get("/api/timeseries")
def timeseries(bbox: str | None = None, region: str | None = None,
               start: str | None = None, end: str | None = None,
               bucket: Literal["day", "week", "month"] = "day",
               sensor: str | None = None, satellites: str | None = None,
               confidence: str | None = None, min_frp: float | None = None,
               daynight: str | None = None) -> dict[str, Any]:
    box = _bbox(bbox, region)
    return sci.timeseries(box, start, end, bucket,
                          **_filter_kwargs(sensor, satellites, confidence, min_frp, daynight))


@app.get("/api/calendar")
def calendar(bbox: str | None = None, region: str | None = None, year: int | None = None,
             period: str = "day", sensor: str | None = None, satellites: str | None = None,
             confidence: str | None = None, min_frp: float | None = None,
             daynight: str | None = None, polygon: str | None = None,
             grid: float = 0.25, compareYear: int | None = None) -> dict[str, Any]:
    if period not in sci.PERIODS:
        raise HTTPException(400, f"period must be one of {', '.join(sci.PERIODS)}")
    target = _target(bbox, region, polygon)
    box = tuple(target["bbox"])
    cov = sci.coverage()
    if year is None:
        year = int(cov["last"][:4]) if cov["last"] else datetime.now().year
    filters = _filter_kwargs(sensor, satellites, confidence, min_frp, daynight)

    def compute() -> dict[str, Any]:
        out = sci.calendar(box, year, period, target=target, grid=grid, **filters)
        out["region"] = target["label"]
        if compareYear is not None:
            out["yearComparison"] = sci.compare_years(
                box, [compareYear, year], "month" if period == "day" else period,
                target=target, **filters)
        return out

    return _cached(("calendar", box, target.get("polygon"), year, period, grid,
                    compareYear, tuple(sorted(filters.items(), key=str))), compute)


@app.get("/api/calendar/history")
def calendar_history(bbox: str | None = None, region: str | None = None,
                     startYear: int = 2000, endYear: int | None = None,
                     polygon: str | None = None, satellites: str | None = None,
                     confidence: str | None = None, min_frp: float | None = None,
                     daynight: str | None = None) -> dict[str, Any]:
    target = _target(bbox, region, polygon)
    last_year = endYear if endYear is not None else datetime.now(timezone.utc).year
    box = tuple(target["bbox"])
    filters = _filter_kwargs(None, satellites, confidence, min_frp, daynight)

    def compute() -> dict[str, Any]:
        try:
            out = sci.monthly_history(
                box, startYear, last_year, target=target, **filters)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        out["region"] = target["label"]
        out["aoi"] = target
        return out

    return _cached((
        "calendar-history", box, target.get("polygon"), startYear, last_year,
        tuple(sorted(filters.items(), key=str)),
    ), compute)


@app.get("/api/calendar/compare")
def calendar_compare(bbox: str | None = None, region: str | None = None,
                     years: str = "", period: str = "month",
                     polygon: str | None = None, sensor: str | None = None,
                     satellites: str | None = None, confidence: str | None = None,
                     min_frp: float | None = None, daynight: str | None = None) -> dict[str, Any]:
    try:
        parsed = [int(y) for y in years.split(",") if y.strip()]
    except ValueError as exc:
        raise HTTPException(400, "years must be comma-separated integers") from exc
    if not parsed:
        raise HTTPException(400, "years is required, e.g. years=2025,2026")
    if period not in sci.PERIODS:
        raise HTTPException(400, f"period must be one of {', '.join(sci.PERIODS)}")
    target = _target(bbox, region, polygon)
    out = sci.compare_years(tuple(target["bbox"]), parsed, period, target=target,
                            **_filter_kwargs(sensor, satellites, confidence, min_frp, daynight))
    out["aoi"] = target
    return out


@app.get("/api/aoi")
def aoi_endpoint(bbox: str | None = None, region: str | None = None,
                 polygon: str | None = None) -> dict[str, Any]:
    return _target(bbox, region, polygon)


@app.get("/api/platforms")
def platforms_endpoint(bbox: str | None = None, region: str | None = None,
                       start: str | None = None, end: str | None = None,
                       cell: float = 0.25, polygon: str | None = None,
                       sensor: str | None = None, satellites: str | None = None,
                       confidence: str | None = None, min_frp: float | None = None,
                       daynight: str | None = None) -> dict[str, Any]:
    target = _target(bbox, region, polygon)
    where, params = sci._filters(tuple(target["bbox"]), start, end,
                                 **_filter_kwargs(sensor, satellites, confidence, min_frp, daynight))
    payload = _cached(
        ("platforms", tuple(target["bbox"]), target.get("polygon"), start, end, cell,
         tuple(params)),
        lambda: platform.platforms(where, params, cell=cell,
                                   delivery=coverage.delivery(start, end)))
    payload["aoi"] = target
    payload["window"] = {"start": start, "end": end}
    return payload


@app.get("/api/comparison")
def comparison_endpoint(bbox: str | None = None, region: str | None = None,
                        start: str | None = None, end: str | None = None,
                        polygon: str | None = None, maxKm: float = 2.0,
                        windowHours: float = 24.0, sweep: bool = True,
                        sensor: str | None = None, confidence: str | None = None,
                        min_frp: float | None = None, daynight: str | None = None) -> dict[str, Any]:
    target = _target(bbox, region, polygon)
    where, params = sci._filters(tuple(target["bbox"]), start, end,
                                 **_filter_kwargs(sensor, None, confidence, min_frp, daynight))
    payload = compare.comparison(where, params, aoi_label=target["label"],
                                 primary_km=maxKm, primary_hours=windowHours, sweep=sweep,
                                 cache_key=("cmp", target.get("polygon"), tuple(params)))
    payload["aoi"] = target
    payload["window"] = {"start": start, "end": end}
    return payload


@app.get("/api/harmonization/v2")
def harmonization_v2(bbox: str | None = None, region: str | None = None,
                     start: str | None = None, end: str | None = None,
                     grid: float = 0.25, polygon: str | None = None,
                     sensitivity: bool = True, includeComparison: bool = False,
                     sensor: str | None = None, confidence: str | None = None,
                     min_frp: float | None = None, daynight: str | None = None) -> dict[str, Any]:
    try:
        cell = geo.check_cell(grid)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    target = _target(bbox, region, polygon)
    where, params = sci._filters(tuple(target["bbox"]), start, end,
                                 **_filter_kwargs(sensor, None, confidence, min_frp, daynight))
    deliver = coverage.delivery(start, end)
    per_sensor_days = {s: len({k.split(":", 1)[1] for k in deliver if k.startswith(f"{s}:")})
                       for s in ("modis", "viirs")}
    def compute() -> dict[str, Any]:
        out = harmonize.indicator(where, params, cell, target=target,
                                  delivery_days=per_sensor_days, sensitivity=sensitivity)
        out["aoi"] = target
        out["window"] = {"start": start, "end": end}
        if includeComparison:
            out["matchedComparison"] = compare.comparison(
                where, params, aoi_label=target["label"],
                cache_key=("cmp", target.get("polygon"), tuple(params)))
        return out

    return _cached(("harm-v2", tuple(target["bbox"]), target.get("polygon"), start, end,
                    cell, sensitivity, includeComparison, sensor, confidence, min_frp,
                    daynight), compute)


@app.get("/api/baseline")
def baseline_endpoint(bbox: str | None = None, region: str | None = None,
                      start: str | None = None, end: str | None = None,
                      date: str | None = None, method: str = "auto",
                      polygon: str | None = None, sensor: str | None = None) -> dict[str, Any]:
    target = _target(bbox, region, polygon)
    where, params = sci._filters(tuple(target["bbox"]), start, end,
                                 **_filter_kwargs(sensor, None, None, None, None))
    payload = _cached(
        ("baseline", tuple(target["bbox"]), target.get("polygon"), start, end, date, method,
         sensor, tuple(params)),
        lambda: {
            "availability": baseline.availability(where, params),
            "anomaly": baseline.anomaly(where, params, target_date=date, sensor=sensor,
                                        method=method),
            "windowBaseline": baseline.window_baseline(where, params, sensor=sensor,
                                                       target_date=date),
        })
    payload["aoi"] = target
    return payload


@app.get("/api/day/{date_str}")
def day(date_str: str, bbox: str | None = None, region: str | None = None,
        sensor: str | None = None, satellites: str | None = None,
        confidence: str | None = None, min_frp: float | None = None,
        daynight: str | None = None, polygon: str | None = None) -> dict[str, Any]:
    try:
        datetime.strptime(date_str[:10], "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    target = _target(bbox, region, polygon)
    box = tuple(target["bbox"])
    name = target["label"]
    return _cached(
        ("day", box, target.get("polygon"), date_str[:10],
         sensor, satellites, confidence, min_frp, daynight),
        lambda: sci.day_detail(box, date_str[:10], name, target=target,
                               **_filter_kwargs(sensor, satellites, confidence, min_frp, daynight)))


@app.get("/api/coverage")
def coverage_status() -> dict[str, Any]:
    return {
        "coverage": sci.coverage(),
        "windows": coverage.archive_windows(20),
        "states": coverage.STATE_CODES,
        "method": ("Delivery is inferred from global product presence per sensor-day. A recorded zero "
                   "is therefore conditional on global delivery, not proof that the area was imaged."),
    }


@app.get("/api/integrity")
def integrity() -> dict[str, Any]:
    return {"database": db.integrity_check(), "counts": db.table_counts()}


@app.get("/api/sources/status")
def sources_status() -> dict[str, Any]:
    """Per-source health: ok / stale / error / auth / rate_limited / invalid / unavailable."""
    now = datetime.now(timezone.utc)
    with db.session() as conn:
        runs = [dict(r) for r in conn.execute(
            "SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 40").fetchall()]
        datasets = [dict(r) for r in conn.execute("SELECT * FROM datasets").fetchall()]
        stored = {r["source"]: r for r in conn.execute(
            "SELECT source, COUNT(*) n, MIN(acq_date) first, MAX(acq_date) last, MAX(ingested_at) seen"
            " FROM observations GROUP BY source").fetchall()}
    latest: dict[str, dict[str, Any]] = {}
    for run in runs:  # newest first
        latest.setdefault(run["source"], run)

    out = []
    for src in SOURCES:
        sid = src["id"]
        ds = next((d for d in datasets if d["id"] == sid or d["source"] == sid), None)
        run = latest.get(sid)
        row = stored.get(sid)
        status = "unknown"
        note = None
        if sid == "gibs-imagery":
            status = "idle"
            note = "imagery layer: proxied on demand, nothing to ingest"
        elif sid == "firms-archive":
            status = "idle"
            note = ("archive access is configured" if coverage.archive_enabled()
                    else "archive needs FIRMS_MAP_KEY; dates outside the stored window stay UNKNOWN")
        if run and status == "unknown":
            status = run["status"] if run["status"] != "running" else "running"
            note = run.get("message")
            if run["finished_at"]:
                age_h = (now.timestamp() * 1000 - run["finished_at"]) / 3_600_000
                if status == "ok" and age_h > 36:
                    status = "stale"
                    note = f"last successful run {age_h:.0f} h ago"
        if status in ("running", "idle"):
            pass
        elif status == "ok" and not row:
            status = "invalid"
            note = "run reported ok but no rows are stored for this source"
        out.append({
            "id": sid,
            "label": src["label"],
            "sensor": src["sensor"],
            "access": src["access"],
            "product": src.get("product"),
            "status": status,
            "note": (note or "")[:300] or None,
            "lastRun": None if not run else {
                "id": run["id"], "status": run["status"], "records": run["records"],
                "finishedAt": run["finished_at"], "startedAt": run["started_at"],
            },
            "stored": None if not row else {
                "records": int(row["n"]), "firstDate": row["first"], "lastDate": row["last"],
                "ingestedAt": row["seen"],
            },
            "dataset": None if not ds else {
                "records": ds["records"], "coverage": ds["coverage"], "status": ds["status"],
            },
            "archive": sid == "firms-archive",
            "archiveReady": coverage.archive_enabled() if sid == "firms-archive" else None,
        })
    return {
        "generatedAt": now.isoformat(),
        "config": config.report(),
        "sources": out,
        "checkpoints": {
            "archive": len(db.checkpoints("firms-archive:VIIRS_NOAA20_NRT")),
        },
    }


@app.get("/api/cells")
def cells(bbox: str | None = None, region: str | None = None,
          start: str | None = None, end: str | None = None, cell: float = 1.0,
          sensor: str | None = None, satellites: str | None = None,
          confidence: str | None = None, min_frp: float | None = None,
          daynight: str | None = None, polygon: str | None = None) -> dict[str, Any]:
    if not (0.1 <= float(cell) <= 10.0):
        raise HTTPException(400, "cell must be between 0.1 and 10 degrees")
    target = _target(bbox, region, polygon)
    box = tuple(target["bbox"])
    data = sci.cells(
        box, start, end, cell, target=target,
        **_filter_kwargs(sensor, satellites, confidence, min_frp, daynight),
    )
    data["aoi"] = target
    return data


@app.get("/api/observations")
def observations(bbox: str | None = None, region: str | None = None,
                 start: str | None = None, end: str | None = None,
                 limit: int = 20000, sensor: str | None = None,
                 satellites: str | None = None, confidence: str | None = None,
                 min_frp: float | None = None, daynight: str | None = None,
                 polygon: str | None = None) -> dict[str, Any]:
    if int(limit) < 1:
        raise HTTPException(400, "limit must be at least 1")
    target = _target(bbox, region, polygon)
    box = tuple(target["bbox"])
    data = sci.detections(
        box, start, end, limit, target=target,
        **_filter_kwargs(sensor, satellites, confidence, min_frp, daynight),
    )
    data["aoi"] = target
    return data


@app.get("/api/observation/{obs_id:path}")
def observation(obs_id: str) -> dict[str, Any]:
    obs = sci.observation_by_id(obs_id)
    if not obs:
        raise HTTPException(status_code=404, detail="Observation not found")
    return obs


@app.get("/api/harmonization")
def harmonization(bbox: str | None = None, region: str | None = None,
                  start: str | None = None, end: str | None = None,
                  grid: float = 0.25, sensitivity: bool = False) -> dict[str, Any]:
    box = _bbox(bbox, region)
    name = get_region(region)["name"] if region else "Custom area"
    return sci.harmonization(box, start, end, name, grid=grid, sensitivity=sensitivity)


@app.get("/api/anomaly")
def anomaly(bbox: str | None = None, region: str | None = None,
            date: str | None = None, sensor: str | None = None) -> dict[str, Any]:
    box = _bbox(bbox, region)
    return sci.anomaly(box, date, sensor if sensor in sci.SENSORS else None)


# --------------------------------------------------------------------------- #
# Imagery availability
# --------------------------------------------------------------------------- #
_imagery_cache: dict[str, Any] = {"key": None, "value": None}


_probe_cache: dict[str, dict[str, Any]] = {}


def _gibs_probe(date: str) -> dict[str, Any]:
    """Decode one GIBS tile and measure how much of it carries imagery.

    Status codes are useless here: GIBS answers 200 with a black JPEG for days
    it has not processed. A single z2 tile over Africa/Europe is enough to tell
    a real composite (mean ~125, ~90% non-black) from an unprocessed frame
    (mean ~40, ~25% non-black).
    """
    if date in _probe_cache:
        return _probe_cache[date]
    url = (
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/"
        "VIIRS_SNPP_CorrectedReflectance_TrueColor/default/"
        f"{date}/GoogleMapsCompatible_Level9/2/1/1.jpg"
    )
    out: dict[str, Any] = {"date": date, "bytes": 0, "coverage": None, "ok": False}
    try:
        with urllib.request.urlopen(  # noqa: S310 - fixed NASA host
            urllib.request.Request(url, headers={"User-Agent": "FIREWATCH-AI/1.0"}), timeout=15
        ) as resp:
            body = resp.read()
        out["bytes"] = len(body)
        try:
            from io import BytesIO

            import numpy as np
            from PIL import Image

            grey = np.asarray(Image.open(BytesIO(body)).convert("L"), dtype=np.float32)
            coverage = float((grey > 25).mean())
            out["coverage"] = round(coverage, 3)
            out["mean"] = round(float(grey.mean()), 1)
            out["ok"] = coverage >= 0.5 and float(grey.mean()) >= 60.0
        except Exception:  # noqa: BLE001 - Pillow optional, fall back to payload size
            out["ok"] = len(body) >= 18_000
    except Exception:  # noqa: BLE001 - missing dates 404
        pass
    _probe_cache[date] = out
    return out


@app.get("/api/imagery/latest")
def imagery_latest(prefer: str | None = None) -> dict[str, Any]:
    """Latest GIBS true-colour date that actually has imagery.

    GIBS trails the near-real-time feeds, so requesting the newest fire date can
    return a black frame. We probe backwards and report the date we used.
    """
    cov = sci.coverage()
    start = prefer or cov["last"] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    key = f"{start}"
    if _imagery_cache["key"] == key:
        return _imagery_cache["value"]

    base = datetime.strptime(start[:10], "%Y-%m-%d")
    checked = []
    found = None
    for i in range(0, 45):
        d = (base - timedelta(days=i)).strftime("%Y-%m-%d")
        probe = _gibs_probe(d)
        checked.append(probe)
        if probe["ok"]:
            found = d
            break
    result = {
        "requested": start[:10],
        "date": found,
        "available": found is not None,
        "layer": "VIIRS_SNPP_CorrectedReflectance_TrueColor",
        "attribution": "NASA EOSDIS GIBS / Worldview",
        "probed": checked[-5:],
        "probeMethod": "tile pixel coverage ≥ 50% (z2 Africa/Europe tile)",
        "note": (None if found else
                 "No true-colour imagery is published for the stored window; the platform shows a "
                 "composited night-lights basemap instead."),
        "src": (
            "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap"
            "&VERSION=1.3.0&LAYERS=VIIRS_SNPP_CorrectedReflectance_TrueColor&CRS=EPSG:4326"
            f"&BBOX=-58,-180,72,180&WIDTH=1400&HEIGHT=720&FORMAT=image/jpeg&TIME={found}"
        ) if found else None,
    }
    _imagery_cache["key"] = key
    _imagery_cache["value"] = result
    return result


# --------------------------------------------------------------------------- #
# Ask the Earth / Intelligence
# --------------------------------------------------------------------------- #
class AskRequest(BaseModel):
    lat: float = Field(..., ge=-89.9, le=89.9)
    lon: float = Field(..., ge=-180, le=180)
    radiusKm: float = Field(50, ge=1, le=500)
    hours: int = Field(72, ge=1, le=24 * 30)
    obsId: str | None = None


class IntelligenceRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=2000)
    bbox: list[float] | None = None
    region: str | None = None
    start: str | None = None
    end: str | None = None
    mode: Literal["auto", "deterministic", "llm"] = "auto"
    # Optional, request-scoped model. Only an installed model is accepted (400
    # otherwise) so the UI's "in use" label can never name a model that did not
    # answer.
    model: str | None = None


@app.post("/api/ask-the-earth")
def ask_the_earth(req: AskRequest) -> dict[str, Any]:
    return analyst.ask_the_earth(req.lat, req.lon, req.radiusKm, req.hours, req.obsId)


@app.post("/api/intelligence")
def intelligence(req: IntelligenceRequest) -> dict[str, Any]:
    if req.bbox and len(req.bbox) == 4:
        box = tuple(req.bbox)  # type: ignore[assignment]
    else:
        box = _bbox(None, req.region)
    name = get_region(req.region)["name"] if req.region else "the selected area"
    try:
        return analyst.intelligence(req.question, box, req.start, req.end, name,
                                    mode=req.mode, model=req.model)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/intelligence/stream")
def intelligence_stream(req: IntelligenceRequest) -> StreamingResponse:
    if req.bbox and len(req.bbox) == 4:
        box = tuple(req.bbox)  # type: ignore[assignment]
    else:
        box = _bbox(None, req.region)
    name = get_region(req.region)["name"] if req.region else "the selected area"

    def events():
        try:
            for event in analyst.stream_intelligence(req.question, box, req.start, req.end, name,
                                                     mode=req.mode, model=req.model):
                yield f"data: {json.dumps(event)}\n\n"
        except ValueError as exc:
            yield f"data: {json.dumps({'type': 'error', 'detail': str(exc)})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #
def _csv_escape(v: Any) -> str:
    s = "" if v is None else str(v)
    return '"' + s.replace('"', '""') + '"' if any(c in s for c in ',"\n') else s


@app.get("/api/report.csv", response_class=PlainTextResponse)
def report_csv(bbox: str | None = None, region: str | None = None,
               start: str | None = None, end: str | None = None,
               polygon: str | None = None, sensor: str | None = None,
               satellites: str | None = None, confidence: str | None = None,
               min_frp: float | None = None, daynight: str | None = None,
               all_rows: bool = False) -> PlainTextResponse:
    target = _target(bbox, region, polygon)
    box = tuple(target["bbox"])
    name = target["label"]
    filters = _filter_kwargs(sensor, satellites, confidence, min_frp, daynight)
    s = sci.summary(box, start, end, target=target, **filters)
    where, params = sci._filters(box, start, end, **filters)
    deliver = coverage.delivery(start, end)
    delivery_days = {
        product: len({
            key.split(":", 1)[1] for key in deliver if key.startswith(f"{product}:")
        })
        for product in ("modis", "viirs")
    }
    h = harmonize.indicator(
        where, params, target=target, delivery_days=delivery_days, sensitivity=False)
    selected = h["selected"]
    # The per-detection table is a sample by default so the file stays openable;
    # the header states exactly how many rows were written and omitted, so the
    # table can never be mistaken for the whole window. `all_rows=true` writes
    # every detection (bounded by the detections() cap) for archival use.
    cap = sci.DETECTIONS_MAX if all_rows else 5_000
    det = sci.detections(box, start, end, limit=cap, target=target, **filters)
    cov = sci.coverage()
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["FIREWATCH AI scientific report"])
    w.writerow(["Region", name])
    w.writerow(["AOI geometry", target["kind"]])
    w.writerow(["Bounding box W,S,E,N", ",".join(f"{v:.4f}" for v in box)])
    w.writerow(["AOI area (km2)", target["areaKm2"]])
    w.writerow(["Requested window", f"{start or 'all'} -> {end or 'all'}"])
    w.writerow(["Stored coverage", f"{cov['first']} -> {cov['last']} ({len(cov['days'])} days)"])
    w.writerow(["Generated (UTC)", datetime.now(timezone.utc).isoformat()])
    w.writerow(["Sources", "NASA FIRMS MODIS C6.1; NASA FIRMS/ArcGIS VIIRS 375 m"])
    written = len(det["features"])
    total = s["totalDetections"]
    w.writerow(["Detections in window", total])
    w.writerow(["Detection rows in this file", written])
    w.writerow(["Detection rows omitted", max(0, total - written)])
    w.writerow(["Row selection", "every row" if written >= total
                else f"brightest {written} by FRP; pass all_rows=true for every row"])
    w.writerow(["Note", "Sensor counts and HFAI are computed from the selected AOI, dates, and filters. "
                        "The per-detection table may be capped."])
    w.writerow([])
    w.writerow(["Metric", "MODIS", "VIIRS", "Unit"])
    w.writerow(["Detections", s["sensors"]["modis"]["detections"], s["sensors"]["viirs"]["detections"], "count"])
    w.writerow(["Median FRP", s["sensors"]["modis"]["frp"]["median"], s["sensors"]["viirs"]["frp"]["median"], "MW"])
    w.writerow(["Mean FRP", s["sensors"]["modis"]["frp"]["mean"], s["sensors"]["viirs"]["frp"]["mean"], "MW"])
    w.writerow(["Detections per 1000 km2",
                round(s["sensors"]["modis"]["detections"] * 1000 / s["areaKm2"], 3) if s["areaKm2"] else None,
                round(s["sensors"]["viirs"]["detections"] * 1000 / s["areaKm2"], 3) if s["areaKm2"] else None,
                "records/1000 km2"])
    w.writerow(["HFAI density (experimental)",
                selected["sensors"]["modis"]["density"],
                selected["sensors"]["viirs"]["density"],
                "MW km-2 day-1"])
    w.writerow(["Paired-cell FRP ratio (not a conversion factor)",
                selected["hfaiV2"]["ratio"], "95% CI", selected["hfaiV2"]["ratioCi95"]])
    w.writerow([])
    w.writerow(["Method", h["formula"]["v1"]])
    w.writerow(["Validation status", h["validationStatus"]])
    for lim in h["limitations"]:
        w.writerow(["Limitation", lim])
    w.writerow([])
    w.writerow(["id", "sensor", "satellite", "acq_date", "acq_time", "lat", "lon", "frp_mw",
                "confidence_raw", "confidence_class", "brightness_k", "daynight", "source"])
    for f in det["features"]:
        p = f["properties"]
        w.writerow([p["id"], p["sensor"], p["satellite"], p["acqDate"], p["acqTime"], p["lat"], p["lon"],
                    p["frp"], p["confidence"], p["confidenceClass"], p["brightness"], p["daynight"],
                    p["source"]])
    filename = f"firewatch-{name.lower().replace(' ', '-')}-{datetime.now(timezone.utc).strftime('%Y%m%d')}.csv"
    return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# --------------------------------------------------------------------------- #
# Ingestion trigger
# --------------------------------------------------------------------------- #
class IngestState(BaseModel):
    running: bool = False
    last_result: dict[str, Any] | None = None
    last_started: str | None = None


_ingest_state = IngestState()


def _run_ingest() -> None:
    _ingest_state.running = True
    _ingest_state.last_started = datetime.now(timezone.utc).isoformat()
    try:
        _ingest_state.last_result = ingest_all()
    finally:
        _ingest_state.running = False


@app.post("/api/ingest")
def ingest(synchronous: bool = False, viirs_max_pages: int = Query(60, ge=1, le=140)) -> dict[str, Any]:
    """Refresh the open NRT feeds.

    Bounded on purpose: the VIIRS paging cap keeps one click from opening a
    795k-row transaction, and a synchronous call is capped as well.
    """
    if _ingest_state.running:
        return {"status": "already-running", **_ingest_state.model_dump()}
    if synchronous:
        _ingest_state.running = True
        try:
            _ingest_state.last_result = ingest_all(viirs_max_pages=viirs_max_pages)
        finally:
            _ingest_state.running = False
        return {"status": "done", **_ingest_state.model_dump()}
    threading.Thread(target=_ingest_state_thread, args=(viirs_max_pages,), daemon=True).start()
    return {"status": "started", "viirsMaxPages": viirs_max_pages}


def _ingest_state_thread(viirs_max_pages: int) -> None:
    _ingest_state.running = True
    _ingest_state.last_started = datetime.now(timezone.utc).isoformat()
    try:
        _ingest_state.last_result = ingest_all(viirs_max_pages=viirs_max_pages)
    finally:
        _ingest_state.running = False


class ArchiveRequest(BaseModel):
    source: Literal["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT",
                    "MODIS_NRT", "MODIS_SP"] = "VIIRS_NOAA20_NRT"
    start: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    days: int = Field(1, ge=1, le=31)
    bbox: str = "-180,-60,180,75"
    confirm: bool = False


@app.post("/api/ingest/archive")
def ingest_archive_route(req: ArchiveRequest) -> dict[str, Any]:
    """Explicit, bounded historical backfill. Requires confirm=true."""
    if not req.confirm:
        raise HTTPException(400, "set confirm=true to start a historical backfill")
    if not coverage.archive_enabled():
        raise HTTPException(400, "FIRMS_MAP_KEY is not configured; the archive is unavailable")
    try:
        box = parse_bbox(req.bbox)
        datetime.strptime(req.start, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if req.start < "2000-01-01" or req.start > datetime.now(timezone.utc).date().isoformat():
        raise HTTPException(400, "start date outside the archive range")
    threading.Thread(
        target=ingest_archive, args=(req.source, req.start, req.days, box), daemon=True
    ).start()
    return {"status": "started", "source": req.source, "start": req.start, "days": req.days,
            "bbox": list(box), "note": "progress is written to ingest_checkpoints and ingest_runs"}


@app.get("/api/ingest/status")
def ingest_status() -> dict[str, Any]:
    return _ingest_state.model_dump()


db.init_db()


_WARM: dict[str, Any] = {"running": False, "done": [], "failed": [], "startedAt": None,
                         "finishedAt": None, "seconds": None}


def _warm_keys(region_id: str, year: int) -> list[tuple[str, Any]]:
    """The exact (label, zero-argument callable) pairs the default UI asks for.

    Calling the HTTP handler functions directly (with the same arguments the
    browser sends) creates the same cache key the request will look up, so the
    first page load is a cache hit rather than a 20 s scan.
    """
    r = region_id
    return [
        ("calendar", lambda: calendar(region=r, year=year, period="day")),
        ("platforms", lambda: platforms_endpoint(region=r)),
        ("harmonization-v2", lambda: harmonization_v2(region=r, grid=0.25, sensitivity=False)),
        ("summary", lambda: summary(region=r)),
        ("timeseries", lambda: timeseries(region=r)),
        ("baseline", lambda: baseline_endpoint(region=r)),
    ]


def _warm() -> None:
    """Pre-compute the aggregates the dashboard opens with.

    The stored window holds ~870k detections; a cold global scan costs seconds.
    Warming in the background keeps the first page load fast without ever
    serving stale numbers (ingestion clears the cache). Failures are recorded,
    never raised: a warm-up problem must not take the engine down.
    """
    _WARM.update(running=True, startedAt=int(time.time() * 1000))
    t0 = time.time()
    try:
        coverage.ensure()
    except Exception as exc:  # noqa: BLE001
        _WARM["failed"].append(f"coverage: {exc}")
    years: list[int] = []
    try:
        years = sci.available_years()
    except Exception:  # noqa: BLE001
        pass
    year = max(years) if years else datetime.now(timezone.utc).year
    # The dashboard opens on "global"; the two demo hotspots come next. The
    # remaining regions warm only their calendar, because they are one click
    # away and the rest of their views would keep the CPU busy for minutes.
    # Only what the dashboard opens with is warmed. Every other region is one
    # click away and costs 1-6 s cold, which is cheaper than minutes of
    # background CPU contention while the first visitor is already looking.
    plan: list[tuple[str, list[str]]] = [("global", []), ("amazon", ["calendar"])]
    for region_id, only in plan:
        keys = [(label, call) for label, call in _warm_keys(region_id, year)
                if not only or label in only]
        for label, call in keys:
            try:
                call()
                _WARM["done"].append(f"{region_id}:{label}")
            except Exception as exc:  # noqa: BLE001
                _WARM["failed"].append(f"{region_id}:{label}: {exc}")
            time.sleep(0.05)  # stay polite to concurrent requests
        if region_id == "global":
            # The day drawer is the most-clicked view; warm the latest day so
            # the first click does not wait for a full ledger rebuild.
            try:
                last = sci.coverage().get("last")
                if last:
                    day(last, region=region_id)
                    _WARM["done"].append(f"{region_id}:day")
            except Exception as exc:  # noqa: BLE001
                _WARM["failed"].append(f"{region_id}:day: {exc}")
    _WARM.update(running=False, finishedAt=int(time.time() * 1000),
                 seconds=round(time.time() - t0, 1))


# Warm-up is a production convenience, not part of the contract: it writes cache
# entries and coverage rows on a background thread. Tests and one-shot scripts
# set FIREWATCH_NO_WARM=1 so they never race a writer against their own
# transactions (this was the cause of an intermittent "database is locked").
if os.environ.get("FIREWATCH_NO_WARM") != "1":
    threading.Thread(target=_warm, name="firewatch-warm", daemon=True).start()
    # Hourly NASA feed check. Disabled with FIREWATCH_REFRESH_DISABLED=1; the
    # first check waits so it never competes with the warm-up scan.
    freshness.start_scheduler(busy=lambda: _ingest_state.running)
