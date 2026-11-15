# Data Schema

Storage: a single SQLite file at `data/firewatch.db` (override with `FIREWATCH_DB`).
The engine is the only writer; the Next.js frontend never opens the file.

Phase 1 changed the schema **additively**. Every pre-existing table and column
is unchanged; new columns are nullable and new tables are created with
`IF NOT EXISTS`. `db.migrate()` is idempotent and returns the list of changes it
made (empty when the database is current).

---

## `observations` — one row per raw satellite detection

Rows are **immutable**. `INSERT OR IGNORE` on the primary key means re-ingesting
the same detection can never rewrite a stored value; if the source later reports
a different FRP for the same identity, the first stored value wins and the
discrepancy is visible in `ingest_runs`.

| column | type | meaning |
| --- | --- | --- |
| `id` | TEXT PK | deterministic identity, see below |
| `sensor` | TEXT | `modis` \| `viirs` (only these two exist) |
| `instrument` | TEXT | `MODIS Terra`, `MODIS Aqua`, `VIIRS 375 m` |
| `satellite` | TEXT | `Terra`, `Aqua`, `NOAA-20`, `NOAA-21`, `Suomi-NPP` |
| `lat`, `lon` | REAL | WGS84, stored at 5 decimals (~1.1 m) |
| `ts` | INTEGER | UTC epoch **milliseconds** of acquisition |
| `acq_date` | TEXT | UTC acquisition date `YYYY-MM-DD` (the date dimension) |
| `acq_time` | TEXT | UTC `HH:MM` as reported, not timezone-shifted |
| `confidence_raw` | TEXT | **verbatim** source value: MODIS `0–100`, VIIRS `l`/`n`/`h` |
| `confidence_pct` | REAL | MODIS only; `NULL` for every VIIRS row — never synthesised |
| `confidence_class` | TEXT | `low` \| `nominal` \| `high`; MODIS derived from the documented bands |
| `frp` | REAL | fire radiative power, MW, as reported. `0` is preserved as `0`; missing stays `NULL` |
| `brightness` | REAL | MODIS band 21/22 brightness temperature (K), or VIIRS I-4 (K) |
| `bright_t31` | REAL | MODIS band 31 / VIIRS I-5 brightness temperature (K) |
| `scan`, `track` | REAL | pixel footprint at nadir (km) — 1 km MODIS, 0.375 km VIIRS |
| `daynight` | TEXT | `D` \| `N` \| `NULL` |
| `version` | TEXT | per-record product version string as delivered |
| `source` | TEXT | ingest source id (`firms-modis-c61`, `firms-viirs-375`, `firms-archive`) |
| `cycle` | TEXT | `nrt` \| `archive` |
| `ingested_at` | INTEGER | epoch ms when this row was written |
| `original_id` | TEXT | source-supplied identifier (e.g. ArcGIS `OBJECTID`); `NULL` when the feed provides none |
| `source_url` | TEXT | exact endpoint fetched, **with any key removed** |
| `source_product` | TEXT | product name, e.g. `MODIS_C6_1_Global_7d` |
| `source_version` | TEXT | product version (distinct from the per-record `version`) |
| `extra` | TEXT | JSON object of source fields this schema does not model |
| `ingest_run_id` | INTEGER | which `ingest_runs` row wrote it (`NULL` for pre-Phase-1 rows) |
| `quality` | TEXT | `raw` for everything ingested; `clean`/`aggregate`/`derived` are reserved for computed tables |

**Identity (`id`)** — `MOD:<satellite>:<lat>:<lon>:<ts>` / `VII:<satellite>:<lat>:<lon>:<ts>`.
It is a content fingerprint of sensor + platform + position (4 decimals,
~11 m, so sub-pixel jitter between deliveries collapses) + acquisition second,
so a detection delivered twice (paging overlap, repeated 7-day pulls,
archive re-fetch) collapses to one row. It is *not* the source's own id; that is
preserved separately in `original_id`. Two sensors can never collide because the
prefix differs.

Indexes: `ts`, `acq_date`, `(sensor, acq_date)`, `(lat, lon)` — the last one
serves the bounding-box scans the API performs.

## `ingest_runs` — one row per ingestion attempt

| column | meaning |
| --- | --- |
| `id` | run id, referenced by `observations.ingest_run_id` |
| `source`, `sensor` | what was attempted |
| `started_at`, `finished_at` | epoch ms; `finished_at` is `NULL` while running |
| `status` | `running` \| `ok` \| `partial` \| `auth` \| `rate_limited` \| `invalid` \| `unavailable` \| `error` \| `dry-run` |
| `records` | rows actually written (not fetched) |
| `message` | human-readable outcome, **always redacted** of any API key |

A crash leaves a `running` row with no `finished_at`: an interrupted run is
visible rather than silent.

## `coverage_days` — product-delivery evidence

Derived from `observations` by `db.rebuild_coverage()`; never edited by hand.
One row per `(sensor, satellite, acq_date)` with the record count and source.
It answers "did this product deliver anything on this day?" — the only input to
the coverage-state model. See `docs/COVERAGE_METHODOLOGY.md`.

## `coverage_windows` — explicit requests and their outcomes

| column | meaning |
| --- | --- |
| `source`, `sensor`, `satellite` | what was requested |
| `start_date`, `end_date`, `bbox` | the requested window / area |
| `requested_at` | epoch ms |
| `records` | rows returned |
| `status` | `ok` or a failure status from the list above |
| `message` | redacted failure detail |

Archive runs write one row per date. A failed window is what upgrades a day from
`COVERAGE_UNKNOWN` to `PRODUCT_UNAVAILABLE`.

## `ingest_checkpoints` — resumable backfill

Primary key `(source, date)`, holding `status`, `records`, `updated_at`,
`message`. A completed date is skipped on a re-run unless `--no-resume` is
passed, so a 30-day backfill that fails on day 12 resumes at day 12.

## `datasets` — per-source rollup for the UI

`records` is **reconciled against stored rows** (`db.reconcile_datasets()`), not
against rows fetched. That removed the historical drift where VIIRS reported
795,290 fetched while 795,243 were stored.

---

## Retention and reproduction

* Raw rows are never deleted by the application. Backfill adds, it does not
  replace.
* The pre-Phase-1 snapshot lives at `data/firewatch.pre-phase1.db`
  (316.6 MB, 871,357 rows) and is the restore point for schema work.
* Rebuilding derived tables is always safe:
  `db.rebuild_coverage()` and `db.reconcile_datasets()` recompute from
  `observations`.
