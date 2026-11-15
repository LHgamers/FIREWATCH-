"""Hourly NASA refresh check + data-freshness reporting.

The brief asks for two different things that are easy to conflate:

1. **The site checks the source every hour.**  That is a scheduler, and it is
   implemented here.
2. **NASA publishes new observations every hour.**  That is false.  MODIS/VIIRS
   near-real-time feeds update every few hours per platform, and the open CSV
   drop is a rolling window.  An hourly *check* therefore often finds no new
   rows — which is a success, not a failure, and is reported as such.

Design:

* A daemon thread sleeps `FIREWATCH_REFRESH_SECONDS` (default 3600) between
  checks, with an initial delay so it never competes with the engine's warm-up.
* Each check calls the existing `ingest_all`, which is idempotent (rows are
  de-duplicated by source id) and bounded (`viirs_max_pages`).
* Only one check may run at a time.  The manual `POST /api/ingest` route and the
  scheduler share the same `busy` callable, so a user click cannot start a
  second overlapping download.
* Failures are recorded, never raised: the API keeps serving stored data and the
  UI shows the last successful check plus a stale warning.
* Observation time, ingestion time and last successful check are three separate
  fields everywhere.  Nothing is renamed to look newer.

Run `POST /api/freshness/check` to trigger a check immediately.
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

from . import db
from . import scientific as sci

DEFAULT_INTERVAL_S = 3600
DEFAULT_INITIAL_DELAY_S = 120
VIIRS_PAGE_CAP = 20  # keep an unattended hourly check light on the source

_state: dict[str, Any] = {
    "enabled": False,
    "intervalSeconds": DEFAULT_INTERVAL_S,
    "running": False,
    "started": False,
    "lastCheckAt": None,
    "lastSuccessAt": None,
    "lastError": None,
    "lastResult": None,
    "consecutiveFailures": 0,
    "checks": 0,
    "nextCheckAt": None,
}
_lock = threading.Lock()
_thread: threading.Thread | None = None
_busy: Callable[[], bool] | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _summarise(result: dict[str, Any]) -> dict[str, Any]:
    """Reduce ingest_all's result to what a status endpoint needs."""
    rows: list[dict[str, Any]] = []
    succeeded = 0
    for item in result.get("results", []) or []:
        source = item.get("source")
        error = item.get("error")
        status = "error" if error else "ok"
        if not error:
            succeeded += 1
        rows.append(
            {
                "source": source,
                "status": status,
                "fetched": item.get("fetched"),
                "written": item.get("written"),
                "seconds": item.get("seconds"),
                "error": (str(error)[:300] if error else None),
            }
        )
    return {
        "ranAt": result.get("ran_at"),
        "sources": rows,
        "succeeded": succeeded,
        "failed": len(rows) - succeeded,
    }


def run_check(*, manual: bool = False) -> dict[str, Any]:
    """Run one refresh check synchronously. Returns its summary."""
    if _busy is not None and _busy():
        return {"status": "busy", "note": "another ingest is already running"}
    with _lock:
        if _state["running"]:
            return {"status": "busy", "note": "a freshness check is already running"}
        _state["running"] = True
        _state["lastCheckAt"] = _now_iso()
        _state["checks"] += 1
    started = time.time()
    try:
        from .ingest import ingest_all

        result = ingest_all(viirs_max_pages=VIIRS_PAGE_CAP)
        summary = _summarise(result)
        if summary["succeeded"] == 0:
            raise RuntimeError("every source failed: " + "; ".join(
                f"{s['source']}: {s['error']}" for s in summary["sources"]
            ))
        with _lock:
            _state["lastSuccessAt"] = _now_iso()
            _state["lastError"] = None
            _state["consecutiveFailures"] = 0
            _state["lastResult"] = summary
        return {
            "status": "ok",
            "manual": manual,
            "seconds": round(time.time() - started, 1),
            "summary": summary,
        }
    except Exception as exc:  # noqa: BLE001 - a failed check must not kill the loop
        message = str(exc)[:400]
        with _lock:
            _state["lastError"] = message
            _state["consecutiveFailures"] += 1
        return {
            "status": "error",
            "manual": manual,
            "seconds": round(time.time() - started, 1),
            "error": message,
        }
    finally:
        with _lock:
            _state["running"] = False


