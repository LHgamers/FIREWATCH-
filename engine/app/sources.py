"""NASA data access.

Every reader in this module talks to an official NASA endpoint and records
which one, so the UI can always show provenance. Nothing here invents values.

Open (no key) sources
---------------------
* FIRMS near-real-time CSV drop for MODIS C6.1 (global, rolling 7 days).
* NASA's hosted ArcGIS feature service for the VIIRS 375 m thermal anomalies
  product (rolling ~7 days, SNPP / NOAA-20 / NOAA-21).
* NASA GIBS WMTS/WMS for raster imagery (context, any date).

Keyed source
------------
* FIRMS area API, which is the only route to the multi-year archive. It needs
  a free MAP_KEY; without it the platform is honest about its 7-day horizon.

Phase 1 hardening
-----------------
* Errors are typed (``auth`` / ``rate_limited`` / ``invalid`` / ``unavailable``)
  so the status endpoint can report the real failure instead of "error".
* The MAP_KEY is registered as a secret and substituted with ``***`` in every
  error message, so it can never reach ``ingest_runs``, logs or an API response.
* Transient failures are retried with exponential backoff (429 honours
  ``Retry-After`` when present).
* Each record carries ``original_id`` (the source's own identifier, e.g. the
  ArcGIS ``OBJECTID``), ``source_url``, ``source_product``, ``source_version``
  and ``extra`` — a JSON bag of source fields this schema does not model.
"""
from __future__ import annotations

import csv
import io
import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Iterable

MODIS_CSV = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_7d.csv"
MODIS_CSV_24H = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv"
FIRMS_AREA = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
VIIRS_ARCGIS = (
    "https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/"
    "Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query"
)
GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"

USER_AGENT = "FIREWATCH-AI/1.0 (LH Studios; NASA Space Apps Challenge 2026)"

_SECRETS: set[str] = set()


# --------------------------------------------------------------------------- #
# Errors + secret redaction
# --------------------------------------------------------------------------- #
class SourceError(RuntimeError):
    """Base class; ``status`` is reported by /api/sources/status."""

    status = "error"


class SourceAuthError(SourceError):
    status = "auth"


class SourceRateLimitError(SourceError):
    status = "rate_limited"


class SourceInvalidError(SourceError):
    status = "invalid"


class SourceUnavailableError(SourceError):
    status = "unavailable"


def register_secret(value: str | None) -> None:
    """Remember a secret so it is stripped from every message this module emits."""
    if value and len(value) >= 4:
        _SECRETS.add(value)


def redact(text: Any) -> str:
    """Remove registered secrets from any string that leaves the engine."""
    out = str(text)
    for secret in _SECRETS:
        if secret in out:
            out = out.replace(secret, "***")
    return out


def firms_map_key() -> str:
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    register_secret(key)
    return key


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _classify(status: int) -> type[SourceError]:
    if status in (401, 403):
        return SourceAuthError
    if status == 429:
        return SourceRateLimitError
    if 400 <= status < 500:
        return SourceInvalidError
    return SourceUnavailableError


def _get(url: str, timeout: int = 60, retries: int = 3,
         headers: dict[str, str] | None = None) -> bytes:
    """GET with typed errors, secret redaction and bounded retry."""
    delay = 0.8
    last: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed NASA hosts
                data = resp.read()
                if resp.status >= 400:  # pragma: no cover - urllib raises instead
                    raise _classify(resp.status)(f"HTTP {resp.status} for {redact(url)}")
                return data
        except urllib.error.HTTPError as exc:
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            klazz = _classify(exc.code)
            last = klazz(f"HTTP {exc.code} for {redact(url)}")
            if exc.code < 500 and exc.code != 429:
                raise last from exc
            if attempt == retries - 1:
                raise last from exc
            try:
                wait = float(retry_after) if retry_after else delay
            except (TypeError, ValueError):
                wait = delay
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = SourceUnavailableError(f"network failure for {redact(url)}: {redact(exc)}")
            if attempt == retries - 1:
                raise last from exc
        time.sleep(min(20.0, delay + random.uniform(0, delay / 2)))
        delay *= 2
    raise last or SourceUnavailableError("request failed")


