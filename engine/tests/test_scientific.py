from __future__ import annotations

import io

import pytest

from engine.app import scientific as sci
from engine.app.regions import bbox_area_km2
from engine.app.sources import harmonized_confidence, parse_modis_csv

BBOX = (20.0, 10.0, 22.0, 11.0)


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #
def test_bbox_area_is_physically_plausible():
    global_area = bbox_area_km2((-180.0, -60.0, 180.0, 75.0))
    assert 4.2e8 < global_area < 5.0e8  # most of Earth's 5.1e8 km² surface


def test_small_bbox_area():
    # 2° lon × 1° lat at the equator ≈ 222 km × 111 km ≈ 24,700 km²
    assert 23000 < bbox_area_km2((20.0, 10.0, 22.0, 11.0)) < 26000


# --------------------------------------------------------------------------- #
# Confidence harmonization is a view, not a conversion
# --------------------------------------------------------------------------- #
def test_modis_confidence_classes():
    assert harmonized_confidence("modis", "0") == (0.0, "low")
    assert harmonized_confidence("modis", "45") == (45.0, "nominal")
    assert harmonized_confidence("modis", "90") == (90.0, "high")


def test_viirs_confidence_has_no_percentage():
    pct, cls = harmonized_confidence("viirs", "nominal")
    assert pct is None and cls == "nominal"
    pct, cls = harmonized_confidence("viirs", "h")
    assert pct is None and cls == "high"


# --------------------------------------------------------------------------- #
# CSV parsing keeps native fields
# --------------------------------------------------------------------------- #
MODIS_CSV = (
    "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n"
    "10.5,20.5,340.2,1.1,0.9,2025-03-01,0735,T,82,6.1NRT,295.1,14.7,D\n"
    "-3.1,-60.2,321.0,1.0,1.0,2025-03-02,0142,A,41,6.1NRT,288.0,,N\n"
    "bad,row\n"
)


def test_parse_modis_csv():
    rows = list(parse_modis_csv(MODIS_CSV))
    assert len(rows) == 2  # malformed row dropped, not guessed
    first = rows[0]
    assert first["sensor"] == "modis"
    assert first["satellite"] == "Terra"
    assert first["acq_time"] == "07:35"
    assert first["confidence_raw"] == "82"
    assert first["confidence_class"] == "high"
    assert first["frp"] == 14.7
    assert first["daynight"] == "D"
    assert rows[1]["satellite"] == "Aqua"
    assert rows[1]["frp"] is None  # missing FRP stays missing, never zero


# --------------------------------------------------------------------------- #
# Aggregation
# --------------------------------------------------------------------------- #
def test_summary_counts_each_sensor():
    s = sci.summary(BBOX, None, None)
    assert s["sensors"]["modis"]["detections"] == 11  # 10 paired + 1 modis-only day
    assert s["sensors"]["viirs"]["detections"] == 10
    assert s["totalDetections"] == 21
    assert s["areaKm2"] > 0
    assert s["sensors"]["modis"]["frp"]["median"] == 40.0


def test_bbox_excludes_distant_detection():
    s = sci.summary(BBOX, None, None)
    # The VIIRS record at -30,120 must not be counted.
    assert s["sensors"]["viirs"]["detections"] == 10


def test_missing_days_are_not_zero():
    ts = sci.timeseries(BBOX, None, None)
    dates = [p["date"] for p in ts["series"]]
    assert "2025-03-06" in dates
    row = next(p for p in ts["series"] if p["date"] == "2025-03-06")
    assert row["modis"] == 1
    assert row["viirs"] == 0
    assert row["available"] is True


# --------------------------------------------------------------------------- #
# Harmonization
# --------------------------------------------------------------------------- #
def test_harmonization_ratio_is_exact_on_controlled_data():
    h = sci.harmonization(BBOX, None, None, "Test box")
    # MODIS FRP is 2× VIIRS FRP on every paired cell-day.
    assert h["hfai"]["modisToViirsRatio"] == pytest.approx(2.0, rel=1e-6)
    assert h["hfai"]["pairedCellDays"] == 10
    assert h["hfai"]["modisOnlyCellDays"] >= 1
    # Ten paired cell-days: point estimate only, no interval is invented.
    assert h["hfai"]["ratioCi95"] is None
    assert h["hfai"]["meanFrpPerActiveCell"]["modis"] == pytest.approx(37.27, abs=0.01)
    assert h["hfai"]["meanFrpPerActiveCell"]["viirs"] == pytest.approx(20.0)
    assert h["hfai"]["status"] == "experimental"


