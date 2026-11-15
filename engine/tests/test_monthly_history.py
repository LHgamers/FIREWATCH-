from __future__ import annotations

from datetime import datetime, timezone

import pytest

from engine.app import coverage, db, scientific


BBOX = (20.0, 10.0, 21.0, 11.0)


def _row(record_id: str, day: str) -> dict:
    timestamp = int(
        datetime.strptime(f"{day}T12:00:00", "%Y-%m-%dT%H:%M:%S")
        .replace(tzinfo=timezone.utc)
        .timestamp() * 1000
    )
    return {
        "id": record_id,
        "sensor": "modis",
        "instrument": "MODIS Terra",
        "satellite": "Terra",
        "lat": 50.25,
        "lon": 100.25,
        "ts": timestamp,
        "acq_date": day,
        "acq_time": "12:00",
        "confidence_raw": "90",
        "confidence_pct": 90.0,
        "confidence_class": "high",
        "frp": 10.0,
        "brightness": 340.0,
        "bright_t31": 290.0,
        "scan": 1.0,
        "track": 1.0,
        "daynight": "D",
        "version": "test",
        "source": "test",
        "cycle": "test",
        "ingested_at": timestamp,
    }


def test_monthly_history_keeps_unknown_months_null():
    coverage.refresh()
    result = scientific.monthly_history(BBOX, 2025, 2025)
    march = next(item for item in result["months"] if item["key"] == "2025-03")
    january = next(item for item in result["months"] if item["key"] == "2025-01")

    assert march["sensors"]["modis"]["detections"] == 11
    assert march["sensors"]["viirs"]["detections"] == 10
    assert march["state"] in ("observed", "partial")
    assert january["sensors"]["modis"]["state"] == "unknown"
    assert january["sensors"]["modis"]["detections"] is None
    assert january["sensors"]["viirs"]["detections"] is None


def test_monthly_anomaly_requires_three_distinct_reference_years():
    years = [2021, 2022, 2023, 2024, 2025]
    counts = [1, 2, 3, 4, 8]
    rows = [
        _row(f"MONTHLY-HISTORY-{year}-{index}", f"{year}-01-15")
        for year, count in zip(years, counts)
        for index in range(count)
    ]
    db.upsert_observations(rows)
    coverage.refresh()
    try:
        result = scientific.monthly_history((100.0, 50.0, 101.0, 51.0), 2021, 2025)
        january = next(item for item in result["months"] if item["key"] == "2025-01")
        baseline = january["anomaly"]["modis"]

        assert baseline["available"] is True
        assert baseline["sampleYears"] == [2021, 2022, 2023, 2024]
        assert baseline["median"] == 2.5
        assert baseline["robustZ"] == pytest.approx((8 - 2.5) / (1.4826 * 1.0), abs=0.001)
        assert baseline["classification"] == "unusual"
    finally:
        with db.session() as conn:
            conn.execute("DELETE FROM observations WHERE id LIKE 'MONTHLY-HISTORY-%'")
            conn.commit()
        coverage.refresh()


@pytest.mark.parametrize(
    ("holdout_modis_cells", "expected_available"),
    [(2, True), (1, False)],
)
def test_monthly_calibration_uses_later_year_holdout(
    holdout_modis_cells: int, expected_available: bool,
):
    end_year = datetime.now(timezone.utc).year - 1
    years = range(end_year - 4, end_year + 1)
    rows = []
    for year in years:
        for month in range(1, 13):
            day = f"{year}-{month:02d}-15"
            modis_cells = holdout_modis_cells if year == end_year else 2
            if year == end_year and month == 1:
                modis_cells = 0
            for index in range(modis_cells):
                row = _row(f"MONTHLY-CAL-{year}-{month}-M{index}", day)
                row.update({
                    "sensor": "modis",
                    "instrument": "MODIS Terra",
                    "satellite": "Terra",
                    "lat": 50.1,
                    "lon": 100.1 + index * 0.3,
                })
                rows.append(row)
            row = _row(f"MONTHLY-CAL-{year}-{month}-V", day)
            row.update({
                "sensor": "viirs",
                "instrument": "VIIRS 375 m",
                "satellite": "NOAA-20",
                "lat": 50.1,
                "lon": 100.1,
            })
            rows.append(row)

    db.upsert_observations(rows)
    coverage.refresh()
    try:
        result = scientific.monthly_history(
            (100.0, 50.0, 101.0, 51.0), end_year - 4, end_year,
        )
        calibration = result["harmonizedActivity"]
        assert calibration["available"] is expected_available, calibration
        assert calibration["trainingYears"] == list(range(end_year - 4, end_year))
        assert calibration["holdoutYears"] == [end_year]
        assert calibration["trainingMonths"] == 48
        assert calibration["holdoutMonths"] == 11
        assert calibration["validation"]["improvedOverUnadjustedVIIRS"] is expected_available
        january = next(
            item for item in result["months"]
            if item["key"] == f"{end_year}-01"
        )
        if expected_available:
            assert calibration["factor"] == 2.0
            assert calibration["validation"]["meanAbsoluteError"] == 0
            assert january["harmonizedActivity"]["cellDays"] == 2.0
            assert january["harmonizedActivity"]["source"] == "calibrated VIIRS substitution"
            assert january["harmonizedActivity"]["estimated"] is True
            assert january["harmonizedAnomaly"]["available"] is True
        else:
            assert calibration["status"] == "not_improved_on_holdout"
            assert calibration["factor"] is None
            assert calibration["candidateFactor"] == 2.0
            assert january["harmonizedActivity"]["cellDays"] is None
    finally:
        with db.session() as conn:
            conn.execute("DELETE FROM observations WHERE id LIKE 'MONTHLY-CAL-%'")
            conn.commit()
        coverage.refresh()


def test_monthly_history_rejects_reversed_and_future_ranges():
    with pytest.raises(ValueError, match="ordered range"):
        scientific.monthly_history(BBOX, 2025, 2024)

    next_year = datetime.now(timezone.utc).year + 1
    with pytest.raises(ValueError, match="ordered range"):
        scientific.monthly_history(BBOX, 2025, next_year)
