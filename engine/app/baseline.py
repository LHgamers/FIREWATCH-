"""Historical availability, baselines and anomalies.

The rule that shapes this module: a baseline needs *years*, not days. The
stored record currently holds eight consecutive days in one month of one year,
so every climatological calculation here must return ``insufficient`` with a
concrete reason. The machinery is implemented so it starts working the moment
an archive is ingested, without any code change and without a synthetic value
ever standing in for a missing year.

Two different comparisons are kept apart:

* **Window baseline** (``windowBaseline``) — median/MAD over the observed days
  inside the stored window. Descriptive, labelled ``window_only``.
* **Climatology** (``climatology``) — day-of-year or month-of-year reference
  built from *distinct years*. Requires ``MIN_YEARS``, otherwise unavailable.
"""
from __future__ import annotations

from datetime import date as _date, datetime, timedelta
from typing import Any

import numpy as np

from . import coverage as cov
from .db import session

MIN_YEARS = 3
MIN_DAYS_PER_YEAR = 1
DEFAULT_WINDOW_DAYS = 15


def _rows(sql: str, params: list[Any]) -> list[dict[str, Any]]:
    with session() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _counts_by_day(where: str, params: list[Any]) -> dict[str, dict[str, int]]:
    rows = _rows(
        f"""SELECT acq_date, sensor, COUNT(*) n FROM observations{where}
            GROUP BY acq_date, sensor ORDER BY acq_date""", params)
    out: dict[str, dict[str, int]] = {}
    for r in rows:
        out.setdefault(r["acq_date"], {})[r["sensor"]] = int(r["n"])
    return out


def _delivery_days(start: str | None, end: str | None) -> dict[str, set[str]]:
    cov.ensure()
    deliver = cov.delivery(start, end)
    out: dict[str, set[str]] = {"modis": set(), "viirs": set()}
    for key in deliver:
        sensor, day = key.split(":", 1)
        out.setdefault(sensor, set()).add(day)
    return out


def availability(where: str, params: list[Any]) -> dict[str, Any]:
    """What history actually exists for this AOI — never inferred from the schema."""
    rows = _rows(
        f"""SELECT sensor, MIN(acq_date) first, MAX(acq_date) last,
                   COUNT(DISTINCT acq_date) days, COUNT(*) detections
            FROM observations{where} GROUP BY sensor""", params)
    per: dict[str, Any] = {}
    all_days: set[str] = set()
    for r in rows:
        clause = f"{where} AND sensor = ?" if where.strip() else " WHERE sensor = ?"
        days = _rows(
            f"SELECT DISTINCT acq_date FROM observations{clause} ORDER BY acq_date",
            params + [r["sensor"]])
        day_list = [d["acq_date"] for d in days]
        all_days.update(day_list)
        years = sorted({d[:4] for d in day_list})
        months = sorted({d[5:7] for d in day_list})
        per[r["sensor"]] = {
            "sensor": r["sensor"],
            "first": r["first"], "last": r["last"],
            "distinctDays": int(r["days"]), "detections": int(r["detections"]),
            "years": years, "months": months,
            "gaps": _gaps(day_list),
        }
    first = min(all_days) if all_days else None
    last = max(all_days) if all_days else None
    years = sorted({d[:4] for d in all_days})
    deliver = _delivery_days(first, last)
    delivery_years = sorted({d[:4] for s in deliver.values() for d in s})
    return {
        "first": first, "last": last,
        "distinctDays": len(all_days),
        "years": years,
        "deliveryYears": delivery_years,
        "perSensor": per,
        "deliveryDays": {k: len(v) for k, v in deliver.items()},
        "climatologyPossible": len(delivery_years) >= MIN_YEARS,
        "climatologyRequirement": f"{MIN_YEARS} distinct years of delivered observations",
        "historicalNote": ("Availability is reported from stored rows only. Dates outside this range are "
                           "not 'quiet' — they were never ingested."),
    }


