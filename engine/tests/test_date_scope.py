"""A question that names a date is answered for that date, or refused.

The failure this fixes was quiet: "How many detections on 2026-11-10?" returned
the same eight-day window total every time, with no indication that the date in
the question had been ignored. A wrong answer that looks right is worse than a
refusal, so uncovered dates are refused rather than answered from the window.
"""
from __future__ import annotations

import pytest

from engine.app import analyst

BBOX = (20.0, 10.0, 21.0, 14.0)


@pytest.mark.parametrize("question,expected", [
    ("What happened on 2027-01-05?", ["2027-01-05"]),
    ("How many detections on 2025-03-02?", ["2025-03-02"]),
    ("on 10 November 2026", ["2026-11-10"]),
    ("NOVEMBER 10, 2026", ["2026-11-10"]),
    ("2025/03/02", ["2025-03-02"]),
    ("2025-03-01 and 2025-03-03", ["2025-03-01", "2025-03-03"]),
    ("2026-02-31", []),          # not a real date
    ("How do MODIS and VIIRS differ?", []),
])
def test_extract_dates(question, expected):
    assert analyst.extract_dates(question) == expected


def test_dated_question_is_scoped_to_that_day():
    r = analyst.intelligence("How many detections on 2025-03-02?", BBOX, None, None,
                             "Test box", mode="deterministic")
    assert r["dateScope"]["resolution"] == "day"
    assert r["dateScope"]["applied"] == "2025-03-02"
    assert r["window"] == {"start": "2025-03-02", "end": "2025-03-02"}
    evidence = {e["label"]: e["value"] for e in r["answer"]["evidence"]}
    assert evidence["Detections"] == "8", "one day of the fixture, not the whole window"
    assert evidence["Date"] == "2025-03-02"
    assert r["answer"]["headline"].startswith("On 2025-03-02:")


def test_unscoped_question_still_uses_the_whole_window():
    r = analyst.intelligence("How many detections?", BBOX, None, None,
                             "Test box", mode="deterministic")
    assert r["dateScope"]["resolution"] == "unscoped"
    evidence = {e["label"]: e["value"] for e in r["answer"]["evidence"]}
    assert evidence["Detections"] == "41"
    assert "Date" not in evidence


def test_date_without_coverage_is_refused_not_substituted():
    r = analyst.intelligence("What happened on 2027-01-05?", BBOX, None, None,
                             "Test box", mode="deterministic")
    assert r["dateScope"]["resolution"] == "refused_no_coverage"
    assert r["dateScope"]["applied"] is None
    assert r["mode"] == "deterministic"
    labels = {e["label"]: e["value"] for e in r["answer"]["evidence"]}
    assert "Detections" not in labels, "an uncovered date must not carry a detection count"
    assert labels["Coverage"] == "no delivery evidence"
    assert "2027-01-05" in r["answer"]["headline"]


def test_date_range_is_scoped():
    r = analyst.intelligence("What happened 2025-03-01 to 2025-03-03?", BBOX, None, None,
                             "Test box", mode="deterministic")
    assert r["dateScope"]["resolution"] == "range"
    assert r["dateScope"]["coveredDays"] == 3
    evidence = {e["label"]: e["value"] for e in r["answer"]["evidence"]}
    assert evidence["Detections"] == "24"


def test_range_entirely_outside_coverage_is_refused():
    r = analyst.intelligence("Compare 2026-01-01 with 2026-01-05", BBOX, None, None,
                             "Test box", mode="deterministic")
    assert r["dateScope"]["resolution"] == "refused_no_coverage"
    assert r["answer"]["headline"].startswith("No coverage evidence")


def test_sensor_question_about_a_covered_day_reports_that_day():
    r = analyst.intelligence("Do MODIS and VIIRS differ on 2025-03-02?", BBOX, None, None,
                             "Test box", mode="deterministic")
    assert r["dateScope"]["resolution"] == "day"
    evidence = {e["label"]: e["value"] for e in r["answer"]["evidence"]}
    assert evidence["MODIS / VIIRS"] == "4 / 4"