def _loop(initial_delay: int, interval: int) -> None:
    time.sleep(max(5, initial_delay))
    while True:
        with _lock:
            _state["nextCheckAt"] = _now_iso()
        run_check()
        with _lock:
            _state["nextCheckAt"] = datetime.fromtimestamp(
                time.time() + interval, timezone.utc
            ).isoformat()
        time.sleep(interval)


def start_scheduler(busy: Callable[[], bool] | None = None) -> bool:
    """Start the hourly check loop. Idempotent; returns False when disabled."""
    global _thread, _busy
    if os.environ.get("FIREWATCH_REFRESH_DISABLED") == "1":
        with _lock:
            _state["enabled"] = False
        return False
    try:
        interval = max(300, int(os.environ.get("FIREWATCH_REFRESH_SECONDS", DEFAULT_INTERVAL_S)))
        initial = max(5, int(os.environ.get("FIREWATCH_REFRESH_INITIAL_DELAY", DEFAULT_INITIAL_DELAY_S)))
    except ValueError:
        interval, initial = DEFAULT_INTERVAL_S, DEFAULT_INITIAL_DELAY_S

    _busy = busy
    with _lock:
        if _state["started"]:
            return True
        _state.update(
            enabled=True,
            intervalSeconds=interval,
            started=True,
            nextCheckAt=datetime.fromtimestamp(time.time() + initial, timezone.utc).isoformat(),
        )
    _thread = threading.Thread(target=_loop, args=(initial, interval),
                               name="firewatch-refresh", daemon=True)
    _thread.start()
    return True


def _source_runs() -> list[dict[str, Any]]:
    with db.session() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT source, sensor, status, records, started_at, finished_at, message"
            " FROM ingest_runs ORDER BY id DESC LIMIT 20"
        ).fetchall()]
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        latest.setdefault(row["source"], row)
    out = []
    for source, row in latest.items():
        out.append(
            {
                "source": source,
                "sensor": row["sensor"],
                "status": row["status"],
                "records": row["records"],
                "startedAt": row["started_at"],
                "finishedAt": row["finished_at"],
                "message": (row["message"] or "")[:200] or None,
            }
        )
    return out


def status() -> dict[str, Any]:
    """Data freshness, with the three clocks kept distinct."""
    cov = sci.coverage()
    now = time.time()
    last_success = _state["lastSuccessAt"]
    age = None if not last_success else int(now - (_ts(last_success) or now))
    readers = cov.get("sensors", {})
    ingested = [v.get("ingestedAt") for v in readers.values() if v and v.get("ingestedAt")]
    last_ingest = max(ingested) if ingested else None

    if last_success is None:
        state = "never-checked"
    elif age is not None and age <= max(7200, _state["intervalSeconds"] * 3):
        state = "fresh"
    else:
        state = "stale"

    return {
        "generatedAt": _now_iso(),
        "state": state,
        "observationWindow": {
            "first": cov.get("first"),
            "last": cov.get("last"),
            "days": len(cov.get("days", [])),
            "note": "Observation dates are acquisition dates from NASA, never adjusted.",
        },
        "lastIngest": last_ingest,
        "lastSuccessAt": last_success,
        "lastCheckAt": _state["lastCheckAt"],
        "nextCheckAt": _state["nextCheckAt"],
        "lastError": _state["lastError"],
        "consecutiveFailures": _state["consecutiveFailures"],
        "checks": _state["checks"],
        "running": _state["running"],
        "scheduler": {
            "enabled": _state["enabled"],
            "intervalSeconds": _state["intervalSeconds"],
            "note": (
                "The engine checks the NASA feeds on this interval. It does not claim that "
                "NASA publishes new observations that often: a check that finds no new rows "
                "is recorded as a successful check with zero new records."
            ),
        },
        "sources": _source_runs(),
        "archiveEnabled": cov.get("archiveEnabled"),
        "archiveNote": cov.get("archiveNote"),
    }
