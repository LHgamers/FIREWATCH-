"""FIREWATCH analyst: evidence assembly, deterministic answers, optional local LLM.

The ordering is deliberate. Statistics are computed here, in Python. A language
model, when one is configured and reachable, only *phrases* the evidence it is
given; it never produces a number that is not already in the evidence payload.
When no model is reachable the deterministic analyst answers from the same
evidence, so every feature keeps working offline.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import date as _date, timedelta as _timedelta
from typing import Any

from . import coverage as cov
from . import scientific as sci
from .knowledge import KB, Doc
from .regions import REGIONS, bbox_area_km2
try:
    from .yorichi_adapter import generate_grounded, available as yorichi_available, hardware_profile
except Exception:
    def generate_grounded(evidence_text, question=""):
        return {"available": False, "scientificSummary": evidence_text, "plainLanguage": evidence_text, "confidenceAndLimitations": ""}
    def yorichi_available(): return False
    def hardware_profile(): return {"available": False}

PROVIDER = os.environ.get("AI_PROVIDER", "auto").strip().lower()
PREFERRED_MODELS = ("phi4-mini:latest", "phi4-mini", "llama3.2:3b", "qwen2.5:3b")
BASE_URL = os.environ.get("AI_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("AI_MODEL", "").strip()


# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #
def fmt_int(v: float | int | None) -> str:
    if v is None:
        return "—"
    return f"{int(round(v)):,}"


def fmt_num(v: float | None, digits: int = 1) -> str:
    if v is None:
        return "—"
    if abs(v) >= 1000:
        return f"{v:,.0f}"
    return f"{v:.{digits}f}"


def fmt_date(d: str | None) -> str:
    return d or "—"


def nearest_region(lat: float, lon: float) -> dict[str, Any] | None:
    best, best_score = None, 0.0
    for r in REGIONS:
        if r["id"] == "global":
            continue
        w, s, e, n = r["bbox"]
        if w <= lon <= e and s <= lat <= n:
            best = r
            break
    if best:
        return best
    # nearest centroid fallback
    import math
    for r in REGIONS:
        if r["id"] == "global":
            continue
        w, s, e, n = r["bbox"]
        cx, cy = (w + e) / 2, (s + n) / 2
        d = math.hypot(cx - lon, cy - lat)
        if best_score == 0 or d < best_score:
            best, best_score = r, d
    return best if best_score < 45 else None


# --------------------------------------------------------------------------- #
# Selection context (Ask the Earth)
# --------------------------------------------------------------------------- #
def selection_context(lat: float, lon: float, radius_km: float = 50.0,
                      hours: int = 72, obs_id: str | None = None) -> dict[str, Any]:
    observation = sci.observation_by_id(obs_id) if obs_id else None
    if observation:
        lat, lon = observation["lat"], observation["lon"]
        radius_km = min(radius_km, 25.0)
    region = nearest_region(lat, lon)
    bbox = (max(-180, lon - 5), max(-60, lat - 5), min(180, lon + 5), min(75, lat + 5))
    near = sci.nearby(lat, lon, radius_km, hours)
    cov = sci.coverage()
    if not near and observation:
        near = [observation]

    by_sensor: dict[str, Any] = {}
    for sensor in ("modis", "viirs"):
        rows = [r for r in near if r["sensor"] == sensor]
        frps = [r["frp"] for r in rows if r["frp"] is not None]
        by_sensor[sensor] = {
            "detections": len(rows),
            "maxFrp": max(frps) if frps else None,
            "meanFrp": round(sum(frps) / len(frps), 2) if frps else None,
            "satellites": sorted({r["satellite"] for r in rows}),
            "day": sum(1 for r in rows if r["daynight"] == "D"),
            "night": sum(1 for r in rows if r["daynight"] == "N"),
            "highConfidence": sum(1 for r in rows if r["confidence_class"] == "high"),
        }
    closest = near[0] if near else None
    return {
        "observation": observation,
        "lat": lat, "lon": lon, "radiusKm": radius_km, "windowHours": hours,
        "region": {"id": region["id"], "name": region["name"], "note": region["note"]} if region else None,
        "bbox": bbox,
        "nearby": {
            "count": len(near),
            "sensors": by_sensor,
            "closest": closest,
            "distanceKm": closest["distanceKm"] if closest else None,
            "observations": near[:40],
        },
        "baseline": sci.anomaly(bbox),
        "coverage": {"first": cov["first"], "last": cov["last"],
                     "days": len(cov["days"]), "sensors": cov["sensors"]},
        "freshness": cov["last"],
    }


def _obs_sentence(obs: dict[str, Any]) -> str:
    conf = obs.get("confidence_class") or "unclassified"
    pct = obs.get("confidence_pct")
    conf_txt = f"{pct:.0f}% ({conf})" if pct is not None else conf
    frp = obs.get("frp")
    return (
        f"{obs['instrument']} on {obs['satellite']} detected a thermal anomaly at "
        f"{obs['lat']:.3f}°, {obs['lon']:.3f}° on {obs['acq_date']} at {obs['acq_time']} UTC "
        f"({obs.get('daynight') or '?'} pass). Reported FRP is {fmt_num(frp, 2)} MW with "
        f"{conf_txt} confidence; brightness temperature {fmt_num(obs.get('brightness'), 1)} K."
    )


def _interpret_observation(sel: dict[str, Any]) -> dict[str, Any]:
    obs = sel["observation"]
    near = sel["nearby"]
    sensors = near["sensors"]
    modis = sensors["modis"]
    viirs = sensors["viirs"]
    region = sel["region"]

    headline = (
        f"A {obs['instrument']} detection of {fmt_num(obs.get('frp'), 2)} MW inside a "
        f"{obs['satellite']} overpass"
    )
    what = [_obs_sentence(obs)]
    if region:
        what.append(f"The point falls inside {region['name']} — {region['note']}")
    if obs.get("confidence_class") == "low":
        what.append("The native confidence is low, so a false positive (sun glint, warm bare soil, "
                    "industrial heat) cannot be excluded from the single record alone.")
    if obs.get("brightness") and obs["brightness"] > 360:
        what.append("The mid-infrared brightness temperature is high enough to suggest an actively "
                    "flaming pixel rather than a residual warm scar.")

    neighbours: list[str] = []
    if near["count"] > 1:
        neighbours.append(
            f"{near['count']} detections lie within {sel['radiusKm']:.0f} km in the last "
            f"{sel['windowHours']} h: {modis['detections']} MODIS and {viirs['detections']} VIIRS."
        )
        if modis["detections"] and viirs["detections"]:
            neighbours.append(
                f"Both instruments see activity here, which is the strongest available corroboration "
                f"that a real fire is present (VIIRS max FRP {fmt_num(viirs['maxFrp'], 2)} MW, "
                f"MODIS max FRP {fmt_num(modis['maxFrp'], 2)} MW)."
            )
        elif viirs["detections"] and not modis["detections"]:
            neighbours.append(
                "Only VIIRS reports this neighbourhood. Its 375 m footprint resolves small or "
                "low-intensity fires that a 1 km MODIS pixel can miss, so absence from MODIS is "
                "expected for a small fire and is not a contradiction."
            )
        elif modis["detections"] and not viirs["detections"]:
            neighbours.append(
                "Only MODIS reports this neighbourhood. Check the time window: VIIRS overpasses do "
                "not coincide with MODIS, and a short-lived fire can be seen by one platform only."
            )
        neighbours.append(
            f"{modis['day'] + viirs['day']} daytime and {modis['night'] + viirs['night']} nighttime "
            "detections are in the window."
        )
    else:
        neighbours.append(
            "No other detection lies inside the search radius and time window. That can mean an "
            "isolated small fire, or a detection at the edge of the swath where neighbouring pixels "
            "were not classified."
        )

    hist: list[str] = []
    base = sel.get("baseline") or {}
    if base.get("available") and base.get("baseline"):
        dev = base["deviation"]
        hist.append(
            f"Regional daily detections on {base['target']['date']} were {fmt_int(base['target']['count'])}, "
            f"against a stored baseline median of {fmt_int(base['baseline']['median'])} "
            f"({base['quality']['baselineDays']} baseline days). Robust z = "
            f"{dev['robustZ'] if dev['robustZ'] is not None else 'n/a'}, percentile {dev['percentile']:.0f}."
        )
        hist.append(base["quality"]["note"])
    else:
        hist.append(
            "No multi-day baseline is stored for this area yet, so no historical comparison is made. "
            "The platform does not substitute an estimate."
        )

    limitations = [
        "A thermal anomaly is not a confirmed wildfire: cause, size and behaviour cannot be derived from "
        "this record.",
        "Cloud, smoke and saturation can hide fire from either instrument; an absent detection is not "
        "evidence of absence.",
        "MODIS percentage confidence and the VIIRS low/nominal/high classes are not interchangeable.",
        f"Stored coverage for this deployment runs {sel['coverage']['first']} → {sel['coverage']['last']} "
        f"({sel['coverage']['days']} days).",
    ]

    evidence = [
        {"label": "Detection ID", "value": obs["id"], "kind": "identifier"},
        {"label": "Sensor", "value": f"{obs['instrument']} / {obs['satellite']}", "kind": "metadata"},
        {"label": "Acquired (UTC)", "value": f"{obs['acq_date']} {obs['acq_time']}", "kind": "time"},
        {"label": "FRP", "value": f"{fmt_num(obs.get('frp'), 2)} MW", "kind": "measurement"},
        {"label": "Confidence (native)", "value": f"{obs.get('confidence_raw')} "
                                                 f"({obs.get('confidence_class') or 'unclassified'})",
         "kind": "quality"},
        {"label": "Brightness", "value": f"{fmt_num(obs.get('brightness'), 1)} K", "kind": "measurement"},
        {"label": "Pixel scan × track", "value": f"{fmt_num(obs.get('scan'), 2)} × "
                                                 f"{fmt_num(obs.get('track'), 2)} km", "kind": "geometry"},
        {"label": "Source dataset", "value": obs["source"], "kind": "provenance"},
    ]

    follow_ups = [
        "Which satellite detected this hotspot, and when?",
        "Does MODIS also report activity nearby?",
        "Is this unusual compared with the stored baseline?",
        "How reliable is this observation?",
        "What would I need to confirm an actual fire here?",
    ]

    return {
        "headline": headline,
        "sections": [
            {"title": "What you selected", "body": what},
            {"title": "Nearby observations", "body": neighbours},
            {"title": "Historical context", "body": hist},
            {"title": "Uncertainty and limitations", "body": limitations},
        ],
        "evidence": evidence,
        "followUps": follow_ups,
        "limitations": limitations,
    }


def ask_the_earth(lat: float, lon: float, radius_km: float = 50.0,
                  hours: int = 72, obs_id: str | None = None) -> dict[str, Any]:
    sel = selection_context(lat, lon, radius_km, hours, obs_id)
    if sel["observation"]:
        interp = _interpret_observation(sel)
        docs = [d for d, _ in KB.search("confidence frp missing observations", 3)]
    else:
        count = sel["nearby"]["count"]
        s = sel["nearby"]["sensors"]
        docs = [d for d, _ in KB.search("missing observations confidence harmonization", 3)]
        headline = (f"{fmt_int(count)} detections within {radius_km:.0f} km over {hours} h"
                    if count else f"No stored detections within {radius_km:.0f} km over {hours} h")
        body = []
        if count:
            body.append(
                f"MODIS contributes {s['modis']['detections']} detections (max FRP "
                f"{fmt_num(s['modis']['maxFrp'], 2)} MW) and VIIRS {s['viirs']['detections']} "
                f"(max FRP {fmt_num(s['viirs']['maxFrp'], 2)} MW)."
            )
            body.append("Expand the radius, extend the window, or select a specific hotspot to read its "
                        "native metadata.")
        else:
            body.append("This is an empty result, not a statement that nothing burned. The point may be "
                        "outside the stored near-real-time window, over water, or under cloud during the "
                        "available overpasses.")
        interp = {
            "headline": headline,
            "sections": [
                {"title": "What you selected", "body": [
                    f"Point {lat:.3f}°, {lon:.3f}° · radius {radius_km:.0f} km · last {hours} h."
                ]},
                {"title": "Observations", "body": body},
                {"title": "Limitations", "body": [
                    "Coverage is the stored near-real-time window only; archive access is not configured.",
                    "Absence of a detection is not evidence of absence.",
                ]},
            ],
            "evidence": [
                {"label": "Detections", "value": fmt_int(count), "kind": "measurement"},
                {"label": "MODIS", "value": fmt_int(s["modis"]["detections"]), "kind": "measurement"},
                {"label": "VIIRS", "value": fmt_int(s["viirs"]["detections"]), "kind": "measurement"},
                {"label": "Coverage", "value": f"{sel['coverage']['first']} → {sel['coverage']['last']}",
                 "kind": "provenance"},
            ],
            "followUps": [
                "Show me the strongest detection in this area.",
                "How do MODIS and VIIRS differ around this point?",
                "What does the stored baseline say?",
            ],
            "limitations": ["Absence of a detection is not evidence of absence."],
        }

    return {
        "selection": {k: v for k, v in sel.items() if k != "nearby"} | {"nearbySummary": {
            "count": sel["nearby"]["count"], "sensors": sel["nearby"]["sensors"],
            "distanceKm": sel["nearby"]["distanceKm"],
        }},
        "interpretation": interp,
        "nearbyTop": [
            {
                "id": r["id"], "sensor": r["sensor"], "satellite": r["satellite"],
                "distanceKm": r["distanceKm"], "frp": r["frp"], "confidenceClass": r["confidence_class"],
                "acqDate": r["acq_date"], "acqTime": r["acq_time"], "lat": r["lat"], "lon": r["lon"],
            }
            for r in sel["nearby"]["observations"][:12]
        ],
        "citations": KB.citations(docs),
        "used_context": {
            "selection": {"obsId": obs_id, "lat": lat, "lon": lon, "radiusKm": radius_km, "hours": hours},
            "summary": sel["summary"],
            "satelliteContext": satellite_context,
            "conditions": conditions,
            "regions": sel["regions"],
            "nearbyCount": sel["nearby"]["count"],
        },
        "evidence_used": [e.get("label") for e in evidence],
        "yorichi": generate_grounded(bundle_text(sel, docs, satellite_context=satellite_context)),
        "model": ai_status(),
        "generatedAt": sel["freshness"],
    }


# --------------------------------------------------------------------------- #
# Conversational analyst
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# Explicit dates in a question
# --------------------------------------------------------------------------- #
_MONTHS = {name.lower(): i for i, name in enumerate(
    ("january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"), start=1)}
_MONTH_ALT = "|".join(sorted(_MONTHS, key=len, reverse=True))
_ISO_DATE = re.compile(r"\b((?:19|20)\d{2})[-/](\d{1,2})[-/](\d{1,2})\b")
_DMY_DATE = re.compile(
    rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({_MONTH_ALT})[a-z]*\.?,?\s+((?:19|20)\d{{2}})\b", re.I)
_MDY_DATE = re.compile(
    rf"\b({_MONTH_ALT})[a-z]*\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{{2}})\b", re.I)


def extract_dates(question: str) -> list[str]:
    """Explicit calendar dates mentioned in a question, as ISO strings.

    Only unambiguous, fully specified dates are extracted (ISO, ``10 November
    2026``, ``November 10, 2026``). Bare numbers, years and month names are left
    alone: guessing the date is worse than answering for the delivered window and
    saying so.
    """
    found: set[str] = set()
    for y, m, d in _ISO_DATE.findall(question):
        found.add(f"{int(y):04d}-{int(m):02d}-{int(d):02d}")
    for d, month, y in _DMY_DATE.findall(question):
        found.add(f"{int(y):04d}-{_MONTHS[month.lower()]:02d}-{int(d):02d}")
    for month, d, y in _MDY_DATE.findall(question):
        found.add(f"{int(y):04d}-{_MONTHS[month.lower()]:02d}-{int(d):02d}")
    valid: list[str] = []
    for iso in sorted(found):
        try:
            valid.append(_date.fromisoformat(iso).isoformat())
        except ValueError:
            continue  # 2026-02-31 is not a date; ignore rather than invent one
    return valid


def _date_coverage(bbox, iso: str) -> str:
    """Coverage state of one day inside this AOI, from delivery evidence."""
    detail = sci.day_detail(bbox, iso, "Requested date")
    return detail["state"]


def _uncovered_answer(question: str, region_name: str, requested: list[str],
                      bbox, start, end) -> dict[str, Any]:
    """Refuse a dated question whose date has no coverage evidence.

    Answering an uncovered date with the surrounding window's totals is the
    failure this function exists to prevent: it silently attributes eight days of
    detections to one day that was never observed.
    """
    stored = cov.window()
    days = ", ".join(requested)
    answer = {
        "headline": f"No coverage evidence for {days}",
        "sections": [
            {"title": "Direct answer", "body": [
                f"This archive cannot answer for {days}: no product delivery is recorded for that "
                "date, so the honest answer is unknown, not zero.",
                "A day with no delivery evidence is not a quiet day. Reporting 0 detections would "
                "claim the area was observed and found clear, which is not what happened.",
            ]},
            {"title": "What this archive does cover", "body": [
                f"Stored coverage runs {stored.get('first') or '—'} to {stored.get('last') or '—'} "
                f"({stored.get('days') or 0} days of near-real-time data).",
                "Ask again for a date inside that window, or name no date to get the whole delivered "
                "window.",
            ]},
            {"title": "What would change this", "body": [
                "Historical backfill needs a FIRMS MAP_KEY: the archive endpoint is the only route to "
                "dates before the near-real-time window, and this deployment has no key.",
            ]},
        ],
        "evidence": [
            {"label": "Requested", "value": days, "kind": "time"},
            {"label": "Coverage", "value": "no delivery evidence", "kind": "coverage"},
            {"label": "Stored window",
             "value": f"{stored.get('first') or '—'} → {stored.get('last') or '—'}", "kind": "time"},
            {"label": "Region", "value": region_name, "kind": "geometry"},
        ],
        "followUps": ["What does the delivered window show?", "Which days have both sensors?",
                      "What would archive access add?"],
        "citations": [],
        "limitations": [
            "Coverage is product delivery, not proof the area was cloud-free.",
            "No value is estimated or interpolated for an uncovered date.",
        ],
        "data": {"summary": None, "harmonization": None, "anomaly": None},
    }
    status = ai_status()
    return {
        "answer": answer,
        "model": {**status, "mode": "deterministic", "used": False},
        "mode": "deterministic",
        "modeLabel": "Deterministic evidence engine",
        "grounding": {"status": "not_applicable", "checked": 0, "ungrounded": []},
        "region": region_name,
        "bbox": list(bbox),
        "window": {"start": start, "end": end},
        "dateScope": {"requested": requested, "applied": None,
                      "resolution": "refused_no_coverage"},
        "deterministic": True,
        "latencyMs": None,
        "latencyScope": "engine total, from request handling to answer",
    }


def _context_stats(bbox, start, end, region_name: str) -> dict[str, Any]:
    s = sci.summary(bbox, start, end)
    ts = sci.timeseries(bbox, start, end)
    an = sci.anomaly(bbox)
    h = sci.harmonization(bbox, start, end, region_name)
    return {"summary": s, "timeseries": ts, "anomaly": an, "harmonization": h}


def intelligence(question: str, bbox, start, end, region_name: str = "Global",
                 mode: str = "auto", model: str | None = None) -> dict[str, Any]:
    # The clock starts before any computation: `latencyMs` is the engine's total
    # work for the answer, including context building, not just the model call.
    import time as _time
    started = _time.time()

    # A question that names a date is answered for that date, or refused. Before
    # this, "How many detections on 2026-11-10?" returned the whole eight-day
    # window: a correct number for the wrong question (PHASE_1_AUDIT P1-4).
    requested_dates = extract_dates(question)
    date_scope: dict[str, Any] = {"requested": requested_dates, "applied": None, "resolution": "unscoped"}
    if requested_dates:
        first, last = requested_dates[0], requested_dates[-1]
        if first == last:
            state = _date_coverage(bbox, first)
            if state in ("unknown", "unavailable"):
                out = _uncovered_answer(question, region_name, requested_dates, bbox, start, end)
                out["latencyMs"] = int((_time.time() - started) * 1000)
                return out
            start, end = first, first
            date_scope.update(applied=first, resolution="day")
        else:
            year_cal = sci.calendar(bbox, int(first[:4]), "day")
            known = [d for d in year_cal["days"]
                     if first <= d["date"] <= last and d["state"] in ("observed", "observed_zero", "partial")]
            if not known:
                out = _uncovered_answer(question, region_name, requested_dates, bbox, start, end)
                out["latencyMs"] = int((_time.time() - started) * 1000)
                return out
            start, end = first, last
            date_scope.update(applied=f"{first} → {last}", resolution="range",
                              coveredDays=len(known))

    ctx = _context_stats(bbox, start, end, region_name)
    s, h, an = ctx["summary"], ctx["harmonization"], ctx["anomaly"]
    q = question.lower()
    hits = KB.search(question, 4)
    docs = [d for d, _ in hits]

    m = s["sensors"]["modis"]
    v = s["sensors"]["viirs"]
    total = s["totalDetections"]
    series = ctx["timeseries"]["series"]
    # Series entries for days without delivery evidence carry no total
    # (None, not 0), so the peak must ignore them rather than compare None.
    peak = max(series, key=lambda r: r["total"] or 0) if series else None

    def sensor_block() -> list[str]:
        return [
            f"MODIS: {fmt_int(m['detections'])} detections, median FRP "
            f"{fmt_num(m['frp']['median'], 1)} MW, {fmt_int(m['confidence']['high'])} high-confidence.",
            f"VIIRS: {fmt_int(v['detections'])} detections, median FRP "
            f"{fmt_num(v['frp']['median'], 1)} MW, {fmt_int(v['confidence']['high'])} high-confidence.",
            f"VIIRS reports {(v['detections'] / max(1, m['detections'])):.2f}× the MODIS detection count "
            "here. That ratio is dominated by footprint size and overpass count, not by fire behaviour.",
        ]

    evidence = [
        {"label": "Window", "value": f"{start or s['dataDays'][0] if s['dataDays'] else '—'} → "
                                     f"{end or s['dataDays'][-1] if s['dataDays'] else '—'}", "kind": "time"},
        {"label": "Detections", "value": fmt_int(total), "kind": "measurement"},
        {"label": "MODIS / VIIRS", "value": f"{fmt_int(m['detections'])} / {fmt_int(v['detections'])}",
         "kind": "measurement"},
        {"label": "Combined FRP", "value": f"{fmt_num(s['frpSum'], 0)} MW·detection", "kind": "measurement"},
        # Every ratio the prose quotes is published here too, so a reader can
        # check the sentence against the evidence instead of trusting the text.
        {"label": "Median FRP (MODIS / VIIRS)",
         "value": f"{fmt_num(m['frp']['median'], 1)} / {fmt_num(v['frp']['median'], 1)} MW",
         "kind": "measurement"},
        {"label": "High-confidence (MODIS / VIIRS)",
         "value": f"{fmt_int(m['confidence']['high'])} / {fmt_int(v['confidence']['high'])}",
         "kind": "measurement"},
        {"label": "VIIRS : MODIS detections",
         "value": f"{v['detections'] / max(1, m['detections']):.2f}x (footprint and overpass, not fire behaviour)",
         "kind": "derived"},
        {"label": "HFAI (experimental)", "value": f"{h['hfai']['combinedDensity']:.3f} MW km⁻² day⁻¹",
         "kind": "derived"},
        {"label": "MODIS→VIIRS ratio", "value": (f"{h['hfai']['modisToViirsRatio']}" if h['hfai']['modisToViirsRatio']
                                                 else "not enough overlap"), "kind": "derived"},
        {"label": "Area", "value": f"{fmt_num(s['areaKm2'], 0)} km²", "kind": "geometry"},
        # Sample size belongs in the evidence list, not only inside data.*, or a
        # reader cannot tell what the derived numbers were computed over.
        {"label": "Sample",
         "value": (f"{fmt_int(h['hfai']['activeCells'])} active cells · "
                   f"{fmt_int(h['hfai']['cellDays'])} cell-days · "
                   f"{len(s['dataDays'])} delivery days"),
         "kind": "derived"},
    ]

    if any(k in q for k in ("modis", "viirs", "differ", "compare", "harmon", "sensor")):
        headline = f"MODIS and VIIRS disagree in a systematic, explainable way over {region_name}"
        sections = [
            {"title": "Direct answer", "body": [
                f"Over {region_name}, VIIRS records {fmt_int(v['detections'])} detections "
                f"against {fmt_int(m['detections'])} from MODIS in the same window. The two sensors are not "
                "measuring the same thing at the same scale, so the counts should never be read as a "
                "like-for-like fire count."
            ]},
            {"title": "Why", "body": [
                "VIIRS pixels are 375 m across; MODIS pixels are 1 km. A single MODIS pixel covers roughly "
                "seven VIIRS pixels, so one MODIS detection can appear as several VIIRS detections.",
                f"VIIRS detections here come from "
                f"{', '.join(v.get('satellites') or {}) or 'no represented platform'}; MODIS from "
                f"{', '.join(m.get('satellites') or {}) or 'none in this window'}. Different platform "
                "counts give different overpass opportunities per day, so raw counts are not like-for-like.",
                "Median FRP differs for the same reason: FRP is integrated over the pixel footprint.",
            ]},
            {"title": "Harmonized view", "body": [
                f"Reducing both sensors to 0.25° cell-days and taking the maximum FRP per cell-day gives a "
                f"combined density of {h['hfai']['combinedDensity']:.3f} MW km⁻² day⁻¹ over "
                f"{h['window']['overlapDays']} overlapping days.",
                f"The paired MODIS/VIIRS ratio is "
                f"{h['hfai']['modisToViirsRatio'] or 'not estimable'} "
                f"(95% bootstrap CI {h['hfai']['ratioCi95'] or '—'}, "
                f"{h['hfai']['pairedCellDays']} cell-days). This is region- and window-specific and is not a "
                "conversion factor.",
            ]},
        ]
        follow = ["Show me the harmonization lab for this region.", "Which days have both sensors?",
                  "What is the uncertainty of the ratio?"]
    elif any(k in q for k in ("unusual", "anomal", "normal", "baseline", "compare with history")):
        dev = (an or {}).get("deviation") or {}
        headline = "Anomaly assessment from the stored baseline"
        sections = [
            {"title": "Direct answer", "body": [
                (f"The latest day has {fmt_int((an or {}).get('target', {}).get('count'))} detections against a "
                 f"baseline median of {fmt_int((an or {}).get('baseline', {}).get('median'))}, a robust z of "
                 f"{dev.get('robustZ')} (percentile {dev.get('percentile')}).")
                if (an or {}).get("available") else "No baseline is available for this area."
            ]},
            {"title": "How this is computed", "body": [
                "Robust z = (x − median) / (1.4826 × MAD). The median and MAD resist the heavy tail of daily "
                "fire counts, which a mean and standard deviation would not.",
                ((an or {}).get("quality") or {}).get("note", ""),
            ]},
        ]
        follow = ["Which day had the highest activity?", "What is the seasonal pattern?",
                  "How many baseline days are stored?"]
    elif any(k in q for k in ("when", "season", "time", "month", "calendar", "trend")):
        headline = "Timing of activity in the stored window"
        body = [f"Activity spans {len(s['dataDays'])} data days."]
        if peak:
            body.append(f"The busiest day is {peak['date']} with {fmt_int(peak['total'])} detections "
                        f"(MODIS {fmt_int(peak['modis'])}, VIIRS {fmt_int(peak['viirs'])}).")
        if s["dataDays"]:
            body.append(f"Stored coverage begins {s['dataDays'][0]} and ends {s['dataDays'][-1]}. "
                        "A seasonal climatology needs the multi-year archive, which requires a FIRMS MAP_KEY.")
        sections = [{"title": "Direct answer", "body": body},
                    {"title": "Caveat", "body": ["Near-real-time windows are too short to establish seasonality. "
                                                 "The calendar view marks days without data as unavailable, "
                                                 "not as zero."]}]
        follow = ["Open the burning activity calendar.", "Compare MODIS and VIIRS days.",
                  "What would archive access add?"]
    elif any(k in q for k in ("confidence", "reliable", "quality", "false")):
        headline = "Reading confidence correctly"
        sections = [
            {"title": "Direct answer", "body": [
                f"{fmt_int(m['confidence']['high'])} MODIS detections (of {fmt_int(m['detections'])}) are in the "
                f"high-confidence class, and {fmt_int(v['confidence']['high'])} VIIRS detections "
                f"(of {fmt_int(v['detections'])}) are reported high.",
                "Confidence is a property of the retrieval algorithm, not a probability of a wildfire.",
            ]},
            {"title": "Practical guidance", "body": [
                "Filter to high confidence when you need a conservative map.",
                "A low-confidence detection co-located with a high-confidence detection from the other sensor "
                "is usually real; an isolated low-confidence detection over bare soil or water is often not.",
                "Smoke, cloud and saturation suppress detections; missing data is not zero activity.",
            ]},
        ]
        follow = ["Show only high-confidence detections.", "What causes false positives?",
                  "How do the sensors' confidence fields differ?"]
    else:
        headline = f"{fmt_int(total)} satellite fire detections over {region_name}"
        sections = [
            {"title": "Direct answer", "body": [
                f"In the stored window the area contains {fmt_int(total)} thermal detections across "
                f"{len(s['dataDays'])} data days, with a combined reported FRP of "
                f"{fmt_num(s['frpSum'], 0)} MW summed over detections."
            ]},
            {"title": "Sensor split", "body": sensor_block()},
            {"title": "What this does not tell you", "body": [
                "Detection counts are not fire counts: one fire can produce many detections across overpasses, "
                "and one detection can cover a sub-pixel fire.",
                "Cause, size and spread cannot be inferred from thermal anomalies alone.",
            ]},
        ]
        follow = ["How do MODIS and VIIRS differ here?", "Was the latest day unusual?",
                  "Which sensor should I trust for small fires?"]

    if date_scope["resolution"] == "day":
        headline = f"On {date_scope['applied']}: " + headline[0].lower() + headline[1:]
        evidence = [{"label": "Date", "value": date_scope["applied"], "kind": "time"}] + evidence
    elif date_scope["resolution"] == "range":
        headline = f"On {date_scope['applied']}: " + headline[0].lower() + headline[1:]
        evidence = [{"label": "Dates", "value": date_scope["applied"], "kind": "time"}] + evidence

    citations = KB.citations(docs)
    answer = {
        "headline": headline,
        "sections": sections,
        "evidence": evidence,
        "followUps": follow,
        "citations": citations,
        "limitations": [
            f"Stored coverage: {s['dataDays'][0] if s['dataDays'] else '—'} → "
            f"{s['dataDays'][-1] if s['dataDays'] else '—'}.",
            "Near-real-time data are provisional and can be revised by the provider.",
            "No number in this answer is estimated; every value is computed from stored detections.",
        ],
        "data": {"summary": s, "harmonization": h["hfai"], "anomaly": an},
    }

    status = ai_status()
    refined = None
    grounding: dict[str, Any] = {"status": "not_applicable", "checked": 0, "ungrounded": []}
    requested = (model or "").strip() or None
    if mode != "deterministic" and status["available"] and requested:
        # A request-scoped model is only honoured when it is actually installed;
        # naming a model that cannot answer would be a silent lie in the UI. The
        # check only runs when a model would actually be used, so a deterministic
        # request is never failed by a stale model name.
        try:
            installed = {m.get("name") for m in _ollama_tags() if m.get("name")}
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            installed = set()
        if requested not in installed:
            raise ValueError(
                f"model '{requested}' is not installed locally; installed: "
                f"{sorted(n for n in installed if n) or 'none'}"
            )
        status = dict(status, model=requested, requested=True)
    if mode != "deterministic" and status["available"]:
        out = _try_llm(question, answer, evidence, model=requested or status.get("model"))
        if out:
            refined, grounding = out
    used = "llm" if refined else "deterministic"
    return {
        "answer": refined or answer,
        # `available` describes the installation, not this answer. Saying
        # "mode: llm" on a deterministic answer made the UI credit phi4-mini for
        # text it never wrote (flagged by the Phase-3 verifier).
        "model": {**status, "mode": used, "used": used == "llm"},
        "mode": used,
        "modeLabel": ("Local model rephrasing engine evidence" if used == "llm"
                      else "Deterministic evidence engine"),
        "grounding": grounding,
        "region": region_name,
        "bbox": list(bbox),
        "window": {"start": start, "end": end},
        "dateScope": date_scope,
        "deterministic": refined is None,
        "latencyMs": int((_time.time() - started) * 1000),
        "latencyScope": "engine total, from request handling to answer",
    }


def stream_intelligence(question: str, bbox, start, end, region_name: str = "Global",
                        mode: str = "deterministic", model: str | None = None):
    """SSE events. Sections are emitted whole, never typed out.

    The mode is the caller's: streaming a deterministic answer is the default and
    the fastest path, but a model-phrased answer streams the same frame types, so
    the client can render partial output either way.
    """
    import time as _t
    started = _t.time()
    result = intelligence(question, bbox, start, end, region_name, mode=mode, model=model)
    engine_ms = result.get("latencyMs")
    yield {"type": "meta", "mode": result["mode"], "model": result["model"],
           "region": region_name, "window": result["window"],
           "grounding": result["grounding"]}
    yield {"type": "headline", "text": result["answer"]["headline"]}
    for section in result["answer"]["sections"]:
        yield {"type": "section", "title": section["title"], "body": section["body"]}
    yield {"type": "evidence", "items": result["answer"]["evidence"]}
    yield {"type": "limitations", "items": result["answer"]["limitations"]}
    yield {"type": "citations", "items": result["answer"]["citations"]}
    yield {"type": "done",
           "latencyMs": engine_ms if engine_ms is not None else int((_t.time() - started) * 1000),
           "streamMs": int((_t.time() - started) * 1000),
           "grounding": result["grounding"]}


# --------------------------------------------------------------------------- #
# Optional local model
# --------------------------------------------------------------------------- #
def _ollama_tags() -> list[dict[str, Any]]:
    with urllib.request.urlopen(f"{BASE_URL}/api/tags", timeout=2.5) as r:  # noqa: S310
        return json.loads(r.read().decode()).get("models", [])


def _pick_model(tags: list[dict[str, Any]]) -> str | None:
    names = [m.get("name") for m in tags if m.get("name")]
    if MODEL:
        return MODEL
    for pref in PREFERRED_MODELS:
        if pref in names:
            return pref
    return names[0] if names else None


def ai_models() -> dict[str, Any]:
    """Installed local models, with the hardware constraint made explicit."""
    try:
        tags = _ollama_tags()
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return {"available": False, "models": [], "error": type(exc).__name__,
                "note": "Ollama is not reachable at the configured base URL."}
    models = []
    for m in tags:
        details = m.get("details") or {}
        size = m.get("size") or 0
        models.append({
            "name": m.get("name"),
            "sizeBytes": size,
            "sizeGb": round(size / 1e9, 2) if size else None,
            "parameters": details.get("parameter_size"),
            "quantization": details.get("quantization_level"),
            "family": details.get("family"),
            "modifiedAt": m.get("modified_at"),
        })
    models.sort(key=lambda x: x["sizeBytes"] or 0)
    return {
        "available": bool(models),
        "models": models,
        "selected": _pick_model(tags),
        "hardware": {
            "gpu": "NVIDIA GeForce RTX 3050 Laptop",
            "vramGb": 4,
            "guidance": ("A 4 GB GPU fits a ~3-4B parameter model at Q4. Larger models spill to system "
                         "memory and become slow; the deterministic analyst stays available regardless."),
        },
    }


def ai_status() -> dict[str, Any]:
    if PROVIDER in ("none", "off"):
        return {"provider": "none", "available": False, "model": None, "mode": "deterministic",
                "note": "Local model disabled. Answers come from the deterministic evidence engine."}
    try:
        if PROVIDER in ("auto", "ollama"):
            tags = _ollama_tags()
            model = _pick_model(tags)
            return {"provider": "ollama", "available": bool(model), "model": model,
                    "mode": "llm" if model else "deterministic",
                    "installed": len(tags),
                    "note": ("Local inference reachable; the model only rephrases engine evidence."
                             if model else "Ollama reachable, no model pulled.")}
        with urllib.request.urlopen(f"{BASE_URL}/v1/models", timeout=2.5) as r:  # noqa: S310
            data = json.loads(r.read().decode())
        model = MODEL or ((data.get("data") or [{}])[0].get("id"))
        return {"provider": "openai-compatible", "available": bool(model), "model": model,
                "mode": "llm" if model else "deterministic", "note": "Local inference reachable."}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        return {"provider": "ollama" if PROVIDER in ("auto", "ollama") else PROVIDER,
                "available": False, "model": MODEL or None, "mode": "deterministic",
                "note": f"Local inference unavailable ({type(exc).__name__}). Deterministic analyst in use."}


_NUM = __import__("re").compile(r"\d[\d,]*(?:\.\d+)?")
_CONSTANTS = {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "24", "60", "72",
              "95", "100", "375", "1000", "0.1", "0.25", "0.5", "1.0", "2.5"}


def _grounding(text: str, evidence_json: str) -> dict[str, Any]:
    """Every number in model prose must already exist in the evidence payload."""
    allowed = set(_CONSTANTS)
    for raw in _NUM.findall(evidence_json):
        allowed.add(raw.replace(",", ""))
        try:
            v = float(raw.replace(",", ""))
        except ValueError:
            continue
        for digits in range(0, 4):
            allowed.add(f"{v:.{digits}f}")
            allowed.add(f"{v:,.{digits}f}")
    ungrounded = []
    for raw in _NUM.findall(text):
        norm = raw.replace(",", "").rstrip(".")
        if norm in allowed:
            continue
        try:
            v = float(norm)
        except ValueError:
            continue
        if any(abs(v - float(a)) < 1e-9 for a in allowed if a.replace(".", "").isdigit()):
            continue
        ungrounded.append(raw)
    return {"status": "passed" if not ungrounded else "rejected",
            "checked": len(_NUM.findall(text)), "ungrounded": ungrounded[:8]}


def _try_llm(question: str, answer: dict[str, Any], evidence: list[dict[str, Any]],
             model: str | None = None) -> tuple[dict[str, Any], dict[str, Any]] | None:
    status = ai_status()
    if not status["available"]:
        return None
    chosen = (model or status.get("model") or "").strip()
    if not chosen:
        return None
    system = (
        "You are FIREWATCH Intelligence, a satellite fire analyst. You are given a JSON evidence payload "
        "computed by a scientific engine. Rephrase the analysis so it reads naturally. Rules: never invent "
        "or alter a number; never add observations not present in the evidence; name only the platforms "
        "and satellites listed in the evidence; keep every caveat; reply "
        "with the same section structure as the payload. If the evidence is insufficient, say so. "
        'Reply with exactly this JSON shape and nothing else: '
        '{"headline": string, "sections": [{"title": string, "body": [string]}], "limitations": [string]}'
    )
    payload = {"question": question, "evidence": evidence,
               "sections": answer["sections"], "limitations": answer["limitations"]}
    try:
        if status["provider"] == "ollama":
            body = json.dumps({
                "model": chosen, "stream": False, "format": "json",
                "options": {"temperature": 0.2, "num_ctx": 4096},
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": json.dumps(payload)}],
            }).encode()
            req = urllib.request.Request(f"{BASE_URL}/api/chat", data=body,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:  # noqa: S310
                text = json.loads(r.read().decode())["message"]["content"]
        else:
            body = json.dumps({
                "model": chosen, "temperature": 0.2,
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": json.dumps(payload)}],
            }).encode()
            req = urllib.request.Request(f"{BASE_URL}/v1/chat/completions", data=body,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:  # noqa: S310
                text = json.loads(r.read().decode())["choices"][0]["message"]["content"]
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return None
        if "sections" not in parsed:
            for wrapper in ("evidence", "answer", "response", "result"):
                inner = parsed.get(wrapper)
                if isinstance(inner, dict) and "sections" in inner:
                    parsed = inner
                    break
        if "sections" not in parsed or not isinstance(parsed["sections"], list):
            return None
        prose = json.dumps(parsed)
        grounding = _grounding(prose, json.dumps(payload))
        if grounding["status"] != "passed":
            # An ungrounded paraphrase is discarded, never shown with a warning:
            # the deterministic text is already correct and traceable.
            return None
        merged = dict(answer)
        merged["sections"] = parsed["sections"]
        if parsed.get("headline"):
            merged["headline"] = parsed["headline"]
        merged["phrasedBy"] = chosen
        return merged, grounding
    except (urllib.error.URLError, TimeoutError, OSError, KeyError, ValueError):
        return None
