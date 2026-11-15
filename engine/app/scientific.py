"""Scientific engine: aggregation, harmonization, baselines, anomalies.

Design principles
-----------------
1. Every number returned here is computed from stored detections. Nothing is
   synthesised.
2. Native sensor fields are never overwritten. Shared views (confidence class)
   are labelled as views.
3. Missing observations are never treated as zero activity: days without data
   are returned with ``available = False`` instead of a zero count.
4. The harmonized metric is explicitly *experimental*. It is a physically
   interpretable surface density (MW km⁻²), not a converted MODIS equivalent,
   and it is reported with a bootstrap interval.
"""
from __future__ import annotations

import math
from datetime import date as _date, datetime, timedelta, timezone
from typing import Any, Iterable

import numpy as np

from . import coverage as cov
from . import geo, harmonize
from .db import session
from .regions import bbox_area_km2

SENSORS = ("modis", "viirs")
PIXEL_AREA_KM2 = {"modis": 1.0, "viirs": 0.140625}  # 1 km and 375 m nominal footprints


# --------------------------------------------------------------------------- #
# Filtering
# --------------------------------------------------------------------------- #
def _filters(bbox: tuple[float, float, float, float] | None,
             start: str | None, end: str | None,
             sensors: Iterable[str] | None = None,
             satellites: Iterable[str] | None = None,
             confidence: Iterable[str] | None = None,
             min_frp: float | None = None,
             daynight: str | None = None,
             instrument: str | None = None) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if bbox:
        w, s, e, n = bbox
        if w <= e:
            clauses.append("lon >= ? AND lon <= ?")
            params += [w, e]
        else:  # antimeridian-crossing box
            clauses.append("(lon >= ? OR lon <= ?)")
            params += [w, e]
        clauses.append("lat >= ? AND lat <= ?")
        params += [s, n]
    if start:
        clauses.append("acq_date >= ?")
        params.append(start[:10])
    if end:
        clauses.append("acq_date <= ?")
        params.append(end[:10])
    sens = [s for s in (sensors or []) if s in SENSORS]
    if sens:
        clauses.append(f"sensor IN ({','.join('?' for _ in sens)})")
        params += sens
    sats = [s for s in (satellites or []) if s]
    if sats:
        clauses.append(f"satellite IN ({','.join('?' for _ in sats)})")
        params += sats
    conf = [c for c in (confidence or []) if c in ("low", "nominal", "high")]
    if conf:
        clauses.append(f"confidence_class IN ({','.join('?' for _ in conf)})")
        params += conf
    if min_frp is not None:
        clauses.append("frp >= ?")
        params.append(float(min_frp))
    if daynight in ("D", "N"):
        clauses.append("daynight = ?")
        params.append(daynight)
    if instrument:
        clauses.append("instrument LIKE ?")
        params.append(instrument)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def available_years() -> list[int]:
    """Years that actually contain stored detections (never inferred, never padded)."""
    rows = _rows("SELECT DISTINCT substr(acq_date, 1, 4) AS y FROM observations", [])
    return sorted({int(r["y"]) for r in rows if r["y"] and r["y"][:1].isdigit()})


def _rows(sql: str, params: list[Any]) -> list[dict[str, Any]]:
    with session() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _one(sql: str, params: list[Any]) -> dict[str, Any]:
    with session() as conn:
        row = conn.execute(sql, params).fetchone()
    return dict(row) if row else {}


# --------------------------------------------------------------------------- #
# Descriptive statistics
# --------------------------------------------------------------------------- #
_CACHE: dict[Any, tuple[float, Any]] = {}
_CACHE_TTL = 900.0


def _freeze(key: Any) -> Any:
    """Make a cache key hashable without changing what it distinguishes.

    Payload parameters often contain lists (sensor names, filter lists) and
    those are not hashable; freezing keeps the cache usable from any caller
    instead of silently raising on the first nested list.
    """
    if isinstance(key, dict):
        return tuple(sorted((k, _freeze(v)) for k, v in key.items()))
    if isinstance(key, (list, tuple, set)):
        return tuple(_freeze(v) for v in key)
    if isinstance(key, (str, int, float, bool)) or key is None:
        return key
    return repr(key)


def _cache_get(key: Any) -> Any | None:
    import time as _t
    key = _freeze(key)
    hit = _CACHE.get(key)
    if not hit:
        return None
    ts, value = hit
    if _t.time() - ts > _CACHE_TTL:
        _CACHE.pop(key, None)
        return None
    return value


def _cache_put(key: Any, value: Any) -> None:
    import time as _t
    _CACHE[_freeze(key)] = (_t.time(), value)
    if len(_CACHE) > 256:  # bounded: drop the oldest half rather than grow forever
        for old in sorted(_CACHE, key=lambda k: _CACHE[k][0])[:128]:
            _CACHE.pop(old, None)


def cache_clear() -> None:
    _CACHE.clear()


def pct(values: np.ndarray, q: float) -> float | None:
    if values.size == 0:
        return None
    return float(np.percentile(values, q))


def _frp_stats(frps: np.ndarray) -> dict[str, Any]:
    frps = frps[~np.isnan(frps)] if frps.size else frps
    if frps.size == 0:
        return {"count": 0, "sum": None, "mean": None, "median": None, "p90": None, "p99": None, "max": None}
    return {
        "count": int(frps.size),
        "sum": float(frps.sum()),
        "mean": float(frps.mean()),
        "median": float(np.median(frps)),
        "p90": pct(frps, 90),
        "p99": pct(frps, 99),
        "max": float(frps.max()),
    }


def coverage() -> dict[str, Any]:
    """Stored window + per-sensor delivery evidence (not detection presence).

    Cached: the delivery window is a property of the stored data, not of the
    request, and recomputing it took ~2 s on every calendar/summary call.
    Ingestion clears the cache, so it can never serve a stale window.
    """
    cache_key = ("coverage",)
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit
    cov.ensure()
    win = cov.window()
    rows = _rows(
        """SELECT sensor, COUNT(*) n, MIN(acq_date) first_day, MAX(acq_date) last_day,
                  COUNT(DISTINCT acq_date) days, MAX(ingested_at) ingested_at
           FROM observations GROUP BY sensor""", [])
    out: dict[str, Any] = {
        "sensors": {}, "days": [], "first": win["first"], "last": win["last"],
        "sensorDays": win["sensorDays"], "archiveEnabled": win["archiveEnabled"],
        "archiveNote": win["archiveNote"], "deliveryMethod": win["deliveryMethod"],
    }
    for r in rows:
        out["sensors"][r["sensor"]] = {
            "detections": r["n"], "firstDay": r["first_day"], "lastDay": r["last_day"],
            "days": r["days"], "ingestedAt": r["ingested_at"],
        }
    days = _rows("SELECT DISTINCT acq_date d FROM coverage_days ORDER BY d", [])
    out["days"] = [r["d"] for r in days]
    _cache_put(cache_key, out)
    return out


def summary(bbox: tuple[float, float, float, float],
            start: str | None, end: str | None,
            target: dict[str, Any] | None = None,
            **filters: Any) -> dict[str, Any]:
    """Aggregated in SQL, never by pulling every row into Python.

    The global window holds ~870k detections; materialising them as dicts costs
    tens of seconds and hundreds of MB, so counts, sums and class shares are
    computed by SQLite and only the FRP column is streamed for percentiles.
    """
    where, params = _filters(bbox, start, end, **filters)
    cache_key = (
        "summary", bbox, start, end,
        target.get("polygon") if target else None,
        tuple(sorted((k, str(v)) for k, v in filters.items())),
    )
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit

    if target and target.get("polygon"):
        exact = _aoi_rows(target, bbox, start, end, **filters) or []
        by_sensor: dict[str, Any] = {}
        for sensor in SENSORS:
            sensor_rows = [r for r in exact if r["sensor"] == sensor]
            conf = {"low": 0, "nominal": 0, "high": 0, "unclassified": 0}
            sats: dict[str, int] = {}
            for row in sensor_rows:
                sats[row["satellite"]] = sats.get(row["satellite"], 0) + 1
                key = row["confidence_class"] if row["confidence_class"] in conf else "unclassified"
                conf[key] += 1
            frps = np.asarray(
                [float(r["frp_raw"]) for r in sensor_rows if r["frp_raw"] is not None],
                dtype=float,
            )
            by_sensor[sensor] = {
                "detections": len(sensor_rows),
                "days": sorted({r["acq_date"] for r in sensor_rows}),
                "nights": sum(1 for r in sensor_rows if r["daynight"] == "N"),
                "dayDetections": sum(1 for r in sensor_rows if r["daynight"] == "D"),
                "frp": _frp_stats(frps),
                "satellites": sats,
                "confidence": conf,
            }
        out = {
            "bbox": list(bbox),
            "start": start,
            "end": end,
            "areaKm2": target["areaKm2"],
            "totalDetections": len(exact),
            "sensors": by_sensor,
            "frpSum": round(sum(v["frp"]["sum"] or 0 for v in by_sensor.values()), 2),
            "dataDays": sorted({r["acq_date"] for r in exact}),
            "aoi": target,
        }
        _cache_put(cache_key, out)
        return out

    # One scan for every categorical aggregate, then FRP streams for percentiles.
    groups = _rows(
        f"""SELECT sensor, satellite, acq_date, confidence_class, daynight,
                   COUNT(*) n, SUM(COALESCE(frp,0)) frp_sum
            FROM observations{where}
            GROUP BY sensor, satellite, acq_date, confidence_class, daynight""", params)

    by_sensor: dict[str, Any] = {}
    for sensor in SENSORS:
        rows = [r for r in groups if r["sensor"] == sensor]
        conf = {"low": 0, "nominal": 0, "high": 0, "unclassified": 0}
        sats: dict[str, int] = {}
        days: set[str] = set()
        det = day = night = 0
        for r in rows:
            det += r["n"]
            day += r["n"] if r["daynight"] == "D" else 0
            night += r["n"] if r["daynight"] == "N" else 0
            sats[r["satellite"]] = sats.get(r["satellite"], 0) + r["n"]
            days.add(r["acq_date"])
            key = r["confidence_class"] if r["confidence_class"] in conf else "unclassified"
            conf[key] += r["n"]
        frps = np.array([float(r[0]) for r in _iter_frp(where, params, sensor)], dtype=float)
        by_sensor[sensor] = {
            "detections": det,
            "days": sorted(days),
            "nights": night,
            "dayDetections": day,
            "frp": _frp_stats(frps),
            "satellites": sats,
            "confidence": conf,
        }

    area = target["areaKm2"] if target else bbox_area_km2(bbox)
    out = {
        "bbox": list(bbox),
        "start": start,
        "end": end,
        "areaKm2": area,
        "totalDetections": sum(v["detections"] for v in by_sensor.values()),
        "sensors": by_sensor,
        "frpSum": round(sum(v["frp"]["sum"] or 0 for v in by_sensor.values()), 2),
        "dataDays": sorted({r["acq_date"] for r in groups}),
        **({"aoi": target} if target else {}),
    }
    _cache_put(cache_key, out)
    return out


