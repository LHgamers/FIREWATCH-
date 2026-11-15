"""Harmonization engine for comparable indicators; not a sensor conversion.

Design rules enforced here
--------------------------
1. Raw observations are read, never modified.
2. Each sensor keeps its own numerator, denominator and day count. A shared
   number is only ever reported *after* the sensor-specific numbers exist.
3. FRP remains MW as reported. This module never converts FRP between sensors.
   The historical calendar separately counts occupied cell-days and may show
   a date-range-specific, temporally held-out VIIRS substitution on that
   activity index; it is not an FRP or fire-intensity calibration.
4. Every derived indicator carries its formula, its uncertainty and an
   explicit experimental status.
5. Cell area is the exact spherical zone area; grid assignment uses a true
   floor, so cells never straddle 0° latitude/longitude.

The three categories the API keeps separate
-------------------------------------------
* **Raw** — detections and native FRP per sensor/platform (``platform.py``).
* **Comparable derived indicator** — HFAI-v1 density / HFAI-v2 paired intensity.
  Dimensionally explicit, grid-dependent, experimental.
* **Validated measurement** — none exists in this build
  (``validationStatus: not_independently_validated``).
"""
from __future__ import annotations

import math
from typing import Any, Iterable

import numpy as np

from . import geo
from .db import session

SENSORS = ("modis", "viirs")
BOOTSTRAP_DRAWS = 800
BOOTSTRAP_SEED = 20261114
MIN_PAIRS_FOR_INTERVAL = 12


# --------------------------------------------------------------------------- #
# Cell-day reduction
# --------------------------------------------------------------------------- #
def _fetch_rows(where: str, params: list[Any], target: dict[str, Any] | None) -> list[tuple]:
    """Fetch the minimum columns needed for exact AOI filtering when a polygon is used."""
    with session() as conn:
        return [tuple(r) for r in conn.execute(
            f"SELECT lat, lon, sensor, acq_date, COALESCE(frp, 0), satellite "
            f"FROM observations{where}", params).fetchall()]


def cell_days(where: str, params: list[Any], cell: float,
              target: dict[str, Any] | None = None) -> dict[str, Any]:
    """Reduce to one value per (cell, day, sensor): the maximum reported FRP.

    Repeated overpasses over the same fire can then never inflate a total, and
    the reduction is identical for both sensors. For polygon AOIs each detection
    is tested exactly before reduction — a bounding-box surrogate is never used.
    """
    cell = geo.check_cell(cell)
    lat_expr, lon_expr, grid_params = geo.grid_sql(cell)

    if target and target.get("polygon"):
        values: dict[tuple[int, int, str, str], float] = {}
        counts: dict[tuple[int, int, str, str], int] = {}
        sats: dict[tuple[int, int, str, str], set[str]] = {}
        for lat, lon, sensor, day, frp, satellite in _fetch_rows(where, params, target):
            if not geo.contains(target, lon, lat):
                continue
            key = (geo.cell_index(lat, cell, geo.LAT_OFFSET),
                   geo.cell_index(lon, cell, geo.LON_OFFSET), day, sensor)
            values[key] = max(values.get(key, 0.0), float(frp))
            counts[key] = counts.get(key, 0) + 1
            sats.setdefault(key, set()).add(satellite)
        rows = [{"cy": k[0], "cx": k[1], "acq_date": k[2], "sensor": k[3],
                 "max_frp": v, "n": counts[k], "satellites": sorted(sats[k])}
                for k, v in values.items()]
    else:
        rows = _fetch_grouped(where, params, cell, lat_expr, lon_expr, grid_params)

    m: dict[tuple[int, int, str], float] = {}
    v: dict[tuple[int, int, str], float] = {}
    m_n: dict[tuple[int, int, str], int] = {}
    v_n: dict[tuple[int, int, str], int] = {}
    m_sat: dict[tuple[int, int, str], list[str]] = {}
    v_sat: dict[tuple[int, int, str], list[str]] = {}
    for r in rows:
        key = (int(r["cy"]), int(r["cx"]), r["acq_date"])
        if r["sensor"] == "modis":
            m[key] = float(r["max_frp"] or 0.0)
            m_n[key] = int(r["n"] or 0)
            m_sat[key] = list(r.get("satellites") or [])
        else:
            v[key] = float(r["max_frp"] or 0.0)
            v_n[key] = int(r["n"] or 0)
            v_sat[key] = list(r.get("satellites") or [])

    m_cells = {(k[0], k[1]) for k in m}
    v_cells = {(k[0], k[1]) for k in v}
    both = sorted(set(m) & set(v))
    return {
        "cell": cell,
        "m": m, "v": v, "mCount": m_n, "vCount": v_n,
        "mSat": m_sat, "vSat": v_sat,
        "mCellSet": m_cells, "vCellSet": v_cells,
        "both": both,
        "onlyM": sorted(set(m) - set(v)),
        "onlyV": sorted(set(v) - set(m)),
        "days": sorted({k[2] for k in m} | {k[2] for k in v}),
        "daysM": sorted({k[2] for k in m}),
        "daysV": sorted({k[2] for k in v}),
    }


