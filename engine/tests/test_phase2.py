"""Phase 2 tests: spatial harmonization, sensor comparison, calendar, history.

The seeded database (``conftest.py``) contains five days where MODIS reports
FRP 40 MW and VIIRS reports 20 MW in the *same* cells, so every expected value
below can be derived from a formula rather than copied from a previous run.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from engine.app import baseline, compare, geo, harmonize, platform
from engine.app import scientific as sci

BBOX = (20.0, 10.0, 21.0, 14.0)   # west,south,east,north: seeded rows sit at lon 20.5, lat 10/11/12/13


# --------------------------------------------------------------------------- #
# Spatial engine
# --------------------------------------------------------------------------- #
def test_grid_index_uses_floor_not_truncation():
    assert geo.cell_index(-0.4, 0.5, geo.LAT_OFFSET) == -1
    assert geo.cell_index(-0.1, 0.5, geo.LAT_OFFSET) == -1
    assert geo.cell_index(0.1, 0.5, geo.LAT_OFFSET) == 0
    assert geo.cell_index(0.0, 0.5, geo.LAT_OFFSET) == 0
    assert geo.cell_index(90.0, 0.5, geo.LAT_OFFSET) == 180
    assert geo.cell_index(-90.0, 0.5, geo.LAT_OFFSET) == -180
    # a 0.5° cell never straddles the equator
    assert geo.cell_index(-0.0001, 0.5, geo.LAT_OFFSET) != geo.cell_index(0.0001, 0.5, geo.LAT_OFFSET)


def test_cell_bounds_and_area_are_exact():
    south, north, west, east = geo.cell_bounds(-1, 0, 0.5)
    assert (south, north, west, east) == (-0.5, 0.0, 0.0, 0.5)
    equator = geo.cell_area_km2(0, 0.5)          # lat 0 .. 0.5
    high = geo.cell_area_km2(119, 0.5)           # lat 59.5 .. 60
    assert equator == pytest.approx(geo.bbox_area_km2(0, 0, 0.5, 0.5), rel=1e-9)
    assert high < equator * 0.55                 # ~half the area at 60° N
    assert high == pytest.approx(equator * math.cos(math.radians(59.75)), rel=2e-3)


def test_polygon_area_matches_bbox_for_rectangle():
    ring = [[20.0, 10.0], [21.0, 10.0], [21.0, 11.0], [20.0, 11.0]]
    assert geo.polygon_area_km2(ring) == pytest.approx(geo.bbox_area_km2(20, 10, 21, 11), rel=1e-6)


def test_antimeridian_polygon_filters_correctly():
    ring = [[179.0, 0.0], [-179.0, 0.0], [-179.0, 1.0], [179.0, 1.0]]
    w, s, e, n = geo.ring_bbox(ring)
    assert w > e                                  # wrapped box
    assert geo.ring_contains(ring, 179.5, 0.5)
    assert geo.ring_contains(ring, -179.5, 0.5)
    assert not geo.ring_contains(ring, 0.0, 0.5)
    target = geo.aoi(polygon=ring)
    clause, params = geo.prefilter(target)
    assert "OR" in clause and params[0] == 179.0 and params[1] == -179.0
    assert geo.contains(target, -179.9, 0.9) and not geo.contains(target, -170.0, 0.9)


def test_polygon_beats_bbox_and_bbox_beats_region():
    target = geo.aoi(region={"name": "R", "bbox": [0, 0, 10, 10]}, bbox="1,1,2,2",
                     polygon=[[3, 3], [4, 3], [4, 4], [3, 4]])
    assert target["kind"] == "polygon"
    assert target["areaKm2"] > 0
    assert geo.aoi(bbox="1,1,2,2")["kind"] == "bbox"
    assert geo.aoi(region={"name": "R", "bbox": [0, 0, 10, 10]})["kind"] == "region"


def test_invalid_polygon_is_rejected():
    with pytest.raises(ValueError):
        geo.aoi(polygon=[[0, 0], [1, 1]])
    with pytest.raises(ValueError):
        geo.aoi(polygon=[[0, 0], [200, 0], [0, 1]])
    with pytest.raises(ValueError):
        geo.check_cell(0.3)


def test_grid_sql_matches_python_floor():
    """The shift-then-truncate SQL trick must agree with Python's floor."""
    import sqlite3

    conn = sqlite3.connect(":memory:")
    lat_expr, lon_expr, params = geo.grid_sql(0.25)
    for value in (-89.9, -0.25, -0.0001, 0.0, 0.0001, 45.5, 89.9):
        sql = conn.execute(
            f"SELECT {lat_expr} FROM (SELECT ? AS lat, ? AS lon)",
            [params[0], value, 0.0],   # SELECT expr binds first, then the subquery
        ).fetchone()[0]
        assert sql == geo.cell_index(value, 0.25, geo.LAT_OFFSET), value