def _ms(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


# --------------------------------------------------------------------------- #
# Source catalogue
# --------------------------------------------------------------------------- #
SOURCES: list[dict[str, Any]] = [
    {
        "id": "firms-modis-c61",
        "label": "MODIS C6.1 active fire (Terra + Aqua)",
        "sensor": "modis",
        "instrument": "MODIS",
        "provider": "NASA FIRMS",
        "url": "https://firms.modaps.eosdis.nasa.gov/data/active_fire/",
        "access": "open",
        "resolution": "1 km",
        "coverage": "rolling 7 days, global",
        "product": "MODIS_C6_1_Global_7d",
    },
    {
        "id": "firms-viirs-375",
        "label": "VIIRS 375 m thermal anomalies (SNPP, NOAA-20, NOAA-21)",
        "sensor": "viirs",
        "instrument": "VIIRS",
        "provider": "NASA FIRMS / ArcGIS",
        "url": "https://firms.modaps.eosdis.nasa.gov/active_fire/",
        "access": "open",
        "resolution": "375 m",
        "coverage": "rolling ~7 days, global",
        "product": "Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity",
    },
    {
        "id": "firms-archive",
        "label": "FIRMS archive (multi-year, area API)",
        "sensor": "both",
        "instrument": "MODIS + VIIRS",
        "provider": "NASA FIRMS",
        "url": "https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html",
        "access": "MAP_KEY required",
        "resolution": "1 km / 375 m",
        "coverage": "2000-present (MODIS), 2012-present (VIIRS)",
        "product": "FIRMS_area_api",
    },
    {
        "id": "gibs-imagery",
        "label": "NASA GIBS true-colour imagery",
        "sensor": "imagery",
        "instrument": "MODIS / VIIRS corrected reflectance",
        "provider": "NASA EOSDIS GIBS",
        "url": "https://gibs.earthdata.nasa.gov/",
        "access": "open",
        "resolution": "250 m",
        "coverage": "2000-present, daily",
        "attribution": "NASA EOSDIS GIBS / Worldview",
    },
]


# --------------------------------------------------------------------------- #
# Field semantics
# --------------------------------------------------------------------------- #
def harmonized_confidence(sensor: str, raw: str) -> tuple[float | None, str | None]:
    """Map each sensor's native confidence field to a shared ordinal class.

    The native value is preserved alongside; the class is a *view*, not a
    conversion, because MODIS percentage confidence and the VIIRS
    low/nominal/high categories are not equivalent quantities.
    """
    if raw is None:
        return None, None
    raw = str(raw).strip()
    if sensor == "modis":
        try:
            pct = float(raw)
        except ValueError:
            return None, None
        cls = "low" if pct < 30 else ("high" if pct >= 80 else "nominal")
        return pct, cls
    low = raw.lower()
    if low in {"l", "low"}:
        return None, "low"
    if low in {"n", "nominal"}:
        return None, "nominal"
    if low in {"h", "high"}:
        return None, "high"
    return None, None


def identity(sensor: str, satellite: str, lat: float, lon: float, ts: int) -> str:
    """Stable record identity.

    Neither the FIRMS CSV drop nor the archive CSV carries a row identifier, so
    identity is the acquisition itself: sensor + platform + 4-decimal position
    (~11 m) + acquisition second. The source's own identifier, when one exists,
    is kept separately in ``original_id`` and is never used to overwrite a row.
    """
    prefix = "MOD" if sensor == "modis" else "VII"
    return f"{prefix}:{satellite}:{lat:.4f}:{lon:.4f}:{ts}"


def _num(v: Any) -> float | None:
    try:
        if v is None or str(v).strip() == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _modis_instrument(sat: str) -> str:
    return {"T": "MODIS Terra", "A": "MODIS Aqua"}.get((sat or "").strip(), "MODIS")


MODIS_FIELDS = {
    "latitude", "longitude", "brightness", "scan", "track", "acq_date", "acq_time",
    "satellite", "instrument", "confidence", "version", "bright_t31", "frp", "daynight",
}
# FIRMS VIIRS CSV uses short satellite tokens. Only documented tokens are
# expanded; anything else is kept verbatim so no platform name is invented.
VIIRS_SATELLITES = {
    "N": "Suomi-NPP", "NPP": "Suomi-NPP", "SNPP": "Suomi-NPP",
    "1": "NOAA-20", "N20": "NOAA-20", "J01": "NOAA-20",
    "2": "NOAA-21", "N21": "NOAA-21", "J02": "NOAA-21",
    "NOAA-20": "NOAA-20", "NOAA-21": "NOAA-21",
}
VIIRS_FIELDS = {
    "latitude", "longitude", "bright_ti4", "scan", "track", "acq_date", "acq_time",
    "satellite", "instrument", "confidence", "version", "bright_ti5", "frp", "daynight",
}
ARCGIS_FIELDS = {
    "objectid", "latitude", "longitude", "bright_ti4", "bright_ti5", "scan", "track",
    "acq_date", "acq_time", "satellite", "instrument", "confidence", "version", "frp",
    "daynight", "esritimeutc", "frp_confidence", "daynightflag", "type", "geometry",
}


def _extra(row: dict[str, Any], modelled: set[str]) -> dict[str, Any] | None:
    out = {
        k: v for k, v in row.items()
        if k and k.lower() not in modelled and v not in (None, "")
    }
    return out or None


# --------------------------------------------------------------------------- #
# Parsers
# --------------------------------------------------------------------------- #
def parse_modis_csv(text: str, source_id: str = "firms-modis-c61",
                    source_url: str = MODIS_CSV) -> Iterable[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(text))
    now = int(time.time() * 1000)
    for row in reader:
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            date = row["acq_date"].strip()
            hhmm = str(row.get("acq_time", "0000")).zfill(4)
            ts = _ms(datetime.strptime(f"{date}T{hhmm[:2]}:{hhmm[2:4]}:00", "%Y-%m-%dT%H:%M:%S"))
        except (KeyError, ValueError):
            continue
        sat = (row.get("satellite") or "").strip()
        pct, cls = harmonized_confidence("modis", row.get("confidence"))
        yield {
            "id": identity("modis", sat, round(lat, 5), round(lon, 5), ts),
            "sensor": "modis",
            "instrument": _modis_instrument(sat),
            "satellite": {"T": "Terra", "A": "Aqua"}.get(sat, sat or "MODIS"),
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "ts": ts,
            "acq_date": date,
            "acq_time": f"{hhmm[:2]}:{hhmm[2:4]}",
            "confidence_raw": str(row.get("confidence")),
            "confidence_pct": pct,
            "confidence_class": cls,
            "frp": _num(row.get("frp")),
            "brightness": _num(row.get("brightness")),
            "bright_t31": _num(row.get("bright_t31")),
            "scan": _num(row.get("scan")),
            "track": _num(row.get("track")),
            "daynight": (row.get("daynight") or "").strip() or None,
            "version": (row.get("version") or "").strip() or None,
            "source": source_id,
            "cycle": "archive" if source_id == "firms-archive" else "nrt",
            "ingested_at": now,
            "original_id": (row.get("_id") or "").strip() or None,
            "source_url": source_url,
            "source_product": "MODIS_C6_1_Global_7d" if source_id == "firms-modis-c61" else "FIRMS_area_api",
            "source_version": (row.get("version") or "").strip() or None,
            "extra": _extra(row, MODIS_FIELDS),
            "quality": "raw",
        }


def fetch_modis_7d(limit: int | None = None) -> list[dict[str, Any]]:
    raw = _get(MODIS_CSV)
    rows = list(parse_modis_csv(raw.decode("utf-8", errors="replace")))
    return rows[:limit] if limit else rows


def parse_viirs_csv(text: str, source_id: str = "firms-archive",
                    source_url: str = FIRMS_AREA) -> Iterable[dict[str, Any]]:
    now = int(time.time() * 1000)
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            date_s = row["acq_date"].strip()
            hhmm = str(row.get("acq_time", "0000")).zfill(4)
            ts = _ms(datetime.strptime(f"{date_s}T{hhmm[:2]}:{hhmm[2:4]}:00", "%Y-%m-%dT%H:%M:%S"))
        except (KeyError, ValueError):
            continue
        pct, cls = harmonized_confidence("viirs", row.get("confidence"))
        sat = str(row.get("satellite") or "").strip()
        code = sat.upper()
        satellite = VIIRS_SATELLITES.get(code, sat or "VIIRS")
        extra = _extra(row, VIIRS_FIELDS)
        if sat:
            # Keep the transport token alongside the expanded platform name so
            # the original identifier is never lost, mapped or not.
            extra = {**(extra or {}), "satellite_code": sat}
        yield {
            "id": identity("viirs", code, round(lat, 5), round(lon, 5), ts),
            "sensor": "viirs",
            "instrument": "VIIRS 375 m",
            "satellite": satellite,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "ts": ts,
            "acq_date": date_s,
            "acq_time": f"{hhmm[:2]}:{hhmm[2:4]}",
            "confidence_raw": str(row.get("confidence")),
            "confidence_pct": pct,
            "confidence_class": cls,
            "frp": _num(row.get("frp")),
            "brightness": _num(row.get("bright_ti4")),
            "bright_t31": _num(row.get("bright_ti5")),
            "scan": _num(row.get("scan")),
            "track": _num(row.get("track")),
            "daynight": (row.get("daynight") or "").strip() or None,
            "version": (row.get("version") or "").strip() or None,
            "source": source_id,
            "cycle": "archive",
            "ingested_at": now,
            "original_id": (row.get("_id") or "").strip() or None,
            "source_url": source_url,
            "source_product": "FIRMS_area_api",
            "source_version": (row.get("version") or "").strip() or None,
            "extra": extra,
            "quality": "raw",
        }


def fetch_viirs(page_size: int = 8000, max_pages: int = 140,
                on_page: Any = None) -> list[dict[str, Any]]:
    """Page through the VIIRS thermal anomaly feature service by OBJECTID cursor.

    Offset paging on this service fails on deep pages, so we use a keyset
    cursor (`OBJECTID > last`) ordered ascending. Each response is capped at
    16k features by the server.
    """
    rows: list[dict[str, Any]] = []
    now = int(time.time() * 1000)
    cursor = -1
    for page in range(max_pages):
        params = {
            "where": f"OBJECTID > {cursor}",
            "outFields": "*",
            "returnGeometry": "false",
            "f": "geojson",
            "resultRecordCount": str(page_size),
            "orderByFields": "OBJECTID ASC",
        }
        payload = _get(f"{VIIRS_ARCGIS}?{urllib.parse.urlencode(params)}", timeout=120)
        data = json.loads(payload.decode("utf-8"))
        features = data.get("features") or []
        if not features:
            break
        for f in features:
            props = f.get("properties") or {}
            lat = _num(props.get("latitude"))
            lon = _num(props.get("longitude"))
            if lat is None or lon is None:
                continue
            ts = _num(props.get("esritimeutc")) or _num(props.get("acq_date"))
            if ts is None:
                continue
            ts = int(ts)
            dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
            pct, cls = harmonized_confidence("viirs", props.get("confidence"))
            sat = str(props.get("satellite") or "").upper()
            sat_name = {"N": "Suomi-NPP", "N20": "NOAA-20", "N21": "NOAA-21",
                        "SNPP": "Suomi-NPP"}.get(sat, sat or "VIIRS")
            rows.append({
                "id": identity("viirs", sat, round(float(lat), 5), round(float(lon), 5), ts),
                "sensor": "viirs",
                "instrument": "VIIRS 375 m",
                "satellite": sat_name,
                "lat": round(float(lat), 5),
                "lon": round(float(lon), 5),
                "ts": ts,
                "acq_date": dt.strftime("%Y-%m-%d"),
                "acq_time": dt.strftime("%H:%M"),
                "confidence_raw": str(props.get("confidence")),
                "confidence_pct": pct,
                "confidence_class": cls,
                "frp": _num(props.get("frp")),
                "brightness": _num(props.get("bright_ti4")),
                "bright_t31": _num(props.get("bright_ti5")),
                "scan": _num(props.get("scan")),
                "track": _num(props.get("track")),
                "daynight": (str(props.get("daynight") or "").strip() or None),
                "version": str(props.get("version") or "") or None,
                "source": "firms-viirs-375",
                "cycle": "nrt",
                "ingested_at": now,
                "original_id": str(props.get("OBJECTID") or props.get("objectid") or "") or None,
                "source_url": VIIRS_ARCGIS,
                "source_product": "Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity",
                "source_version": str(props.get("version") or "") or None,
                "extra": _extra(props, ARCGIS_FIELDS),
                "quality": "raw",
            })
        last_feature = features[-1]
        last_id = last_feature.get("id") or (last_feature.get("properties") or {}).get("OBJECTID")
        if last_id is None:
            break
        cursor = int(last_id)
        if on_page:
            on_page(page + 1, len(rows))
        if len(features) < page_size:
            break
    return rows


def fetch_firms_archive(source: str, bbox: tuple[float, float, float, float],
                        date: str, days: int = 1) -> list[dict[str, Any]]:
    """Official FIRMS area API. Requires FIRMS_MAP_KEY.

    The key is part of the URL path by design of that API, so the URL is never
    echoed: every raised error is built from ``redact(url)`` and the response
    body is only quoted after redaction.
    """
    key = firms_map_key()
    if not key:
        raise SourceAuthError("FIRMS_MAP_KEY is not configured; the multi-year archive is unavailable.")
    w, s, e, n = bbox
    area = f"{w},{s},{e},{n}"
    day_spec = date if days <= 1 else f"{date}/{days}"
    url = f"{FIRMS_AREA}/{key}/{source}/{area}/{day_spec}"
    safe_url = redact(url)
    try:
        payload = _get(url)
    except SourceError as exc:
        raise type(exc)(redact(str(exc))) from None
    text = payload.decode("utf-8", errors="replace")
    head = text[:200]
    if head.lstrip().upper().startswith("ERROR") or "Invalid" in head:
        raise SourceInvalidError(redact(f"FIRMS rejected the request: {text[:200]}"))
    if source.upper().startswith("MODIS"):
        return list(parse_modis_csv(text, source_id="firms-archive", source_url=safe_url))
    return list(parse_viirs_csv(text, source_id="firms-archive", source_url=safe_url))


def gibs_layer_url(layer: str, date: str, z: int, x: int, y: int,
                   tile_matrix_set: str = "GoogleMapsCompatible_Level9") -> str:
    return f"{GIBS}/{layer}/default/{date}/{tile_matrix_set}/{z}/{y}/{x}.jpg"