def _iter_frp(where: str, params: list[Any], sensor: str):
    with session() as conn:
        for row in conn.execute(
            f"SELECT frp FROM observations{where} AND sensor = ? AND frp IS NOT NULL"
            if where else f"SELECT frp FROM observations WHERE sensor = ? AND frp IS NOT NULL",
            params + [sensor] if where else [sensor],
        ):
            yield row


def timeseries(bbox: tuple[float, float, float, float],
               start: str | None, end: str | None,
               bucket: str = "day", **filters: Any) -> dict[str, Any]:
    cache_key = ("ts", bbox, start, end, bucket, tuple(sorted((k, str(v)) for k, v in filters.items())))
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit
    where, params = _filters(bbox, start, end, **filters)
    rows = _rows(
        f"""SELECT acq_date, sensor, COUNT(*) n, SUM(COALESCE(frp,0)) frp_sum, AVG(frp) frp_mean
            FROM observations{where} GROUP BY acq_date, sensor ORDER BY acq_date""", params)
    days = sorted({r["acq_date"] for r in rows})
    if days:
        d0 = datetime.strptime(days[0], "%Y-%m-%d").date()
        d1 = datetime.strptime(days[-1], "%Y-%m-%d").date()
        full = [(d0 + timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]
        # Fill interior gaps only; never extend beyond observed coverage.
        for d in full:
            if d not in days:
                days.append(d)
        days = sorted(days)
    lookup = {(r["acq_date"], r["sensor"]): r for r in rows}

    def bucket_key(d: str) -> str:
        dt = datetime.strptime(d, "%Y-%m-%d")
        if bucket == "week":
            return (dt - timedelta(days=dt.weekday())).strftime("%Y-%m-%d")
        if bucket == "month":
            return dt.strftime("%Y-%m")
        return d

    # Delivery evidence, so "no detections" and "no data" stay distinguishable in
    # the series too: a day without delivery is a gap, not a zero the chart can
    # draw (PHASE_1_AUDIT P1-3).
    cov.ensure()
    deliver = cov.delivery(days[0], days[-1]) if days else set()
    unavailable = cov.unavailable_dates(days[0], days[-1]) if days else set()

    buckets: dict[str, dict[str, Any]] = {}
    for d in days:
        k = bucket_key(d)
        b = buckets.setdefault(k, {"date": k, "modis": 0, "viirs": 0,
                                   "modisFrp": 0.0, "viirsFrp": 0.0,
                                   "available": False, "dataDays": [], "known": False})
        counts = {sensor: (lookup.get((d, sensor)) or {}).get("n", 0) for sensor in SENSORS}
        states = cov.day_states(d, deliver, counts, unavailable)
        if any(v["state"] not in ("unknown", "unavailable") for v in states.values()):
            b["known"] = True
        for sensor in SENSORS:
            r = lookup.get((d, sensor))
            if r:
                b[sensor] += r["n"]
                b[f"{sensor}Frp"] += float(r["frp_sum"] or 0)
                b["available"] = True
                b["dataDays"].append(d)
    series = []
    for k in sorted(buckets):
        b = buckets[k]
        known = b["known"] or b["available"]
        series.append({
            "date": b["date"],
            "modis": b["modis"] if known else None,
            "viirs": b["viirs"] if known else None,
            "modisFrp": round(b["modisFrp"], 2) if known else None,
            "viirsFrp": round(b["viirsFrp"], 2) if known else None,
            "total": (b["modis"] + b["viirs"]) if known else None,
            "available": b["available"],
            "state": "observed" if b["available"] else ("observed_zero" if known else "unknown"),
            "dataDays": len(set(b["dataDays"])),
        })
    out = {"bucket": bucket, "series": series, "days": days}
    _cache_put(cache_key, out)
    return out


PERIODS = ("day", "week", "month", "season")

SEASON_OF = {12: "DJF", 1: "DJF", 2: "DJF", 3: "MAM", 4: "MAM", 5: "MAM",
             6: "JJA", 7: "JJA", 8: "JJA", 9: "SON", 10: "SON", 11: "SON"}


def _bucket(d: _date, period: str) -> tuple[str, str, str, str]:
    """(key, label, start, end) for one calendar bucket."""
    if period == "week":
        iso = d.isocalendar()
        monday = d - timedelta(days=d.weekday())
        return (f"{iso.year}-W{iso.week:02d}", f"Week {iso.week}",
                monday.isoformat(), (monday + timedelta(days=6)).isoformat())
    if period == "month":
        first = d.replace(day=1)
        nxt = (first + timedelta(days=32)).replace(day=1)
        return (f"{d.year}-{d.month:02d}", d.strftime("%B"), first.isoformat(),
                (nxt - timedelta(days=1)).isoformat())
    if period == "season":
        tag = SEASON_OF[d.month]
        return (f"{d.year if d.month != 12 else d.year + 1}-{tag}", tag, d.isoformat(), d.isoformat())
    return (d.isoformat(), d.strftime("%d %b"), d.isoformat(), d.isoformat())


def _aoi_rows(target: dict[str, Any] | None, bbox, start: str | None, end: str | None,
              **filters: Any) -> list[dict[str, Any]] | None:
    """Exact AOI-filtered detection rows, or ``None`` when SQL is sufficient.

    A polygon is tested per detection. It is never replaced by its bounding box,
    because that would silently include area the user did not select.
    """
    if not target or not target.get("polygon"):
        return None
    where, params = _filters(bbox, start, end, **filters)
    rows = _rows(
        f"""SELECT id, lat, lon, ts, acq_date, acq_time, sensor, instrument, satellite,
                   frp, frp frp_raw, confidence_pct, brightness, bright_t31,
                   scan, track, confidence_raw, confidence_class, daynight, version, source
            FROM observations{where}""", params)
    return [r for r in rows if geo.contains(target, r["lon"], r["lat"])]


def monthly_history(bbox: tuple[float, float, float, float],
                            start_year: int, end_year: int,
                            target: dict[str, Any] | None = None,
                            **filters: Any) -> dict[str, Any]:
            """Return a year-by-month sensor matrix without treating missing data as zero."""
            current_year = datetime.now(timezone.utc).year
            if start_year < 2000 or end_year > current_year or start_year > end_year:
                raise ValueError(f"years must be an ordered range from 2000 through {current_year}")
            if end_year - start_year > 119:
                raise ValueError("the requested history range cannot exceed 120 years")

            start, end = f"{start_year}-01-01", f"{end_year}-12-31"
            where, params = _filters(bbox, start, end, **filters)
            exact = _aoi_rows(target, bbox, start, end, **filters)
            if exact is None:
                rows = _rows(
                    f"""SELECT substr(acq_date, 1, 7) month, sensor, COUNT(*) detections,
                               SUM(COALESCE(frp, 0)) frp_sum, COUNT(DISTINCT acq_date) observed_days
                        FROM observations{where}
                        GROUP BY month, sensor""", params)
            else:
                grouped: dict[tuple[str, str], dict[str, Any]] = {}
                days: dict[tuple[str, str], set[str]] = {}
                for row in exact:
                    month = row["acq_date"][:7]
                    key = (month, row["sensor"])
                    item = grouped.setdefault(key, {
                        "month": month, "sensor": row["sensor"], "detections": 0,
                        "frp_sum": 0.0, "observed_days": 0,
                    })
                    item["detections"] += 1
                    item["frp_sum"] += float(row["frp"] or 0)
                    days.setdefault(key, set()).add(row["acq_date"])
                rows = list(grouped.values())
                for row in rows:
                    row["observed_days"] = len(days[(row["month"], row["sensor"])])

            values = {(r["month"], r["sensor"]): r for r in rows}
            reduced = harmonize.cell_days(where, params, 0.25, target)
            cell_day_counts: dict[str, dict[str, int]] = {"modis": {}, "viirs": {}}
            for sensor, source in (("modis", reduced["m"]), ("viirs", reduced["v"])):
                for _, _, day in source:
                    month = day[:7]
                    cell_day_counts[sensor][month] = cell_day_counts[sensor].get(month, 0) + 1
            delivery = cov.delivery(start, end)
            delivery_by_month: dict[tuple[str, str], set[str]] = {}
            for key in delivery:
                sensor, day = key.split(":", 1)
                if sensor in SENSORS:
                    delivery_by_month.setdefault((day[:7], sensor), set()).add(day)
            unavailable = cov.unavailable_dates(start, end)
            footprint_gaps = cov.footprint_gap(bbox)
            known_months = {
                (month, sensor)
                for (month, sensor), item in values.items()
                if item["detections"] > 0
            }
            if not footprint_gaps:
                known_months.update(delivery_by_month)
            calibration_pairs = []
            for (month, modis_days) in cell_day_counts["modis"].items():
                viirs_days = cell_day_counts["viirs"].get(month, 0)
                if (
                    modis_days > 0
                    and viirs_days > 0
                    and (month, "modis") in known_months
                    and (month, "viirs") in known_months
                ):
                    calibration_pairs.append({
                        "month": month,
                        "year": int(month[:4]),
                        "modis": modis_days,
                        "viirs": viirs_days,
                    })

            pair_years = sorted({pair["year"] for pair in calibration_pairs})
            holdout_count = max(1, int(math.ceil(len(pair_years) * 0.2))) if pair_years else 0
            holdout_years = set(pair_years[-holdout_count:]) if holdout_count else set()
            training_pairs = [pair for pair in calibration_pairs if pair["year"] not in holdout_years]
            holdout_pairs = [pair for pair in calibration_pairs if pair["year"] in holdout_years]
            calibration: dict[str, Any] = {
                "available": False,
                "status": "insufficient_overlapping_history",
                "validationStatus": "not_available",
                "referenceSensor": "MODIS",
                "metric": "0.25-degree occupied cell-days per month",
                "factor": None,
                "candidateFactor": None,
                "trainingYears": sorted({pair["year"] for pair in training_pairs}),
                "holdoutYears": sorted(holdout_years),
                "trainingMonths": len(training_pairs),
                "holdoutMonths": len(holdout_pairs),
                "validation": None,
                "reason": (
                    "Calibration requires at least 12 paired positive-activity months across "
                    "3 training years and 3 later holdout months. No fixed conversion factor is assumed."
                ),
            }
            if (
                len(calibration["trainingYears"]) >= 3
                and len(training_pairs) >= 12
                and len(holdout_pairs) >= 3
            ):
                ratios = np.asarray(
                    [pair["modis"] / pair["viirs"] for pair in training_pairs],
                    dtype=float,
                )
                factor = round(float(np.median(ratios)), 9)
                observed = np.asarray([pair["modis"] for pair in holdout_pairs], dtype=float)
                viirs = np.asarray([pair["viirs"] for pair in holdout_pairs], dtype=float)
                calibrated = factor * viirs
                raw_mae = float(np.mean(np.abs(viirs - observed)))
                calibrated_mae = float(np.mean(np.abs(calibrated - observed)))
                mape = float(np.mean(np.abs(calibrated - observed) / observed) * 100)
                bias = float((calibrated.sum() / observed.sum() - 1) * 100)
                improved = calibrated_mae < raw_mae
                calibration.update({
                    "available": improved,
                    "status": "out_of_sample_improved" if improved else "not_improved_on_holdout",
                    "validationStatus": "temporal_holdout_only",
                    "factor": round(factor, 9) if improved else None,
                    "candidateFactor": factor,
                    "validation": {
                        "months": len(holdout_pairs),
                        "meanAbsoluteError": round(calibrated_mae, 3),
                        "rawMeanAbsoluteError": round(raw_mae, 3),
                        "meanAbsolutePercentError": round(mape, 3),
                        "relativeBiasPercent": round(bias, 3),
                        "improvedOverUnadjustedVIIRS": improved,
                    },
                    "reason": (
                        "A region-, grid-, and date-range-specific median ratio improved the held-out "
                        "MODIS occupied-cell-day error. This is temporal internal validation, not "
                        "external fire-perimeter ground-truth validation."
                        if improved else
                        "The estimated factor did not improve held-out error over unadjusted VIIRS; "
                        "no calibrated substitution is exposed."
                    ),
                })

            months: list[dict[str, Any]] = []
            for year in range(start_year, end_year + 1):
                for month in range(1, 13):
                    key = f"{year:04d}-{month:02d}"
                    sensors: dict[str, dict[str, Any]] = {}
                    states: dict[str, dict[str, Any]] = {}
                    for sensor in SENSORS:
                        row = values.get((key, sensor))
                        delivered_days = delivery_by_month.get((key, sensor), set())
                        if row and row["detections"]:
                            state = "observed"
                        elif delivered_days and not footprint_gaps:
                            state = "observed_zero"
                        else:
                            state = "unknown"
                        states[sensor] = {
                            "state": state,
                            "deliveryDays": len(delivered_days),
                            "unavailableDays": sum(
                                1 for day in unavailable.get(sensor, set())
                                if day.startswith(key)
                            ),
                            "basis": (
                                "detection records in the selected AOI and filter set"
                                if state == "observed" else
                                "global product delivery; this does not prove the AOI was imaged cloud-free"
                                if state == "observed_zero" else
                                "no AOI detections or product-delivery evidence"
                            ),
                        }
                        sensors[sensor] = {
                            "state": state,
                            "detections": (
                                int(row["detections"]) if row else
                                0 if state == "observed_zero" else None
                            ),
                            "frpSumMw": (
                                round(float(row["frp_sum"] or 0), 3) if row else
                                0.0 if state == "observed_zero" else None
                            ),
                            "observedDays": int(row["observed_days"]) if row else 0,
                            "deliveryDays": len(delivered_days),
                            "unavailableDays": states[sensor]["unavailableDays"],
                            "basis": states[sensor]["basis"],
                        }
                    if footprint_gaps:
                        cov.apply_footprint(states, bbox)
                        for sensor in SENSORS:
                            if states[sensor]["state"] == "unknown":
                                sensors[sensor]["state"] = "unknown"
                                sensors[sensor]["detections"] = None
                                sensors[sensor]["frpSumMw"] = None
                                sensors[sensor]["basis"] = states[sensor]["basis"]

                    months.append({
                        "year": year,
                        "month": month,
                        "key": key,
                        "label": datetime(year, month, 1).strftime("%b"),
                        "state": cov.combine_states({s: states[s]["state"] for s in SENSORS}),
                        "sensors": sensors,
                        "anomaly": {},
                    })

            for item in months:
                modis_state = item["sensors"]["modis"]["state"]
                viirs_state = item["sensors"]["viirs"]["state"]
                if modis_state in ("observed", "observed_zero"):
                    harmonized_value = cell_day_counts["modis"].get(item["key"], 0)
                    harmonized_source = "MODIS reference"
                    estimated = False
                elif viirs_state in ("observed", "observed_zero") and calibration["available"]:
                    harmonized_value = (
                        cell_day_counts["viirs"].get(item["key"], 0) * calibration["factor"]
                    )
                    harmonized_source = "calibrated VIIRS substitution"
                    estimated = True
                else:
                    harmonized_value = None
                    harmonized_source = None
                    estimated = False
                item["harmonizedActivity"] = {
                    "cellDays": (
                        round(float(harmonized_value), 3)
                        if harmonized_value is not None else None
                    ),
                    "source": harmonized_source,
                    "estimated": estimated,
                    "unit": "occupied 0.25-degree cell-days",
                }

                for sensor in SENSORS:
                    sensor_cell = item["sensors"][sensor]
                    sample = [
                        prior["sensors"][sensor]["detections"]
                        for prior in months
                        if prior["month"] == item["month"]
                        and prior["year"] != item["year"]
                        and prior["sensors"][sensor]["state"] in ("observed", "observed_zero")
                    ]
                    sample_years = [
                        prior["year"] for prior in months
                        if prior["month"] == item["month"]
                        and prior["year"] != item["year"]
                        and prior["sensors"][sensor]["state"] in ("observed", "observed_zero")
                    ]
                    anomaly: dict[str, Any] = {
                        "available": len(set(sample_years)) >= 3,
                        "sampleYears": sorted(set(sample_years)),
                        "sampleCount": len(sample),
                        "median": None,
                        "mean": None,
                        "mad": None,
                        "robustSigma": None,
                        "robustZ": None,
                        "deviationPercent": None,
                        "classification": "insufficient_history",
                    }
                    current = sensor_cell["detections"]
                    if anomaly["available"] and current is not None:
                        baseline_values = np.asarray(sample, dtype=float)
                        median = float(np.median(baseline_values))
                        mean = float(np.mean(baseline_values))
                        mad = float(np.median(np.abs(baseline_values - median)))
                        sigma = 1.4826 * mad
                        robust_z = (float(current) - median) / sigma if sigma else None
                        anomaly.update({
                            "median": round(median, 3),
                            "mean": round(mean, 3),
                            "mad": round(mad, 3),
                            "robustSigma": round(sigma, 3),
                            "robustZ": round(robust_z, 3) if robust_z is not None else None,
                            "deviationPercent": (
                                round((float(current) / median - 1) * 100, 2) if median else None
                            ),
                            "classification": (
                                "no_baseline_spread" if sigma == 0 else
                                "unusual" if abs(robust_z) >= 3 else
                                "above_or_below" if abs(robust_z) >= 2 else "near_baseline"
                            ),
                        })
                    item["anomaly"][sensor] = anomaly

            for item in months:
                sample = [
                    prior["harmonizedActivity"]["cellDays"]
                    for prior in months
                    if prior["month"] == item["month"]
                    and prior["year"] != item["year"]
                    and prior["harmonizedActivity"]["cellDays"] is not None
                ]
                sample_years = [
                    prior["year"] for prior in months
                    if prior["month"] == item["month"]
                    and prior["year"] != item["year"]
                    and prior["harmonizedActivity"]["cellDays"] is not None
                ]
                current = item["harmonizedActivity"]["cellDays"]
                available = len(set(sample_years)) >= 3 and current is not None
                anomaly: dict[str, Any] = {
                    "available": available,
                    "sampleYears": sorted(set(sample_years)),
                    "sampleCount": len(sample),
                    "median": None,
                    "mean": None,
                    "mad": None,
                    "robustSigma": None,
                    "robustZ": None,
                    "deviationPercent": None,
                    "classification": "insufficient_history",
                }
                if available:
                    baseline_values = np.asarray(sample, dtype=float)
                    median = float(np.median(baseline_values))
                    mean = float(np.mean(baseline_values))
                    mad = float(np.median(np.abs(baseline_values - median)))
                    sigma = 1.4826 * mad
                    robust_z = (float(current) - median) / sigma if sigma else None
                    anomaly.update({
                        "median": round(median, 3),
                        "mean": round(mean, 3),
                        "mad": round(mad, 3),
                        "robustSigma": round(sigma, 3),
                        "robustZ": round(robust_z, 3) if robust_z is not None else None,
                        "deviationPercent": (
                            round((float(current) / median - 1) * 100, 2) if median else None
                        ),
                        "classification": (
                            "no_baseline_spread" if sigma == 0 else
                            "unusual" if abs(robust_z) >= 3 else
                            "above_or_below" if abs(robust_z) >= 2 else "near_baseline"
                        ),
                    })
                item["harmonizedAnomaly"] = anomaly

            cov.ensure()
            window = cov.window()
            observed_years = sorted({
                int(row["month"][:4]) for row in rows
                if row.get("detections", 0) > 0
            })
            return {
                "startYear": start_year,
                "endYear": end_year,
                "bbox": list(bbox),
                "months": months,
                "observedYears": observed_years,
                "coverage": window,
                "harmonizedActivity": calibration,
                "method": (
                    "Monthly raw detection-record counts and FRP sums are reported by sensor. The "
                    "experimental common-scale series is MODIS-reference occupied 0.25-degree "
                    "cell-days; calibrated VIIRS is used only when MODIS has no coverage. Its factor "
                    "is learned from positive paired months and tested on later years. Anomalies use "
                    "same-month values from at least three other years. Zero coverage is conditional "
                    "on global product delivery and does not prove cloud-free AOI coverage."
                ),
            }


def calendar(bbox: tuple[float, float, float, float], year: int,
             period: str = "day", target: dict[str, Any] | None = None,
             grid: float = 0.25, **filters: Any) -> dict[str, Any]:
    """Burning-activity calendar with explicit coverage states.

    v1 marked a day available if any detection existed, which silently turned
    missing coverage into zero activity. v2 resolves three states per sensor
    (observed / observed_zero / unknown) from product-delivery evidence and only
    verified-zero days count as zero.
    """
    period = period if period in PERIODS else "day"
    start, end = f"{year}-01-01", f"{year}-12-31"
    cov.ensure()
    window = cov.window()
    deliver = cov.delivery(start, end)
    unavailable = cov.unavailable_dates(start, end)

    where, params = _filters(bbox, start, end, **filters)
    exact = _aoi_rows(target, bbox, start, end, **filters)
    if exact is not None:
        grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
        for r in exact:
            key = (r["acq_date"], r["sensor"], r["satellite"])
            cell = grouped.setdefault(key, {"acq_date": key[0], "sensor": key[1],
                                            "satellite": key[2], "n": 0, "frp": 0.0})
            cell["n"] += 1
            cell["frp"] += float(r["frp"] or 0)
        rows = list(grouped.values())
    else:
        rows = _rows(
            f"""SELECT acq_date, sensor, satellite, COUNT(*) n, SUM(COALESCE(frp,0)) frp
                FROM observations{where} GROUP BY acq_date, sensor, satellite""", params)

    # Derived daily indicator (experimental, cell-based). Computed only for days
    # that actually have a reduction, so no day is given an invented value.
    derived = harmonize.daily(where, params, geo.check_cell(grid), target)

    lookup: dict[str, dict[str, Any]] = {}
    for r in rows:
        cell = lookup.setdefault(r["acq_date"], {
            "modis": 0, "viirs": 0, "modisFrp": 0.0, "viirsFrp": 0.0,
            "satellites": {"modis": {}, "viirs": {}},
        })
        cell[r["sensor"]] += r["n"]
        cell[f"{r['sensor']}Frp"] += float(r["frp"] or 0)
        cell["satellites"][r["sensor"]][r["satellite"]] = r["n"]

    days: list[dict[str, Any]] = []
    d = _date(year, 1, 1)
    while d.year == year:
        key = d.isoformat()
        counts = lookup.get(key)
        states = cov.day_states(key, deliver, {
            "modis": (counts or {}).get("modis", 0),
            "viirs": (counts or {}).get("viirs", 0),
        }, unavailable)
        # A zero outside the product's spatial footprint is not a confirmed zero.
        footprint_gaps = cov.apply_footprint(states, bbox)
        state = cov.combine_states({k: v["state"] for k, v in states.items()})
        for sensor, payload in states.items():
            sensor_known = (payload["state"] in ("observed", "observed_zero", "partial")
                            or (counts or {}).get(sensor, 0) > 0)
            payload["frp"] = round((counts or {}).get(f"{sensor}Frp", 0.0), 2) if sensor_known else None
            payload["satellites"] = (counts or {}).get("satellites", {}).get(sensor, {})
            payload["stateLabel"] = cov.STATE_LABELS[payload["state"]]
            if not sensor_known and "count" in payload:
                payload["count"] = None
        # A day without delivery evidence carries NO numbers. Returning 0 for
        # counts and 0.0 for FRP made "we have no data" indistinguishable from
        # "we observed the area and saw nothing" to any client that summed or
        # charted the field (PHASE_1_AUDIT P1-3). state/stateCode carry the
        # distinction; the numeric fields carry null.
        # Numbers are published when they exist. A day can lack delivery evidence
        # and still have detections in the archive (e.g. coverage rows rebuilt
        # separately); hiding real observations would be worse than the caveat
        # the unknown state already carries.
        known = state in ("observed", "observed_zero", "partial") or counts is not None
        days.append({
            "date": key,
            "doy": d.timetuple().tm_yday,
            "state": state,
            "stateCode": cov.state_code(state),
            "available": known,
            "modis": (counts or {}).get("modis", 0) if known else None,
            "viirs": (counts or {}).get("viirs", 0) if known else None,
            "modisFrp": round((counts or {}).get("modisFrp", 0.0), 2) if known else None,
            "viirsFrp": round((counts or {}).get("viirsFrp", 0.0), 2) if known else None,
            "total": ((counts or {}).get("modis", 0) + (counts or {}).get("viirs", 0)) if known else None,
            "sensors": states,
            "derived": derived.get(key),
        })
        d += timedelta(days=1)

    observed = [x for x in days if x["state"] == "observed"]
    zero = [x for x in days if x["state"] == "observed_zero"]
    partial = [x for x in days if x["state"] == "partial"]
    unavailable_days = [x for x in days if x["state"] == "unavailable"]
    unknown = [x for x in days if x["state"] in ("unknown", "unavailable")]

    buckets: dict[str, dict[str, Any]] = {}
    for x in days:
        key, label, bstart, bend = _bucket(_date.fromisoformat(x["date"]), period)
        b = buckets.setdefault(key, {
            "key": key, "label": label, "start": bstart, "end": bend,
            "modis": 0, "viirs": 0, "total": 0, "modisFrp": 0.0, "viirsFrp": 0.0,
            "observedDays": 0, "zeroDays": 0, "unknownDays": 0, "unavailableDays": 0,
        })
        if period == "season":
            b["start"] = min(b["start"], x["date"])
            b["end"] = max(b["end"], x["date"])
        if x["total"] is not None:
            b["modis"] += x["modis"]
            b["viirs"] += x["viirs"]
            b["total"] += x["total"]
            b["modisFrp"] += x["modisFrp"]
            b["viirsFrp"] += x["viirsFrp"]
        if x["state"] in ("observed", "observed_zero"):
            b["observedDays"] += 1
        if x["state"] == "observed_zero":
            b["zeroDays"] += 1
        if x["state"] == "unknown":
            b["unknownDays"] += 1
        if x["state"] == "unavailable":
            b["unavailableDays"] += 1
    for b in buckets.values():
        b["modisFrp"] = round(b["modisFrp"], 2)
        b["viirsFrp"] = round(b["viirsFrp"], 2)
        # A bucket whose days were all unknown has no total, not a zero total.
        # A partly-observed bucket keeps its (real) observed sum and says so.
        b["lowerBound"] = bool(b["observedDays"] or b["zeroDays"]) and bool(
            b["unknownDays"] or b["unavailableDays"])
        if b["observedDays"] + b["unavailableDays"] + b["unknownDays"] == 0:
            b.update(modis=None, viirs=None, total=None, modisFrp=None, viirsFrp=None)
        elif not b["observedDays"] and not b["zeroDays"] and (b["unknownDays"] or b["unavailableDays"]):
            b.update(modis=None, viirs=None, total=None, modisFrp=None, viirsFrp=None)
        if b["total"]:
            b["state"] = "observed"
        elif b["observedDays"] and not b["unknownDays"]:
            b["state"] = "observed_zero"
        elif b["observedDays"]:
            b["state"] = "partial"
        elif b["unavailableDays"]:
            b["state"] = "unavailable"
        else:
            b["state"] = "unknown"

    # Baseline uses observed days only; unknown days never enter the sample.
    totals = np.array([x["total"] for x in observed + zero], dtype=float)
    baseline: dict[str, Any] = {
        "available": False,
        "method": "robust median/MAD over observed days; unknown days excluded",
        "sampleDays": int(totals.size),
        "reason": "Fewer than seven observed days; a deviation would be unstable.",
    }
    if totals.size >= 7:
        med = float(np.median(totals))
        mad = float(np.median(np.abs(totals - med)))
        sigma = 1.4826 * mad
        baseline.update({
            "available": True, "median": med, "mad": mad, "robustSigma": sigma,
            "p90": pct(totals, 90), "max": float(totals.max()), "min": float(totals.min()),
            "sampleDays": int(totals.size),
            "note": ("Baseline covers the stored window only; treat deviations as indicative, "
                     "not climatological."),
        })
    for x in days:
        if baseline["available"] and x["state"] == "observed":
            x["baseline"] = {
                "median": baseline["median"],
                "ratio": round(x["total"] / baseline["median"], 2) if baseline["median"] else None,
                "robustZ": (round((x["total"] - baseline["median"]) / baseline["robustSigma"], 2)
                            if baseline["robustSigma"] else None),
            }
        else:
            x["baseline"] = None

    unknown_reason = None
    if unknown:
        reasons = {cov.unknown_reason(unknown[0]["date"], window),
                   cov.unknown_reason(unknown[-1]["date"], window)}
        unknown_reason = reasons.pop() if len(reasons) == 1 else "outside_window"

    return {
        "year": year,
        "period": period,
        "bbox": list(bbox),
        "coverage": window,
        "days": days,
        "buckets": [b for b in buckets.values() if b["observedDays"] or b["unknownDays"] < 366],
        "availableDays": len(observed) + len(zero),
        "summary": {
            "observedDays": len(observed),
            "zeroDays": len(zero),
            "partialDays": len(partial),
            "unknownDays": len(unknown),
            "unavailableDays": len(unavailable_days),
            "derivedDays": sum(1 for x in days if x.get("derived")),
            "grid": grid,
            "derivedUnit": "MW km^-2 day^-1 (experimental)",
            "totalDetections": int(sum(x["total"] or 0 for x in days)),
            "unknownReason": unknown_reason,
            "footprintNote": (
                f"The AOI extends {' and '.join(footprint_gaps)}; outside {cov.FOOTPRINT_LABEL} "
                "a day without detections is UNKNOWN, not a confirmed zero."
            ) if footprint_gaps else None,
            "note": ("Unknown coverage is not zero activity. Only days with verified product delivery "
                     "can be interpreted as zero detections; a zero is conditional on global delivery, "
                     "not proof the area was imaged cloud-free."),
        },
        "stateLegend": cov.STATE_CODES,
        "aoi": target or {"kind": "bbox", "bbox": list(bbox)},
        "grid": grid,
        "derivedNote": ("Derived density is the day's maximum reported FRP per active cell, divided by "
                        "the exact spherical area of those active cells. It is experimental, grid "
                        "dependent, and absent on days without a reduction."),
        "baseline": baseline,
        "note": None if (observed or zero) else
                "No stored observations cover this year for the selected area.",
    }


def day_detail(bbox: tuple[float, float, float, float], date_str: str,
               region_name: str = "Selected area",
               target: dict[str, Any] | None = None, **filters: Any) -> dict[str, Any]:
    """Everything needed to explain one calendar cell."""
    cov.ensure()
    window = cov.window()
    deliver = cov.delivery(date_str, date_str)
    unavailable = cov.unavailable_dates(date_str, date_str)
    where, params = _filters(bbox, date_str, date_str, **filters)
    exact = _aoi_rows(target, bbox, date_str, date_str, **filters)
    if exact is not None:
        grouped: dict[tuple, dict[str, Any]] = {}
        for r in exact:
            key = (r["sensor"], r["satellite"], r["confidence_class"], r["daynight"])
            cell = grouped.setdefault(key, {"sensor": key[0], "satellite": key[1],
                                            "confidence_class": key[2], "daynight": key[3],
                                            "n": 0, "frp": 0.0})
            cell["n"] += 1
            cell["frp"] += float(r["frp"] or 0)
        rows = list(grouped.values())
    else:
        rows = _rows(
            f"""SELECT sensor, satellite, confidence_class, daynight, COUNT(*) n,
                       SUM(COALESCE(frp,0)) frp
                FROM observations{where} GROUP BY sensor, satellite, confidence_class, daynight""",
            params)
    counts = {"modis": 0, "viirs": 0}
    sensors: dict[str, Any] = {s: {"detections": 0, "frp": 0.0, "satellites": {}} for s in SENSORS}
    confidence: dict[str, dict[str, int]] = {s: {"low": 0, "nominal": 0, "high": 0, "unclassified": 0}
                                             for s in SENSORS}
    for r in rows:
        s = r["sensor"] if r["sensor"] in SENSORS else None
        if not s:
            continue
        counts[s] += r["n"]
        sensors[s]["detections"] += r["n"]
        sensors[s]["frp"] += float(r["frp"] or 0)
        sensors[s]["satellites"][r["satellite"]] = sensors[s]["satellites"].get(r["satellite"], 0) + r["n"]
        cls = r["confidence_class"] if r["confidence_class"] in confidence[s] else "unclassified"
        confidence[s][cls] += r["n"]

    states = cov.day_states(date_str, deliver, counts, unavailable)
    cov.apply_footprint(states, bbox)
    for s, payload in states.items():
        known = payload["state"] in ("observed", "observed_zero", "partial")
        payload.update(sensors[s])
        if not known:
            # `count` and `detections` both carry "how many": neither may read 0
            # for a day that was never observed.
            payload.update(detections=None, frp=None, satellites={}, count=None)
        else:
            payload["frp"] = round(payload.get("frp", 0.0), 2)
    state = cov.combine_states({k: v["state"] for k, v in states.items()})

    if exact is not None:
        obs_rows = sorted(exact, key=lambda r: -(r["frp"] or 0))[:25]
    else:
        obs_rows = _rows(
            f"""SELECT id, sensor, satellite, lat, lon, acq_date, acq_time, frp, brightness,
                       confidence_raw, confidence_class, daynight, version, source
                FROM observations{where}
                ORDER BY COALESCE(frp,0) DESC LIMIT 25""", params)
    observations = []
    for r in obs_rows:
        hour = str(r["acq_time"] or "0000").zfill(4)
        observations.append({
            "id": r["id"], "sensor": r["sensor"], "satellite": r["satellite"],
            "lat": r["lat"], "lon": r["lon"],
            "time": f"{r['acq_date']}T{hour[:2]}:{hour[2:]}:00Z",
            "frp": r["frp"], "brightness": r["brightness"],
            "confidence": r["confidence_class"], "confidenceRaw": r["confidence_raw"],
            "daynight": r["daynight"], "version": r["version"], "source": r["source"],
        })

    frp_series = {s: np.array([x["frp"] for x in observations if x["sensor"] == s and x["frp"] is not None])
                  for s in SENSORS}
    derived = harmonize.daily(where, params, 0.25, target).get(date_str)
    return {
        "date": date_str,
        "state": state,
        "stateLabel": cov.STATE_LABELS[state],
        "region": region_name,
        "bbox": list(bbox),
        "sensors": states,
        "confidence": confidence,
        "frp": {s: _frp_stats(frp_series[s]) for s in SENSORS},
        "observations": observations,
        "derived": derived,
        "coverage": window,
        "provenance": {
            "sources": sorted({x["source"] for x in observations}),
            "versions": sorted({x["version"] for x in observations if x["version"]}),
            "delivery": {s: deliver.get(f"{s}:{date_str}") for s in SENSORS},
        },
        "method": (
            "Counts and FRP statistics are computed from stored detections inside the selected area on "
            "this date. The state uses global product-delivery evidence per sensor-day; a verified zero "
            "means no detection was reported, not that no fire burned (cloud, smoke and saturation can "
            "mask fires)."
        ),
    }


# --------------------------------------------------------------------------- #
# Spatial aggregation for the map
# --------------------------------------------------------------------------- #
def cells(bbox: tuple[float, float, float, float],
          start: str | None, end: str | None,
          cell: float = 1.0, target: dict[str, Any] | None = None,
          **filters: Any) -> dict[str, Any]:
    where, params = _filters(bbox, start, end, **filters)
    cell = max(0.05, min(20.0, float(cell)))
    # Floor-indexed cells (the +90/+180 shift makes SQL truncation behave as
    # floor), so a display cluster is never straddling 0° latitude/longitude.
    lat_expr = f"(CAST((lat + 90) / ? AS INT) - {int(round(90 / cell))})"
    lon_expr = f"(CAST((lon + 180) / ? AS INT) - {int(round(180 / cell))})"
    grid: dict[tuple[int, int], dict[str, Any]] = {}
    exact = _aoi_rows(target, bbox, start, end, **filters)
    if exact is None:
        rows = _rows(
            f"""SELECT {lat_expr} cy, {lon_expr} cx, sensor,
                       COUNT(*) n, MAX(COALESCE(frp,0)) max_frp, SUM(COALESCE(frp,0)) frp,
                       SUM(CASE WHEN confidence_class='high' THEN 1 ELSE 0 END) high
                FROM observations{where}
                GROUP BY cy, cx, sensor""", [cell, cell] + params)
        for r in rows:
            key = (r["cy"], r["cx"])
            g = grid.setdefault(key, {
                "lat": (r["cy"] + 0.5) * cell, "lon": (r["cx"] + 0.5) * cell,
                "count": 0, "modis": 0, "viirs": 0, "frp": 0.0, "maxFrp": 0.0, "high": 0,
            })
            g["count"] += r["n"]
            g[r["sensor"]] += r["n"]
            g["frp"] += float(r["frp"] or 0)
            g["maxFrp"] = max(g["maxFrp"], float(r["max_frp"] or 0))
            g["high"] += r["high"]
    else:
        for r in exact:
            cy = geo.cell_index(r["lat"], cell, geo.LAT_OFFSET)
            cx = geo.cell_index(r["lon"], cell, geo.LON_OFFSET)
            key = (cy, cx)
            g = grid.setdefault(key, {
                "lat": (cy + 0.5) * cell, "lon": (cx + 0.5) * cell,
                "count": 0, "modis": 0, "viirs": 0, "frp": 0.0, "maxFrp": 0.0, "high": 0,
            })
            frp = float(r["frp"] or 0)
            g["count"] += 1
            g[r["sensor"]] += 1
            g["frp"] += frp
            g["maxFrp"] = max(g["maxFrp"], frp)
            g["high"] += int(r["confidence_class"] == "high")
    out = []
    for g in grid.values():
        g["frp"] = round(g["frp"], 2)
        g["maxFrp"] = round(g["maxFrp"], 2)
        out.append(g)
    out.sort(key=lambda x: x["count"], reverse=True)
    return {"cell": cell, "cells": out, "total": sum(c["count"] for c in out)}


DETECTIONS_MAX = 50_000  # hard cap: one CSV/GeoJSON payload stays openable


def detections(bbox, start, end, limit: int = 20000,
               target: dict[str, Any] | None = None, **filters) -> dict[str, Any]:
    where, params = _filters(bbox, start, end, **filters)
    capped = min(max(int(limit), 1), DETECTIONS_MAX)
    exact = _aoi_rows(target, bbox, start, end, **filters)
    if exact is None:
        rows = _rows(
            f"""SELECT id, sensor, instrument, satellite, lat, lon, ts, acq_date, acq_time,
                       confidence_raw, confidence_pct, confidence_class, frp, brightness, bright_t31,
                       scan, track, daynight, version, source
                FROM observations{where}
                ORDER BY frp DESC NULLS LAST, ts DESC LIMIT ?""", params + [capped])
    else:
        rows = sorted(
            exact,
            key=lambda r: (
                r["frp_raw"] is not None,
                float(r["frp_raw"] or 0),
                int(r["ts"] or 0),
            ),
            reverse=True,
        )[:capped]
    features = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
        "properties": {
            "id": r["id"], "sensor": r["sensor"], "instrument": r["instrument"],
            "satellite": r["satellite"], "acqDate": r["acq_date"], "acqTime": r["acq_time"],
            "ts": r["ts"], "lat": r["lat"], "lon": r["lon"], "frp": r["frp"],
            "confidence": r["confidence_raw"], "confidencePct": r["confidence_pct"],
            "confidenceClass": r["confidence_class"], "brightness": r["brightness"],
            "brightT31": r["bright_t31"], "scan": r["scan"], "track": r["track"],
            "daynight": r["daynight"], "version": r["version"], "source": r["source"],
        },
    } for r in rows]
    return {"type": "FeatureCollection", "features": features,
            "meta": {
                "returned": len(features),
                "limit": capped,
                **({"total": len(exact)} if exact is not None else {}),
            }}