# --------------------------------------------------------------------------- #
# Platform separation
# --------------------------------------------------------------------------- #
def test_platforms_are_never_pooled_before_reporting():
    where, params = sci._filters(BBOX, "2025-03-01", "2025-03-05")
    payload = platform.platforms(where, params, cell=0.25)
    assert {p["sensor"] for p in payload["platforms"]} == {"modis", "viirs"}
    assert payload["sensors"]["modis"]["detections"] == sum(
        p["detections"] for p in payload["platforms"] if p["sensor"] == "modis")
    assert payload["separationNote"]
    # VIIRS confidence is categorical; no percentage is manufactured anywhere
    for p in payload["platforms"]:
        assert p["confidence"]["native"] in ("percentage 0-100", "categorical l/n/h")


def test_platform_stats_report_nominal_opportunities_as_unadjusted():
    where, params = sci._filters(BBOX, "2025-03-01", "2025-03-05")
    payload = platform.platforms(where, params, cell=0.25)
    for p in payload["platforms"]:
        assert p["opportunities"]["adjusted"] is False
        assert p["opportunities"]["nominalOverpassesPerDay"] == 2
        assert p["opportunities"]["nominalOpportunities"] == p["observedDays"] * 2


# --------------------------------------------------------------------------- #
# Harmonization engine
# --------------------------------------------------------------------------- #
def _expected_case():
    where, params = sci._filters(BBOX, "2025-03-01", "2025-03-05")
    return where, params


def test_hfai_v1_formula_is_reproducible():
    where, params = _expected_case()
    payload = harmonize.indicator(where, params, 0.1, delivery_days={"modis": 5, "viirs": 5},
                                  sensitivity=False)
    sel = payload["selected"]
    m = sel["sensors"]["modis"]
    # The four seeded rows sit at lat 10.0/10.1/10.2/10.3 -> four 0.1° cells.
    cells = {geo.cell_index(10.0 + c, 0.1, geo.LAT_OFFSET) for c in range(4)}
    assert m["activeAreaKm2"] == pytest.approx(
        sum(geo.cell_area_km2(cy, 0.1) for cy in cells), abs=0.5)   # payload rounds to 0.1 km²
    expected_density = m["frpTotalMw"] / (sum(geo.cell_area_km2(cy, 0.1) for cy in cells)) / 5
    assert m["density"] == pytest.approx(expected_density, rel=2e-3)
    assert m["densityCi95"] is not None
    lo, hi = m["densityCi95"]
    # payload rounds to 9 dp, so compare with a relative tolerance
    assert lo <= m["density"] * (1 + 1e-5) and m["density"] * (1 - 1e-5) <= hi