def test_harmonization_density_is_positive_and_finite():
    h = sci.harmonization(BBOX, None, None, "Test box")
    d = h["hfai"]["combinedDensity"]
    assert 0 < d < 1e6
    assert h["hfai"]["activeCells"] == 3
    assert h["hfai"]["activeAreaKm2"] > 0


def test_harmonization_separates_overlap_days():
    h = sci.harmonization(BBOX, None, None, "Test box")
    assert h["window"]["overlapDays"] == 5
    assert h["window"]["modisOnlyDays"] == ["2025-03-06"]


# --------------------------------------------------------------------------- #
# Anomaly
# --------------------------------------------------------------------------- #
def test_anomaly_refuses_a_thin_baseline():
    """Five observed days is not enough for a robust deviation."""
    a = sci.anomaly(BBOX, "2025-03-05")
    assert a["available"] is True
    assert a["baseline"] is None
    assert a["quality"]["level"] == "insufficient"
    assert a["quality"]["baselineDays"] < 7
    assert "deviation" not in a


def test_anomaly_detects_an_obvious_spike():
    """Eight observed days, then a day with 30x the activity."""
    bbox = (40.0, 30.0, 41.0, 31.0)
    from engine.app import coverage, db

    def row(idx: int, day: str, n: int) -> list[dict]:
        return [
            {"id": f"SPK{idx}-{i}", "sensor": "modis", "instrument": "MODIS Terra",
             "satellite": "Terra", "lat": 30.2, "lon": 40.2, "ts": 0, "acq_date": day,
             "acq_time": "12:00", "confidence_raw": "90", "confidence_pct": 90.0,
             "confidence_class": "high", "frp": 5.0, "brightness": 330.0, "bright_t31": 290.0,
             "scan": 1.0, "track": 1.0, "daynight": "D", "version": "test",
             "source": "test", "cycle": "test", "ingested_at": 0}
            for i in range(n)
        ]

    rows: list[dict] = []
    for d in range(1, 9):
        rows += row(d, f"2025-05-{d:02d}", 1)
    rows += row(9, "2025-05-09", 30)
    db.upsert_observations(rows)
    coverage.refresh()

    spike = sci.anomaly(bbox, "2025-05-09")
    assert spike["available"] is True
    assert spike["baseline"] is not None
    assert spike["quality"]["baselineDays"] >= 7
    assert spike["deviation"]["absolute"] > 0
    assert spike["deviation"]["percentile"] == 100.0
    assert spike["target"]["count"] == 30


def test_anomaly_outside_coverage_is_explicit():
    a = sci.anomaly(BBOX, "2019-01-01")
    assert a["available"] is False
    assert "coverage" in a["reason"].lower()


# --------------------------------------------------------------------------- #
# Point context
# --------------------------------------------------------------------------- #
def test_nearby_uses_distance_and_window():
    rows = sci.nearby(10.2, 20.4, radius_km=40, hours=24 * 365 * 3)
    assert rows
    assert all(r["distanceKm"] <= 40 for r in rows)
    assert rows == sorted(rows, key=lambda r: (r["distanceKm"], -(r["frp"] or 0)))


def test_haversine_known_distance():
    d = sci.haversine_km(0.0, 0.0, 0.0, 1.0)
    assert 111.0 < d < 111.4