# --------------------------------------------------------------------------- #
# Harmonization
# --------------------------------------------------------------------------- #
def _bootstrap_ratio_ci(modis: np.ndarray, viirs: np.ndarray, n: int = 600,
                        seed: int = 7) -> tuple[float | None, float | None, float | None]:
    """Bootstrap CI for the mean paired difference in log10 FRP density."""
    mask = (modis > 0) & (viirs > 0)
    m, v = modis[mask], viirs[mask]
    if m.size == 0:
        return None, None, None
    diff = np.log10(m) - np.log10(v)
    point = float(np.mean(diff))
    if diff.size < 12:
        # Too few cell-days to resample honestly; report the point estimate
        # without an interval rather than inventing precision.
        return point, None, None
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, diff.size, size=(n, diff.size))
    means = diff[idx].mean(axis=1)
    lo, hi = np.percentile(means, [2.5, 97.5])
    return point, float(lo), float(hi)


GRID_CHOICES = (0.1, 0.25, 0.5)


def _grid_cells(bbox, start, end, cell_deg: float) -> dict[str, Any]:
    """Reduce detections to max-FRP per cell-day per sensor, with true cell areas.

    Two audit findings are fixed here (they were live until PHASE_1_AUDIT):

    * The index used ``CAST(lat / cell AS INT)``, which truncates *toward zero*,
      so cells straddled the equator/prime meridian and the southern hemisphere
      was shifted by one cell. It now uses ``geo.grid_sql`` (+90/+180 shift), the
      same floor-indexed grid as every other analysis path.
    * Cell area was the flat approximation ``(cell * 111.32)^2 * cos(lat)``. It is
      now the exact spherical zone area ``R^2 dlon (sin lat2 - sin lat1)``, the
      only physical normaliser used anywhere else in the engine.
    """
    where, params = _filters(bbox, start, end)
    lat_expr, lon_expr, grid_params = geo.grid_sql(cell_deg)
    rows = _rows(
        f"""SELECT {lat_expr} cy, {lon_expr} cx, acq_date, sensor,
                   MAX(COALESCE(frp,0)) max_frp
            FROM observations{where}
            GROUP BY cy, cx, acq_date, sensor""", grid_params + params)
    cell_area: dict[tuple[int, int], float] = {}
    m_cells: dict[tuple[int, int, str], float] = {}
    v_cells: dict[tuple[int, int, str], float] = {}
    for r in rows:
        key = (r["cy"], r["cx"], r["acq_date"])
        if r["sensor"] == "modis":
            m_cells[key] = float(r["max_frp"] or 0.0)
        else:
            v_cells[key] = float(r["max_frp"] or 0.0)
        cell_area[(r["cy"], r["cx"])] = geo.cell_area_km2(r["cy"], cell_deg)
    all_days = sorted(set(m_cells) | set(v_cells))
    both = sorted(set(m_cells) & set(v_cells))
    union_cells = {(k[0], k[1]) for k in all_days}
    return {
        "cellDeg": cell_deg,
        "mCells": m_cells, "vCells": v_cells, "cellArea": cell_area,
        "mCellSet": {(k[0], k[1]) for k in m_cells},
        "vCellSet": {(k[0], k[1]) for k in v_cells},
        "allDays": all_days, "both": both,
        "onlyM": len(set(m_cells) - set(v_cells)),
        "onlyV": len(set(v_cells) - set(m_cells)),
        "unionCells": union_cells,
        "activeArea": sum(cell_area[c] for c in union_cells) or 1e-6,
        "dayCount": max(1, len({k[2] for k in all_days})),
        "modisFrpTotal": sum(m_cells.values()),
        "viirsFrpTotal": sum(v_cells.values()),
        "combinedFrp": sum(max(m_cells.get(k, 0.0), v_cells.get(k, 0.0)) for k in all_days),
    }


