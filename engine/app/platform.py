"""Sensor- and platform-specific processing.

Nothing in this module combines MODIS and VIIRS. It produces one record per
(sensor, satellite) pair so the UI and the harmonization layer can always start
from what each instrument actually reported, and only then decide whether a
combination is defensible.

Observation opportunity is reported, never silently corrected: the keyless feeds
publish detections, not acquisition metadata, so the number of overpasses is a
*nominal* 2 per platform-day (one ascending, one descending). That number is
labelled ``nominal`` everywhere and is not used as a denominator for any
published metric.
"""
from __future__ import annotations

from typing import Any, Iterable

import numpy as np

from . import geo
from .db import session

SENSORS = ("modis", "viirs")
PLATFORM_RESOLUTION = {
    "Terra": ("MODIS", "1 km", 1.0),
    "Aqua": ("MODIS", "1 km", 1.0),
    "Suomi-NPP": ("VIIRS", "375 m", 0.140625),
    "NOAA-20": ("VIIRS", "375 m", 0.140625),
    "NOAA-21": ("VIIRS", "375 m", 0.140625),
}
# Nominal overpasses per platform per day. Not measured, not corrected for.
NOMINAL_OVERPASSES = 2


def _rows(sql: str, params: list[Any]) -> list[dict[str, Any]]:
    with session() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _frp_by_platform(where: str, params: list[Any]) -> dict[tuple[str, str], np.ndarray]:
    """One pass over the AOI for FRP, grouped in Python.

    Four separate scans (one per platform) cost 4x; a single scan whose rows are
    bucketed by platform is both faster and guarantees the four distributions
    come from exactly the same row set.
    """
    clause = f"{where} AND" if where.strip() else " WHERE"
    sql = f"SELECT sensor, satellite, frp FROM observations{clause} frp IS NOT NULL"
    buckets: dict[tuple[str, str], list[float]] = {}
    with session() as conn:
        for sensor, satellite, frp in conn.execute(sql, params):
            buckets.setdefault((sensor, satellite), []).append(float(frp))
    return {k: np.asarray(v, dtype=float) for k, v in buckets.items()}


def _stats(values: np.ndarray) -> dict[str, Any]:
    if values.size == 0:
        return {"count": 0, "sum": None, "mean": None, "median": None,
                "p10": None, "p90": None, "p99": None, "max": None}
    return {
        "count": int(values.size),
        "sum": round(float(values.sum()), 3),
        "mean": round(float(values.mean()), 3),
        "median": round(float(np.median(values)), 3),
        "p10": round(float(np.percentile(values, 10)), 3),
        "p90": round(float(np.percentile(values, 90)), 3),
        "p99": round(float(np.percentile(values, 99)), 3),
        "max": round(float(values.max()), 3),
    }