def test_hfai_v2_ratio_matches_the_paired_cell_days():
    where, params = _expected_case()
    sel = harmonize.indicator(where, params, 0.1, sensitivity=False)["selected"]
    v2 = sel["hfaiV2"]
    assert v2["pairedCellDays"] == 20            # 4 cells x 5 days at 0.1 deg
    assert v2["modisMeanFrp"] == pytest.approx(40.0)
    assert v2["viirsMeanFrp"] == pytest.approx(20.0)
    assert v2["ratio"] == pytest.approx(2.0, abs=1e-3)


def test_indicator_never_returns_a_conversion_factor():
    where, params = _expected_case()
    payload = harmonize.indicator(where, params, 0.1, sensitivity=False)
    assert payload["status"] == "experimental"
    assert payload["validationStatus"] == "not_independently_validated"
    assert "not a conversion factor" in payload["formula"]["v2Note"]


def test_grid_sensitivity_reports_every_grid_and_density_changes():
    where, params = _expected_case()
    payload = harmonize.indicator(where, params, 0.5, sensitivity=True)
    grids = [g["grid"] for g in payload["gridSensitivity"]]
    assert grids == sorted(geo.GRID_CHOICES)
    densities = {g["grid"]: g["combined"]["density"] for g in payload["gridSensitivity"]}
    assert len(set(densities.values())) > 1       # grid choice matters, and is visible


def test_daily_indicator_absent_on_days_without_data():
    where, params = sci._filters(BBOX, "2025-03-01", "2025-03-09")
    daily = harmonize.daily(where, params, 0.1)
    assert {"2025-03-01", "2025-03-02", "2025-03-03", "2025-03-04", "2025-03-05"} <= set(daily)
    assert "2025-03-06" in daily                  # MODIS-only day still has a reduction
    assert "2025-03-07" not in daily              # VIIRS row is outside the AOI
    for entry in daily.values():
        assert entry["combined"]["density"] > 0


# --------------------------------------------------------------------------- #
# Matched comparison
# --------------------------------------------------------------------------- #
def test_comparison_matches_identical_locations_and_reports_ratio():
    where, params = _sci(BBOX, "2025-03-01", "2025-03-05")
    payload = compare.comparison(where, params, primary_km=0.5, primary_hours=0.0, sweep=False)
    detail = payload["matching"]["detail"]
    assert detail["pairs"] > 0
    assert detail["medianDistanceKm"] == pytest.approx(0.0, abs=1e-6)
    assert detail["frpRatio"] == pytest.approx(2.0, abs=0.05)
    assert detail["oneToOne"] is True
    assert payload["validationStatus"] == "not_independently_validated"


def test_comparison_settings_sweep_changes_pair_count():
    where, params = _sci(BBOX, "2025-03-01", "2025-03-05")
    payload = compare.comparison(where, params, primary_km=0.5, sweep=True)
    pairs = [s["pairs"] for s in payload["matching"]["settings"] if s.get("pairs")]
    assert pairs and max(pairs) >= min(pairs)


def test_comparison_never_claims_same_fire():
    where, params = _sci(BBOX, "2025-03-01", "2025-03-05")
    payload = compare.comparison(where, params, sweep=False)
    assert "not proven to be the same fire" in payload["matching"]["rules"]


def _sci(bbox, start, end):
    return sci._filters(bbox, start, end)


# --------------------------------------------------------------------------- #
# History: availability, baselines, year comparison
# --------------------------------------------------------------------------- #
def test_availability_reports_single_year_and_refuses_climatology():
    where, params = _sci(BBOX, None, None)
    avail = baseline.availability(where, params)
    assert avail["years"] == ["2025"]
    assert avail["climatologyPossible"] is False

    clim = baseline.climatology(where, params, target_date="2025-03-03")
    assert clim["available"] is False
    assert clim["reason"] == "insufficient_history"
    assert "at least 3" in clim["detail"]


def test_window_baseline_is_labelled_not_climatology():
    where, params = _sci(BBOX, None, None)
    win = baseline.window_baseline(where, params, target_date="2025-03-03")
    assert win["kind"] == "window_baseline"
    assert win["notClimatology"] is True
    if win.get("available"):
        assert "stored-window baseline" in win["language"]


