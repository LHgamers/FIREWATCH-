# Data Provenance

Every stored detection can be traced back to the exact request that produced it,
and every derived number can be recomputed from stored rows. This document
states what is recorded, what is *not* recorded, and where the boundary sits.

---

## The chain

```
NASA source (CSV file | ArcGIS FeatureServer | FIRMS Area API)
        │  fetch (retries, backoff, key redaction)
        ▼
parser (sources.parse_modis_csv / parse_viirs_csv / ArcGIS mapping)
        │  emits identity + native fields + provenance fields
        ▼
ingest_run  (id, source, sensor, started_at, status, records, message)
        │
        ├──► observations  (ingest_run_id → ingest_runs.id, quality='raw')
        └──► ingest_checkpoints (per-date status, resumable)
                     │
                     ▼
        coverage_days (delivery evidence)  ──►  coverage states in the API
                     │
                     ▼
        scientific aggregates (summary, cells, harmonization, calendar)
```

## What is stored per row

| field | example | notes |
| --- | --- | --- |
| `original_id` | `1` (ArcGIS `OBJECTID`) | only when the source supplies an identifier; MODIS CSV supplies none → `NULL` |
| `source_url` | `https://services9.arcgis.com/.../FeatureServer/0/query` | the endpoint actually fetched, with any key stripped |
| `source_product` | `MODIS_C6_1_Global_7d`, `Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity`, `FIRMS_area_api` | derived from the endpoint, not guessed |
| `source_version` | `6.1NRT`, `2.0NRT` | product-level version string as delivered |
| `extra` | `{"hours_old": 182}` | JSON of source fields the schema does not model |
| `ingest_run_id` | `5` | which run wrote it |
| `quality` | `raw` | everything ingested is raw; no row is ever relabelled |

`extra` is where unmodelled source fields survive instead of being discarded.
Two examples currently in use: ArcGIS `hours_old`, and the raw FIRMS platform
token (`satellite_code`) when a short code was expanded to a platform name.
`type` (fire/volcano/other, where the feed provides it) is also carried here
because the schema has no dedicated column for it — dropping it would have been
silent data loss.

## What is deliberately *not* claimed

* **No invented precision.** A missing FRP stays `NULL`. A zero FRP stays `0`.
  VIIRS `confidence_pct` stays `NULL` rather than being mapped from `l/n/h`.
* **No invented identifiers.** When the source provides no row id, none is
  manufactured as `original_id`; the deterministic content identity lives in
  `id` and is documented as such.
* **No back-filled provenance.** Pre-Phase-1 rows (871,357 of them) have
  `ingest_run_id = NULL`, `original_id = NULL`, `extra = NULL`. Their
  `source_product` and `source_version` were filled from the source id and the
  stored per-record version — facts already present in each row — never guessed.
  The migration report states exactly this.
* **No cross-sensor substitution.** A MODIS row is never used to stand in for a
  missing VIIRS row, and vice versa.

## Reproducing a number

1. `GET /api/sources/status` → per-source `status`, `lastRun`, `stored` counts,
   and the dataset rollup.
2. `GET /api/integrity` → `PRAGMA integrity_check`, plus coordinate, timestamp,
   sensor and source sanity counters.
3. `SELECT * FROM observations WHERE ingest_run_id = <id>` reproduces exactly
   what a given run contributed.
4. `db.rebuild_coverage()` recomputes delivery evidence; `db.reconcile_datasets()`
   recomputes `datasets.records` from stored rows.

## Failure is recorded, not hidden

| situation | what is stored |
| --- | --- |
| HTTP 401/403 | run `status='auth'`, redacted message |
| HTTP 429 | run `status='rate_limited'`, `Retry-After` honoured before retrying |
| HTTP 400 / malformed body | run `status='invalid'` |
| HTTP 5xx after retries | run `status='unavailable'` |
| network exception | run `status='error'` |
| process killed mid-run | run left `status='running'`, `finished_at IS NULL` |
| database lock | chunk retried with backoff; if it still fails, `status='error'` and committed chunks are kept |

A failure never produces a `0` in the data. It produces a `PRODUCT_UNAVAILABLE`
or `COVERAGE_UNKNOWN` state for that sensor-day, which the UI renders as
"unknown", never as "no fire".

## Verified provenance (this build)

| check | result |
| --- | --- |
| rows with `ingest_run_id` set | 3,284 (all rows from the Phase-1 verification run) |
| rows with `original_id` (VIIRS, ArcGIS) | present, e.g. `original_id = "1"` for the first page |
| rows with `extra` populated | VIIRS: `{"hours_old": 182}`; FIRMS CSV: `satellite_code` |
| `source_url` containing a key | 0 (redacted at construction) |
| duplicate identities | 0 (874,641 rows, 874,641 distinct ids) |
| rows relabelled from `raw` | 0 |
| datasets drift after reconciliation | 0 (`firms-modis-c61` 79,398 · `firms-viirs-375` 795,243, both equal to stored rows) |
| `PRAGMA integrity_check` | `ok` |