def _hfai_v1(g: dict[str, Any]) -> dict[str, Any]:
    """Legacy grid summary. The authoritative HFAI values come from
    :func:`harmonize.indicator`; this helper stays for grid sensitivity, where
    only the *relative* change between grids is reported.

    The previous version divided a per-sensor FRP total by the *union* active
    area and by days-with-detections. That under-reported each sensor's density
    (MODIS was ~2x too low on the Amazon window) because the denominator
    contained cells only the other sensor saw.
    """
    m_area = sum(g["cellArea"][c] for c in g["mCellSet"]) or 0.0
    v_area = sum(g["cellArea"][c] for c in g["vCellSet"]) or 0.0
    m_days = max(1, len({k[2] for k in g["mCells"]}))
    v_days = max(1, len({k[2] for k in g["vCells"]}))
    u_days = max(1, len({k[2] for k in g["allDays"]}))
    return {
        "combinedDensity": round(g["combinedFrp"] / g["activeArea"] / u_days, 4) if g["activeArea"] else 0.0,
        "modisDensity": round(g["modisFrpTotal"] / m_area / m_days, 4) if m_area else 0.0,
        "viirsDensity": round(g["viirsFrpTotal"] / v_area / v_days, 4) if v_area else 0.0,
        "activeCells": len(g["unionCells"]),
        "activeAreaKm2": round(g["activeArea"], 1),
        "cellDays": len(g["allDays"]),
    }


