"""Observation-coverage evidence.

The calendar must never turn "we have no observation" into "there was no fire".
This module states, per sensor and day, *why* a value exists:

===========================================  ==========================================================
state (legacy key)                           meaning
===========================================  ==========================================================
``observed`` / ``DETECTIONS_RECORDED``       product delivered for that sensor-day and the AOI
                                             reported >= 1 detection
``observed_zero`` /                          product delivered for that sensor-day and the AOI
``COVERAGE_CONFIRMED_ZERO_DETECTIONS``       reported exactly 0 detections *(conditional on global
                                             delivery — see the basis string)*
``unknown`` / ``COVERAGE_UNKNOWN``           delivery cannot be established for that sensor-day
``unavailable`` / ``PRODUCT_UNAVAILABLE``    a request for that date was attempted and the source
                                             rejected or failed it (auth, rate limit, invalid, error)
``partial``                                  at least one sensor is known, at least one is not
===========================================  ==========================================================

Delivery is inferred from global product presence per sensor-day. A
polar-orbiting sensor that delivered any record anywhere proves its swath and
product existed for that date. It does **not** prove the swath covered a
specific AOI, which is why ``observed_zero`` is reported with an explicit
``basis`` and is never described as "no fire".

``PRODUCT_UNAVAILABLE`` is only claimed when there is a stored failure for that
sensor and date (an archive window or a per-date checkpoint). A date we simply
never requested stays ``unknown`` — the conservative direction.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Sequence

from . import db

SENSORS = ("modis", "viirs")

# Canonical state codes required by the Phase 1 specification.
STATE_CODES: dict[str, dict[str, str]] = {
    "observed": {
        "code": "DETECTIONS_RECORDED",
        "label": "Detections recorded",
        "meaning": "The product delivered for this sensor-day and the area reported at least one detection.",
    },
    "observed_zero": {
        "code": "COVERAGE_CONFIRMED_ZERO_DETECTIONS",
        "label": "Coverage confirmed, zero detections",
        "meaning": "The product delivered for this sensor-day and the area reported no detections. "
                   "This is a conditional zero: global delivery proves the product existed, not that "
                   "this specific area was imaged cloud-free.",
    },
    "partial": {
        "code": "COVERAGE_PARTIAL",
        "label": "One sensor missing",
        "meaning": "At least one sensor has delivery evidence and at least one does not.",
    },
    "unknown": {
        "code": "COVERAGE_UNKNOWN",
        "label": "Coverage unknown",
        "meaning": "Product delivery cannot be established, so no statement about activity is possible.",
    },
    "unavailable": {
        "code": "PRODUCT_UNAVAILABLE",
        "label": "Product unavailable",
        "meaning": "A request for this date was attempted and the source failed, rejected or could not "
                   "deliver it. Missing data, not zero activity.",
    },
}

STATE_LABELS = {k: v["label"] for k, v in STATE_CODES.items()}

# Which ingest sources belong to which sensor, for failure attribution.
SOURCE_SENSORS: dict[str, str] = {
    "firms-modis-c61": "modis",
    "firms-modis-c61-24h": "modis",
    "firms-viirs-375": "viirs",
}
FAILURE_STATUSES = ("auth", "rate_limited", "invalid", "unavailable", "error")

ARCHIVE_NOTE_NO_KEY = (
    "Archive backfill needs FIRMS_MAP_KEY. Dates outside the stored window are UNKNOWN, "
    "not zero activity."
)
ARCHIVE_NOTE_KEY = "FIRMS archive access is configured; historical windows can be requested."


def archive_enabled() -> bool:
    """Read at call time so .env loading order never matters."""
    return bool(os.environ.get("FIRMS_MAP_KEY", "").strip())


def state_code(state: str) -> str:
    return STATE_CODES.get(state, STATE_CODES["unknown"])["code"]


def ensure() -> None:
    """Build the delivery table once if it does not exist yet."""
    if db.coverage_day_count() == 0:
        db.rebuild_coverage()


def refresh() -> int:
    """Recompute delivery evidence after ingestion."""
    return db.rebuild_coverage()


def _rows(sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
    with db.session() as conn:
        return [dict(r) for r in conn.execute(sql, list(params))]


def delivery(start: str | None = None, end: str | None = None) -> dict[str, dict[str, Any]]:
    """sensor/date -> delivery evidence (records, satellites, sources)."""
    where, params = "", []
    if start and end:
        where = " WHERE acq_date >= ? AND acq_date <= ?"
        params = [start, end]
    rows = _rows(
        f"""SELECT sensor, acq_date, SUM(records) records,
                   GROUP_CONCAT(satellite || ':' || records) breakdown,
                   MAX(source) source
            FROM coverage_days{where}
            GROUP BY sensor, acq_date""",
        params,
    )
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        sats: dict[str, int] = {}
        for part in (r["breakdown"] or "").split(","):
            if ":" in part:
                name, n = part.rsplit(":", 1)
                sats[name] = int(n)
        out[f"{r['sensor']}:{r['acq_date']}"] = {
            "sensor": r["sensor"],
            "date": r["acq_date"],
            "records": int(r["records"] or 0),
            "satellites": sats,
            "source": r["source"],
        }
    return out


def unavailable_dates(start: str | None = None, end: str | None = None) -> dict[str, set[str]]:
    """sensor -> dates for which a stored request failed (PRODUCT_UNAVAILABLE)."""
    marks: dict[str, set[str]] = {s: set() for s in SENSORS}
    for row in _rows(
        """SELECT source, sensor, start_date, end_date, status FROM coverage_windows
           WHERE status IN ({})""".format(",".join("?" for _ in FAILURE_STATUSES)),
        FAILURE_STATUSES,
    ):
        sensor = row["sensor"] or SOURCE_SENSORS.get(row["source"], "")
        if sensor not in marks:
            continue
        for d in date_range(row["start_date"], row["end_date"]):
            marks[sensor].add(d)
    for row in _rows(
        """SELECT source, date, status FROM ingest_checkpoints
           WHERE status IN ({})""".format(",".join("?" for _ in FAILURE_STATUSES)),
        FAILURE_STATUSES,
    ):
        sensor = SOURCE_SENSORS.get(row["source"], "viirs" if "VIIRS" in row["source"].upper() else "")
        if sensor in marks:
            marks[sensor].add(row["date"])
    if start and end:
        for sensor in marks:
            marks[sensor] = {d for d in marks[sensor] if start <= d <= end}
    return marks


def window() -> dict[str, Any]:
    """Global stored window + per-sensor delivery day counts."""
    rows = _rows(
        """SELECT sensor, MIN(acq_date) first, MAX(acq_date) last,
                  COUNT(DISTINCT acq_date) days
           FROM coverage_days GROUP BY sensor"""
    )
    per = {r["sensor"]: {"first": r["first"], "last": r["last"], "days": int(r["days"])}
           for r in rows}
    first = min((v["first"] for v in per.values()), default=None)
    last = max((v["last"] for v in per.values()), default=None)
    enabled = archive_enabled()
    return {
        "first": first,
        "last": last,
        "sensorDays": {k: v["days"] for k, v in per.items()},
        "perSensor": per,
        "archiveEnabled": enabled,
        "archiveNote": ARCHIVE_NOTE_KEY if enabled else ARCHIVE_NOTE_NO_KEY,
        "deliveryMethod": "global product delivery per sensor-day (keyless NRT feeds)",
        "states": STATE_CODES,
    }


# Spatial extent of the ingested product. Delivery rows are recorded per
# sensor-day globally, so they say nothing about whether an AOI outside this
# latitude band was ever observed. Kept in sync with the `global` region bbox in
# regions.py and the FIRMS feed extents in sources.py.
PRODUCT_BBOX = (-180.0, -60.0, 180.0, 75.0)
FOOTPRINT_LABEL = "60S to 75N (the ingested FIRMS product extent)"


def footprint_gap(bbox: Sequence[float]) -> list[str]:
    """Which sides of an AOI fall outside the product's spatial coverage."""
    _, south, _, north = (float(v) for v in bbox)
    gaps: list[str] = []
    if south < PRODUCT_BBOX[1]:
        gaps.append(f"south of {abs(PRODUCT_BBOX[1]):.0f}S")
    if north > PRODUCT_BBOX[3]:
        gaps.append(f"north of {PRODUCT_BBOX[3]:.1f}N".replace(".0N", "N"))
    return gaps


