"""Geodesy for grid aggregation and area-of-interest filtering.

Three things live here, all of which the scientific numbers depend on:

1. **Grid assignment.** A cell index must be ``floor(value / size)``. Truncation
   toward zero (``CAST`` in SQLite) silently merges the cells either side of
   0° latitude/longitude into one double-height cell — Phase 1 had exactly that
   bug. The portable trick used here is to shift the coordinate into the
   non-negative range first (``lat + 90``, ``lon + 180``), where truncation and
   floor agree, because every supported grid size divides both offsets exactly.

2. **Cell area.** Angular cells are *not* equal-area. A 0.5° cell at 60° N is
   about half the area of one at the equator. Physical normalisation therefore
   uses the exact spherical zone area ``R²·Δλ·|sin φ₂ − sin φ₁|``, never a flat
   ``(cell·111.32)²·cos(lat)`` approximation.

3. **AOI.** Rectangles (including antimeridian-crossing ones) and polygons
   (including polygons that cross the antimeridian) are supported, with a
   spherical area so density denominators are honest.
"""
from __future__ import annotations

import math
from typing import Any, Iterable, Sequence

EARTH_R_KM = 6371.0088
GRID_CHOICES = (0.1, 0.25, 0.5)
# Offsets make the shifted coordinate non-negative; all grid sizes divide these.
LAT_OFFSET = 90.0
LON_OFFSET = 180.0


# --------------------------------------------------------------------------- #
# Grid
# --------------------------------------------------------------------------- #
def check_cell(cell: float) -> float:
    """Only the configured comparison grids are accepted."""
    value = float(cell)
    for choice in GRID_CHOICES:
        if abs(value - choice) < 1e-9:
            return choice
    raise ValueError(f"grid must be one of {GRID_CHOICES}")


def cell_index(value: float, cell: float, offset: float) -> int:
    """Exact floor division into a cell index (Python reference implementation)."""
    return math.floor((float(value) + offset) / cell) - int(round(offset / cell))


def cell_origin(index: int, cell: float, offset: float) -> float:
    """Lower edge of a cell index, back in degrees."""
    return (index + offset / cell) * cell - offset


def cell_bounds(cy: int, cx: int, cell: float) -> tuple[float, float, float, float]:
    """(south, north, west, east) in degrees."""
    south = cell_origin(cy, cell, LAT_OFFSET)
    west = cell_origin(cx, cell, LON_OFFSET)
    return round(south, 6), round(south + cell, 6), round(west, 6), round(west + cell, 6)


def cell_center(cy: int, cx: int, cell: float) -> tuple[float, float]:
    south, _, west, _ = cell_bounds(cy, cx, cell)
    return round(south + cell / 2, 6), round(west + cell / 2, 6)


def cell_area_km2(cy: int, cell: float) -> float:
    """Exact spherical area of a latitudinal band cell, in km²."""
    south, north, west, east = cell_bounds(cy, cx=0, cell=cell)
    d_lon = math.radians(east - west)
    d_sin = math.sin(math.radians(north)) - math.sin(math.radians(south))
    return abs(EARTH_R_KM ** 2 * d_lon * d_sin)


def grid_sql(cell: float) -> tuple[str, str, list[float]]:
    """SQL expressions + params for shifted-floor cell indices.

    ``CAST`` truncates toward zero; the +90/+180 shift makes the argument
    non-negative, so truncation *is* floor, and the offsets are removed again by
    the returned index arithmetic.
    """
    lat_expr = f"(CAST((lat + {LAT_OFFSET}) / ? AS INT) - {int(round(LAT_OFFSET / cell))})"
    lon_expr = f"(CAST((lon + {LON_OFFSET}) / ? AS INT) - {int(round(LON_OFFSET / cell))})"
    return lat_expr, lon_expr, [cell, cell]


# --------------------------------------------------------------------------- #
# Areas
# --------------------------------------------------------------------------- #
def bbox_area_km2(west: float, south: float, east: float, north: float) -> float:
    """Exact spherical area of a latitude/longitude rectangle (antimeridian-aware)."""
    lon_span = (east - west) % 360.0
    if lon_span == 0:
        lon_span = 360.0
    d_lon = math.radians(lon_span)
    d_sin = math.sin(math.radians(north)) - math.sin(math.radians(south))
    return abs(EARTH_R_KM ** 2 * d_lon * d_sin)


