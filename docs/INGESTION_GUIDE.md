# Ingestion Guide

How to run, monitor, resume and repair NASA ingestion for FIREWATCH AI.

Everything below runs on Windows (PowerShell or Git Bash) with the engine's
Python environment. The engine (`:8010`) is the only writer; the Next.js app
(`:3000`) reads through it.

---

## 1. Configuration

Copy `.env.example` to `.env` (or `.env.local`) in the repository root:

```ini
ENGINE_URL=http://127.0.0.1:8010
ENGINE_PORT=8010
FIRMS_MAP_KEY=            # optional: unlocks the historical archive
AI_PROVIDER=none
AI_BASE_URL=http://127.0.0.1:11434
AI_MODEL=
```

Rules enforced by `engine/app/config.py`:

* `.env.local` is read before `.env`; **a real environment variable always wins**.
* `FIRMS_MAP_KEY` is validated: empty or placeholder values (`your-key-here`,
  `changeme`, too short) are reported as *configured but not valid*, and archive
  requests refuse to start.
* The key is registered with `sources.register_secret()` at bootstrap and is
  redacted from every URL and error string before it can reach the database, an
  API response or a log line.
* The key never leaves the engine. No frontend code reads it; no endpoint
  returns it.

Check what the engine sees:

```bash
curl -s http://127.0.0.1:8010/api/sources/status | python -m json.tool
```

## 2. Start the engine

```bash
python engine/run.py            # http://127.0.0.1:8010
```

Startup runs `config.bootstrap()`, `db.init_db()` (idempotent, additive
migration), `coverage.ensure()` and a background cache warm-up.

## 3. NRT refresh (open feeds, no key)

```bash
python -m engine.app.ingest --all
python -m engine.app.ingest --modis
python -m engine.app.ingest --viirs --max-pages 20
python -m engine.app.ingest --all --dry-run      # fetch + parse, write nothing
```

* MODIS C6.1 Global 7-day CSV is one request (≈80k rows).
* VIIRS is keyset-paged by `OBJECTID`, 8,000 rows per page; `--max-pages` bounds
  the work (default 80, hard ceiling 140).
* Writes are chunked (default 4,000 rows/transaction) with lock retry and
  backoff, so a single page can never open one giant transaction again — the
  exact failure recorded as run 3, `database is locked`.
* Each run opens an `ingest_runs` row first and closes it with a status.

Via the API:

```bash
curl -X POST "http://127.0.0.1:8010/api/ingest"                        # background
curl -X POST "http://127.0.0.1:8010/api/ingest?synchronous=true&viirs_max_pages=1"
```

Both paths are bounded. `viirs_max_pages` is capped at 140.

## 4. Archive backfill (needs `FIRMS_MAP_KEY`)

```bash
python -m engine.app.ingest --archive 2024-08-01 7 \
    --source VIIRS_NOAA20_NRT --bbox -74,-14,-44,5
```

* `--archive <start-date> [days]`; at most one request per date.
* Every date is checkpointed in `ingest_checkpoints` with its status, so
  re-running the same command **resumes** and skips completed dates.
  `--no-resume` forces a re-fetch.
* A failed date is recorded with its failure class and the run continues, except
  for `auth`/`invalid`, where the run stops because every remaining date would
  fail identically.
* Archive rows are marked `cycle='archive'` and keep their own `source_url`,
  `source_product='FIRMS_area_api'` and `ingest_run_id`.

Via the API (explicit confirmation required):

```bash
curl -X POST http://127.0.0.1:8010/api/ingest/archive \
  -H 'Content-Type: application/json' \
  -d '{"source":"VIIRS_NOAA20_NRT","start":"2024-08-01","days":7,"bbox":"-74,-14,-44,5","confirm":true}'
```

Refusals: missing `confirm` → 400; missing key → 400; bad date or bbox → 400;
`days` outside 1–31 → 422.

## 5. Monitoring

| endpoint | shows |
| --- | --- |
| `GET /api/health` | engine up, row count, AI mode |
| `GET /api/sources/status` | per-source status, last run, stored counts, dataset rollup, config |
| `GET /api/integrity` | `PRAGMA integrity_check` + coordinate/time/sensor/source counters |
| `GET /api/coverage` | delivery window, per-sensor days, state legend, archive windows |
| `GET /api/meta` | everything the UI needs in one call (sources, runs, config, AI) |

Status values: `ok`, `running`, `stale` (last good run > 36 h ago), `partial`,
`auth`, `rate_limited`, `invalid`, `unavailable`, `error`, `dry-run`, `idle`
(for sources that are not ingested, such as the GIBS imagery proxy).

## 6. Repairing

| symptom | action |
| --- | --- |
| `database is locked` in a run message | re-run; chunked writes retry with backoff. If persistent, stop the frontend during ingest. |
| `datasets.records` ≠ stored rows | `python -c "from engine.app import db; print(db.reconcile_datasets())"` |
| Coverage states look wrong | `python -c "from engine.app import db; print(db.rebuild_coverage())"` — derived, safe to rebuild |
| Want to verify a run's contribution | `SELECT COUNT(*) FROM observations WHERE ingest_run_id = <id>` |
| Restore point | `data/firewatch.pre-phase1.db` (871,357 rows, pre-migration) |

Never delete rows to "fix" a count. Rows are immutable evidence; only derived
tables (`coverage_days`, `datasets`) are recomputed.

## 7. Safety properties

* **No key in any response.** Redaction is applied at the boundary where URLs
  are constructed, so a failure cannot leak a key through a traceback.
* **No silent overwrite.** `INSERT OR IGNORE` on a deterministic identity means
  a re-delivery never rewrites stored values.
* **No half-written batch.** Each chunk commits independently; a crash keeps
  what was committed and leaves the run visibly `running`.
* **No invented rows.** Missing fields stay `NULL`; missing days stay `unknown`.
* **Bounded work.** Page caps, date caps and `days ≤ 31` prevent one call from
  turning into an unbounded crawl.