def harmonization(bbox, start, end, region_name: str = "Selected area",
                  grid: float = 0.25, sensitivity: bool = False) -> dict[str, Any]:
    """MODIS <-> VIIRS comparison with an explicit, experimental shared metric."""
    grid = grid if grid in GRID_CHOICES else 0.25
    cache_key = ("harm", bbox, start, end, region_name, grid, sensitivity)
    hit = _cache_get(cache_key)
    if hit is not None:
        return hit

    where, params = _filters(bbox, start, end)
    days_rows = _rows(
        f"""SELECT acq_date, sensor, COUNT(*) n FROM observations{where}
            GROUP BY acq_date, sensor ORDER BY acq_date""", params)
    days_by_sensor: dict[str, set[str]] = {s: set() for s in SENSORS}
    for r in days_rows:
        days_by_sensor.setdefault(r["sensor"], set()).add(r["acq_date"])
    detection_overlap = sorted(days_by_sensor.get("modis", set()) & days_by_sensor.get("viirs", set()))
    modis_only = sorted(days_by_sensor.get("modis", set()) - days_by_sensor.get("viirs", set()))
    viirs_only = sorted(days_by_sensor.get("viirs", set()) - days_by_sensor.get("modis", set()))

    cov.ensure()
    deliver = cov.delivery(start, end)
    delivery_days = {s: {d.split(":")[1] for d in deliver if d.startswith(f"{s}:")} for s in SENSORS}
    delivery_overlap = sorted(delivery_days["modis"] & delivery_days["viirs"])

    stats = summary(bbox, start, end)
    g = _grid_cells(bbox, start, end, grid)
    m_cells, v_cells, both = g["mCells"], g["vCells"], g["both"]

    m_pairs = np.array([m_cells[k] for k in both], dtype=float) if both else np.array([])
    v_pairs = np.array([v_cells[k] for k in both], dtype=float) if both else np.array([])
    mean_log, lo, hi = _bootstrap_ratio_ci(m_pairs, v_pairs)
    ratio = float(10 ** mean_log) if mean_log is not None else None

    def cls_share(sensor: str) -> dict[str, float]:
        conf = stats["sensors"].get(sensor, {}).get("confidence", {})
        total = max(1, sum(conf.values()))
        return {k: round(v / total, 3) for k, v in conf.items()}

    frp_m = stats["sensors"].get("modis", {}).get("frp", {})
    frp_v = stats["sensors"].get("viirs", {}).get("frp", {})
    v1 = _hfai_v1(g)

    # HFAI-v2: paired cell-days only. Both sensors saw the same cell on the same
    # day, so unequal overpass counts and footprint mismatch are reduced to the
    # smallest defensible comparison. Still experimental, still not a calibration.
    paired_mean_m = float(np.mean(m_pairs)) if m_pairs.size else None
    paired_mean_v = float(np.mean(v_pairs)) if v_pairs.size else None
    v2 = {
        "metric": "HFAI-v2 (paired cell-day intensity)",
        "unit": "MW per paired cell-day",
        "pairedCellDays": int(m_pairs.size),
        "modisMeanFrp": round(paired_mean_m, 3) if paired_mean_m is not None else None,
        "viirsMeanFrp": round(paired_mean_v, 3) if paired_mean_v is not None else None,
        "ratio": round(ratio, 3) if ratio else None,
        "ratioCi95": [round(10 ** lo, 3), round(10 ** hi, 3)] if lo is not None else None,
        "status": "experimental",
        "validation": "none in this build - no independent ground truth (airborne/perimeter data) is available",
        "note": ("Restricting to cell-days reported by both sensors removes unequal overpass counts, but "
                 "not footprint size, saturation or cloud effects. Report it as context, never as a "
                 "correction factor."),
    }

    # ---------------------------------------------------------------------
    # Authoritative HFAI numbers.
    #
    # Two independent HFAI implementations used to exist: this function's local
    # math and harmonize.indicator(). On the live Amazon window they disagreed
    # (MODIS density 0.0067 here vs 0.014372 in /api/harmonization/v2) and both
    # were rendered as "HFAI-v1" on one page. The indicator is now the single
    # source of truth; the legacy local numbers are kept only where they describe
    # something the indicator does not publish (mean FRP per active cell).
    # ---------------------------------------------------------------------
    canonical_full = harmonize.indicator(where, params, grid, sensitivity=False)
    canonical = canonical_full["selected"]
    canon_sensors = canonical["sensors"]
    canon_combined = canonical["combined"]
    canon_v2 = canonical["hfaiV2"]

    v1.update({
        "combinedDensity": canon_combined["density"],
        "modisDensity": canon_sensors["modis"]["density"],
        "viirsDensity": canon_sensors["viirs"]["density"],
        "activeCells": canon_combined["activeCells"],
        "activeAreaKm2": canon_combined["activeAreaKm2"],
        "cellDays": canon_combined["cellDays"],
        "daysUsed": canon_combined["daysUsed"],
        "densityCi95": canon_combined.get("densityCi95"),
        "sensorDensityCi95": {
            "modis": canon_sensors["modis"].get("densityCi95"),
            "viirs": canon_sensors["viirs"].get("densityCi95"),
        },
        "provenance": "harmonize.indicator (same code path as /api/harmonization/v2)",
        "gridDefinition": canonical["gridDefinition"],
        "cellAreaMethod": canonical["cellAreaMethod"],
        "validationStatus": canonical_full.get("validationStatus"),
        "assumptions": canonical_full.get("assumptions"),
        "limitations": canonical_full.get("limitations"),
    })
    v2.update({
        "pairedCellDays": canon_v2["pairedCellDays"],
        "modisMeanFrp": canon_v2["modisMeanFrp"],
        "viirsMeanFrp": canon_v2["viirsMeanFrp"],
        "ratio": canon_v2["ratio"],
        "ratioCi95": canon_v2["ratioCi95"],
    })
    ratio = canon_v2["ratio"]

    hfai = {
        "metric": "Experimental harmonized fire intensity (HFAI-v1)",
        "unit": "MW km^-2 day^-1",
        "method": (
            f"Every detection is reduced to the maximum reported FRP per {grid} deg cell per day and per sensor, "
            "so repeated overpasses over the same fire cannot inflate totals. Active burning area is the "
            "union of cells that reported at least once, weighted by true spherical cell area. HFAI-v1 is the "
            "combined cell-day FRP (max across sensors, to avoid double counting the same fire) divided by "
            "that burning area and by the number of observation days. The MODIS/VIIRS ratio is reported "
            "separately and is never applied as a correction factor."
        ),
        **v1,
        "meanFrpPerActiveCell": {
            "modis": round(float(np.mean(list(m_cells.values()))), 2) if m_cells else 0.0,
            "viirs": round(float(np.mean(list(v_cells.values()))), 2) if v_cells else 0.0,
            "combined": round(float(np.mean([max(m_cells.get(k, 0.0), v_cells.get(k, 0.0))
                                             for k in g["allDays"]])), 2) if g["allDays"] else 0.0,
        },
        # v2 is the authority for the paired comparison too. The legacy bootstrap
        # here produced a CI ~0.1% away from the published one (1.975-2.26 vs
        # 1.977-2.268), which is two realisations of the same quantity reported
        # under one name - a verifier flagged it, so it reads from one place now.
        "modisToViirsRatio": canon_v2["ratio"],
        "ratioCi95": canon_v2["ratioCi95"],
        "pairedCellDays": canon_v2["pairedCellDays"],
        "coincidentShare": canonical["disagreement"]["coincidenceShare"],
        "coincidenceJaccard": canonical["disagreement"]["jaccardCells"],
        "modisOnlyCellDays": canonical["disagreement"]["modisOnlyCellDays"],
        "viirsOnlyCellDays": canonical["disagreement"]["viirsOnlyCellDays"],
        "status": "experimental",
        "validation": "none in this build - reported with a bootstrap interval, not calibrated",
    }

    methods = [
        {
            "id": "A", "name": "Native detections", "status": "validated by source",
            "unit": "detections",
            "value": {"modis": stats["sensors"]["modis"]["detections"],
                      "viirs": stats["sensors"]["viirs"]["detections"]},
            "note": "Counts are not comparable across sensors: 1 km vs 375 m footprints and 2 vs 3 satellites.",
        },
        {
            "id": "B", "name": "Detection density", "status": "derived",
            "unit": "detections per 1,000 km2",
            "value": {
                "modis": round(stats["sensors"]["modis"]["detections"] / max(1.0, stats["areaKm2"]) * 1000, 3),
                "viirs": round(stats["sensors"]["viirs"]["detections"] / max(1.0, stats["areaKm2"]) * 1000, 3),
            },
            "note": "Normalises by area, not by footprint or overpass count.",
        },
        {
            "id": "C", "name": "Native FRP", "status": "validated by source",
            "unit": "MW",
            "value": {"modis": frp_m, "viirs": frp_v},
            "note": "FRP is integrated over each sensor's own pixel; totals are not directly comparable.",
        },
        {
            "id": "D", "name": "HFAI-v1 area-normalised density", "status": "experimental",
            "unit": "MW km^-2 day^-1",
            "value": {"combined": v1["combinedDensity"], "modis": v1["modisDensity"],
                      "viirs": v1["viirsDensity"]},
            "note": "Union burning area denominator; sensitive to grid size and to which sensor saw the cell.",
        },
        {
            "id": "E", "name": "HFAI-v2 paired cell-day intensity", "status": "experimental",
            "unit": "MW per paired cell-day",
            "value": {"modis": v2["modisMeanFrp"], "viirs": v2["viirsMeanFrp"], "ratio": v2["ratio"]},
            "note": "Restricts to cell-days both sensors reported; no ground-truth validation exists here.",
        },
    ]

    grid_sensitivity = None
    if sensitivity:
        grid_sensitivity = []
        for gd in GRID_CHOICES:
            gg = g if gd == grid else _grid_cells(bbox, start, end, gd)
            mm = np.array([gg["mCells"][k] for k in gg["both"]], dtype=float) if gg["both"] else np.array([])
            vv = np.array([gg["vCells"][k] for k in gg["both"]], dtype=float) if gg["both"] else np.array([])
            ml, l2, h2 = _bootstrap_ratio_ci(mm, vv)
            grid_sensitivity.append({
                "grid": gd,
                "combinedDensity": _hfai_v1(gg)["combinedDensity"],
                "activeCells": len(gg["unionCells"]),
                "pairedCellDays": int(mm.size),
                "ratio": round(float(10 ** ml), 3) if ml is not None else None,
                "ratioCi95": [round(10 ** l2, 3), round(10 ** h2, 3)] if l2 is not None else None,
            })

    sample = []
    if both:
        step = max(1, len(both) // 1400)
        for k in both[::step][:1400]:
            sample.append({
                "lat": round((k[0] + 0.5) * grid, 3),
                "lon": round((k[1] + 0.5) * grid, 3),
                "day": k[2],
                "modisFrp": round(m_cells[k], 3),
                "viirsFrp": round(v_cells[k], 3),
            })

    comparison = {
        "region": region_name,
        "bbox": list(bbox),
        "grid": grid,
        "gridChoices": list(GRID_CHOICES),
        "window": {
            "start": start, "end": end,
            "overlapDays": len(detection_overlap), "overlap": detection_overlap,
            "modisOnlyDays": modis_only, "viirsOnlyDays": viirs_only,
            "deliveryOverlapDays": len(delivery_overlap),
            "deliveryOverlap": delivery_overlap,
            "note": ("Detection overlap counts days where both sensors reported at least one detection. "
                     "Delivery overlap counts days both products were delivered, which is the correct "
                     "denominator for 'did both sensors look?'."),
        },
        "sensors": {
            "modis": {
                "detections": stats["sensors"]["modis"]["detections"],
                "frp": frp_m, "confidence": cls_share("modis"),
                "pixelAreaKm2": PIXEL_AREA_KM2["modis"], "resolution": "1 km",
                "satellites": stats["sensors"]["modis"]["satellites"],
                "detectionsPer1000Km2": round(
                    stats["sensors"]["modis"]["detections"] / max(1.0, stats["areaKm2"]) * 1000, 3),
                "meanFrp": frp_m.get("mean"),
            },
            "viirs": {
                "detections": stats["sensors"]["viirs"]["detections"],
                "frp": frp_v, "confidence": cls_share("viirs"),
                "pixelAreaKm2": PIXEL_AREA_KM2["viirs"], "resolution": "375 m",
                "satellites": stats["sensors"]["viirs"]["satellites"],
                "detectionsPer1000Km2": round(
                    stats["sensors"]["viirs"]["detections"] / max(1.0, stats["areaKm2"]) * 1000, 3),
                "meanFrp": frp_v.get("mean"),
            },
        },
        "hfai": hfai,
        "hfaiV2": v2,
        "methods": methods,
        "gridSensitivity": grid_sensitivity,
        "pairedSample": sample,
        "limitations": [
            "MODIS and VIIRS report FRP over different footprint areas (1 km vs 375 m), so a single "
            "detection is not a comparable unit between sensors.",
            f"VIIRS platforms represented here: "
            f"{', '.join(stats['sensors']['viirs']['satellites']) or 'none'}; MODIS: "
            f"{', '.join(stats['sensors']['modis']['satellites']) or 'none'}. A different number of "
            "platforms gives a different number of overpass opportunities per day. Cell-day maxima "
            "reduce, but do not remove, this effect.",
            "Confidence is native to each product: MODIS reports a percentage, VIIRS reports low/nominal/high. "
            "The shared class is a display view, not a calibration.",
            "Only days present in both feeds are used for the ratio. Cloud, smoke and saturation can hide "
            "active fire from either sensor, and an absent detection is not evidence of absence.",
            "The ratio is specific to this area and window. Do not reuse it as a global conversion factor.",
            "No independent ground truth (airborne or perimeter data) is available in this build, so no "
            "method here is validated against observed fire size or intensity.",
        ],
    }
    _cache_put(cache_key, comparison)
    return comparison


# --------------------------------------------------------------------------- #
# Baselines and anomalies
# --------------------------------------------------------------------------- #
def daily_series(bbox, sensor: str | None = None, observed_only: bool = False) -> list[dict[str, Any]]:
    """Daily counts. With ``observed_only`` the series is built on delivery days,
    so verified-zero days appear as 0 instead of being silently dropped."""
    where, params = _filters(bbox, None, None, sensors=[sensor] if sensor else None)
    rows = _rows(
        f"""SELECT acq_date, COUNT(*) n, SUM(COALESCE(frp,0)) frp
            FROM observations{where} GROUP BY acq_date ORDER BY acq_date""", params)
    series = {r["acq_date"]: {"date": r["acq_date"], "count": r["n"], "frp": float(r["frp"] or 0)}
              for r in rows}
    if not observed_only:
        return list(series.values())
    cov.ensure()
    win = cov.window()
    if not win["first"] or not win["last"]:
        return list(series.values())
    deliver = cov.delivery(win["first"], win["last"])
    sensors = [sensor] if sensor else list(SENSORS)
    out = []
    for day in cov.date_range(win["first"], win["last"]):
        if not any(f"{s}:{day}" in deliver for s in sensors):
            continue
        out.append(series.get(day, {"date": day, "count": 0, "frp": 0.0}))
    return out


def anomaly(bbox, target_date: str | None = None, sensor: str | None = None) -> dict[str, Any]:
    """Robust deviation of one observed day against observed days only.

    Unknown-coverage days are excluded from the baseline and can never be the
    target: a day without delivery evidence has no defensible count.
    """
    series = daily_series(bbox, sensor, observed_only=True)
    if not series:
        return {"available": False, "reason": "No stored detections for this area.",
                "target": None, "baseline": None}
    if target_date:
        target = next((r for r in series if r["date"] == target_date[:10]), None)
        if target is None:
            return {"available": False,
                    "reason": ("The requested date has no verified coverage in the stored window, "
                               "so no deviation can be computed."),
                    "target": target_date, "baseline": None}
    else:
        target = max(series, key=lambda r: r["date"])

    # A run of VIIRS late deliveries must not read as a drop in fire activity.
    # Compare the target only with days that carry the SAME set of delivering
    # sensors: a MODIS-only day is never measured against a MODIS+VIIRS median.
    cov.ensure()
    win = cov.window()
    deliver = cov.delivery(win["first"], win["last"]) if win["first"] else set()
    sensors = [sensor] if sensor else list(SENSORS)

    def delivered(day: str) -> frozenset[str]:
        return frozenset(s for s in sensors if f"{s}:{day}" in deliver)

    target_sensors = delivered(target["date"])
    baseline = [r for r in series
                if r["date"] != target["date"] and delivered(r["date"]) == target_sensors]
    excluded = len(series) - 1 - len(baseline)
    counts = np.array([r["count"] for r in baseline], dtype=float)
    value = float(target["count"])
    method = ("Robust z-score: (x − median) / (1.4826 × MAD) over observed days only. "
              "MAD is used because daily fire counts are heavy-tailed and non-normal. "
              "Baseline days must have the same delivering sensor set as the target day.")
    mix_note = ""
    if excluded:
        present = ", ".join(sorted(target_sensors)) or "no verified delivery"
        mix_note = (f" {excluded} stored day(s) with a different delivering sensor mix "
                    f"({present} on the target day) were excluded from the baseline.")
    if counts.size < 7:
        return {
            "available": True, "target": target, "baseline": None,
            "quality": {"level": "insufficient", "baselineDays": int(counts.size),
                        "targetSensors": sorted(target_sensors),
                        "excludedSensorMixDays": excluded,
                        "note": ("Fewer than seven comparable observed baseline days are stored, so no "
                                 "robust deviation is reported. Unknown days are excluded, not "
                                 "zero-filled." + mix_note)},
            "method": method,
        }
    med = float(np.median(counts))
    mad = float(np.median(np.abs(counts - med)))
    robust_sigma = 1.4826 * mad
    z = (value - med) / robust_sigma if robust_sigma > 0 else None
    percentile = float((counts <= value).mean() * 100)
    level = "adequate" if counts.size >= 14 else "limited"
    return {
        "available": True,
        "target": target,
        "baseline": {"median": med, "mad": mad, "robustSigma": robust_sigma,
                     "days": int(counts.size), "min": float(counts.min()), "max": float(counts.max()),
                     "p90": pct(counts, 90)},
        "deviation": {
            "absolute": value - med,
            "relative": (value / med - 1) if med else None,
            "robustZ": round(z, 2) if z is not None else None,
            "percentile": round(percentile, 1),
            "direction": "above" if value > med else ("below" if value < med else "at"),
        },
        "quality": {
            "level": level, "baselineDays": int(counts.size),
            "targetSensors": sorted(target_sensors),
            "excludedSensorMixDays": excluded,
            "note": (("Baseline covers the stored near-real-time window only. Treat as indicative, "
                      "not climatological.") if level != "adequate" else
                     "Baseline is long enough for a robust comparison within this window.") + mix_note,
        },
        "method": method,
    }


# --------------------------------------------------------------------------- #
# Point queries (Ask the Earth)
# --------------------------------------------------------------------------- #
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nearby(lat: float, lon: float, radius_km: float = 50.0, hours: int = 72,
           limit: int = 120) -> list[dict[str, Any]]:
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(0.15, math.cos(math.radians(lat))))
    since = int((datetime.now(timezone.utc).timestamp() - hours * 3600) * 1000)
    rows = _rows(
        """SELECT * FROM observations
           WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND ts >= ?
           ORDER BY ts DESC LIMIT 4000""",
        [lat - dlat, lat + dlat, lon - dlon, lon + dlon, since])
    out = []
    for r in rows:
        d = haversine_km(lat, lon, r["lat"], r["lon"])
        if d <= radius_km:
            r["distanceKm"] = round(d, 2)
            out.append(r)
    out.sort(key=lambda r: (r["distanceKm"], -(r["frp"] or 0)))
    return out[:limit]


