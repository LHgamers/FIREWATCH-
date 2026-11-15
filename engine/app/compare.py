"""MODIS-VIIRS matched comparison.

Matching rules are explicit and never implied:

* **Spatial tolerance** — a great-circle distance in km (default 2 km). Two
  detections closer than the tolerance are a *candidate* pair, not the same fire.
* **Temporal tolerance** — detections must fall within ``window_hours`` of each
  other (default 24 h, i.e. the same UTC day or an adjacent overpass).
* **One-to-one** — candidates are assigned greedily by ascending distance, so one
  VIIRS detection cannot be counted as the match of several MODIS detections.
  Unmatched detections stay unmatched and are reported as such.

Every matching setting is re-run over a grid of tolerances so the effect of the
choice is visible instead of hidden. None of this establishes that a pair is the
same physical fire, and the module says so in its own payload.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from . import harmonize
from .db import session
from .scientific import _cache_get, _cache_put

PRIMARY_KM = 2.0
PRIMARY_HOURS = 24.0
DISTANCE_SWEEP = (0.5, 1.0, 2.0, 5.0, 10.0)
WINDOW_SWEEP = (0.0, 24.0)
MAX_POINTS = 60_000
EARTH_R_KM = 6371.0088


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_KM * math.asin(math.sqrt(a))


def _load(where: str, params: list[Any]) -> dict[str, list[dict[str, Any]]]:
    sql = (f"SELECT lat, lon, sensor, satellite, ts, acq_date, frp, confidence_class "
           f"FROM observations{where} ORDER BY ts, id")
    with session() as conn:
        rows = conn.execute(sql, params).fetchall()
    total = len(rows)
    step = max(1, math.ceil(total / MAX_POINTS))
    out: dict[str, list[dict[str, Any]]] = {"modis": [], "viirs": []}
    for i, r in enumerate(rows):
        if i % step:
            continue
        row = dict(r)
        out.setdefault(row["sensor"], []).append(row)
    return {"modis": out["modis"], "viirs": out["viirs"], "total": total, "step": step}


def _bucket(points: list[dict[str, Any]], size: float = 0.1) -> dict[tuple[int, int], list[int]]:
    buckets: dict[tuple[int, int], list[int]] = {}
    for idx, p in enumerate(points):
        key = (int(math.floor(p["lat"] / size)), int(math.floor(p["lon"] / size)))
        buckets.setdefault(key, []).append(idx)
    return buckets


def _match(modis: list[dict[str, Any]], viirs: list[dict[str, Any]],
           max_km: float, window_hours: float) -> list[tuple[float, int, int]]:
    """Greedy one-to-one candidate pairs sorted by distance."""
    size = 0.1  # ~11 km at the equator; neighbours reach 10 km comfortably
    buckets = _bucket(viirs, size)
    span = 1
    window_ms = window_hours * 3_600_000
    candidates: list[tuple[float, int, int]] = []
    for mi, m in enumerate(modis):
        cy, cx = int(math.floor(m["lat"] / size)), int(math.floor(m["lon"] / size))
        for dy in range(-span, span + 1):
            for dx in range(-span, span + 1):
                for vi in buckets.get((cy + dy, cx + dx), ()):
                    v = viirs[vi]
                    if window_ms and abs(v["ts"] - m["ts"]) > window_ms:
                        continue
                    if not window_ms and v["acq_date"] != m["acq_date"]:
                        continue
                    d = _haversine(m["lat"], m["lon"], v["lat"], v["lon"])
                    if d <= max_km:
                        candidates.append((d, mi, vi))
    candidates.sort(key=lambda c: c[0])
    used_m: set[int] = set()
    used_v: set[int] = set()
    pairs: list[tuple[float, int, int]] = []
    for dist, mi, vi in candidates:
        if mi in used_m or vi in used_v:
            continue
        used_m.add(mi)
        used_v.add(vi)
        pairs.append((dist, mi, vi))
        if len(pairs) == min(len(modis), len(viirs)):
            break
    return pairs


def _log_ratio_ci(a: np.ndarray, b: np.ndarray) -> tuple[float | None, list[float] | None]:
    mask = (a > 0) & (b > 0)
    if not mask.any():
        return None, None
    diff = np.log10(a[mask]) - np.log10(b[mask])
    point = float(diff.mean())
    if diff.size < harmonize.MIN_PAIRS_FOR_INTERVAL:
        return point, None
    rng = np.random.default_rng(harmonize.BOOTSTRAP_SEED)
    idx = rng.integers(0, diff.size, size=(harmonize.BOOTSTRAP_DRAWS, diff.size))
    means = diff[idx].mean(axis=1)
    lo, hi = np.percentile(means, [2.5, 97.5])
    return point, [round(10 ** float(lo), 3), round(10 ** float(hi), 3)]


def comparison(where: str, params: list[Any], *, aoi_label: str = "Selected area",
               primary_km: float = PRIMARY_KM, primary_hours: float = PRIMARY_HOURS,
               sweep: bool = True, cache_key: Any = None) -> dict[str, Any]:
    key = ("cmp", cache_key, where, tuple(params), aoi_label, primary_km, primary_hours, sweep)
    hit = _cache_get(key)
    if hit is not None:
        return hit
    data = _load(where, params)
    modis, viirs = data["modis"], data["viirs"]

    m_frp = np.asarray([p["frp"] or 0.0 for p in modis], dtype=float)
    v_frp = np.asarray([p["frp"] or 0.0 for p in viirs], dtype=float)
    distribution = harmonize._ks_2samp(m_frp, v_frp)

    settings: list[dict[str, Any]] = []
    grid = [(primary_km, primary_hours)]
    if sweep:
        # One factor at a time, so the table answers "what does the distance
        # tolerance do?" and "what does the time window do?" without a 10-cell
        # cross product that mostly repeats the same answer.
        grid = ([(km, primary_hours) for km in DISTANCE_SWEEP]
                + [(primary_km, hrs) for hrs in WINDOW_SWEEP])
        grid = list(dict.fromkeys(grid))

    best: dict[tuple[float, float], list[tuple[float, int, int]]] = {}
    for km, hrs in grid:
        pairs = _match(modis, viirs, km, hrs)
        best[(km, hrs)] = pairs
        if not pairs:
            settings.append({"maxKm": km, "windowHours": hrs, "pairs": 0})
            continue
        d = np.asarray([p[0] for p in pairs], dtype=float)
        pm = np.asarray([modis[p[1]]["frp"] or 0.0 for p in pairs], dtype=float)
        pv = np.asarray([viirs[p[2]]["frp"] or 0.0 for p in pairs], dtype=float)
        mask = (pm > 0) & (pv > 0)
        ratio = float(np.median(pm[mask] / pv[mask])) if mask.any() else None
        settings.append({
            "maxKm": km, "windowHours": hrs,
            "pairs": len(pairs),
            "modisMatchedShare": round(len({p[1] for p in pairs}) / max(1, len(modis)), 3),
            "viirsMatchedShare": round(len({p[2] for p in pairs}) / max(1, len(viirs)), 3),
            "medianDistanceKm": round(float(np.median(d)), 3),
            "p90DistanceKm": round(float(np.percentile(d, 90)), 3),
            "medianFrpRatio": round(ratio, 3) if ratio else None,
        })

    pairs = best.get((primary_km, primary_hours), [])
    detail: dict[str, Any] = {"pairs": len(pairs)}
    if pairs:
        d = np.asarray([p[0] for p in pairs], dtype=float)
        pm = np.asarray([modis[p[1]]["frp"] or 0.0 for p in pairs], dtype=float)
        pv = np.asarray([viirs[p[2]]["frp"] or 0.0 for p in pairs], dtype=float)
        point, ci = _log_ratio_ci(pm, pv)
        by_conf: dict[str, dict[str, Any]] = {}
        for cls in ("low", "nominal", "high"):
            mask = np.asarray([viirs[p[2]]["confidence_class"] == cls for p in pairs])
            if not mask.any():
                by_conf[cls] = {"pairs": 0}
                continue
            pair_mask = mask & (pm > 0) & (pv > 0)
            ratio = (float(np.median(pm[pair_mask] / pv[pair_mask]))
                     if pair_mask.any() else None)
            by_conf[cls] = {"pairs": int(mask.sum()),
                            "medianFrpRatio": round(float(ratio), 3) if ratio else None,
                            "medianModisFrp": round(float(np.median(pm[mask])), 2),
                            "medianViirsFrp": round(float(np.median(pv[mask])), 2)}
        detail = {
            "pairs": len(pairs),
            "maxKm": primary_km,
            "windowHours": primary_hours,
            "medianDistanceKm": round(float(np.median(d)), 3),
            "p90DistanceKm": round(float(np.percentile(d, 90)), 3),
            "maxDistanceKm": round(float(d.max()), 3),
            "modisMatched": int(len({p[1] for p in pairs})),
            "viirsMatched": int(len({p[2] for p in pairs})),
            "modisTotal": len(modis), "viirsTotal": len(viirs),
            "modisMatchedShare": round(len({p[1] for p in pairs}) / max(1, len(modis)), 3),
            "viirsMatchedShare": round(len({p[2] for p in pairs}) / max(1, len(viirs)), 3),
            "frpLog10Ratio": round(point, 4) if point is not None else None,
            "frpRatio": round(10 ** point, 3) if point is not None else None,
            "frpRatioCi95": ci,
            "spearmanRho": (round(rho, 3)
                            if (rho := harmonize._spearman(pm, pv)) is not None else None),
            "byViirsConfidence": by_conf,
            "oneToOne": True,
        }

    result = {
        "aoi": aoi_label,
        "counts": {
            "modisDetections": len(modis),
            "viirsDetections": len(viirs),
            "sampled": data["step"] > 1,
            "sampleStep": data["step"],
            "rowsConsidered": data["total"],
        },
        "matching": {
            "primaryKm": primary_km, "primaryHours": primary_hours,
            "distanceSweepKm": list(DISTANCE_SWEEP) if sweep else [primary_km],
            "windowSweepHours": list(WINDOW_SWEEP) if sweep else [primary_hours],
            "settings": settings,
            "detail": detail,
            "rules": ("Candidates must fall within the distance tolerance and the temporal window; "
                      "assignment is greedy one-to-one by ascending distance. A matched pair is "
                      "coincident, not proven to be the same fire."),
        },
        "frpDistribution": distribution,
        "validationStatus": "not_independently_validated",
        "validationNote": ("No burned-area or perimeter product is stored, so this comparison cannot be "
                           "validated against observed fire extents. It measures sensor behaviour, not "
                           "ground truth."),
        "limitations": [
            "A spatial match can join two independent fires inside the tolerance, and can miss one "
            "large fire whose detections fall farther apart than the tolerance.",
            "VIIRS has three times the detections of MODIS in this window; unmatched MODIS points are "
            "expected even for real fires because of footprint and threshold differences.",
            "FRP ratios are sensor-specific and window-specific; they are not a conversion factor.",
            "One-to-one greedy assignment is sensitive to dense clusters; the sweep shows how much.",
        ],
    }
    _cache_put(key, result)
    return result