# --------------------------------------------------------------------------- #
# Coverage states (v2): unknown is never zero
# --------------------------------------------------------------------------- #
def test_calendar_distinguishes_observed_zero_and_unknown():
    from engine.app import coverage, scientific as sci

    coverage.refresh()
    cal = sci.calendar((20.0, 10.0, 21.0, 11.0), 2025)
    by_date = {d["date"]: d for d in cal["days"]}

    # Both sensors delivered and reported: observed.
    assert by_date["2025-03-01"]["state"] == "observed"
    assert by_date["2025-03-01"]["sensors"]["modis"]["state"] == "observed"

    # MODIS delivered, VIIRS did not: partial, not zero.
    assert by_date["2025-03-06"]["state"] == "partial"
    assert by_date["2025-03-06"]["sensors"]["viirs"]["state"] == "unknown"

    # VIIRS delivered globally but reported nothing here: verified zero.
    assert by_date["2025-03-07"]["sensors"]["viirs"]["state"] == "observed_zero"
    assert by_date["2025-03-07"]["sensors"]["viirs"]["count"] == 0

    # A day with no delivery at all is unknown, and never counted as zero.
    assert by_date["2025-03-20"]["state"] == "unknown"
    assert by_date["2025-03-20"]["available"] is False
    assert cal["summary"]["unknownDays"] > 0


def test_calendar_baseline_excludes_unknown_days():
    from engine.app import coverage, scientific as sci

    coverage.refresh()
    cal = sci.calendar((20.0, 10.0, 21.0, 11.0), 2025)
    observed = [d for d in cal["days"] if d["state"] in ("observed", "observed_zero")]
    assert cal["baseline"]["sampleDays"] == len(observed)
    assert cal["baseline"]["sampleDays"] < len(cal["days"])


def test_day_detail_carries_delivery_evidence():
    from engine.app import coverage, scientific as sci

    coverage.refresh()
    detail = sci.day_detail((20.0, 10.0, 21.0, 11.0), "2025-03-06")
    assert detail["state"] == "partial"
    assert detail["sensors"]["modis"]["state"] == "observed"
    assert detail["sensors"]["viirs"]["state"] == "unknown"
    assert "delivery" in detail["provenance"]


def test_harmonization_grid_sensitivity_is_reported():
    from engine.app import scientific as sci

    h = sci.harmonization((20.0, 10.0, 21.0, 11.0), "2025-03-01", "2025-03-05",
                          "test", grid=0.25, sensitivity=True)
    assert h["grid"] == 0.25
    assert [m["id"] for m in h["methods"]] == ["A", "B", "C", "D", "E"]
    assert h["hfaiV2"]["status"] == "experimental"
    assert len(h["gridSensitivity"]) == 3
    assert {row["grid"] for row in h["gridSensitivity"]} == {0.1, 0.25, 0.5}


def test_grounding_rejects_a_number_absent_from_evidence():
    from engine.app import analyst

    evidence = '{"detections": 1234, "ratio": 1.466}'
    ok = analyst._grounding("There were 1,234 detections and a ratio of 1.466.", evidence)
    assert ok["status"] == "passed"
    bad = analyst._grounding("There were 9,999 detections.", evidence)
    assert bad["status"] == "rejected"
    assert "9,999" in bad["ungrounded"]


# --------------------------------------------------------------------------- #
# Coverage-matched anomaly baseline (Phase 6)
# --------------------------------------------------------------------------- #
def test_anomaly_refuses_different_sensor_mix() -> None:
    from engine.app import scientific as sci

    # 2025-03-06 is MODIS-only in the fixture; every other day has both sensors.
    result = sci.anomaly([19, 9, 22, 14], target_date="2025-03-06")
    assert result["quality"]["targetSensors"] == ["modis"]
    assert result["quality"]["excludedSensorMixDays"] >= 1
    deviation = result.get("deviation")
    # Either no comparable baseline exists, or any computed z has no spread to divide by.
    assert deviation is None or deviation["robustZ"] is None
    assert "different delivering sensor mix" in result["quality"]["note"]


def test_anomaly_compares_like_with_like() -> None:
    from engine.app import scientific as sci

    result = sci.anomaly([19, 9, 22, 14], target_date="2025-03-03")
    assert result["quality"]["targetSensors"] == ["modis", "viirs"]
    assert result["quality"]["excludedSensorMixDays"] >= 1  # the MODIS-only day
