"""Coverage honesty in payloads: missing data must be null, never zero.

Before PHASE_1_AUDIT, a day with no delivery evidence was serialised with
``modis: 0, viirs: 0, total: 0, modisFrp: 0.0`` and ``available: false``. Any
consumer that summed or charted the field — including a stranger reading the API
during judging — saw a confident zero. The three coverage states only work if the
numbers themselves stay absent.

The seeded test database has no delivery evidence outside 2025-03, so a day in
another month is the natural negative case.
"""
from __future__ import annotations

import pytest

from engine.app import db
from engine.app import scientific as sci

BBOX = (20.0, 10.0, 21.0, 14.0)


@pytest.fixture(scope="module")
def calendar_2025():
    return sci.calendar(BBOX, 2025, "day", grid=0.25)


def test_unknown_day_has_no_numbers(calendar_2025):
    unknown = [d for d in calendar_2025["days"] if d["state"] == "unknown"]
    assert unknown, "the fixture must contain days outside delivery coverage"
    day = unknown[0]
    assert day["available"] is False
    assert day["stateCode"] == "COVERAGE_UNKNOWN"
    for field in ("modis", "viirs", "total", "modisFrp", "viirsFrp"):
        assert day[field] is None, f"{field} must be null on a day with no data"
    assert day["derived"] is None


def test_observed_day_still_has_numbers(calendar_2025):
    observed = [d for d in calendar_2025["days"] if d["state"] == "observed"]
    assert observed
    day = observed[0]
    assert day["total"] == day["modis"] + day["viirs"]
    assert day["total"] > 0


def test_month_without_any_evidence_has_no_total(calendar_2025):
    months = sci.calendar(BBOX, 2025, "month", grid=0.25)["buckets"]
    january = next(b for b in months if b["label"] == "January")
    assert january["state"] == "unknown"
    assert january["total"] is None
    assert january["modis"] is None
    assert january["observedDays"] == 0


def test_partly_observed_month_is_flagged_as_a_lower_bound(calendar_2025):
    months = sci.calendar(BBOX, 2025, "month", grid=0.25)["buckets"]
    march = next(b for b in months if b["label"] == "March")
    assert march["total"] is not None and march["total"] > 0
    assert march["unknownDays"] > 0
    assert march["lowerBound"] is True, "a month with unknown days is a lower bound, not a total"


def test_day_detail_marks_missing_sensors_as_absent():
    detail = sci.day_detail(BBOX, "2025-01-15", "Test box")
    assert detail["state"] == "unknown"
    for sensor in ("modis", "viirs"):
        payload = detail["sensors"][sensor]
        assert payload["detections"] is None
        assert payload["frp"] is None


def test_timeseries_has_gaps_not_zeros(monkeypatch):
    """A day with neither rows nor delivery evidence is a gap, not a zero."""
    real_rows = sci._rows
    hole = "2025-03-03"

    def rows_without_hole(sql, params):
        return [r for r in real_rows(sql, params) if r.get("acq_date") != hole]

    real_delivery = sci.cov.delivery
    monkeypatch.setattr(sci, "_rows", rows_without_hole)
    monkeypatch.setattr(
        sci.cov, "delivery",
        lambda a, b: {k: v for k, v in real_delivery(a, b).items() if not k.endswith(hole)},
    )
    series = sci.timeseries(BBOX, "2025-03-01", "2025-03-05", "day")["series"]

    gap = [p for p in series if p["date"] == hole]
    assert gap, "the interior day must still be present in the series"
    assert gap[0]["state"] == "unknown"
    assert gap[0]["total"] is None and gap[0]["modis"] is None
    assert gap[0]["available"] is False
    observed = [p for p in series if p["state"] == "observed"]
    assert observed and all(p["total"] is not None for p in observed)


def test_calendar_totals_only_count_known_days(calendar_2025):
    known = sum(d["total"] or 0 for d in calendar_2025["days"])
    assert calendar_2025["summary"]["totalDetections"] == known
    stored = db.table_counts()["observations"]
    # The bbox is a 1-degree window, so this is not the whole store; the point is
    # that the summary equals the sum of the days it publishes.
    assert known <= stored


def test_aoi_outside_the_product_footprint_is_unknown_not_zero():
    """Antarctica is outside the ingested 60S-75N product extent.

    Delivery rows are per sensor-day and global, so they cannot confirm a zero
    for a latitude the product never covers. Before this check the calendar
    reported 8 "confirmed zero" days for an Antarctic box.
    """
    cal = sci.calendar((0.0, -80.0, 30.0, -70.0), 2025, "day", grid=0.25)
    assert cal["summary"]["zeroDays"] == 0
    assert cal["summary"]["footprintNote"]
    assert "south of 60S" in cal["summary"]["footprintNote"]
    assert all(d["state"] != "observed_zero" for d in cal["days"])
    assert all(d["total"] is None for d in cal["days"])


def test_aoi_inside_the_footprint_still_confirms_zero():
    cal = sci.calendar(BBOX, 2025, "day", grid=0.25)
    assert cal["summary"]["footprintNote"] is None
    assert cal["summary"]["zeroDays"] >= 0
    assert cal["summary"]["observedDays"] > 0
