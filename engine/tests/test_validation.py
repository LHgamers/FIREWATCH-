"""Phase 1 audit — API contract tests for areas and query parameters.

These tests exist because the pre-audit behaviour was unsafe in two ways that a
rendering test would never catch:

* ``?region=<typo>`` and ``?bbox=not-a-box`` returned **HTTP 200 with Global
  totals** (874,641 detections in the live DB). A shared link, a screenshot or a
  report could therefore carry worldwide figures under any label.
* ``?bbox=200,-100,300,100`` (latitudes and longitudes outside the valid range)
  was accepted and answered with **zero detections** — an impossible extent
  presented as a confident, verified zero.
* ``period=hour`` silently became ``day`` and ``cell=0`` silently became 0.05°
  (137k cells), so a client could believe it had received a different query than
  the one it asked for.

The contract enforced here: anything the engine cannot honour is a 400 with an
explanation, and a well-formed request is unchanged.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
import io
import json

import pytest
from fastapi.testclient import TestClient

from engine.app import main
from engine.app.regions import InvalidArea, get_region, parse_bbox

BBOX = (20.0, 10.0, 21.0, 14.0)


@pytest.fixture(scope="module")
def client():
    # The seeded fixture in conftest.py has already created and populated the DB.
    return TestClient(main.app)


def test_monthly_history_api_returns_matrix_and_refuses_future_year(client):
    response = client.get(
        "/api/calendar/history",
        params={"bbox": "20,10,21,11", "startYear": 2025, "endYear": 2025},
    )
    assert response.status_code == 200
    payload = response.json()
    assert len(payload["months"]) == 12
    assert payload["months"][0]["key"] == "2025-01"
    assert payload["harmonizedActivity"]["available"] is False

    future = client.get(
        "/api/calendar/history",
        params={
            "bbox": "20,10,21,11",
            "startYear": 2025,
            "endYear": datetime.now(timezone.utc).year + 1,
        },
    )
    assert future.status_code == 400


def test_polygon_summary_and_export_filter_exact_geometry(client):
    polygon = json.dumps([
        [20.0, 9.9], [20.9, 9.9], [20.9, 10.9], [20.0, 10.9],
    ])
    params = {
        "polygon": polygon,
        "start": "2025-03-01",
        "end": "2025-03-07",
    }

    summary = client.get("/api/summary", params=params)
    assert summary.status_code == 200
    result = summary.json()
    assert result["totalDetections"] == 11
    assert result["sensors"]["modis"]["detections"] == 6
    assert result["sensors"]["viirs"]["detections"] == 5
    assert result["aoi"]["kind"] == "polygon"

    export = client.get("/api/report.csv", params={**params, "all_rows": True})
    assert export.status_code == 200
    rows = list(csv.reader(io.StringIO(export.text)))
    assert ["Detection rows in this file", "11"] in rows
    assert ["AOI geometry", "polygon"] in rows


# --------------------------------------------------------------------------- #
# Region resolution
# --------------------------------------------------------------------------- #
def test_known_region_resolves():
    assert get_region("amazon")["id"] == "amazon"


def test_region_id_is_case_space_and_underscore_tolerant():
    assert get_region("Amazon")["id"] == "amazon"
    assert get_region("  AMAZON ")["id"] == "amazon"
    assert get_region("West Africa")["id"] == "west-africa"
    assert get_region("west_africa")["id"] == "west-africa"
    assert get_region("SOUTHEAST-ASIA")["id"] == "southeast-asia"


def test_unknown_region_raises_instead_of_falling_back():
    with pytest.raises(InvalidArea) as err:
        get_region("amazonia")
    assert "unknown region" in str(err.value)
    assert "amazon" in str(err.value)          # the message lists valid ids


def test_empty_region_means_global():
    assert get_region(None)["id"] == "global"
    assert get_region("   ")["id"] == "global"


# --------------------------------------------------------------------------- #
# Bounding box parsing
# --------------------------------------------------------------------------- #
def test_bbox_round_trip():
    assert parse_bbox("20,10,21,14") == BBOX
    assert parse_bbox(" 20 , 10 , 21 , 14 ") == BBOX


def test_antimeridian_box_is_kept_not_rejected():
    assert parse_bbox("170,-10,-170,10") == (170.0, -10.0, -170.0, 10.0)


@pytest.mark.parametrize("bad", [
    "bad",            # not numbers
    "1,2,3",          # three values
    "1,2,3,4,5",      # five values
    "200,-100,300,100",   # latitude and longitude out of range
    "1,-95,2,-30",    # latitude below -90
    "1,50,2,10",      # south (50) north of north (10)
    "1,2,1,3",        # zero-width box
    "1,2,3,nan",      # not finite
    "1,2,3,inf",
])
def test_invalid_bbox_is_rejected(bad):
    with pytest.raises(InvalidArea):
        parse_bbox(bad)


# --------------------------------------------------------------------------- #
# HTTP surface: the defect must be gone end to end
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("path", [
    # /api/coverage is a global product-status endpoint and takes no region.
    "/api/summary", "/api/timeseries", "/api/cells",
    "/api/observations", "/api/platforms", "/api/harmonization",
    "/api/baseline", "/api/anomaly", "/api/calendar", "/api/day/2025-03-02",
])
def test_unknown_region_is_400_everywhere(client, path):
    r = client.get(path, params={"region": "not-a-region"})
    assert r.status_code == 400, (path, r.status_code, r.text[:200])
    assert "unknown region" in r.json()["detail"]


@pytest.mark.parametrize("bad", ["bad", "1,2,3", "200,-100,300,100"])
def test_invalid_bbox_is_400_not_global_data(client, bad):
    r = client.get("/api/summary", params={"bbox": bad})
    assert r.status_code == 400
    assert "bbox" in r.json()["detail"]


def test_impossible_bbox_never_returns_zero(client):
    """The dangerous case: a valid-looking but impossible extent used to return
    a zero that a reader could mistake for 'observed, nothing burned'."""
    r = client.get("/api/summary", params={"bbox": "200,-100,300,100"})
    assert r.status_code == 400


def test_explicit_bbox_still_wins_over_region(client):
    ok = client.get("/api/summary", params={"bbox": "20,10,21,14", "region": "amazon"})
    assert ok.status_code == 200
    assert ok.json()["bbox"] == [20.0, 10.0, 21.0, 14.0]


def test_valid_region_still_works(client):
    r = client.get("/api/summary", params={"region": "global"})
    assert r.status_code == 200
    assert r.json()["totalDetections"] > 0


# --------------------------------------------------------------------------- #
# Other silently-coerced parameters
# --------------------------------------------------------------------------- #
def test_invalid_period_is_rejected_not_coerced(client):
    r = client.get("/api/calendar", params={"region": "global", "year": 2025, "period": "hour"})
    assert r.status_code == 400
    assert "period must be one of" in r.json()["detail"]

    r2 = client.get("/api/calendar/compare",
                    params={"region": "global", "years": "2024,2025", "period": "hour"})
    assert r2.status_code == 400


def test_valid_period_is_unchanged(client):
    r = client.get("/api/calendar", params={"region": "global", "year": 2025, "period": "day"})
    assert r.status_code == 200
    assert r.json()["period"] == "day"


def test_cell_size_outside_supported_range_is_rejected(client):
    for bad in ("0", "0.05", "25", "-1"):
        r = client.get("/api/cells", params={"region": "global", "cell": bad})
        assert r.status_code == 400, (bad, r.status_code)


def test_cell_size_inside_range_is_served(client):
    r = client.get("/api/cells", params={"region": "global", "cell": 3})
    assert r.status_code == 200
    assert r.json()["cell"] == 3


def test_negative_limit_is_rejected(client):
    r = client.get("/api/observations", params={"region": "global", "limit": -5})
    assert r.status_code == 400


def test_positive_limit_is_served(client):
    r = client.get("/api/observations", params={"region": "global", "limit": 2})
    assert r.status_code == 200
    assert r.json()["meta"]["returned"] <= 2


def test_unknown_model_is_rejected_by_the_engine(client):
    """Naming a model that is not installed must never be silently substituted."""
    r = client.post("/api/intelligence", json={
        "question": "how many detections", "region": "global",
        "mode": "llm", "model": "definitely-not-installed:latest",
    })
    # Ollama being unavailable is also an acceptable outcome for this contract:
    # the engine then answers deterministically. What must never happen is a 200
    # that pretends the requested model answered.
    assert r.status_code in (400, 503, 200), r.status_code
    if r.status_code == 400:
        assert "not installed" in r.json()["detail"]
    else:
        body = r.json()
        assert body["mode"] != "llm", "an uninstalled model must not be used"
        assert body.get("ai", {}).get("model") != "definitely-not-installed:latest"


# --------------------------------------------------------------------------- #
# Polygon geometry contract
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("polygon", [
    "[[0,0],[1,1],[0,0]]",                      # three points, two places
    "[[0,0],[1,1],[2,2]]",                      # collinear, zero area
    "[[0,0],[1,1]]",                            # too few points
    "[[0,0],[1,1],[2,2],[0,0]]",                # collinear ring
])
def test_degenerate_polygon_is_rejected(client, polygon):
    r = client.get("/api/aoi", params={"polygon": polygon})
    assert r.status_code == 400, r.text
    assert "polygon" in r.json()["detail"]


def test_valid_polygon_still_works(client):
    poly = "[[-70,-10],[-50,-10],[-50,2],[-70,2]]"
    r = client.get("/api/aoi", params={"polygon": poly})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "polygon"
    assert body["areaKm2"] > 0
    assert body["antimeridian"] is False


def test_antimeridian_polygon_is_flagged(client):
    poly = "[[170,-10],[-170,-10],[-170,10],[170,10]]"
    r = client.get("/api/aoi", params={"polygon": poly})
    assert r.status_code == 200
    body = r.json()
    assert body["antimeridian"] is True
    assert body["areaKm2"] > 0
    west, south, east, north = body["bbox"]
    assert west > east, "a wrapped AOI must report west > east"