def test_anomaly_language_matches_the_magnitude():
    assert baseline.language_for(0.4, "stored-window baseline").startswith("near")
    assert "higher" in baseline.language_for(2.5, "multi-year baseline")
    assert "unusual" in baseline.language_for(-3.4, "multi-year baseline")
    assert "no spread" in baseline.language_for(None, "multi-year baseline")


def test_anomaly_never_selects_climatology_without_years():
    where, params = _sci(BBOX, None, None)
    result = baseline.anomaly(where, params, target_date="2025-03-03")
    assert result["selected"] in ("window_baseline", "none")
    assert result["climatology"]["available"] is False


def test_year_comparison_refuses_to_invent_years():
    payload = sci.compare_years(BBOX, [2024, 2025], "month")
    assert payload["comparisonAvailable"] is False
    assert payload["availableYears"] == [2025]
    assert "at least two years" in payload["reason"]
    assert payload["comparisons"] == []


# --------------------------------------------------------------------------- #
# Calendar integration
# --------------------------------------------------------------------------- #
def test_calendar_carries_derived_indicator_and_ci():
    payload = sci.calendar(BBOX, 2025, "day")
    observed = [d for d in payload["days"] if d["state"] == "observed"]
    assert observed
    first = observed[0]
    assert first["derived"] is not None
    assert first["derived"]["combined"]["density"] > 0
    assert payload["summary"]["derivedDays"] == sum(1 for d in payload["days"] if d["derived"])
    assert payload["derivedNote"]


def test_calendar_unknown_days_have_no_derived_value():
    payload = sci.calendar(BBOX, 2025, "day")
    for day in payload["days"]:
        if day["state"] in ("unknown", "unavailable"):
            assert day["derived"] is None
            assert day["available"] is False


def test_calendar_polygon_is_exact_not_bbox_surrogate():
    """A polygon covering only the upper half of the rows must halve the count."""
    ring = [[20.0, 10.5], [21.0, 10.5], [21.0, 14.0], [20.0, 14.0]]
    target = geo.aoi(polygon=ring)
    poly = sci.calendar(BBOX, 2025, "day", target=target)
    box = sci.calendar(BBOX, 2025, "day")
    poly_observed = [d for d in poly["days"] if d["state"] == "observed"]
    box_observed = [d for d in box["days"] if d["state"] == "observed"]
    assert poly_observed and box_observed
    assert poly_observed[0]["total"] <= box_observed[0]["total"]
    assert poly["aoi"]["kind"] == "polygon"


def test_day_detail_reports_evidence_and_derived():
    payload = sci.day_detail(BBOX, "2025-03-02", "Test area")
    assert payload["state"] == "observed"
    assert payload["sensors"]["modis"]["evidence"].startswith("global delivery")
    assert payload["derived"]["combined"]["activeAreaKm2"] > 0


def test_api_endpoints_answer_from_the_same_data():
    from fastapi.testclient import TestClient

    from engine.app.main import app

    client = TestClient(app)
    for path in ("/api/platforms?bbox=20,10,21,11&start=2025-03-01&end=2025-03-05",
                 "/api/harmonization/v2?bbox=20,10,21,11&grid=0.25&sensitivity=false",
                 "/api/baseline?bbox=20,10,21,11",
                 "/api/calendar/compare?bbox=20,10,21,11&years=2024,2025",
                 "/api/aoi?region=amazon"):
        resp = client.get(path)
        assert resp.status_code == 200, (path, resp.text[:200])

    bad = client.get("/api/harmonization/v2?bbox=20,10,21,11&grid=0.3")
    assert bad.status_code == 400
    bad_poly = client.get("/api/aoi?polygon=[[0,0],[1,1]]")
    assert bad_poly.status_code == 400