def apply_footprint(states: dict[str, dict[str, Any]], bbox: Sequence[float]) -> list[str]:
    """Downgrade a confirmed zero that the product could not have confirmed.

    "Delivered and nothing detected" is only a zero inside the footprint. For an
    AOI that reaches outside it (Antarctica, the high Arctic), the AOI was never
    observed there, so the day is UNKNOWN, not zero. Mutates and returns the gap
    description for the caller to publish.
    """
    gaps = footprint_gap(bbox)
    if not gaps:
        return gaps
    where = " and ".join(gaps)
    for payload in states.values():
        if payload.get("state") == "observed_zero":
            payload["state"] = "unknown"
            payload["evidence"] = (
                f"no detections recorded, but the AOI extends {where}, outside {FOOTPRINT_LABEL}"
            )
            payload["basis"] = "AOI outside the product footprint - a zero cannot be confirmed here"
            payload["stateLabel"] = STATE_LABELS["unknown"]
    return gaps


def combine_states(states: dict[str, str]) -> str:
    """Day-level state from per-sensor states.

    ``partial`` takes precedence over ``observed``: a day where MODIS reported
    but VIIRS never delivered is incomplete, and calling it "observed" would
    hide that. ``unavailable`` only wins when nothing at all is known.
    """
    values = list(states.values())
    known = [s for s in values if s in ("observed", "observed_zero")]
    if len(known) == len(SENSORS):
        return "observed" if any(s == "observed" for s in values) else "observed_zero"
    if known:
        return "partial"
    if values and all(s == "unavailable" for s in values):
        return "unavailable"
    return "unknown"


