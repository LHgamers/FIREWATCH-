# NASA Data Sources

Two classes of NASA data are used, and they are kept strictly apart: **active
fire detections** (vector, tabular) and **imagery** (raster). Neither is
interpolated onto the other, and neither is used to fill a gap in the other.

Two access tiers exist, and the UI always says which one is active:

| tier | requirement | consequence |
| --- | --- | --- |
| Open / keyless | nothing | 7-day rolling NRT window only |
| Archive | `FIRMS_MAP_KEY` (backend-only) | arbitrary historical windows |

`config.map_key_status()` distinguishes *configured* from *valid* and rejects
placeholder values. The key is never returned by any endpoint; `sources.redact()`
scrubs it from every error string and URL before it can reach `ingest_runs`,
`/api/ingest/status`, `/api/sources/status` or a log line.

---

## 1. MODIS C6.1 · Terra + Aqua · 1 km

**Endpoint (keyless):** `https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_7d.csv`

| property | value |
| --- | --- |
| sensors | MODIS Terra (10:30 desc / 22:30 asc), MODIS Aqua (13:30 asc / 01:30 desc) |
| native footprint | 1 km at nadir |
| nominal global revisits | 4 per day (2 platforms × 2 overpasses) |
| confidence | percentage `0–100` — stored verbatim in `confidence_raw` + `confidence_pct` |
| FRP | `frp`, MW, as reported (no conversion) |
| delivery | rolling 7-day file, rewritten daily, no pagination |
| limits | `MAP_KEY` not needed for the 7-day file; the same data via the Area API does need one |

Notes that matter for interpretation:

* A MODIS "fire pixel" integrates a **1 km × 1 km** area. Several fires inside
  one pixel look like one detection, and one large fire can span many pixels.
* `confidence` is a retrieval confidence, not the probability that a fire
  exists, and not a severity measure.
* `bright_t31` is a 4 µm channel and saturates in very large/intense fires,
  which biases FRP low for extreme events.

## 2. VIIRS 375 m · Suomi-NPP / NOAA-20 / NOAA-21

**Endpoint (keyless, used):** NASA EOSDIS ArcGIS FeatureServer
`https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query`

**Endpoint (archive, needs a key):** FIRMS Area API
`https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/{W,S,E,N}/{DATE}[/{DAYS}]`

| property | value |
| --- | --- |
| sensors | VIIRS on Suomi-NPP, NOAA-20, NOAA-21 |
| native footprint | 375 m at nadir (I-band) |
| nominal global revisits | 6 per day (3 platforms × 2 overpasses) |
| confidence | **categorical only**: `l` low, `n` nominal, `h` high (`confidence_pct` is `NULL`) |
| FRP | `frp`, MW, as reported |
| paging | keyset pagination on `OBJECTID`, page size 8,000 |

Notes:

* `confidence_pct` is `NULL` on every VIIRS row **on purpose**. VIIRS does not
  publish a percentage, and manufacturing one from the categorical band would
  be fabrication. Any UI that shows a VIIRS percentage is wrong.
* The ArcGIS service is a live mirror of the VIIRS 375 m feed with full platform
  names (`NOAA-20`, `NOAA-21`, `Suomi-NPP`). It is not a NASA-operated
  `firms.modaps` host, so it is recorded as its own product name in
  `source_product` to keep provenance unambiguous.
* FIRMS CSV deliveries use short platform tokens. `sources.VIIRS_SATELLITES`
  expands only the documented ones (`N`, `1`, `2`, `NPP`, `N20`, `N21`,
  `J01`, `J02`); anything unrecognised is kept verbatim as the platform name and
  the raw token is preserved in `extra.satellite_code`. The platform name is
  never guessed.

## 3. Imagery · NASA GIBS (WMTS/XYZ)

Used only for the visual basemap and the "latest usable composite" panel — never
for analysis.

* `VIIRS_SNPP_CorrectedReflectance_TrueColor` — daily true-colour mosaic.
* `BlueMarble_ShadedRelief_Bathymetry` — static reference mosaic (used for the 3D globe texture).
* `VIIRS_Black_Marble` — night-lights mosaic (globe night-side emissive texture).

GIBS publishes imagery on its own schedule. **The composite date is charted
separately from the fire window** because they are different things: the
composite currently available may be older than the newest detections.

Validity is decided by a **pixel test**, not an HTTP status: a tile is accepted
only when it decodes, is not a placeholder, and has `coverage >= 0.5` and
`mean >= 60`. GIBS returns HTTP 200 with a black/placeholder JPEG for dates it
does not have, which is exactly the failure this guards against.

**Abandoned:** GIBS *vector* thermal tiles. `TILEMATRIXSET is invalid for
LAYER` and `_Level8` tiles 404. Not used, not planned.

## 4. What was evaluated and rejected

| source | why not used |
| --- | --- |
| FIRMS VIIRS CSV (`VIIRS_SNPP_NRT`, 7-day) | the keyless file is header-only in practice — no rows |
| FIRMS Area API without a key | 401/403; no keyless archive exists |
| GIBS vector thermal tiles | unusable matrix set / 404s |
| NASA EONET | event metadata, not detections; no FRP, no sub-pixel geometry |
| MODIS/VIIRS burned-area products (MCD64A1, VNP64A1) | different product family, weeks-to-months latency, would misrepresent "active fire" |

## 5. Attribution shown in the product

> Active fire detections: NASA FIRMS (MODIS C6.1, VIIRS 375 m) ·
> Imagery: NASA EOSDIS GIBS / Worldview

Both MODIS and VIIRS remain independently identifiable end to end: separate
`sensor`, `satellite`, `source`, `source_product` values, separate colours in
the UI, and no merged "fire count" that cannot be decomposed.
