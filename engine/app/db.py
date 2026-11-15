"""SQLite storage for FIREWATCH AI.

Deliberately small: the platform only needs a fast, indexed store for
near-real-time satellite fire detections plus the ingestion audit trail.
Swap `db.py` for PostGIS when running at production scale.

Phase 1 additions (all additive — existing rows are never rewritten):

* provenance columns on ``observations`` (source identifier, endpoint,
  product, product version, unmodelled source fields, ingestion run);
* ``quality`` ladder marker so raw source values are never mistaken for
  cleaned or derived values;
* ``ingest_checkpoints`` so an interrupted archive run resumes per date;
* chunked transactional writes with lock retry, because a single 795k-row
  transaction produced ``database is locked`` failures (see PHASE_1_AUDIT.md).
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Iterable, Iterator

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data")
DB_PATH = os.environ.get("FIREWATCH_DB", os.path.join(DATA_DIR, "firewatch.db"))

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
    id            TEXT PRIMARY KEY,
    sensor        TEXT NOT NULL,
    instrument    TEXT NOT NULL,
    satellite     TEXT NOT NULL,
    lat           REAL NOT NULL,
    lon           REAL NOT NULL,
    ts            INTEGER NOT NULL,
    acq_date      TEXT NOT NULL,
    acq_time      TEXT NOT NULL,
    confidence_raw TEXT,
    confidence_pct REAL,
    confidence_class TEXT,
    frp           REAL,
    brightness    REAL,
    bright_t31    REAL,
    scan          REAL,
    track         REAL,
    daynight      TEXT,
    version       TEXT,
    source        TEXT NOT NULL,
    cycle         TEXT,
    ingested_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_ts ON observations(ts);
CREATE INDEX IF NOT EXISTS idx_obs_date ON observations(acq_date);
CREATE INDEX IF NOT EXISTS idx_obs_sensor_date ON observations(sensor, acq_date);
CREATE INDEX IF NOT EXISTS idx_obs_latlon ON observations(lat, lon);
-- Covering index for the grid/day aggregation path: lets SQLite answer
-- "one value per cell-day per sensor" from the index alone instead of
-- touching the table for every candidate row.
CREATE INDEX IF NOT EXISTS idx_obs_cover ON observations(lat, lon, acq_date, sensor, frp);

CREATE TABLE IF NOT EXISTS ingest_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,
    sensor      TEXT,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    status      TEXT NOT NULL,
    records     INTEGER DEFAULT 0,
    message     TEXT
);

CREATE TABLE IF NOT EXISTS coverage_days (
    sensor      TEXT NOT NULL,
    satellite   TEXT NOT NULL,
    acq_date    TEXT NOT NULL,
    records     INTEGER NOT NULL,
    source      TEXT,
    first_seen  INTEGER,
    last_seen   INTEGER,
    PRIMARY KEY (sensor, satellite, acq_date)
);
CREATE INDEX IF NOT EXISTS idx_cov_date ON coverage_days(acq_date);

CREATE TABLE IF NOT EXISTS coverage_windows (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT NOT NULL,
    sensor       TEXT,
    satellite    TEXT,
    start_date   TEXT NOT NULL,
    end_date     TEXT NOT NULL,
    bbox         TEXT,
    requested_at INTEGER NOT NULL,
    records      INTEGER DEFAULT 0,
    status       TEXT NOT NULL,
    message      TEXT
);

CREATE TABLE IF NOT EXISTS datasets (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    sensor       TEXT NOT NULL,
    source       TEXT NOT NULL,
    coverage     TEXT,
    first_seen   INTEGER,
    last_seen    INTEGER,
    records      INTEGER,
    status       TEXT,
    note         TEXT
);

CREATE TABLE IF NOT EXISTS ingest_checkpoints (
    source     TEXT NOT NULL,
    date       TEXT NOT NULL,
    status     TEXT NOT NULL,
    records    INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    message    TEXT,
    PRIMARY KEY (source, date)
);
"""