def platforms(where: str, params: list[Any], *, window: dict[str, Any] | None = None,
              cell: float = 0.25, delivery: dict[str, Any] | None = None) -> dict[str, Any]:
    """Per-platform statistics for one AOI/window/filter set.

    ``where``/``params`` must already encode the AOI and date range (see
    ``scientific._filters``); this module never builds its own filters so the
    caller cannot accidentally mix two different AOIs.
    """
    cell = geo.check_cell(cell)
    lat_expr, lon_expr, grid_params = geo.grid_sql(cell)

    counts = _rows(
        f"""SELECT sensor, satellite, COUNT(*) n,
                   SUM(CASE WHEN frp IS NOT NULL THEN 1 ELSE 0 END) n_frp,
                   MIN(acq_date) first_date, MAX(acq_date) last_date,
                   COUNT(DISTINCT acq_date) days,
                   SUM(CASE WHEN daynight = 'N' THEN 1 ELSE 0 END) nights,
                   SUM(CASE WHEN confidence_class = 'low' THEN 1 ELSE 0 END) c_low,
                   SUM(CASE WHEN confidence_class = 'nominal' THEN 1 ELSE 0 END) c_nom,
                   SUM(CASE WHEN confidence_class = 'high' THEN 1 ELSE 0 END) c_high
            FROM observations{where}
            GROUP BY sensor, satellite""", params)

    # One grouped query yields both the cell count and the cell-day count:
    # each row is one (sensor, platform, cell, day) with its detection count.
    grid_groups = _rows(
        f"""SELECT sensor, satellite, {lat_expr} cy, {lon_expr} cx, acq_date, COUNT(*) n
            FROM observations{where}
            GROUP BY sensor, satellite, cy, cx, acq_date""",
        grid_params + params)
    cell_sets: dict[tuple[str, str], set[tuple[int, int]]] = {}
    cell_day_counts: dict[tuple[str, str], int] = {}
    for r in grid_groups:
        key = (r["sensor"], r["satellite"])
        cell_sets.setdefault(key, set()).add((r["cy"], r["cx"]))
        cell_day_counts[key] = cell_day_counts.get(key, 0) + 1

    sensor_days = _rows(
        f"""SELECT sensor, COUNT(DISTINCT acq_date) days FROM observations{where}
            GROUP BY sensor""", params)

    versions = _rows(
        f"""SELECT sensor, satellite, version, COUNT(*) n FROM observations{where}
            GROUP BY sensor, satellite, version ORDER BY n DESC""", params)

    days_lookup = {r["sensor"]: int(r["days"]) for r in sensor_days}
    cell_lookup = {k: len(v) for k, v in cell_sets.items()}
    cell_day_lookup = cell_day_counts
    frp_lookup = _frp_by_platform(where, params)
    version_lookup: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for r in versions:
        version_lookup.setdefault((r["sensor"], r["satellite"]), []).append(
            {"version": r["version"], "records": r["n"]})

    deliver_days: dict[str, set[str]] = {"modis": set(), "viirs": set()}
    if delivery:
        for key in delivery:
            sensor, day = key.split(":", 1)
            deliver_days.setdefault(sensor, set()).add(day)

    out: list[dict[str, Any]] = []
    for row in counts:
        sensor, satellite = row["sensor"], row["satellite"]
        family, resolution, pixel = PLATFORM_RESOLUTION.get(
            satellite, (sensor.upper(), "unknown", None))
        frp = frp_lookup.get((sensor, satellite), np.asarray([], dtype=float))
        observed_days = int(row["days"] or 0)
        available = len(deliver_days.get(sensor, set())) or None
        out.append({
            "sensor": sensor,
            "satellite": satellite,
            "family": family,
            "instrument": "MODIS" if sensor == "modis" else "VIIRS 375 m",
            "resolution": resolution,
            "pixelAreaKm2": pixel,
            "detections": int(row["n"]),
            "detectionsWithFrp": int(row["n_frp"] or 0),
            "cells": cell_lookup.get((sensor, satellite), 0),
            "cellDays": cell_day_lookup.get((sensor, satellite), 0),
            "observedDays": observed_days,
            "sensorDeliveryDays": available,
            "dayCoveragePct": (round(100.0 * observed_days / available, 1)
                               if available else None),
            "firstDate": row["first_date"],
            "lastDate": row["last_date"],
            "nightDetections": int(row["nights"] or 0),
            "confidence": {
                "low": int(row["c_low"] or 0),
                "nominal": int(row["c_nom"] or 0),
                "high": int(row["c_high"] or 0),
                "native": "percentage 0-100" if sensor == "modis" else "categorical l/n/h",
            },
            "frp": _stats(frp),
            "versions": version_lookup.get((sensor, satellite), []),
            "opportunities": {
                "nominalOverpassesPerDay": NOMINAL_OVERPASSES,
                "observedDays": observed_days,
                "nominalOpportunities": observed_days * NOMINAL_OVERPASSES,
                "detectionsPerNominalOpportunity": (
                    round(int(row["n"]) / (observed_days * NOMINAL_OVERPASSES), 2)
                    if observed_days else None),
                "basis": "nominal (1 ascending + 1 descending per platform-day); acquisition "
                         "metadata is not published by the keyless feeds",
                "adjusted": False,
            },
            "missing": {
                "status": "complete_for_window" if available == observed_days and available
                else ("partial" if observed_days else "no_detections"),
                "note": None if available == observed_days and available else
                "this platform reported on fewer days than its product was delivered",
            },
        })
    out.sort(key=lambda p: (p["sensor"], -p["detections"]))

    sensors: dict[str, Any] = {}
    for sensor in SENSORS:
        rows = [p for p in out if p["sensor"] == sensor]
        if not rows:
            sensors[sensor] = {"platforms": 0, "detections": 0, "cells": 0, "cellDays": 0}
            continue
        sensors[sensor] = {
            "platforms": len(rows),
            "detections": sum(p["detections"] for p in rows),
            "cells": sum(p["cells"] for p in rows),
            "cellDays": sum(p["cellDays"] for p in rows),
            "observedDays": days_lookup.get(sensor, 0),
            "deliveryDays": len(deliver_days.get(sensor, set())) or None,
            "dayCoveragePct": (round(100.0 * days_lookup.get(sensor, 0)
                                     / len(deliver_days[sensor]), 1)
                               if deliver_days.get(sensor) else None),
            "confidence": {
                key: sum(p["confidence"][key] for p in rows)
                for key in ("low", "nominal", "high")
            },
            "resolution": rows[0]["resolution"],
            "pixelAreaKm2": rows[0]["pixelAreaKm2"],
        }

    return {
        "grid": cell,
        "gridDefinition": "equal-angle global grid, origin at -180/-90, floor-indexed",
        "cellAreaMethod": "exact spherical zone area R^2 dlon (sin lat2 - sin lat1)",
        "platforms": out,
        "sensors": sensors,
        "opportunityNote": ("Two nominal overpasses per platform-day are reported for context only. "
                            "Platform count is not a coverage multiplier: swath overlap, latitude and "
                            "scheduling all change the real number of looks, and none of that metadata "
                            "is available here."),
        "separationNote": "Platform statistics are never pooled before this point.",
    }
