"""Named study regions used across the platform.

Bounding boxes are [west, south, east, north] in decimal degrees (WGS84).
"""
from __future__ import annotations

import math
from typing import Any


class InvalidArea(ValueError):
    """A request named an area the engine cannot resolve.

    Raised instead of silently substituting something else: an unknown region id
    or a malformed bounding box must never be answered with Global numbers, and
    an impossible box must never be answered with a confident zero.
    """

REGIONS: list[dict[str, Any]] = [
    {"id": "global", "name": "Global", "bbox": [-180.0, -60.0, 180.0, 75.0], "kind": "global",
     "note": "All land surfaces between 60°S and 75°N."},
    {"id": "amazon", "name": "Amazon Basin", "bbox": [-74.0, -14.0, -44.0, 5.0], "kind": "region",
     "note": "Legal Amazon and Cerrado transition — humid tropical deforestation frontier."},
    {"id": "cerrado", "name": "Cerrado", "bbox": [-60.0, -24.0, -42.0, -5.0], "kind": "region",
     "note": "Brazilian savanna, strongly seasonal fire regime."},
    {"id": "congo", "name": "Congo Basin", "bbox": [10.0, -8.0, 32.0, 5.0], "kind": "region",
     "note": "Humid central African forest and savanna mosaic."},
    {"id": "west-africa", "name": "West African Savanna", "bbox": [-18.0, 4.0, 12.0, 17.0], "kind": "region",
     "note": "Sudano-Sahelian belt with a pronounced dry-season fire season."},
    {"id": "southeast-asia", "name": "Maritime Southeast Asia", "bbox": [95.0, -10.0, 141.0, 12.0], "kind": "region",
     "note": "Peatland and slash-and-burn regimes, strong ENSO modulation."},
    {"id": "boreal-na", "name": "Boreal North America", "bbox": [-170.0, 50.0, -55.0, 72.0], "kind": "region",
     "note": "Boreal forest — stand-replacing crown fire regime."},
    {"id": "siberia", "name": "Siberia", "bbox": [60.0, 50.0, 180.0, 75.0], "kind": "region",
     "note": "Remote boreal and tundra fire regimes."},
    {"id": "mediterranean", "name": "Mediterranean", "bbox": [-10.0, 30.0, 40.0, 46.0], "kind": "region",
     "note": "Summer-dry shrubland and pine fire regime."},
    {"id": "australia", "name": "Australia", "bbox": [112.0, -45.0, 154.0, -10.0], "kind": "region",
     "note": "Tropical savanna north, temperate south-east; spring–summer peaks."},
    {"id": "california", "name": "California", "bbox": [-125.0, 32.0, -114.0, 42.0], "kind": "region",
     "note": "Mediterranean climate, autumn wind-driven fire regime."},
    {"id": "chile", "name": "Central Chile", "bbox": [-76.0, -42.0, -69.0, -28.0], "kind": "region",
     "note": "Andean Mediterranean zone with summer fire activity."},
]

REGION_BY_ID = {r["id"]: r for r in REGIONS}


def normalise_region_id(region_id: str) -> str:
    """Case/whitespace/underscore tolerant, but never silently substitutive."""
    key = str(region_id).strip().lower()
    # Accept "West Africa", "west_africa" and "West-Africa" for the same region.
    key = key.replace(" ", "-").replace("_", "-")
    return "-".join(part for part in key.split("-") if part)


def get_region(region_id: str | None) -> dict[str, Any]:
    """Resolve a region id, or raise for one that does not exist.

    Falling back to Global was the original behaviour and it was unsafe: a typo
    in a shared link, a note or a screenshot silently produced worldwide totals
    labelled with whatever name the caller had in mind.
    """
    if region_id is None or str(region_id).strip() == "":
        return REGION_BY_ID["global"]
    key = normalise_region_id(region_id)
    if key not in REGION_BY_ID:
        raise InvalidArea(
            f"unknown region {region_id!r}; valid regions: {', '.join(sorted(REGION_BY_ID))}"
        )
    return REGION_BY_ID[key]


def parse_bbox(text: str) -> tuple[float, float, float, float]:
    """Parse 'w,s,e,n' strictly. Raises InvalidArea with a human explanation.

    Rules: exactly four finite numbers; latitudes within ±90 and in south-to-north
    order; longitudes within ±180. A west edge greater than the east edge is kept
    as-is because that is an antimeridian-crossing box, which every query path
    already handles.
    """
    parts = [p.strip() for p in str(text).split(",")]
    if len(parts) != 4:
        raise InvalidArea(
            f"bbox must have 4 comma-separated values (west,south,east,north); got {len(parts)}"
        )
    try:
        w, s, e, n = (float(v) for v in parts)
    except ValueError as exc:
        raise InvalidArea(f"bbox values must be numbers (west,south,east,north): {exc}") from exc
    if not all(math.isfinite(v) for v in (w, s, e, n)):
        raise InvalidArea("bbox values must be finite numbers")
    if not (-90.0 <= s <= 90.0 and -90.0 <= n <= 90.0):
        raise InvalidArea(f"bbox latitudes must be within -90..90; got south={s}, north={n}")
    if not (-180.0 <= w <= 180.0 and -180.0 <= e <= 180.0):
        raise InvalidArea(f"bbox longitudes must be within -180..180; got west={w}, east={e}")
    if s > n:
        raise InvalidArea(f"bbox south ({s}) must not exceed north ({n})")
    if abs(e - w) < 1e-9:
        raise InvalidArea("bbox has zero longitude width")
    return (w, s, e, n)


def resolve_bbox(bbox: str | None, region_id: str | None) -> tuple[float, float, float, float]:
    """Explicit bbox wins; otherwise the named region; otherwise Global.

    Both inputs are validated. Nothing is substituted: a request that cannot be
    honoured raises InvalidArea so the API can answer 400 instead of returning
    numbers for a different area than the caller asked about.
    """
    if bbox is not None and str(bbox).strip() != "":
        return parse_bbox(str(bbox))
    return tuple(get_region(region_id)["bbox"])  # type: ignore[return-value]


def bbox_area_km2(bbox: tuple[float, float, float, float]) -> float:
    """Approximate spherical area of a lat/lon box in km²."""
    import math

    w, s, e, n = bbox
    r = 6371.0088
    lon_span = (e - w) if e >= w else (e + 360 - w)
    lon_rad = math.radians(min(max(lon_span, 0.0), 360.0))
    area = lon_rad * r * r * (math.sin(math.radians(n)) - math.sin(math.radians(s)))
    return abs(area)
