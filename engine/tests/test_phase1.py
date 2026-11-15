"""Phase 1 tests: ingestion, provenance, coverage states, security.

These tests exercise the real code paths against recorded fixtures and a
throw-away SQLite database. Nothing here contacts NASA; the one network-shaped
test monkeypatches ``urlopen`` so failure handling is deterministic.
"""
from __future__ import annotations

import io
import os
import sqlite3
import tempfile
import urllib.error
import urllib.parse
from pathlib import Path

import pytest

from engine.app import config, coverage, db, sources


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
MODIS_HEADER = (
    "country_id,latitude,longitude,brightness,scan,track,acq_date,acq_time,"
    "satellite,instrument,confidence,version,bright_t31,frp,daynight,type\n"
)


@pytest.fixture()
def temp_db(monkeypatch):
    """A private database for tests that mutate schema or counts."""
    path = os.path.join(tempfile.mkdtemp(prefix="firewatch-p1-"), "t.db")
    monkeypatch.setattr(db, "DB_PATH", path)
    db.init_db()
    yield path


def _row(**over) -> dict:
    base = {
        "id": "X1", "sensor": "modis", "instrument": "MODIS Terra", "satellite": "Terra",
        "lat": 1.0, "lon": 2.0, "ts": 1_700_000_000_000, "acq_date": "2025-01-01",
        "acq_time": "12:00", "confidence_raw": "90", "confidence_pct": 90.0,
        "confidence_class": "high", "frp": 12.5, "brightness": 330.0, "bright_t31": 290.0,
        "scan": 1.0, "track": 1.0, "daynight": "D", "version": "6.1NRT",
        "source": "firms-modis-c61", "cycle": "nrt", "ingested_at": 1,
    }
    base.update(over)
    return base


# --------------------------------------------------------------------------- #
# Parsing: native semantics are preserved, nothing is invented
# --------------------------------------------------------------------------- #
def test_modis_parser_keeps_native_percentage_and_missing_fields():
    csv_text = MODIS_HEADER + (
        "BRA,10.5,20.5,340.1,1.0,1.0,2025-01-02,1345,T,1 km,87,6.1NRT,295.0,12.5,D,V\n"
        # missing brightness_t31 / frp / daynight -> must be None, never 0
        "BRA,10.6,20.6,,1.0,1.0,2025-01-02,1346,A,1 km,25,6.1NRT,,,\n"
    )
    rows = list(sources.parse_modis_csv(csv_text))
    assert len(rows) == 2
    a, b = rows
    assert a["sensor"] == "modis" and a["satellite"] == "Terra"
    assert a["confidence_pct"] == 87.0 and a["confidence_class"] == "high"
    assert a["frp"] == 12.5 and a["bright_t31"] == 295.0
    assert a["source_product"] == "MODIS_C6_1_Global_7d"
    assert a["source_version"] == "6.1NRT"
    assert a["quality"] == "raw"
    assert b["frp"] is None and b["bright_t31"] is None and b["brightness"] is None
    assert b["daynight"] is None
    assert b["confidence_class"] == "low"
    assert b["satellite"] == "Aqua"


def test_modis_parser_keeps_unmodelled_fields_in_extra():
    csv_text = MODIS_HEADER.replace("type\n", "type,instrument_extra\n") + (
        "BRA,10.5,20.5,340.1,1.0,1.0,2025-01-02,1345,T,1 km,87,6.1NRT,295.0,12.5,D,V,legacy\n"
    )
    row = next(iter(sources.parse_modis_csv(csv_text)))
    # `type` has no dedicated column, so it must land in extra rather than vanish.
    assert row["extra"] == {"country_id": "BRA", "type": "V", "instrument_extra": "legacy"}


def test_viirs_parser_never_invents_a_percentage():
    csv_text = (
        "country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,"
        "satellite,instrument,confidence,version,bright_ti5,frp,daynight\n"
        "BRA,-3.1,-60.2,331.0,0.4,0.4,2025-01-03,0142,1,NOAA-20,h,2.0NRT,290.0,7.4,N\n"
    )
    row = next(iter(sources.parse_viirs_csv(csv_text)))
    assert row["confidence_raw"] == "h"
    assert row["confidence_pct"] is None          # categorical, not a percentage
    assert row["confidence_class"] == "high"
    assert row["satellite"] == "NOAA-20"        # token "1" -> NOAA-20, documented
    assert row["extra"] == {"country_id": "BRA", "satellite_code": "1"}
    assert row["frp"] == 7.4
    assert row["cycle"] == "archive"


