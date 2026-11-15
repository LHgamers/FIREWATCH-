"""NASA knowledge base + lightweight retrieval.

The assistant is grounded on a curated, citable set of statements about the
FIRMS distribution, the MODIS and VIIRS active-fire products and the limits of
interpretation. Retrieval is a transparent TF-IDF style overlap — no external
model, no network call, fully inspectable.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field


@dataclass
class Doc:
    id: str
    title: str
    text: str
    source: str
    url: str
    tags: list[str] = field(default_factory=list)


DOCS: list[Doc] = [
    Doc(
        id="firms-overview",
        title="What FIRMS distributes",
        text=(
            "NASA FIRMS (Fire Information for Resource Management System) distributes near real-time "
            "active fire detections from MODIS and VIIRS, typically within three hours of a satellite "
            "overpass. Each record is a thermal anomaly: a pixel whose mid-infrared radiance exceeded a "
            "contextual threshold. A detection is evidence of a hot surface, not proof of a wildfire, and "
            "FIRMS does not attribute cause."
        ),
        source="NASA FIRMS — About / FAQ",
        url="https://firms.modaps.eosdis.nasa.gov/about/",
        tags=["firms", "overview", "what", "detection", "definition"],
    ),
    Doc(
        id="modis-instruments",
        title="MODIS Terra and Aqua",
        text=(
            "MODIS flies on Terra (launched December 1999, operational 2000) and Aqua (launched 2002). "
            "The active fire product is derived from the 1 km MODIS fire product (MCD14ML in the standard "
            "archive, Collection 6.1). MODIS has roughly two daytime and two nighttime overpasses per day "
            "when both platforms are combined, at mid-to-high latitudes. The confidence field is a "
            "percentage from 0 to 100 produced by the contextual algorithm."
        ),
        source="NASA FIRMS — MODIS Collection 6.1",
        url="https://firms.modaps.eosdis.nasa.gov/descriptions/FIRMS_MODIS_Active_Fire_Products.html",
        tags=["modis", "terra", "aqua", "1km", "confidence", "overpass", "collection"],
    ),
    Doc(
        id="viirs-instruments",
        title="VIIRS 375 m active fire",
        text=(
            "The VIIRS 375 m I-band active fire product flies on Suomi-NPP (from January 2012), NOAA-20 "
            "(from 2018) and NOAA-21. Its finer 375 m footprint detects smaller and cooler fires than MODIS "
            "and produces more detections for the same fire. VIIRS confidence is reported as low, nominal or "
            "high, which is a different quantity from the MODIS percentage."
        ),
        source="NASA FIRMS — VIIRS 375 m",
        url="https://firms.modaps.eosdis.nasa.gov/descriptions/FIRMS_VIIRS_Active_Fire_Products.html",
        tags=["viirs", "375m", "snpp", "noaa-20", "noaa-21", "confidence", "resolution"],
    ),
    Doc(
        id="confidence",
        title="Confidence fields are not interchangeable",
        text=(
            "MODIS confidence is a percentage; VIIRS confidence is an ordinal category. Neither is a "
            "probability that a pixel contains a fire in the statistical sense, and converting one to the "
            "other is not supported by the product documentation. The platform therefore keeps native "
            "values and only offers an ordinal low/nominal/high view for filtering, explicitly labelled as "
            "a view rather than a calibration."
        ),
        source="FIRMS product guides; Giglio et al. (2016); Schroeder et al. (2014)",
        url="https://firms.modaps.eosdis.nasa.gov/content/descriptions/",
        tags=["confidence", "calibration", "comparison", "modis", "viirs"],
    ),
    Doc(
        id="frp",
        title="Fire Radiative Power",
        text=(
            "FRP is the radiant power emitted by a fire, in megawatts, estimated from the mid-infrared "
            "radiance of the fire pixel. It scales with the rate of fuel consumption, so it is a measure of "
            "combustion intensity rather than of burned area. FRP depends on the sensor footprint: a "
            "sub-pixel fire inside a 1 km MODIS pixel and the same fire inside a 375 m VIIRS pixel can "
            "report very different FRP values."
        ),
        source="Wooster et al. (2003); Kaufman et al. (1998); FIRMS field definitions",
        url="https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html",
        tags=["frp", "radiative", "power", "intensity", "mw"],
    ),
    Doc(
        id="brightness",
        title="Brightness temperatures",
        text=(
            "brightness (MODIS) is the brightness temperature of the fire pixel around 4 µm. For VIIRS, "
            "bright_ti4 is the I-4 channel brightness temperature near 3.74 µm and bright_ti5 is the I-5 "
            "channel near 11.45 µm. A very high brightness temperature indicates a hot, often flaming, "
            "pixel; saturated pixels can cap the reported value and hide how hot the fire really is."
        ),
        source="MODIS C6.1 ATBD; VIIRS 375 m product guide",
        url="https://firms.modaps.eosdis.nasa.gov/descriptions/FIRMS_VIIRS_Active_Fire_Products.html",
        tags=["brightness", "temperature", "band", "saturation", "kelvin"],
    ),
    Doc(
        id="gap-limits",
        title="Missing observations are not zero activity",
        text=(
            "Active fire sensors only see a location a few times per day, and cloud, smoke, thick aerosol, "
            "solar glint, steep terrain and sensor saturation can all suppress a detection. A day with no "
            "detections is not a day without fire. The platform records coverage per day and marks days "
            "without data as unavailable rather than zero."
        ),
        source="NASA FIRMS FAQ; MODIS/VIIRS product guides",
        url="https://firms.modaps.eosdis.nasa.gov/faq/",
        tags=["gap", "missing", "cloud", "zero", "availability", "false", "negative"],
    ),
    Doc(
        id="harmonization",
        title="Harmonizing MODIS and VIIRS",
        text=(
            "MODIS (1 km) and VIIRS (375 m) differ in footprint, overpass count, saturation behaviour and "
            "confidence semantics, so raw detection counts are not comparable. A defensible comparison "
            "aggregates to a common spatial grid, reduces repeated overpasses within a cell-day, and "
            "compares a physical quantity such as FRP per unit ground area. Any scaling factor derived from "
            "one region and period is experimental and must not be applied globally."
        ),
        source="FIREWATCH AI scientific methodology; NASA product guides",
        url="https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html",
        tags=["harmonization", "comparison", "method", "methodology", "grid", "scale"],
    ),
    Doc(
        id="anomaly",
        title="How anomalies are computed",
        text=(
            "Daily activity is compared with a baseline using a robust z-score: (x − median) / (1.4826 × "
            "MAD). The median and median absolute deviation are used because daily fire counts are heavily "
            "skewed and a single extreme day would distort a mean and standard deviation. The result is "
            "indicative, not a forecast: an unusual day is not automatically an emergency."
        ),
        source="FIREWATCH AI scientific methodology",
        url="https://firms.modaps.eosdis.nasa.gov/faq/",
        tags=["anomaly", "baseline", "z-score", "mad", "statistics"],
    ),
    Doc(
        id="attribution",
        title="What cannot be inferred",
        text=(
            "Satellite thermal anomalies cannot establish ignition cause, fire size, rate of spread or "
            "whether a fire is under management. Those require ground records, burned-area mapping or "
            "incident reporting. FIREWATCH AI is not an emergency service and does not replace official "
            "warnings."
        ),
        source="NASA FIRMS FAQ; FIREWATCH AI limitations",
        url="https://firms.modaps.eosdis.nasa.gov/faq/",
        tags=["cause", "limitation", "emergency", "spread", "safety"],
    ),
    Doc(
        id="daynight",
        title="Day and night overpasses",
        text=(
            "Day/night flags describe the solar illumination at acquisition. Night detections are useful "
            "because small fires stand out against a cool background, but the detection thresholds and "
            "saturation behaviour differ from daytime, so day and night counts should not be pooled without "
            "saying so."
        ),
        source="MODIS C6.1 ATBD; VIIRS product guide",
        url="https://firms.modaps.eosdis.nasa.gov/descriptions/FIRMS_MODIS_Active_Fire_Products.html",
        tags=["day", "night", "overpass", "threshold"],
    ),
    Doc(
        id="scan-track",
        title="Scan and track",
        text=(
            "scan and track give the along-scan and along-track pixel dimensions in kilometres at the "
            "detection location. Pixels grow towards the edge of the swath, so the same fire can be "
            "reported with different effective areas depending on where in the swath it was observed."
        ),
        source="FIRMS field definitions",
        url="https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html",
        tags=["scan", "track", "pixel", "swath", "geometry"],
    ),
    Doc(
        id="api",
        title="FIRMS data access",
        text=(
            "FIRMS provides rolling near-real-time CSV and shapefile drops, and an area API that returns "
            "CSV for a bounding box and date range. The area API requires a free MAP_KEY. This deployment "
            "reads the open near-real-time drops without a key, which is why the stored window is short; "
            "configuring FIRMS_MAP_KEY unlocks archive retrieval for arbitrary historical periods."
        ),
        source="NASA FIRMS — Data API",
        url="https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html",
        tags=["api", "access", "archive", "map_key", "download"],
    ),
]

_STOP = {
    "the", "a", "an", "is", "are", "was", "were", "of", "to", "in", "on", "for", "and", "or", "what",
    "which", "how", "why", "does", "do", "did", "this", "that", "it", "with", "from", "be", "can",
    "you", "me", "my", "about", "there", "here", "tell", "explain", "show",
}


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9\-]+", text.lower()) if t not in _STOP and len(t) > 2]


class KnowledgeBase:
    def __init__(self, docs: list[Doc] | None = None) -> None:
        self.docs = docs or DOCS
        self._doc_tokens = [(_tokens(d.title + " " + d.text + " " + " ".join(d.tags)), d) for d in self.docs]
        df: dict[str, int] = {}
        for toks, _ in self._doc_tokens:
            for t in set(toks):
                df[t] = df.get(t, 0) + 1
        n = len(self.docs)
        self._idf = {t: math.log((n + 1) / (c + 0.5)) for t, c in df.items()}

    def search(self, query: str, k: int = 4) -> list[tuple[Doc, float]]:
        qt = _tokens(query)
        if not qt:
            return []
        scored: list[tuple[Doc, float]] = []
        for toks, doc in self._doc_tokens:
            counts: dict[str, int] = {}
            for t in toks:
                counts[t] = counts.get(t, 0) + 1
            score = 0.0
            for t in qt:
                if t in counts:
                    score += (1 + math.log(counts[t])) * self._idf.get(t, 0.5)
            if doc.id in {"confidence", "frp", "gap-limits"} and score > 0:
                score *= 1.05
            if score > 0:
                scored.append((doc, round(score, 3)))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:k]

    def citations(self, docs: list[Doc]) -> list[dict[str, str]]:
        seen = set()
        out = []
        for d in docs:
            if d.id in seen:
                continue
            seen.add(d.id)
            out.append({"id": d.id, "title": d.title, "source": d.source, "url": d.url})
        return out


KB = KnowledgeBase()
