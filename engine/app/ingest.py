"""Ingestion orchestration + CLI.

Usage
-----
    python -m engine.app.ingest --all
    python -m engine.app.ingest --modis
    python -m engine.app.ingest --viirs
    python -m engine.app.ingest --all --dry-run
    python -m engine.app.ingest --archive 2024-08-01 7 --source VIIRS_NOAA20_NRT --bbox -74,-14,-44,5

Design
------
* The CLI is the only place that talks to the network on a schedule; the API
  reads from SQLite and never blocks on NASA.
* Every run is recorded with a *run id* before any row is written, so an
  interrupted run is visible as ``status='interrupted'`` instead of vanishing.
* Rows are written in bounded chunks inside their own transactions; a failure
  keeps everything already committed and never leaves a half-written batch.
* Archive runs checkpoint per date, so re-running the same command resumes
  instead of re-downloading.
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterable

from . import config, db
from . import coverage as cov
from .scientific import cache_clear
from .sources import (
    SOURCES, SourceError, fetch_firms_archive, fetch_modis_7d, fetch_viirs, redact,
)


def _dataset_row(source_id: str, sensor: str, status: str, records: int,
                 coverage_text: str | None, note: str | None) -> dict[str, Any]:
    return {
        "id": source_id,
        "label": next((s["label"] for s in SOURCES if s["id"] == source_id), source_id),
        "sensor": sensor,
        "source": source_id,
        "coverage": coverage_text,
        "first_seen": None,
        "last_seen": int(time.time() * 1000) if records else None,
        "records": records,
        "status": status,
        "note": note,
    }


def _ingest_source(source_id: str, fetcher: Callable[[], list[dict[str, Any]]],
                   sensor: str, *, dry_run: bool = False,
                   chunk: int = 4000, verbose: bool = True) -> dict[str, Any]:
    run_id = db.start_run(source_id, sensor)
    t0 = time.time()
    progress: list[int] = [0, 0]

    def on_progress(seen: int, written: int) -> None:
        progress[0], progress[1] = seen, written
        if verbose and seen and seen % 50000 < chunk:
            print(f"  {source_id}: {seen:,} read / {written:,} new", flush=True)

    try:
        rows = fetcher()
        fetched = len(rows)
        if dry_run:
            db.finish_run(run_id, "dry-run", 0, f"{fetched} rows fetched, nothing written")
            return {"source": source_id, "fetched": fetched, "written": 0, "dryRun": True,
                    "seconds": round(time.time() - t0, 1)}

        written = db.upsert_observations(rows, chunk=chunk, run_id=run_id, on_progress=on_progress)
        cache_clear()
        n = cov.refresh()
        dates = sorted({r["acq_date"] for r in rows}) if rows else []
        for d in dates:
            db.set_checkpoint(source_id, d, "complete", sum(1 for r in rows if r["acq_date"] == d))
        db.finish_run(run_id, "ok", written, f"{written} new of {fetched} fetched")
        db.upsert_dataset(_dataset_row(
            source_id, sensor, "ok", fetched,
            f"{dates[0]} -> {dates[-1]}" if dates else "no rows",
            None if written or not fetched else "no new rows (already stored)",
        ))
        db.reconcile_datasets()
        return {"source": source_id, "fetched": fetched, "written": written,
                "dates": dates, "coverageDays": n, "runId": run_id,
                "seconds": round(time.time() - t0, 1)}
    except SourceError as exc:
        message = redact(str(exc))
        db.finish_run(run_id, exc.status, progress[1], message)
        db.upsert_dataset(_dataset_row(source_id, sensor, exc.status, progress[0], None, message[:300]))
        return {"source": source_id, "error": message, "status": exc.status,
                "written": progress[1], "runId": run_id, "seconds": round(time.time() - t0, 1)}
    except Exception as exc:  # noqa: BLE001 - surfaced to the operator/UI
        message = redact(str(exc))
        db.finish_run(run_id, "error", progress[1], message)
        db.upsert_dataset(_dataset_row(source_id, sensor, "error", progress[0], None, message[:300]))
        return {"source": source_id, "error": message, "status": "error",
                "written": progress[1], "runId": run_id, "seconds": round(time.time() - t0, 1)}


def ingest_all(viirs_max_pages: int = 80, *, dry_run: bool = False,
               chunk: int = 4000) -> dict[str, Any]:
    config.bootstrap()
    db.init_db()
    results = [
        _ingest_source("firms-modis-c61", fetch_modis_7d, "modis", dry_run=dry_run, chunk=chunk),
        _ingest_source("firms-viirs-375",
                       lambda: fetch_viirs(max_pages=viirs_max_pages), "viirs",
                       dry_run=dry_run, chunk=chunk),
    ]
    return {"ran_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "results": results, "totals": db.table_counts()}


def ingest_archive(source: str, date: str, days: int,
                   bbox: tuple[float, float, float, float],
                   *, resume: bool = True, chunk: int = 4000) -> dict[str, Any]:
    """Backfill a bounded date range, one date per request, with checkpoints."""
    config.bootstrap()
    db.init_db()
    sensor = "modis" if source.upper().startswith("MODIS") else "viirs"
    start = datetime.strptime(date, "%Y-%m-%d").date()
    completed = {c["date"] for c in db.checkpoints(f"firms-archive:{source}", "complete")}
    all_rows: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    skipped = 0
    run_id = db.start_run(f"firms-archive:{source}", sensor)
    t0 = time.time()

    try:
        for i in range(max(1, days)):
            day = (start + timedelta(days=i)).isoformat()
            if resume and day in completed:
                skipped += 1
                continue
            try:
                rows = fetch_firms_archive(source, bbox, day, 1)
            except SourceError as exc:
                message = redact(str(exc))
                db.set_checkpoint(f"firms-archive:{source}", day, exc.status, 0, message)
                failed.append({"date": day, "status": exc.status, "message": message})
                if exc.status in ("auth", "invalid"):
                    break  # a bad key or a rejected range will not improve per date
                continue
            written = db.upsert_observations(rows, chunk=chunk, run_id=run_id)
            db.set_checkpoint(f"firms-archive:{source}", day, "complete", len(rows),
                              f"{written} new of {len(rows)} fetched")
            all_rows.extend(rows)
            cov.register_window(f"firms-archive:{source}", sensor, None, day, day,
                                ",".join(str(v) for v in bbox), len(rows), "ok", None)
            print(f"  {day}: {len(rows):,} rows ({written:,} new)", flush=True)

        cache_clear()
        cov.refresh()
        status = "ok" if not failed else ("partial" if all_rows else failed[0]["status"])
        db.finish_run(run_id, status, len(all_rows),
                      f"{len(all_rows)} rows over {len(all_rows)} dates; {len(failed)} failed")
        db.upsert_dataset(_dataset_row(
            f"firms-archive:{source}", sensor, status, len(all_rows),
            f"{date} +{days - 1}d" if all_rows else None,
            f"{len(failed)} dates failed" if failed else None,
        ))
        db.reconcile_datasets()
        return {"source": source, "dates": days, "skipped": skipped, "rows": len(all_rows),
                "failed": failed, "status": status, "runId": run_id,
                "seconds": round(time.time() - t0, 1)}
    except Exception as exc:
        message = redact(str(exc))
        db.finish_run(run_id, "error", len(all_rows), message)
        return {"source": source, "error": message, "status": "error", "runId": run_id}


def parse_bbox(text: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be west,south,east,north")
    try:
        w, s, e, n = (float(p) for p in parts)
    except ValueError as exc:
        raise ValueError("bbox values must be numbers") from exc
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise ValueError("bbox out of range or inverted")
    return w, s, e, n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="FIREWATCH AI ingestion")
    ap.add_argument("--all", action="store_true", help="ingest every open feed")
    ap.add_argument("--modis", action="store_true")
    ap.add_argument("--viirs", action="store_true")
    ap.add_argument("--archive", nargs="+", metavar="DATE",
                    help="archive start date [days] via FIRMS area API")
    ap.add_argument("--source", default="VIIRS_NOAA20_NRT")
    ap.add_argument("--bbox", default="-180,-60,180,75")
    ap.add_argument("--max-pages", type=int, default=80)
    ap.add_argument("--chunk", type=int, default=4000)
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch and validate, write nothing")
    ap.add_argument("--no-resume", action="store_true",
                    help="ignore archive checkpoints and re-fetch every date")
    args = ap.parse_args(argv)

    config.bootstrap()
    db.init_db()
    print("config:", config.report(), flush=True)

    out: dict[str, Any] = {}
    if args.all or args.modis:
        out["modis"] = _ingest_source("firms-modis-c61", fetch_modis_7d, "modis",
                                      dry_run=args.dry_run, chunk=args.chunk)
    if args.all or args.viirs:
        out["viirs"] = _ingest_source("firms-viirs-375",
                                      lambda: fetch_viirs(max_pages=args.max_pages), "viirs",
                                      dry_run=args.dry_run, chunk=args.chunk)
    if args.archive:
        date = args.archive[0]
        days = int(args.archive[1]) if len(args.archive) > 1 else 1
        bbox = parse_bbox(args.bbox)
        out["archive"] = ingest_archive(args.source, date, days, bbox,
                                        resume=not args.no_resume, chunk=args.chunk)
    if not out:
        ap.print_help()
        return 1
    for k, v in out.items():
        print(f"{k}: {redact(v)}")
    print("counts:", db.table_counts())
    return 0


if __name__ == "__main__":
    sys.exit(main())