def _fetch_grouped(where: str, params: list[Any], cell: float,
                   lat_expr: str, lon_expr: str, grid_params: list[float]) -> list[dict[str, Any]]:
    sql = f"""SELECT {lat_expr} cy, {lon_expr} cx, acq_date, sensor,
                     MAX(COALESCE(frp, 0)) max_frp, COUNT(*) n
              FROM observations{where}
              GROUP BY cy, cx, acq_date, sensor"""
    with session() as conn:
        return [dict(r) for r in conn.execute(sql, grid_params + params).fetchall()]


def cell_area_map(keys: Iterable[tuple[int, int]], cell: float) -> dict[tuple[int, int], float]:
    return {key: geo.cell_area_km2(key[0], cell) for key in keys}


# --------------------------------------------------------------------------- #
# Uncertainty
# --------------------------------------------------------------------------- #
def _boot_mean_ci(values: np.ndarray, scale: float,
                  draws: int = BOOTSTRAP_DRAWS) -> tuple[float, float] | None:
    """Percentile bootstrap CI for ``scale * mean(values)``.

    Resampling cell-days is the honest unit here: the cell-day is the
    independent-ish observation the indicator is built from, and the spread of
    its FRP values is what dominates the uncertainty of a mean intensity.
    """
    if values.size < MIN_PAIRS_FOR_INTERVAL:
        return None
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    idx = rng.integers(0, values.size, size=(draws, values.size))
    means = values[idx].mean(axis=1) * scale
    lo, hi = np.percentile(means, [2.5, 97.5])
    return float(lo), float(hi)


