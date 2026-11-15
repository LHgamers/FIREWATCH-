# Spatial Aggregation

How a detection becomes a cell, and why the cell's physical area is computed the
way it is. Implementation: `engine/app/geo.py`, consumed by `platform.py`,
`harmonize.py`, `compare.py`, `scientific.py`.

---

## 1. Grid definition

| property | value |
| --- | --- |
| grid type | equal-angle global grid (WGS84 lat/lon) |
| resolutions | 0.1°, 0.25°, 0.5° (validated list; anything else → 400) |
| origin | cell boundaries at multiples of the resolution; index 0 at 0° |
| projection | none — aggregation happens on the geographic grid, no reprojection |
| assignment | a detection belongs to the cell containing its coordinate |

### Assignment: floor, not truncation

```
i = floor((value + offset) / cell) − offset / cell      offset = 90 (lat), 180 (lon)
```

Phase 1 used SQL `CAST(lat / cell AS INT)`, which truncates toward zero and
therefore merged the two cells either side of 0° latitude and 0° longitude into
one double-height cell. Measured: `CAST(-0.4/0.5) = 0` and `CAST(0.1/0.5) = 0`
— the same index for opposite hemispheres.

Phase 2 shifts the coordinate into the non-negative range before the integer
cast (every supported grid divides 90 and 180 exactly), so truncation *is* floor:

```sql
CAST((lat + 90) / ? AS INT) − 360      -- 0.25° example
```

The equivalence is unit-tested against Python's `math.floor` for
`-89.9, -0.25, -0.0001, 0, 0.0001, 45.5, 89.9` (`test_grid_sql_matches_python_floor`).
No SQLite math-function dependency is required.

## 2. Cell area

Angular cells are **not** equal-area. Exact spherical zone area:

```
A(c) = R² · (λ_east − λ_west) · (sin φ_north − sin φ_south)
R    = 6371.0088 km
```

Measured: a 0.5° × 0.5° cell at the equator is 3,091.0 km²; the same angular cell
at 59.5–60° N is 1,557.2 km² (ratio 0.504 ≈ cos 59.75°). A flat
`(0.5·111.32)²·cos(lat_centre)` approximation overstates the polar cell by ~1–2 %
and, more importantly, normalises the Phase 1 HFAI denominator with a formula
that does not integrate to the AOI area.

Consequence for density: a detection in one high-latitude cell contributes half
the active area of the same detection at the equator, which is the physically
correct behaviour for a MW km⁻² density.

## 3. Boundary and rounding behaviour

| case | behaviour |
| --- | --- |
| coordinate exactly on a boundary | belongs to the upper cell (floor semantics) |
| antimeridian (lon ±180) | `lon + 180` shift keeps indices continuous; lon = 180 and −180 map to different edge cells, never merging |
| pole | lat ∈ [−90, 90]; lat 90 falls in the last cell, no wraparound |
| stored precision | lat/lon stored at 5 decimals; identity uses 4 decimals (~11 m) |
| duplicate detections in a cell-day | reduced by `max(FRP)`, not summed |

## 4. Polygon AOIs

Rectangles and polygons are both supported (`geo.aoi`). Rules:

1. Priority: `polygon` > `bbox` > `region`. The resolved payload always states
   `kind`, so a polygon request is never answered with a bounding box.
2. SQL prefilter uses the polygon's bounding box (antimeridian-safe, `west > east`
   when it wraps); the exact test is per detection, not per cell centre.
3. Ray-casting on longitudes unwrapped to a continuous frame, so a ring crossing
   ±180° works: `ring_contains(ring, 179.5) == True` and
   `ring_contains(ring, -179.5) == True`, while `0°` is excluded (tested).
4. Polygon area uses the spherical ring integral
   `A = |Σ (λ₂−λ₁)(2 + sin φ₁ + sin φ₂)| · R² / 2`, which reproduces the exact
   bbox area for a rectangle to 1e-6 relative (tested).
5. A cell whose centroid is outside the polygon can still contain a detection
   inside it — that is why filtering happens on detections, not on cells.

**Denominator disclosure.** Density denominators are the *active cells* that
contain at least one accepted detection, never the polygon's total area. The AOI
area is reported separately (`aoi.areaKm2`) for context only.

## 5. Aggregation formulas by consumer

| consumer | reduction | units |
| --- | --- | --- |
| `platform.platforms` | count, distinct cells, distinct cell-days per (sensor, platform) | detections / cells / cell-days |
| `harmonize.cell_days` | `max(FRP)` per (cell, day, sensor) | MW |
| `harmonize.indicator` | sums of the above per sensor, divided by exact active area and delivery days | MW km⁻² day⁻¹ |
| `compare.comparison` | nearest-neighbour one-to-one within tolerance | km, MW |
| `scientific.cells` (map) | count, ΣFP, max FRP per cell | detections, MW |

`cells` still uses the legacy `CAST` reduction at 1° for map display; it is a
**descriptive display layer**, not a density input, and is labelled as such. It
does not feed HFAI.

## 6. What spatial aggregation does not do

* It does **not** make 1 km MODIS and 375 m VIIRS footprints equivalent.
* It does **not** resample or interpolate detections onto a common raster.
* It does **not** claim an equal-angle cell has equal physical area — the exact
  area is applied instead.
* It does **not** attribute a detection to a cell's centroid for analysis; the
  centroid is display-only.