def language_for(z: float | None, reference: str) -> str:
    """Map a robust z-score to permitted wording.

    A deviation is never called an emergency, and an unremarkable one is not
    dressed up as notable. Thresholds: |z| < 2 near, 2-3 higher/lower, >= 3 unusual.
    """
    if z is None:
        return f"at the {reference} (no spread in the reference sample)"
    magnitude = abs(z)
    direction = "higher" if z > 0 else "lower"
    if magnitude < 2:
        return f"near the {reference}"
    if magnitude < 3:
        return f"{direction} than the {reference}"
    return f"unusual relative to the {reference}"


def _gaps(days: list[str], min_days: int = 2) -> list[dict[str, Any]]:
    """Missing runs between stored days (only interior gaps are real gaps)."""
    out: list[dict[str, Any]] = []
    parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in days]
    for a, b in zip(parsed, parsed[1:]):
        missing = (b - a).days - 1
        if missing >= min_days:
            out.append({"after": a.isoformat(), "before": b.isoformat(), "missingDays": missing})
    return out


def window_baseline(where: str, params: list[Any], sensor: str | None = None,
                    target_date: str | None = None) -> dict[str, Any]:
    """Median/MAD over observed days inside the stored window.

    This is what the Phase 1 anomaly endpoint computes; it is retained and
    relabelled so nobody can mistake it for a climatology.
    """
    counts = _counts_by_day(where, params)
    deliver = _delivery_days(None, None)
    sensors = [sensor] if sensor in ("modis", "viirs") else ["modis", "viirs"]
    days = sorted(d for d, per in counts.items() if any(s in per for s in sensors))
    if not days:
        return {"available": False, "reason": "no stored detections for this area",
                "method": "median/MAD over observed days in the stored window"}
    series = [(d, sum(counts[d].get(s, 0) for s in sensors)) for d in days]
    target = target_date[:10] if target_date else series[-1][0]
    if target not in dict(series):
        return {"available": False, "reason": "target date is not an observed day",
                "method": "median/MAD over observed days in the stored window"}
    values = np.asarray([v for d, v in series if d != target], dtype=float)
    x = dict(series)[target]
    base = {
        "kind": "window_baseline",
        "label": "Stored-window baseline",
        "method": "median/MAD over observed days inside the stored window (unknown days excluded)",
        "sampleDays": int(values.size),
        "target": {"date": target, "count": x},
        "notClimatology": True,
    }
    if values.size < 7:
        base.update({"available": False,
                     "reason": "fewer than seven observed baseline days in the stored window",
                     "minimumSample": 7})
        return base
    med = float(np.median(values))
    mad = float(np.median(np.abs(values - med)))
    sigma = 1.4826 * mad
    base.update({
        "available": True,
        "baseline": {"median": med, "mad": mad, "robustSigma": sigma,
                     "min": float(values.min()), "max": float(values.max())},
        "deviation": {
            "absolute": x - med,
            "relative": (x / med - 1) if med else None,
            "robustZ": round((x - med) / sigma, 2) if sigma else None,
        },
        "language": language_for(
            (x - med) / sigma if sigma else None, "stored-window baseline"),
    })
    return base