def day_states(date_str: str, deliver: dict[str, dict[str, Any]],
               counts: dict[str, int],
               unavailable: dict[str, set[str]] | None = None) -> dict[str, dict[str, Any]]:
    """Per-sensor state for one date given delivery + observed counts."""
    sensors: dict[str, dict[str, Any]] = {}
    for sensor in SENSORS:
        delivery_row = deliver.get(f"{sensor}:{date_str}")
        n = int(counts.get(sensor, 0))
        if delivery_row is None:
            failed = bool(unavailable and date_str in unavailable.get(sensor, set()))
            state = "unavailable" if failed else "unknown"
            sensors[sensor] = {
                "state": state,
                "code": state_code(state),
                "count": 0,
                "evidence": ("a request for this date failed at the source" if failed
                             else "no delivery evidence for this sensor-day"),
                "basis": "stored source failure" if failed else "no global delivery record",
            }
        elif n > 0:
            sensors[sensor] = {
                "state": "observed",
                "code": state_code("observed"),
                "count": n,
                "evidence": f"global delivery: {delivery_row['records']:,} records",
                "basis": "global product delivery + area detections",
            }
        else:
            sensors[sensor] = {
                "state": "observed_zero",
                "code": state_code("observed_zero"),
                "count": 0,
                "evidence": f"global delivery: {delivery_row['records']:,} records, 0 in this area",
                "basis": "global product delivery, conditional zero for this area",
            }
        if delivery_row:
            sensors[sensor]["satellites"] = delivery_row["satellites"]
        sensors[sensor]["satellites"] = sensors[sensor].get("satellites", {})
    return sensors


def date_range(first: str, last: str) -> list[str]:
    a = datetime.strptime(first, "%Y-%m-%d").date()
    b = datetime.strptime(last, "%Y-%m-%d").date()
    out = []
    while a <= b:
        out.append(a.isoformat())
        a += timedelta(days=1)
    return out


def unknown_reason(date_str: str, window_info: dict[str, Any]) -> str:
    first, last = window_info.get("first"), window_info.get("last")
    if not first:
        return "no_ingest"
    if date_str < first:
        return "before_window"
    if date_str > last:
        return "after_window" if date_str <= date.today().isoformat() else "future"
    return "source_gap"


def register_window(source: str, sensor: str | None, satellite: str | None,
                    start_date: str, end_date: str, bbox: str | None,
                    records: int, status: str, message: str | None = None) -> None:
    db.record_coverage_window({
        "source": source, "sensor": sensor, "satellite": satellite,
        "start_date": start_date, "end_date": end_date, "bbox": bbox,
        "requested_at": int(datetime.now(timezone.utc).timestamp() * 1000),
        "records": records, "status": status, "message": message,
    })


def archive_windows(limit: int = 20) -> list[dict[str, Any]]:
    return _rows(
        "SELECT * FROM coverage_windows ORDER BY requested_at DESC LIMIT ?", [limit]
    )