def polygon_area_km2(ring: Sequence[Sequence[float]]) -> float:
    """Spherical polygon area (km²) via the surface integral of a closed ring.

    ``A = |Σ (λ₂−λ₁)(2 + sin φ₁ + sin φ₂)| · R² / 2`` with longitudes unwrapped
    so the ring stays continuous across the antimeridian.
    """
    pts = _unwrap_ring(ring)
    if len(pts) < 3:
        return 0.0
    total = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(pts, pts[1:] + pts[:1]):
        total += math.radians(lon2 - lon1) * (
            2 + math.sin(math.radians(lat1)) + math.sin(math.radians(lat2))
        )
    return abs(total) * EARTH_R_KM ** 2 / 2.0


# --------------------------------------------------------------------------- #
# Polygons
# --------------------------------------------------------------------------- #
def normalize_ring(points: Iterable[Sequence[float]]) -> list[list[float]]:
    """Validate and close a ring given as ``[[lon, lat], ...]``."""
    ring: list[list[float]] = []
    for point in points:
        if len(point) < 2:
            raise ValueError("each polygon point needs [lon, lat]")
        lon, lat = float(point[0]), float(point[1])
        if not (-180.0 <= lon <= 180.0) or not (-90.0 <= lat <= 90.0):
            raise ValueError(f"polygon point out of range: {lon}, {lat}")
        ring.append([lon, lat])
    if len(ring) < 3:
        raise ValueError("a polygon needs at least three points")
    if ring[0] != ring[-1]:
        ring.append(list(ring[0]))
    # Three points that are not three *places* is a line, and a line encloses no
    # area. Accepting it produced an AOI with areaKm2 = 0.0 that silently matched
    # nothing, which reads as "no fires here" rather than "this is not an area".
    distinct = {(round(p[0], 9), round(p[1], 9)) for p in ring[:-1]}
    if len(distinct) < 3:
        raise ValueError("a polygon needs at least three distinct points")
    if _planar_area(ring) <= 0.0:
        raise ValueError("polygon encloses no area (points are collinear)")
    return ring


def _planar_area(ring: Sequence[Sequence[float]]) -> float:
    """Absolute planar shoelace area in square degrees, on the unwrapped ring.

    Used only as a degeneracy test: it is exactly zero for collinear or repeated
    points, where the spherical integral is small but not exactly zero. The
    reported area always comes from ``polygon_area_km2``.
    """
    pts = _unwrap_ring(ring)
    if len(pts) < 3:
        return 0.0
    acc = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(pts, pts[1:] + pts[:1]):
        acc += lon1 * lat2 - lon2 * lat1
    return abs(acc) / 2.0


def _unwrap_ring(ring: Sequence[Sequence[float]]) -> list[tuple[float, float]]:
    """Make longitudes continuous so antimeridian rings do not wrap ±360."""
    out: list[tuple[float, float]] = []
    prev: float | None = None
    for lon, lat in ring:
        lon = float(lon)
        if prev is not None:
            while lon - prev > 180.0:
                lon -= 360.0
            while prev - lon > 180.0:
                lon += 360.0
        out.append((lon, float(lat)))
        prev = lon
    return out


def ring_bbox(ring: Sequence[Sequence[float]]) -> tuple[float, float, float, float]:
    """(west, south, east, north) of a ring, as an antimeridian-safe bbox."""
    pts = _unwrap_ring(ring)
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    west, east = min(lons), max(lons)
    if west < -180.0:
        west += 360.0
    if east > 180.0:
        east -= 360.0
    # A ring spanning >180° of unwrapped longitude crosses the antimeridian;
    # normalising both ends back into [-180, 180] yields west > east, which is
    # exactly how the SQL prefilter recognises a wrapped box.
    return (west, min(lats), east, max(lats))