# Provenance columns added in Phase 1.  ``ALTER TABLE ADD COLUMN`` is O(1) in
# SQLite and leaves every existing row untouched (new columns read as NULL).
PROVENANCE_COLUMNS: tuple[tuple[str, str], ...] = (
    ("original_id", "TEXT"),        # identifier supplied by the source (e.g. ArcGIS OBJECTID)
    ("source_url", "TEXT"),         # exact endpoint the record came from (never contains a key)
    ("source_product", "TEXT"),     # product name, e.g. MODIS_C6_1_Global_7d
    ("source_version", "TEXT"),     # product version, distinct from per-record version
    ("extra", "TEXT"),              # JSON of source fields this schema does not model
    ("ingest_run_id", "INTEGER"),   # FK into ingest_runs
    ("quality", "TEXT"),            # raw | clean | aggregate | derived
)

# ``source`` → product name.  The mapping is derived from the endpoint that was
# actually fetched, not invented: these are the files/services named in sources.py.
SOURCE_PRODUCTS: dict[str, str] = {
    "firms-modis-c61": "MODIS_C6_1_Global_7d",
    "firms-modis-c61-24h": "MODIS_C6_1_Global_24h",
    "firms-viirs-375": "Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity",
    "firms-archive": "FIRMS_area_api",
}

WRITE_COLUMNS: tuple[str, ...] = (
    "id", "sensor", "instrument", "satellite", "lat", "lon", "ts", "acq_date", "acq_time",
    "confidence_raw", "confidence_pct", "confidence_class", "frp", "brightness", "bright_t31",
    "scan", "track", "daynight", "version", "source", "cycle", "ingested_at",
    "original_id", "source_url", "source_product", "source_version", "extra",
    "ingest_run_id", "quality",
)


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    # Read-heavy dashboard: a 64 MiB page cache, memory temp tables for GROUP
    # BY, and a 256 MiB memory map keep repeated aggregate scans off the disk.
    conn.execute("PRAGMA cache_size=-65536")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA mmap_size=268435456")
    return conn