def test_viirs_unknown_satellite_token_is_not_guessed():
    csv_text = (
        "latitude,longitude,bright_ti4,acq_date,acq_time,satellite,confidence,frp\n"
        "5.0,6.0,300.0,2025-01-04,0000,ZZ,h,1.0\n"
    )
    row = next(iter(sources.parse_viirs_csv(csv_text)))
    assert row["satellite"] == "ZZ"             # never replaced with a guess
    assert row["extra"]["satellite_code"] == "ZZ"


def test_identity_is_stable_and_sensor_separated():
    a = sources.identity("modis", "Terra", 1.23456, 2.34567, 1700000000000)
    b = sources.identity("modis", "Terra", 1.234561, 2.345671, 1700000000000)
    c = sources.identity("viirs", "Terra", 1.23456, 2.34567, 1700000000000)
    assert a == b            # sub-10 m jitter collapses to one identity
    assert a != c            # sensors never collide
    assert a.startswith("MOD:Terra:")


# --------------------------------------------------------------------------- #
# Database: idempotent, additive, raw values never overwritten
# --------------------------------------------------------------------------- #
def test_upsert_is_idempotent_and_never_overwrites_raw(temp_db):
    row = _row(extra={"hours_old": 3}, original_id="42",
               source_url="https://example.test/q", source_product="P", source_version="2.0NRT")
    assert db.upsert_observations([row], chunk=1) == 1
    # same identity, different payload: the stored record must not change
    tampered = {**row, "frp": 999.0, "confidence_raw": "1"}
    assert db.upsert_observations([tampered], chunk=1) == 0
    with db.session() as conn:
        got = dict(conn.execute("SELECT * FROM observations").fetchone())
    assert got["frp"] == 12.5
    assert got["confidence_raw"] == "90"
    assert got["original_id"] == "42"
    assert got["quality"] == "raw"
    assert got["source_version"] == "2.0NRT"


def test_chunked_upsert_writes_every_row(temp_db):
    rows = [_row(id=f"C{i}", lat=float(i)) for i in range(25)]
    assert db.upsert_observations(rows, chunk=7) == 25
    assert db.table_counts()["observations"] == 25


def test_migration_is_idempotent_and_preserves_rows(temp_db):
    db.upsert_observations([_row()])
    with db.session() as conn:
        again = db.migrate(conn)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(observations)")}
    assert again == []
    assert {"original_id", "source_url", "source_product", "source_version",
            "extra", "ingest_run_id", "quality"} <= cols
    assert db.table_counts()["observations"] == 1


def test_run_lifecycle_is_recorded(temp_db):
    run_id = db.start_run("firms-modis-c61", "modis")
    db.finish_run(run_id, "ok", 3, "3 new of 3 fetched")
    with db.session() as conn:
        row = dict(conn.execute("SELECT * FROM ingest_runs WHERE id=?", (run_id,)).fetchone())
    assert row["status"] == "ok" and row["records"] == 3 and row["finished_at"]


def test_checkpoints_upsert_per_date(temp_db):
    db.set_checkpoint("firms-archive:MODIS_NRT", "2024-08-01", "complete", 10)
    db.set_checkpoint("firms-archive:MODIS_NRT", "2024-08-01", "complete", 12)
    rows = db.checkpoints("firms-archive:MODIS_NRT")
    assert len(rows) == 1 and rows[0]["records"] == 12


# --------------------------------------------------------------------------- #
# Coverage: the four required states
# --------------------------------------------------------------------------- #
def _delivery(date_str: str, records: int = 500) -> dict:
    return {f"modis:{date_str}": {"sensor": "modis", "date": date_str,
                                  "records": records, "satellites": {"Terra": records},
                                  "source": "test"},
            f"viirs:{date_str}": {"sensor": "viirs", "date": date_str,
                                  "records": records, "satellites": {"NOAA-20": records},
                                  "source": "test"}}


def test_state_detections_recorded():
    states = coverage.day_states("2025-01-01", _delivery("2025-01-01"),
                                 {"modis": 4, "viirs": 9})
    assert {s["state"] for s in states.values()} == {"observed"}
    assert states["modis"]["code"] == "DETECTIONS_RECORDED"
    assert coverage.combine_states({k: v["state"] for k, v in states.items()}) == "observed"


def test_state_confirmed_zero_is_conditional_on_delivery():
    states = coverage.day_states("2025-01-01", _delivery("2025-01-01"),
                                 {"modis": 0, "viirs": 0})
    assert states["modis"]["state"] == "observed_zero"
    assert states["modis"]["code"] == "COVERAGE_CONFIRMED_ZERO_DETECTIONS"
    assert "conditional" in states["modis"]["basis"]
    assert coverage.combine_states({k: v["state"] for k, v in states.items()}) == "observed_zero"