def _spearman(x: np.ndarray, y: np.ndarray) -> float | None:
    """Spearman rank correlation without SciPy (average ranks for ties)."""
    if x.size < 3 or x.size != y.size:
        return None

    def ranks(a: np.ndarray) -> np.ndarray:
        order = np.argsort(a, kind="mergesort")
        out = np.empty(a.size, dtype=float)
        i = 0
        while i < a.size:
            j = i
            while j + 1 < a.size and a[order[j + 1]] == a[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1.0
            out[order[i:j + 1]] = avg
            i = j + 1
        return out

    rx, ry = ranks(x), ranks(y)
    if rx.std() == 0 or ry.std() == 0:
        return None
    return float(np.corrcoef(rx, ry)[0, 1])


def _ks_2samp(a: np.ndarray, b: np.ndarray) -> dict[str, Any]:
    """Two-sample Kolmogorov-Smirnov statistic with an asymptotic p-value."""
    if a.size == 0 or b.size == 0:
        return {"statistic": None, "pValue": None, "note": "one sample is empty"}
    grid = np.sort(np.unique(np.concatenate([a, b])))
    cdf_a = np.searchsorted(np.sort(a), grid, side="right") / a.size
    cdf_b = np.searchsorted(np.sort(b), grid, side="right") / b.size
    d = float(np.max(np.abs(cdf_a - cdf_b)))
    n_eff = (a.size * b.size) / (a.size + b.size)
    lam = (math.sqrt(n_eff) + 0.12 + 0.11 / math.sqrt(n_eff)) * d
    p = 2.0 * sum((-1) ** (k - 1) * math.exp(-2.0 * (k * lam) ** 2) for k in range(1, 101))
    return {
        "statistic": round(d, 4),
        "pValue": round(min(1.0, max(0.0, p)), 6),
        "n1": int(a.size), "n2": int(b.size),
        "note": ("Ks distribution test on native FRP values (MW). With hundreds of thousands of "
                 "detections the test has power to detect trivially small differences; the effect "
                 "size matters more than the p-value."),
    }


# --------------------------------------------------------------------------- #
# Indicators
# --------------------------------------------------------------------------- #
def _v1_sensor(cd: dict[str, Any], sensor: str, delivery_days: int | None) -> dict[str, Any]:
    cells = cd["mCellSet"] if sensor == "modis" else cd["vCellSet"]
    values = cd["m"] if sensor == "modis" else cd["v"]
    days = cd["daysM"] if sensor == "modis" else cd["daysV"]
    areas = cell_area_map(cells, cd["cell"])
    active_area = sum(areas.values())
    n_days = delivery_days or max(1, len(days))
    frp_total = float(sum(values.values()))
    density = frp_total / active_area / n_days if active_area else 0.0
    arr = np.asarray(list(values.values()), dtype=float)
    ci = (_boot_mean_ci(arr, scale=arr.size / active_area / n_days)
          if active_area else None)
    return {
        "sensor": sensor,
        "cellDays": len(values),
        "cells": len(cells),
        "activeAreaKm2": round(active_area, 1),
        "frpTotalMw": round(frp_total, 2),
        "observationDays": len(days),
        "deliveryDaysUsed": n_days,
        "density": round(density, 6),
        "densityUnit": "MW km^-2 day^-1",
        "densityCi95": None if not ci else [round(ci[0], 9), round(ci[1], 9)],
        "ciMethod": ("percentile bootstrap over cell-day maximum FRP, 800 draws"
                     if ci else f"not reported: fewer than {MIN_PAIRS_FOR_INTERVAL} cell-days"),
    }


def indicator(where: str, params: list[Any], cell: float = 0.25, *,
              target: dict[str, Any] | None = None,
              delivery_days: dict[str, int] | None = None,
              sensitivity: bool = True) -> dict[str, Any]:
    """Compute HFAI-v1 (revised) and HFAI-v2 for one AOI/window/filter set."""
    delivery_days = delivery_days or {}
    grids = [geo.check_cell(cell)]
    if sensitivity:
        grids = [g for g in geo.GRID_CHOICES]

    results: dict[float, dict[str, Any]] = {}
    for g in grids:
        cd = cell_days(where, params, g, target)
        union_cells = cd["mCellSet"] | cd["vCellSet"]
        union_area = sum(cell_area_map(union_cells, g).values())
        both_days = sorted(set(cd["daysM"]) & set(cd["daysV"]))
        both_delivery = min(delivery_days.get("modis", 0), delivery_days.get("viirs", 0)) or None
        combined_days = both_delivery or max(1, len(set(cd["daysM"]) | set(cd["daysV"])))

        m = _v1_sensor(cd, "modis", delivery_days.get("modis"))
        v = _v1_sensor(cd, "viirs", delivery_days.get("viirs"))

        # Combined descriptive value: max FRP per cell-day across sensors, so the
        # same fire seen by both is counted once. It is an upper bound of shared
        # activity, not a calibrated total.
        union_values = np.asarray(
            [max(cd["m"].get(k, 0.0), cd["v"].get(k, 0.0)) for k in cd["both"]]
            + [cd["m"][k] for k in cd["onlyM"]] + [cd["v"][k] for k in cd["onlyV"]],
            dtype=float)
        combined_total = float(union_values.sum()) if union_values.size else 0.0
        combined_density = combined_total / union_area / combined_days if union_area else 0.0
        combined_ci = (_boot_mean_ci(union_values, union_values.size / union_area / combined_days)
                       if union_area else None)

        paired_m = np.asarray([cd["m"][k] for k in cd["both"]], dtype=float)
        paired_v = np.asarray([cd["v"][k] for k in cd["both"]], dtype=float)
        log_ratio = None
        ratio_ci = None
        if paired_m.size:
            mask = (paired_m > 0) & (paired_v > 0)
            if mask.any():
                diff = np.log10(paired_m[mask]) - np.log10(paired_v[mask])
                log_ratio = float(diff.mean())
                boot = _boot_mean_ci(diff, 1.0) if diff.size >= MIN_PAIRS_FOR_INTERVAL else None
                if boot:
                    ratio_ci = [round(10 ** boot[0], 3), round(10 ** boot[1], 3)]

        jaccard = (len(cd["mCellSet"] & cd["vCellSet"]) / len(union_cells)) if union_cells else None

        results[g] = {
            "grid": g,
            "gridDefinition": "equal-angle global grid, origin at -180/-90, floor-indexed",
            "cellAreaMethod": "exact spherical zone area R^2 dlon (sin lat2 - sin lat1)",
            "sensors": {"modis": m, "viirs": v},
            "combined": {
                "cellDays": int(union_values.size),
                "activeCells": len(union_cells),
                "activeAreaKm2": round(union_area, 1),
                "frpTotalMw": round(combined_total, 2),
                "daysUsed": combined_days,
                "density": round(combined_density, 6),
                "densityUnit": "MW km^-2 day^-1",
                "densityCi95": None if not combined_ci else
                               [round(combined_ci[0], 9), round(combined_ci[1], 9)],
                "reduction": "max FRP across sensors per cell-day (shared fires counted once)",
            },
            "hfaiV2": {
                "pairedCellDays": int(paired_m.size),
                "modisMeanFrp": round(float(paired_m.mean()), 3) if paired_m.size else None,
                "viirsMeanFrp": round(float(paired_v.mean()), 3) if paired_v.size else None,
                "ratio": round(10 ** log_ratio, 3) if log_ratio is not None else None,
                "ratioCi95": ratio_ci,
                "log10Ratio": round(log_ratio, 4) if log_ratio is not None else None,
                "spearmanRho": (round(rho, 3) if (rho := _spearman(paired_m, paired_v))
                                is not None else None),
                "unit": "MW per paired cell-day",
            },
            "disagreement": {
                "modisOnlyCellDays": len(cd["onlyM"]),
                "viirsOnlyCellDays": len(cd["onlyV"]),
                "pairedCellDays": len(cd["both"]),
                "jaccardCells": round(jaccard, 3) if jaccard is not None else None,
                "coincidenceShare": round(len(cd["both"]) / max(1, union_values.size), 3),
                "interpretation": ("Cells are 1 km (MODIS) or 375 m (VIIRS) footprints aggregated to "
                                   "the chosen grid. Coincidence is not proof of the same fire, and "
                                   "absence from one sensor is not proof of no fire."),
            },
            "opportunity": {
                "modisDays": len(cd["daysM"]), "viirsDays": len(cd["daysV"]),
                "pairedDays": len(both_days),
                "adjusted": False,
                "note": ("Counts are not corrected for overpass or platform counts. The paired "
                         "cell-day restriction bounds the opportunity effect; it does not remove it."),
            },
        }

    main = results[geo.check_cell(cell)]
    return {
        "metricVersions": {
            "v1": "HFAI-v1 (revised): per-sensor active-area density, exact spherical cell area",
            "v2": "HFAI-v2: mean FRP over cell-days reported by both sensors",
        },
        "status": "experimental",
        "validationStatus": "not_independently_validated",
        "validationDetail": ("No reference product and no ground truth are available in this build. "
                             "Nothing here is calibrated against observed fire size, intensity or "
                             "burned area."),
        "selected": main,
        "gridSensitivity": [results[g] for g in sorted(results)] if sensitivity else [],
        "formula": {
            "v1": ("D_s = (Σ_{cell-days of s} max FRP) / (Σ_{cells of s} exact cell area) "
                   "/ delivery_days_s"),
            "v1Combined": ("D = (Σ_{union cell-days} max_s max FRP) / (Σ_{union cells} exact cell area) "
                           "/ days_with_both_products_delivered"),
            "v2": "R = 10 ^ mean(log10(FRP_modis_k) - log10(FRP_viirs_k)) over paired cell-days k",
            "v2Note": ("R is a ratio of reported FRP for the same cell-day, not a conversion factor. "
                       "It is specific to this AOI, window, grid and filter set."),
        },
        "assumptions": [
            "A cell-day maximum is a defensible proxy for peak reported intensity in that cell.",
            "Cells with a detection are 'active'; the denominator is active area, not the AOI area.",
            "Both products delivered on a day is the denominator for daily normalisation, not that "
            "the AOI was imaged cloud-free.",
            "Exact spherical cell area is the correct physical normaliser for an equal-angle grid.",
        ],
        "limitations": [
            "Footprint mismatch (1 km vs 375 m) is not corrected.",
            "Sensor-specific retrieval algorithms are not inter-calibrated.",
            "FRP saturates in very intense fires, biasing both sensors low.",
            "Density depends on grid size; compare only within one grid.",
            "Cloud, smoke and off-swath geometry can hide fire from either sensor.",
        ],
    }


# --------------------------------------------------------------------------- #
# Daily indicator (calendar)
# --------------------------------------------------------------------------- #
def daily(where: str, params: list[Any], cell: float = 0.25,
          target: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """Per-day comparable indicator, computed from the same cell-day reduction.

    Returns ``{date: {modis: {...}, viirs: {...}, combined: {...}}}``. Days with
    no reduction are absent, so the caller decides the coverage state rather
    than receiving an invented zero.
    """
    cell = geo.check_cell(cell)
    cd = cell_days(where, params, cell, target)

    # Group once: day -> sensor -> {(cy, cx): maxFrp}
    tables: dict[str, dict[str, dict[tuple[int, int], float]]] = {}
    for sensor, source in (("modis", cd["m"]), ("viirs", cd["v"])):
        for (cy, cx, day), value in source.items():
            tables.setdefault(day, {}).setdefault(sensor, {})[(cy, cx)] = value

    out: dict[str, dict[str, Any]] = {}
    for day, by_sensor in tables.items():
        modis_cells = by_sensor.get("modis", {})
        viirs_cells = by_sensor.get("viirs", {})
        entry: dict[str, Any] = {"date": day, "grid": cell}
        for sensor, cells in (("modis", modis_cells), ("viirs", viirs_cells)):
            values = np.asarray(list(cells.values()), dtype=float)
            area = sum(geo.cell_area_km2(cy, cell) for cy, _ in cells)
            total = float(values.sum()) if values.size else 0.0
            ci = (_boot_mean_ci(values, values.size / area) if area else None)
            entry[sensor] = {
                "cellDays": int(values.size),
                "activeCells": len(cells),
                "activeAreaKm2": round(area, 1),
                "frpSumMw": round(total, 2),
                "density": round(total / area, 9) if area else None,
                "densityCi95": None if not ci else [round(ci[0], 9), round(ci[1], 9)],
                "meanCellFrp": round(float(values.mean()), 3) if values.size else None,
            }
        union_cells = set(modis_cells) | set(viirs_cells)
        union_values = np.asarray(
            [max(modis_cells.get(k, 0.0), viirs_cells.get(k, 0.0)) for k in union_cells],
            dtype=float)
        combined_area = sum(geo.cell_area_km2(cy, cell) for cy, _ in union_cells)
        combined_total = float(union_values.sum()) if union_values.size else 0.0
        ci = (_boot_mean_ci(union_values, union_values.size / combined_area)
              if combined_area else None)
        entry["combined"] = {
            "activeCells": len(union_cells),
            "activeAreaKm2": round(combined_area, 1),
            "frpSumMw": round(combined_total, 2),
            "density": round(combined_total / combined_area, 9) if combined_area else None,
            "densityCi95": None if not ci else [round(ci[0], 9), round(ci[1], 9)],
            "reduction": "max FRP across sensors per cell",
        }
        out[day] = entry
    return out
