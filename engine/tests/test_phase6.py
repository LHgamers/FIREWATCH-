"""Tests for the Phase 6 additions: place lookup and data freshness.

No network is used: the upstream geocoder is monkeypatched, and the freshness
endpoint only reads the seeded database and in-process scheduler state.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from engine.app import freshness, geo_search
from engine.app.main import app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


# --------------------------------------------------------------------------- #
# Geocoding: validation, normalisation, caching (no upstream calls)
# --------------------------------------------------------------------------- #
def test_geocode_rejects_short_query(client: TestClient) -> None:
    response = client.get("/api/geocode", params={"q": "a"})
    assert response.status_code == 422  # FastAPI min_length, before any network


def test_geocode_validation_messages() -> None:
    geo_search.cache_clear()
    with pytest.raises(ValueError):
        geo_search.search("a")
    with pytest.raises(ValueError):
        geo_search.search("ab\ncd")
    with pytest.raises(ValueError):
        geo_search.search("x" * 200)


def test_nominatim_bbox_order_is_converted() -> None:
    # Nominatim: [south, north, west, east] as strings.
    assert geo_search._bbox({"boundingbox": ["26.34", "30.44", "80.05", "88.20"]}) == [
        80.05, 26.34, 88.20, 30.44,
    ]
    assert geo_search._bbox({"boundingbox": ["30", "26", "80", "88"]}) is None
    assert geo_search._bbox({"boundingbox": ["x", "y", "z", "w"]}) is None


def test_geocode_payload_contract_and_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    geo_search.cache_clear()
    calls = {"n": 0}
    sample = [{
        "name": "Nepal", "displayName": "Nepal", "lat": 28.3, "lon": 84.0,
        "bbox": [80.05, 26.34, 88.20, 30.44], "kind": "country",
        "admin": "", "country": "Nepal", "source": "nominatim", "id": "1",
    }]

    def fake(query: str, limit: int):
        calls["n"] += 1
        return sample

    monkeypatch.setattr(geo_search, "_upstream", fake)
    first = geo_search.search("Nepal", 3)
    second = geo_search.search("Nepal", 3)
    assert calls["n"] == 1, "identical queries must be served from the cache"
    assert first["cached"] is False and second["cached"] is True
    assert first["provider"] and first["attribution"]
    assert first["results"][0]["bbox"] == [80.05, 26.34, 88.20, 30.44]


def test_upstream_failure_is_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    geo_search.cache_clear()

    def fail(query: str, limit: int):
        raise geo_search.GeocodeUnavailable("network down")

    monkeypatch.setattr(geo_search, "_upstream", fail)
    with pytest.raises(geo_search.GeocodeUnavailable):
        geo_search.search("Kathmandu")
    geo_search.cache_clear()


# --------------------------------------------------------------------------- #
# Freshness: three clocks, scheduler state, coverage window
# --------------------------------------------------------------------------- #
def test_freshness_endpoint_shape(client: TestClient) -> None:
    payload = client.get("/api/freshness").json()
    for key in ("generatedAt", "state", "observationWindow", "lastSuccessAt",
                "lastCheckAt", "scheduler", "sources", "archiveEnabled"):
        assert key in payload
    assert payload["state"] in {"fresh", "stale", "never-checked"}
    window = payload["observationWindow"]
    assert window["first"] is not None and window["last"] is not None
    assert window["first"] <= window["last"]
    assert "checks the NASA feeds" in payload["scheduler"]["note"]


def test_freshness_does_not_confuse_observation_and_check() -> None:
    payload = freshness.status()
    # A stored observation window is not a scheduler success: a process that has
    # never run a check must not claim a last successful check.
    if payload["checks"] == 0:
        assert payload["lastSuccessAt"] is None
    assert payload["observationWindow"]["note"].startswith("Observation dates")


def test_meta_embeds_freshness(client: TestClient) -> None:
    payload = client.get("/api/meta").json()
    assert "freshness" in payload
    assert payload["freshness"]["observationWindow"]["last"] == payload["coverage"]["last"]


def test_freshness_check_route_rejects_bad_method(client: TestClient) -> None:
    # The trigger is POST-only; a GET must not start a download.
    assert client.get("/api/freshness/check").status_code == 405
