"""Place-name lookup for Ask the Earth.

The browser asks **this engine** for a place (`/api/geocode`), never a third
party directly. That keeps the User-Agent, the upstream rate limit and the
attribution string on the server, which is what the OpenStreetMap Nominatim
usage policy requires.

Rules enforced here:

* **One upstream request per second, maximum.** A process-wide lock plus a
  monotonic clock spaces calls; the cache absorbs repeats. Nominatim's policy
  explicitly forbids bulk querying.
* **Cache first.** Identical `(q, limit)` pairs are answered from memory for a
  day. Nothing is written to the observations database.
* **Nothing invented.** If the upstream fails, this module raises
  `GeocodeUnavailable` (503). The UI then offers the 12 documented built-in
  regions. There is no fallback gazetteer of made-up coordinates.
* **Attribution is part of the payload.** `provider` and `attribution` are sent
  with every response so the UI cannot guess a licence.

The query string is validated: 2-80 characters, no control characters. This
endpoint performs no SQL and no shell work, so the input cannot reach a
database or a process.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "FIREWATCH-AI/1.0 (LH Studios; NASA Space Apps Challenge 2026)"

PROVIDER = "OpenStreetMap Nominatim"
ATTRIBUTION = "© OpenStreetMap contributors, ODbL 1.0 — geocoding by Nominatim"
NOTE = (
    "A place resolves to its published administrative or natural extent, not to a "
    "fire perimeter. The extent becomes the engine AOI."
)

MAX_QUERY = 80
MIN_QUERY = 2
CACHE_TTL_S = 86_400
CACHE_MAX = 600
MIN_INTERVAL_S = 1.1  # Nominatim: absolute maximum 1 request/second

_lock = threading.Lock()
_last_call = 0.0
_cache: dict[tuple[str, int], tuple[float, list[dict[str, Any]]]] = {}


class GeocodeUnavailable(RuntimeError):
    """Upstream geocoder unreachable or refused the request."""


class GeocodeRateLimited(RuntimeError):
    """Our own politeness gate refused because the caller is too fast."""


_KIND = {
    "country": "country",
    "state": "state",
    "province": "state",
    "region": "region",
    "state_district": "state",
    "county": "area",
    "district": "area",
    "city": "city",
    "town": "city",
    "village": "city",
    "municipality": "city",
    "hamlet": "city",
    "suburb": "city",
    "locality": "city",
    "administrative": "area",
    "island": "area",
    "national_park": "area",
    "protected_area": "area",
}


def _kind(raw: dict[str, Any]) -> str:
    for key in ("addresstype", "type"):
        value = raw.get(key)
        if isinstance(value, str) and value in _KIND:
            return _KIND[value]
    return "unknown"


def _bbox(raw: dict[str, Any]) -> list[float] | None:
    """Nominatim sends [south, north, west, east] as strings."""
    box = raw.get("boundingbox")
    if not isinstance(box, list) or len(box) != 4:
        return None
    try:
        south, north, west, east = (float(v) for v in box)
    except (TypeError, ValueError):
        return None
    if not (-90 <= south < north <= 90) or not (-180 <= west <= 180 and -180 <= east <= 180):
        return None
    return [west, south, east, north]


def _coord(raw: dict[str, Any], key: str) -> float | None:
    try:
        value = float(raw.get(key))
    except (TypeError, ValueError):
        return None
    return value


def _normalise(raw: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    display = raw.get("display_name")
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        name = display.split(",")[0].strip() if isinstance(display, str) else ""
    if not name:
        return None

    lat = _coord(raw, "lat")
    lon = _coord(raw, "lon")
    box = _bbox(raw)
    if box is None and lat is not None and lon is not None:
        # A point is a place, not an AOI. Use a 0.1° box and say so in `kind`.
        box = [lon - 0.05, max(-90.0, lat - 0.05), lon + 0.05, min(90.0, lat + 0.05)]
    if box is None:
        return None
    if lat is None or lon is None:
        lat = (box[1] + box[3]) / 2
        lon = (box[0] + box[2]) / 2

    address = raw.get("address") if isinstance(raw.get("address"), dict) else {}
    admin = ""
    for key in ("state", "region", "state_district", "county"):
        value = address.get(key)  # type: ignore[union-attr]
        if isinstance(value, str) and value.strip():
            admin = value.strip()
            break
    country = address.get("country", "") if isinstance(address, dict) else ""
    country = country.strip() if isinstance(country, str) else ""

    return {
        "name": name.strip(),
        "displayName": display.strip() if isinstance(display, str) else None,
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "bbox": [round(v, 5) for v in box],
        "kind": _kind(raw),
        "admin": admin,
        "country": country,
        "source": "nominatim",
        "id": str(raw.get("place_id") or ""),
        "class": raw.get("class"),
        "type": raw.get("type"),
    }


def _upstream(query: str, limit: int) -> list[dict[str, Any]]:
    global _last_call
    params = urllib.parse.urlencode(
        {
            "q": query,
            "format": "jsonv2",
            "addressdetails": 1,
            "limit": str(limit),
            "accept-language": "en",
        }
    )
    request = urllib.request.Request(
        f"{NOMINATIM}?{params}",
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )

    with _lock:
        wait = MIN_INTERVAL_S - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=12) as resp:  # noqa: S310 - fixed host
                body = resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                raise GeocodeRateLimited("the upstream geocoder rate-limited this engine") from exc
            raise GeocodeUnavailable(f"upstream geocoder returned HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise GeocodeUnavailable("upstream geocoder is unreachable (network or DNS)") from exc

    try:
        payload = json.loads(body.decode("utf-8", "replace"))
    except json.JSONDecodeError as exc:
        raise GeocodeUnavailable("upstream geocoder returned a non-JSON body") from exc
    if not isinstance(payload, list):
        raise GeocodeUnavailable("upstream geocoder returned an unexpected payload shape")

    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in payload:
        normalised = _normalise(item)
        if not normalised:
            continue
        key = (normalised["name"].lower(), ",".join(f"{v:.3f}" for v in normalised["bbox"]))
        if key in seen:  # duplicate detection, required by the brief
            continue
        seen.add(key)
        out.append(normalised)
    return out


def search(query: str, limit: int = 8) -> dict[str, Any]:
    """Resolve free text to places. Raises GeocodeUnavailable / ValueError."""
    # Control characters are rejected on the RAW input: normalising whitespace
    # first ("a\nb" -> "a b") would otherwise let a multi-line injection attempt
    # through the validator and into the upstream query string.
    if any(ord(c) < 32 for c in query):
        raise ValueError("q contains control characters")
    text = " ".join(query.split())
    if len(text) < MIN_QUERY:
        raise ValueError(f"q must be at least {MIN_QUERY} characters")
    if len(text) > MAX_QUERY:
        raise ValueError(f"q must be at most {MAX_QUERY} characters")

    limit = max(1, min(int(limit), 10))
    key = (text.lower(), limit)
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_TTL_S:
        results = hit[1]
        cached = True
    else:
        results = _upstream(text, limit)
        cached = False
        if len(_cache) >= CACHE_MAX:
            _cache.pop(next(iter(_cache)))
        _cache[key] = (now, results)

    return {
        "query": text,
        "provider": PROVIDER,
        "attribution": ATTRIBUTION,
        "note": NOTE,
        "cached": cached,
        "results": results,
        "count": len(results),
    }


def cache_clear() -> int:
    with _lock:
        n = len(_cache)
        _cache.clear()
    return n