@contextmanager
def closing(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def _columns(conn: sqlite3.Connection) -> set[str]:
    return {row[1] for row in conn.execute("PRAGMA table_info(observations)")}


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Apply additive migrations. Idempotent; safe to call on every boot.

    Returns the list of columns that were actually added (empty on a second run).
    """
    existing = _columns(conn)
    added: list[str] = []
    for name, decl in PROVENANCE_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE observations ADD COLUMN {name} {decl}")
            added.append(name)
    if added:
        # Provenance for rows ingested before Phase 1 is *derived from what is
        # already stored* — source product from the source id that was fetched,
        # product version from the per-record version field. Nothing is invented:
        # source_url, original_id and extra stay NULL because that information
        # was never captured and cannot be reconstructed.
        conn.execute("UPDATE observations SET quality='raw' WHERE quality IS NULL")
        conn.execute(
            "UPDATE observations SET source_version = version WHERE source_version IS NULL"
        )
        for source, product in SOURCE_PRODUCTS.items():
            conn.execute(
                "UPDATE observations SET source_product=? WHERE source=? AND source_product IS NULL",
                (product, source),
            )
        conn.execute(
            "UPDATE observations SET source_product = source WHERE source_product IS NULL"
        )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_obs_run ON observations(ingest_run_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_obs_original ON observations(original_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_obs_product ON observations(source_product)")
    return added


def init_db() -> None:
    with closing(connect()) as conn:
        conn.executescript(SCHEMA)
        migrate(conn)
        conn.commit()


# --------------------------------------------------------------------------- #
# Writes
# --------------------------------------------------------------------------- #
def _row_values(r: dict[str, Any]) -> list[Any]:
    values = []
    for col in WRITE_COLUMNS:
        v = r.get(col)
        if col == "extra" and isinstance(v, (dict, list)):
            v = json.dumps(v, separators=(",", ":"), sort_keys=True)
        values.append(v)
    return values


def _write_chunk(conn: sqlite3.Connection, batch: list[list[Any]], retries: int = 4) -> int:
    sql = (
        f"INSERT OR IGNORE INTO observations ({','.join(WRITE_COLUMNS)}) "
        f"VALUES ({','.join('?' for _ in WRITE_COLUMNS)})"
    )
    delay = 0.25
    for attempt in range(retries):
        try:
            cur = conn.executemany(sql, batch)
            conn.commit()
            return cur.rowcount
        except sqlite3.OperationalError as exc:
            conn.rollback()
            if "locked" not in str(exc).lower() or attempt == retries - 1:
                raise
            time.sleep(delay)
            delay *= 2
    return 0


def upsert_observations(
    rows: Iterable[dict[str, Any]],
    *,
    chunk: int = 4000,
    run_id: int | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> int:
    """Insert detections in bounded transactions.

    Duplicate suppression is by primary key (see ``identity`` in sources.py):
    an identical record is ignored, never overwritten, so raw values cannot be
    mutated by a later ingest. Returns the number of newly written rows.
    """
    written = 0
    seen = 0
    batch: list[list[Any]] = []
    with _lock, session() as conn:
        for r in rows:
            if run_id is not None and r.get("ingest_run_id") is None:
                r = {**r, "ingest_run_id": run_id}
            if r.get("quality") is None:
                r = {**r, "quality": "raw"}
            batch.append(_row_values(r))
            if len(batch) >= chunk:
                written += _write_chunk(conn, batch)
                seen += len(batch)
                batch = []
                if on_progress:
                    on_progress(seen, written)
        if batch:
            written += _write_chunk(conn, batch)
            seen += len(batch)
            if on_progress:
                on_progress(seen, written)
    return written


def start_run(source: str, sensor: str | None) -> int:
    with _lock, session() as conn:
        cur = conn.execute(
            "INSERT INTO ingest_runs (source, sensor, started_at, status, records, message)"
            " VALUES (?,?,?,'running',0,NULL)",
            (source, sensor, int(time.time() * 1000)),
        )
        conn.commit()
        return int(cur.lastrowid)


def finish_run(run_id: int, status: str, records: int = 0, message: str | None = None) -> None:
    with _lock, session() as conn:
        conn.execute(
            "UPDATE ingest_runs SET finished_at=?, status=?, records=?, message=? WHERE id=?",
            (int(time.time() * 1000), status, records, (message or "")[:500] or None, run_id),
        )
        conn.commit()


def record_run(source: str, sensor: str | None, started_at: int, status: str,
               records: int = 0, message: str | None = None) -> int:
    """Legacy one-shot run record (kept for callers that do not stream)."""
    with _lock, session() as conn:
        cur = conn.execute(
            "INSERT INTO ingest_runs (source, sensor, started_at, finished_at, status, records, message)"
            " VALUES (?,?,?,?,?,?,?)",
            (source, sensor, started_at, int(time.time() * 1000), status, records, (message or "")[:500] or None),
        )
        conn.commit()
        return int(cur.lastrowid)


def upsert_dataset(ds: dict[str, Any]) -> None:
    with _lock, session() as conn:
        conn.execute(
            """INSERT INTO datasets (id,label,sensor,source,coverage,first_seen,last_seen,records,status,note)
               VALUES (:id,:label,:sensor,:source,:coverage,:first_seen,:last_seen,:records,:status,:note)
               ON CONFLICT(id) DO UPDATE SET
                 coverage=excluded.coverage, first_seen=excluded.first_seen, last_seen=excluded.last_seen,
                 records=excluded.records, status=excluded.status, note=excluded.note""",
            ds,
        )
        conn.commit()


def reconcile_datasets() -> list[dict[str, Any]]:
    """Make ``datasets.records`` reflect rows actually stored, not rows fetched."""
    with _lock, session() as conn:
        rows = conn.execute(
            """SELECT d.id,
                      (SELECT COUNT(*) FROM observations o WHERE o.source = d.source) stored,
                      (SELECT MIN(acq_date) FROM observations o WHERE o.source = d.source) first_date,
                      (SELECT MAX(acq_date) FROM observations o WHERE o.source = d.source) last_date
               FROM datasets d"""
        ).fetchall()
        out = []
        for r in rows:
            coverage = (
                f"{r['first_date']} -> {r['last_date']}" if r["first_date"] else "no rows"
            )
            conn.execute(
                "UPDATE datasets SET records=?, coverage=? WHERE id=?",
                (int(r["stored"] or 0), coverage, r["id"]),
            )
            out.append({"id": r["id"], "stored": int(r["stored"] or 0), "coverage": coverage})
        conn.commit()
        return out


def rebuild_coverage() -> int:
    """Materialise per sensor/satellite/day product-delivery evidence.

    A polar-orbiting sensor that delivered any record anywhere on a date proves
    the swath/product existed for that date. This is the only keyless delivery
    signal available, and it is deliberately conservative: zero global records
    means UNKNOWN delivery, never "zero activity".
    """
    with _lock, session() as conn:
        conn.execute("DELETE FROM coverage_days")
        conn.execute(
            """INSERT INTO coverage_days (sensor, satellite, acq_date, records, source, first_seen, last_seen)
               SELECT sensor, satellite, acq_date, COUNT(*), MAX(source),
                      MIN(ingested_at), MAX(ingested_at)
               FROM observations
               GROUP BY sensor, satellite, acq_date"""
        )
        n = conn.execute("SELECT COUNT(*) FROM coverage_days").fetchone()[0]
        conn.commit()
        return int(n)


def coverage_day_count() -> int:
    with session() as conn:
        row = conn.execute("SELECT COUNT(*) FROM coverage_days").fetchone()
        return int(row[0]) if row else 0


def record_coverage_window(win: dict[str, Any]) -> None:
    with _lock, session() as conn:
        conn.execute(
            """INSERT INTO coverage_windows
               (source, sensor, satellite, start_date, end_date, bbox, requested_at, records, status, message)
               VALUES (:source,:sensor,:satellite,:start_date,:end_date,:bbox,:requested_at,:records,:status,:message)""",
            win,
        )
        conn.commit()


def set_checkpoint(source: str, date: str, status: str, records: int = 0,
                   message: str | None = None) -> None:
    with _lock, session() as conn:
        conn.execute(
            """INSERT INTO ingest_checkpoints (source,date,status,records,updated_at,message)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(source,date) DO UPDATE SET
                 status=excluded.status, records=excluded.records,
                 updated_at=excluded.updated_at, message=excluded.message""",
            (source, date, status, records, int(time.time() * 1000), (message or "")[:400] or None),
        )
        conn.commit()


def checkpoints(source: str, status: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM ingest_checkpoints WHERE source=?"
    params: list[Any] = [source]
    if status:
        sql += " AND status=?"
        params.append(status)
    sql += " ORDER BY date"
    with session() as conn:
        return [dict(r) for r in conn.execute(sql, params)]


def table_counts() -> dict[str, int]:
    with session() as conn:
        total = conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0]
        modis = conn.execute("SELECT COUNT(*) FROM observations WHERE sensor='modis'").fetchone()[0]
    return {"observations": total, "modis": modis, "viirs": total - modis}


def integrity_check() -> dict[str, Any]:
    """Cheap integrity probe exposed by the status endpoint."""
    with session() as conn:
        ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
        nulls = conn.execute(
            "SELECT SUM(lat IS NULL OR lon IS NULL) bad_coords,"
            " SUM(acq_date IS NULL OR ts IS NULL) missing_time,"
            " SUM(sensor NOT IN ('modis','viirs')) bad_sensor,"
            " SUM(source IS NULL) missing_source"
            " FROM observations"
        ).fetchone()
    return {
        "integrity": ok,
        "badCoords": int(nulls["bad_coords"] or 0),
        "missingTime": int(nulls["missing_time"] or 0),
        "badSensor": int(nulls["bad_sensor"] or 0),
        "missingSource": int(nulls["missing_source"] or 0),
    }