def test_state_unknown_without_delivery_is_never_zero():
    states = coverage.day_states("2025-01-01", {}, {"modis": 0, "viirs": 0})
    assert {s["state"] for s in states.values()} == {"unknown"}
    assert states["viirs"]["code"] == "COVERAGE_UNKNOWN"
    day = coverage.combine_states({k: v["state"] for k, v in states.items()})
    assert day == "unknown"


def test_state_product_unavailable_from_stored_failure():
    unavailable = {"modis": {"2025-01-01"}, "viirs": {"2025-01-01"}}
    states = coverage.day_states("2025-01-01", {}, {"modis": 0, "viirs": 0}, unavailable)
    assert {s["state"] for s in states.values()} == {"unavailable"}
    assert states["modis"]["code"] == "PRODUCT_UNAVAILABLE"
    assert coverage.combine_states({k: v["state"] for k, v in states.items()}) == "unavailable"


def test_state_unavailable_beats_unknown_but_not_detections():
    unavailable = {"modis": {"2025-01-01"}, "viirs": set()}
    states = coverage.day_states("2025-01-01", _delivery("2025-01-01"),
                                 {"modis": 7, "viirs": 0}, unavailable)
    # a real detection always wins over a failure marker
    assert states["modis"]["state"] == "observed"
    assert coverage.combine_states({k: v["state"] for k, v in states.items()}) == "observed"


def test_partial_day_is_not_called_observed():
    only_modis = {k: v for k, v in _delivery("2025-01-02").items() if k.startswith("modis")}
    states = coverage.day_states("2025-01-02", only_modis, {"modis": 3, "viirs": 0})
    assert coverage.combine_states({k: v["state"] for k, v in states.items()}) == "partial"


def test_unavailable_dates_reads_failed_windows(temp_db):
    db.record_coverage_window({
        "source": "firms-archive:VIIRS_NOAA20_NRT", "sensor": "viirs", "satellite": None,
        "start_date": "2024-08-01", "end_date": "2024-08-03", "bbox": None,
        "requested_at": 1, "records": 0, "status": "auth", "message": "bad key",
    })
    marks = coverage.unavailable_dates("2024-08-01", "2024-08-03")
    assert marks["viirs"] == {"2024-08-01", "2024-08-02", "2024-08-03"}
    assert marks["modis"] == set()


# --------------------------------------------------------------------------- #
# Security: the MAP_KEY can never leak
# --------------------------------------------------------------------------- #
def test_secret_is_redacted_from_errors(monkeypatch):
    key = "abcdef0123456789abcdef0123456789"
    monkeypatch.setenv("FIRMS_MAP_KEY", key)
    sources.firms_map_key()  # registers the secret

    def boom(req, timeout=0):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, io.BytesIO(b""))

    monkeypatch.setattr(sources.urllib.request, "urlopen", boom)
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/MODIS_NRT/1,2,3,4/2024-08-01"
    with pytest.raises(sources.SourceAuthError) as exc:
        sources._get(url, retries=1)
    assert key not in str(exc.value)
    assert "***" in str(exc.value)


def test_map_key_status_flags_placeholders(monkeypatch):
    monkeypatch.delenv("FIRMS_MAP_KEY", raising=False)
    assert config.map_key_status()["configured"] is False
    monkeypatch.setenv("FIRMS_MAP_KEY", "your-key-here")
    state = config.map_key_status()
    assert state["configured"] is True and state["valid"] is False
    monkeypatch.setenv("FIRMS_MAP_KEY", "a" * 32)
    assert config.map_key_status()["valid"] is True
    # the value itself is never returned
    assert "a" * 32 not in str(config.map_key_status())


def test_env_file_parsing_does_not_override_environment(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("FIREWATCH_TEST_A=from-file\nFIREWATCH_TEST_B='quoted value'\n# c\n",
                        encoding="utf-8")
    monkeypatch.setattr(config, "ENV_FILES", (env_file,))
    monkeypatch.setenv("FIREWATCH_TEST_A", "from-env")
    monkeypatch.delenv("FIREWATCH_TEST_B", raising=False)
    config.load_env()
    assert os.environ["FIREWATCH_TEST_A"] == "from-env"
    assert os.environ["FIREWATCH_TEST_B"] == "quoted value"


def test_archive_without_key_raises_auth_error(monkeypatch):
    monkeypatch.delenv("FIRMS_MAP_KEY", raising=False)
    with pytest.raises(sources.SourceAuthError):
        sources.fetch_firms_archive("MODIS_NRT", (-1, -1, 1, 1), "2024-08-01")


def test_classify_maps_status_codes():
    assert sources._classify(401) is sources.SourceAuthError
    assert sources._classify(403) is sources.SourceAuthError
    assert sources._classify(429) is sources.SourceRateLimitError
    assert sources._classify(400) is sources.SourceInvalidError
    assert sources._classify(503) is sources.SourceUnavailableError