def observation_by_id(obs_id: str) -> dict[str, Any] | None:
    with session() as conn:
        row = conn.execute("SELECT * FROM observations WHERE id = ?", (obs_id,)).fetchone()
    return dict(row) if row else None


# --------------------------------------------------------------------------- #
# Year comparison
# --------------------------------------------------------------------------- #
def compare_years(bbox, years: Iterable[int], period: str = "month",
                  target: dict[str, Any] | None = None, **filters: Any) -> dict[str, Any]:
    """Compare stored years bucket by bucket, refusing to fabricate absent years."""
    period = period if period in PERIODS else "month"
    years = sorted({int(y) for y in years})
    if not years:
        return {"available": False, "reason": "no years requested"}
    cov.ensure()
    deliver_all = cov.delivery(f"{years[0]}-01-01", f"{years[-1]}-12-31")
    out: list[dict[str, Any]] = []
    for year in years:
        start, end = f"{year}-01-01", f"{year}-12-31"
        where, params = _filters(bbox, start, end, **filters)
        exact = _aoi_rows(target, bbox, start, end, **filters)
        if exact is not None:
            rows = [{"acq_date": r["acq_date"], "n": 1, "frp": float(r["frp"] or 0)} for r in exact]
        else:
            rows = _rows(
                f"""SELECT acq_date, COUNT(*) n, SUM(COALESCE(frp,0)) frp
                    FROM observations{where} GROUP BY acq_date""", params)
        buckets: dict[str, dict[str, Any]] = {}
        for r in rows:
            key, label, bstart, bend = _bucket(_date.fromisoformat(r["acq_date"]), period)
            b = buckets.setdefault(key, {"key": key, "label": label, "start": bstart,
                                         "end": bend, "detections": 0, "frp": 0.0})
            b["detections"] += int(r["n"])
            b["frp"] += float(r["frp"] or 0)
        delivery_days = {k.split(":", 1)[1] for k in deliver_all
                         if k.split(":", 1)[1].startswith(str(year))}
        observed_days = {r["acq_date"] for r in rows}
        out.append({
            "year": year,
            "buckets": sorted(buckets.values(), key=lambda b: b["start"]),
            "deliveryDays": len(delivery_days),
            "observedDays": len(observed_days),
            "detections": sum(b["detections"] for b in buckets.values()),
            "frp": round(sum(b["frp"] for b in buckets.values()), 2),
            "available": bool(delivery_days),
            "state": "observed" if observed_days else ("observed_zero" if delivery_days else "unknown"),
        })
    usable = [y for y in out if y["available"]]
    pairs = []
    if len(usable) >= 2:
        for a, b in zip(usable, usable[1:]):
            for bucket in a["buckets"]:
                match = next((x for x in b["buckets"] if x["key"] == bucket["key"]), None)
                if not match:
                    continue
                pairs.append({
                    "bucket": bucket["key"], "label": bucket["label"],
                    "earlyYear": a["year"], "lateYear": b["year"],
                    "early": bucket["detections"], "late": match["detections"],
                    "difference": match["detections"] - bucket["detections"],
                    "ratio": round(match["detections"] / bucket["detections"], 3)
                    if bucket["detections"] else None,
                })
    return {
        "period": period,
        "years": out,
        "availableYears": [y["year"] for y in usable],
        "comparisonAvailable": len(usable) >= 2,
        "comparisons": pairs,
        "reason": None if len(usable) >= 2 else (
            "Year comparison needs at least two years with delivered observations; the stored record "
            f"contains {len(usable)}."),
        "note": ("A bucket is only compared when both years have it. Missing buckets are omitted, never "
                 "zero-filled."),
    }