def climatology(where: str, params: list[Any], *, method: str = "doy",
                window_days: int = DEFAULT_WINDOW_DAYS,
                target_date: str | None = None) -> dict[str, Any]:
    """Day-of-year / month-of-year climatology from distinct years, or a refusal."""
    counts = _counts_by_day(where, params)
    deliver = _delivery_days(None, None)
    observed = sorted(d for d, per in counts.items() if per)
    delivery_years = sorted({d[:4] for s in deliver.values() for d in s})
    years = sorted({d[:4] for d in observed})

    meta = {
        "kind": "climatology",
        "method": ("day-of-year median/MAD across distinct years, using observed days only"
                   if method == "doy" else
                   "month-of-year median/MAD across distinct years, using observed days only"),
        "windowDays": window_days if method == "doy" else None,
        "minYears": MIN_YEARS,
        "yearsAvailable": years,
        "deliveryYears": delivery_years,
        "observedDays": len(observed),
        "notClimatology": False,
    }
    if len(delivery_years) < MIN_YEARS:
        meta.update({
            "available": False,
            "reason": "insufficient_history",
            "detail": (f"A climatology needs observations from at least {MIN_YEARS} distinct years; "
                       f"the stored record contains {len(delivery_years)} "
                       f"({', '.join(delivery_years) if delivery_years else 'none'})."),
        })
        return meta

    if not target_date:
        target_date = max(observed) if observed else None
    if not target_date:
        meta.update({"available": False, "reason": "no_observations"})
        return meta

    target = datetime.strptime(target_date[:10], "%Y-%m-%d").date()
    by_year: dict[str, list[float]] = {}
    for day, per in counts.items():
        d = datetime.strptime(day, "%Y-%m-%d").date()
        if d.year == target.year:
            continue
        if method == "doy":
            delta = abs((d - _date(d.year, target.month, min(target.day, 28))).days)
            if delta > window_days:
                continue
        else:
            if d.month != target.month:
                continue
        by_year.setdefault(str(d.year), []).append(float(sum(per.values())))

    yearly = {y: float(np.mean(v)) for y, v in by_year.items() if len(v) >= MIN_DAYS_PER_YEAR}
    meta.update({
        "targetDate": target.isoformat(),
        "yearsUsed": sorted(yearly),
        "yearMeans": {y: round(v, 2) for y, v in sorted(yearly.items())},
        "sampleYears": len(yearly),
    })
    if len(yearly) < MIN_YEARS:
        meta.update({
            "available": False,
            "reason": "insufficient_years_in_window",
            "detail": (f"{len(yearly)} year(s) contributed observations to this window; "
                       f"{MIN_YEARS} are required."),
        })
        return meta

    values = np.asarray(list(yearly.values()), dtype=float)
    med = float(np.median(values))
    mad = float(np.median(np.abs(values - med)))
    sigma = 1.4826 * mad
    observed_target = float(sum(counts.get(target.isoformat(), {}).values())) if target.isoformat() in counts else None
    meta.update({
        "available": True,
        "baseline": {"median": round(med, 2), "mad": round(mad, 2),
                     "robustSigma": round(sigma, 2), "min": float(values.min()),
                     "max": float(values.max())},
        "targetObserved": observed_target,
        "comparison": None if observed_target is None else {
            "absolute": round(observed_target - med, 2),
            "ratio": round(observed_target / med, 3) if med else None,
            "robustZ": round((observed_target - med) / sigma, 2) if sigma else None,
            "language": language_for(
                (observed_target - med) / sigma if sigma else None, "multi-year baseline"),
        },
    })
    return meta


def anomaly(where: str, params: list[Any], target_date: str | None = None,
            sensor: str | None = None, method: str = "auto") -> dict[str, Any]:
    """Anomaly only where a defensible baseline exists.

    ``auto`` prefers the multi-year climatology and falls back to the
    stored-window baseline, always reporting which was used and why.
    """
    clim = climatology(where, params, target_date=target_date)
    if method in ("auto", "climatology") and clim.get("available"):
        return {"selected": "climatology", "result": clim,
                "validationStatus": "not_independently_validated"}
    win = window_baseline(where, params, sensor=sensor, target_date=target_date)
    return {
        "selected": "window_baseline" if win.get("available") else "none",
        "climatology": clim,
        "windowBaseline": win,
        "reason": (clim.get("detail") if not clim.get("available") else
                   "climatology unavailable for the requested method"),
        "validationStatus": "not_independently_validated",
        "language": win.get("language") or
                    "Insufficient history for a multi-year comparison; only a stored-window baseline exists.",
    }