def ring_contains(ring: Sequence[Sequence[float]], lon: float, lat: float) -> bool:
    """Ray-casting point-in-polygon on an unwrapped ring (antimeridian-safe)."""
    pts = _unwrap_ring(ring)
    # Bring the probe into the ring's continuous longitude frame.
    target = float(lon)
    lons = [p[0] for p in pts]
    centre = (min(lons) + max(lons)) / 2
    while target - centre > 180.0:
        target -= 360.0
    while centre - target > 180.0:
        target += 360.0

    inside = False
    x, y = target, float(lat)
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        if (y1 > y) != (y2 > y):
            x_at = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < x_at:
                inside = not inside
    return inside


# --------------------------------------------------------------------------- #
# AOI resolution
# --------------------------------------------------------------------------- #
def _bbox_clause(west: float, south: float, east: float, north: float,
                 alias: str = "") -> tuple[str, list[float]]:
    p = f"{alias}." if alias else ""
    if west <= east:
        return (f"{p}lon >= ? AND {p}lon <= ? AND {p}lat >= ? AND {p}lat <= ?",
                [west, east, south, north])
    return (f"({p}lon >= ? OR {p}lon <= ?) AND {p}lat >= ? AND {p}lat <= ?",
            [west, east, south, north])


def aoi(region: dict[str, Any] | None = None,
        bbox: str | Sequence[float] | None = None,
        polygon: str | Sequence[Sequence[float]] | None = None) -> dict[str, Any]:
    """Resolve one AOI from a region id, a bbox string, or a polygon.

    Priority: polygon > bbox > region. The payload always states which was used,
    so a polygon request can never be answered with a bounding box silently.
    """
    import json

    if polygon:
        if isinstance(polygon, str):
            polygon = json.loads(polygon)
        ring = normalize_ring(polygon)
        w, s, e, n = ring_bbox(ring)
        return {
            "kind": "polygon",
            "label": "Custom polygon",
            "bbox": [w, s, e, n],
            "polygon": ring,
            "areaKm2": round(polygon_area_km2(ring), 1),
            "antimeridian": w > e,
            "areaMethod": "spherical polygon area (R=6371.0088 km)",
        }

    if bbox:
        if isinstance(bbox, str):
            try:
                parts = [float(x) for x in bbox.split(",")]
            except ValueError as exc:
                raise ValueError("bbox must contain four comma-separated numbers") from exc
        else:
            try:
                parts = [float(x) for x in bbox]
            except (TypeError, ValueError) as exc:
                raise ValueError("bbox must contain four numbers") from exc
        if len(parts) != 4:
            raise ValueError("bbox must be west,south,east,north")
        w, s, e, n = parts
        if not all(math.isfinite(v) for v in parts) or not (
            -180 <= w <= 180 and -180 <= e <= 180 and -90 <= s < n <= 90
        ):
            raise ValueError("bbox out of range")
        if w == e:
            raise ValueError("bbox has zero longitude span")
        return {
            "kind": "bbox",
            "label": "Custom bounding box",
            "bbox": [w, s, e, n],
            "polygon": None,
            "areaKm2": round(bbox_area_km2(w, s, e, n), 1),
            "antimeridian": w > e,
            "areaMethod": "exact spherical zone area",
        }

    region = region or {"id": "global", "name": "Global",
                        "bbox": [-180.0, -60.0, 180.0, 75.0]}
    w, s, e, n = region["bbox"]
    return {
        "kind": "region",
        "id": region.get("id"),
        "label": region.get("name") or "Selected area",
        "bbox": [w, s, e, n],
        "polygon": None,
        "areaKm2": round(bbox_area_km2(w, s, e, n), 1),
        "antimeridian": w > e,
        "areaMethod": "exact spherical zone area",
        "note": region.get("note"),
    }


def prefilter(target: dict[str, Any], alias: str = "") -> tuple[str, list[float]]:
    """SQL clause that is a superset of the AOI (exact filtering happens next)."""
    w, s, e, n = target["bbox"]
    return _bbox_clause(w, s, e, n, alias)


def contains(target: dict[str, Any], lon: float, lat: float) -> bool:
    """Exact AOI membership for one detection."""
    if target.get("polygon"):
        return ring_contains(target["polygon"], lon, lat)
    w, s, e, n = target["bbox"]
    if not (s <= lat <= n):
        return False
    return (w <= lon <= e) if w <= e else (lon >= w or lon <= e)
