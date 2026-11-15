"use client";

/**
 * Ask the Earth — point at the planet, read what the satellites recorded.
 *
 * The page is two halves of one interaction:
 *   1. <GlobeEarth> turns a click into a coordinate (pure geometry, no data).
 *   2. <AoiEvidence> asks the engine what is actually known about that AOI and
 *      reports the coverage verdict before it reports any count.
 *
 * The page itself owns only the selection (coordinate, radius or explicit bbox)
 * and the URL contract `?lat=&lon=&r=[&bbox=]` so a selection can be shared or
 * reached from the map.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Crosshair, Flame, LocateFixed, MapPin, Satellite, Sparkles, Target,
} from "lucide-react";
import { apiGet } from "@/lib/api";
import { useApi, useMeta } from "@/lib/hooks";
import { REGION_MAP } from "@/lib/regions";
import { useFilters } from "@/components/shell/FiltersProvider";
import {
  bboxCenter, formatBbox, haversineKm, parseBbox, parseCoordInput, radiusToBbox,
} from "@/lib/globe";
import { cn, formatInt } from "@/lib/format";
import { GlobeEarth, type GlobeObservation } from "@/components/earth/GlobeEarth";
import { AoiEvidence } from "@/components/ask/AoiEvidence";
import { PlaceSearch } from "@/components/ask/PlaceSearch";
import type { PlaceResult } from "@/lib/geocode";
import { Badge, DataNotice, Loading, Panel, PanelHead } from "@/components/ui/primitives";
import type { DetectionCollection } from "@/lib/types";

const DEFAULT = { lat: -3.47, lon: -62.36, radiusKm: 60 };
const RADIUS_MIN = 5;
const RADIUS_MAX = 500;

interface Selection {
  lat: number;
  lon: number;
  radiusKm: number;
  /** Explicit AOI from ?bbox= or the bbox field; otherwise derived from radius. */
  bbox: [number, number, number, number] | null;
}

export default function AskPage() {
  // useSearchParams must sit under a Suspense boundary for the production build.
  return (
    <Suspense fallback={<Loading label="Preparing the globe" />}>
      <AskPageInner />
    </Suspense>
  );
}

function AskPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { region } = useFilters();
  const { meta } = useMeta();

  const [sel, setSel] = useState<Selection>({ ...DEFAULT, bbox: null });
  const [latDraft, setLatDraft] = useState(String(DEFAULT.lat));
  const [lonDraft, setLonDraft] = useState(String(DEFAULT.lon));
  const [radiusDraft, setRadiusDraft] = useState(String(DEFAULT.radiusKm));
  const [bboxDraft, setBboxDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [pickedObs, setPickedObs] = useState<GlobeObservation | null>(null);
  const applied = useRef<string>("");

  /* ------------------------------------------------------------ URL → state */
  useEffect(() => {
    const q = params.toString();
    if (q === applied.current) return;
    applied.current = q;

    const pLat = params.get("lat");
    const pLon = params.get("lon");
    const pR = params.get("r") ?? params.get("radius");
    const pBox = parseBbox(params.get("bbox"));
    // The selected place name travels in the URL so a shared link keeps its
    // label. Any other selection clears it (the AOI is then a raw coordinate).
    setPlaceName(params.get("place"));

    const la = pLat !== null ? parseCoordInput(pLat) : null;
    const lo = pLon !== null ? parseCoordInput(pLon) : null;
    if (la !== null && lo !== null) {
      const r = pR !== null ? Number(pR) : DEFAULT.radiusKm;
      const radiusKm = clampRadius(Number.isFinite(r) ? r : DEFAULT.radiusKm);
      setSel({ lat: la, lon: lo, radiusKm, bbox: pBox });
      setLatDraft(String(la));
      setLonDraft(String(lo));
      setRadiusDraft(String(radiusKm));
      setBboxDraft(pBox ? formatBbox(pBox) : "");
      setFocusToken((t) => t + 1);
    } else if (pBox) {
      const c = bboxCenter(pBox);
      const radiusKm = radiusForBox(pBox);
      setSel({ lat: c.lat, lon: c.lon, radiusKm, bbox: pBox });
      setLatDraft(String(c.lat));
      setLonDraft(String(c.lon));
      setRadiusDraft(String(radiusKm));
      setBboxDraft(formatBbox(pBox));
      setFocusToken((t) => t + 1);
    }
  }, [params]);

  /* ------------------------------------------------------------ state → URL */
  const commit = useCallback(
    (next: Selection, opts: { focus?: boolean; label?: string | null } = {}) => {
      setSel(next);
      setLatDraft(String(next.lat));
      setLonDraft(String(next.lon));
      setRadiusDraft(String(next.radiusKm));
      setBboxDraft(next.bbox ? formatBbox(next.bbox) : "");
      setPlaceName(opts.label ?? null);
      if (opts.focus) setFocusToken((t) => t + 1);

      const q = new URLSearchParams({
        lat: next.lat.toFixed(4),
        lon: next.lon.toFixed(4),
        r: String(next.radiusKm),
      });
      if (next.bbox) q.set("bbox", formatBbox(next.bbox));
      if (opts.label) q.set("place", opts.label);
      applied.current = q.toString();
      router.replace(`/ask?${q.toString()}`, { scroll: false });
    },
    [router],
  );

  /**
   * A geocoded or built-in place becomes the AOI: its published bounding box,
   * not a camera move. Everything downstream (observations, evidence, the
   * globe's red points) is keyed on `effectiveBbox` below.
   */
  const pickPlace = useCallback(
    (place: PlaceResult) => {
      const radiusKm = radiusForBox(place.bbox);
      const label = place.country ? `${place.name} · ${place.country}` : place.name;
      commit(
        { lat: place.lat, lon: place.lon, radiusKm, bbox: place.bbox },
        { focus: true, label },
      );
    },
    [commit],
  );

  /* ------------------------------------------------------------- selection */
  const pickFromGlobe = useCallback(
    (la: number, lo: number) => {
      commit({ lat: la, lon: lo, radiusKm: sel.radiusKm, bbox: null }, { focus: false });
    },
    [commit, sel.radiusKm],
  );

  const pickFromList = useCallback(
    (la: number, lo: number) => {
      commit({ lat: la, lon: lo, radiusKm: sel.radiusKm, bbox: null }, { focus: true });
    },
    [commit, sel.radiusKm],
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const la = parseCoordInput(latDraft);
      const lo = parseCoordInput(lonDraft);
      const r = Number(radiusDraft);
      if (la === null || Math.abs(la) > 89.9) {
        setFormError("Latitude must be a number between −89.9 and 89.9 (N/S accepted).");
        return;
      }
      if (lo === null || Math.abs(lo) > 180) {
        setFormError("Longitude must be a number between −180 and 180 (E/W accepted).");
        return;
      }
      if (!Number.isFinite(r) || r < RADIUS_MIN || r > RADIUS_MAX) {
        setFormError(`Radius must be ${RADIUS_MIN}–${RADIUS_MAX} km (the engine accepts 1–500).`);
        return;
      }
      setFormError(null);
      commit({ lat: la, lon: lo, radiusKm: clampRadius(r), bbox: null }, { focus: true });
    },
    [commit, latDraft, lonDraft, radiusDraft],
  );

  const submitBbox = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const box = parseBbox(bboxDraft);
      if (!box) {
        setFormError("Bounding box must be four numbers, W,S,E,N (e.g. -64,-5,-62,-3) with S < N.");
        return;
      }
      setFormError(null);
      const c = bboxCenter(box);
      commit({ lat: c.lat, lon: c.lon, radiusKm: radiusForBox(box), bbox: box }, { focus: true });
    },
    [bboxDraft, commit],
  );

  const strongest = useCallback(async () => {
    try {
      const d = await apiGet<DetectionCollection>("/api/observations", { limit: 1 });
      const f = d.features[0];
      if (f) pickFromList(f.properties.lat, f.properties.lon);
    } catch {
      /* the button stays inert; no invented fallback */
    }
  }, [pickFromList]);

  const centreRegion = useCallback(() => {
    const b = REGION_MAP[region]?.bbox;
    if (!b) return;
    commit({ lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2, radiusKm: sel.radiusKm, bbox: null }, { focus: true });
  }, [commit, region, sel.radiusKm]);

  const effectiveBbox = useMemo(
    () => sel.bbox ?? radiusToBbox(sel.lat, sel.lon, sel.radiusKm),
    [sel],
  );
  const bboxKey = useMemo(() => formatBbox(effectiveBbox), [effectiveBbox]);

  // The points drawn on the sphere are the engine's own records for this AOI.
  // They are capped for rendering, and the cap is stated by the legend, so the
  // dots are never presented as "every detection on Earth".
  const { data: obsData, error: obsError } = useApi<DetectionCollection>(
    "/api/observations",
    { bbox: bboxKey, limit: 6000 },
    [bboxKey],
  );
  const globePoints = useMemo<GlobeObservation[]>(() => {
    if (!obsData) return [];
    return obsData.features.map((f) => ({
      lat: f.properties.lat,
      lon: f.properties.lon,
      sensor: f.properties.sensor,
      frp: f.properties.frp,
      id: f.properties.id,
      satellite: f.properties.satellite,
      acqDate: f.properties.acqDate,
      acqTime: f.properties.acqTime,
      confidence: f.properties.confidence,
      confidenceClass: f.properties.confidenceClass,
    }));
  }, [obsData]);

  return (
    <div className="space-y-3">
      {/* ------------------------------------------------------------- hero */}
      <Panel className="overflow-hidden">
        <div className="relative grid gap-4 p-5 lg:grid-cols-[1.25fr_1fr]">
          <div className="absolute inset-0 grid-bg opacity-40" />
          <div className="relative">
            <Badge tone="cyan"><Crosshair size={10} /> Signature interaction</Badge>
            <h2 className="mt-3 text-[22px] font-semibold leading-tight tracking-[-0.01em] text-ink">
              Point at the planet. Read what the satellites recorded.
            </h2>
            <p className="mt-2 max-w-xl text-[12.5px] leading-relaxed text-muted">
              Drag the globe, click a point, and the engine answers for that area: detections by
              sensor and platform, FRP in megawatts with the native confidence, the coverage state of
              every day in the window, and an explicit list of what the data cannot tell you.
            </p>
            <p className="mt-2 max-w-xl text-[11px] leading-relaxed text-muted/80">
              The globe is an index built from NASA Blue Marble and Black Marble imagery. Red-orange
              and crimson points are <span className="text-ink/80">stored MODIS and VIIRS detections</span>{" "}
              at their recorded coordinates for the selected AOI; the silhouette itself is background
              imagery, never a live fire observation.
            </p>
          </div>
          <div className="relative grid grid-cols-2 gap-2 self-start">
            <MiniStat
              label="Stored window"
              value={meta ? `${meta.coverage.first ?? "—"} → ${meta.coverage.last ?? "—"}` : "—"}
              note={meta ? `${meta.coverage.days.length} days` : "loading"}
            />
            <MiniStat
              label="Detections"
              value={meta ? formatInt(meta.engine.observations) : "—"}
              note={meta ? `MODIS ${formatInt(meta.engine.modis)} · VIIRS ${formatInt(meta.engine.viirs)}` : "loading"}
            />
            <MiniStat
              label="Archive access"
              value={meta?.coverage.archiveEnabled ? "configured" : "key not set"}
              note="outside the window = UNKNOWN, not zero"
            />
            <MiniStat
              label="Selection"
              value={`${sel.radiusKm} km`}
              note={sel.bbox ? "explicit bbox" : "radius around point"}
            />
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 xl:grid-cols-12">
        {/* ------------------------------------------------- globe + inputs */}
        <div className="fw-stagger space-y-3 xl:col-span-5">
          <Panel>
            <div className="p-3">
              <PlaceSearch onSelect={pickPlace} currentName={placeName} />
            </div>
          </Panel>

          <Panel>
            <PanelHead
              title="Interactive Earth"
              hint="Drag to orbit · scroll to zoom · click to select"
              icon={<Satellite size={14} />}
              action={<Badge tone="muted">{`${sel.lat.toFixed(2)}°, ${sel.lon.toFixed(2)}°`}</Badge>}
            />
            <div className="p-3">
              {obsError ? (
                <p className="mb-2 rounded border border-ember/25 bg-ember/[0.06] px-2 py-1 font-mono text-[9.5px] leading-relaxed text-ember">
                  Detection layer unavailable · {obsError}. The globe and the evidence query still work.
                </p>
              ) : null}
              <GlobeEarth
                lat={sel.lat}
                lon={sel.lon}
                radiusKm={sel.radiusKm}
                observations={globePoints}
                observationsNote="Stored NASA FIRMS detections inside the selected AOI. A point is a thermal anomaly, not a confirmed wildfire."
                onPickObservation={setPickedObs}
                onSelect={pickFromGlobe}
                focusToken={focusToken}
                height={392}
              />

              <div className="mt-2 space-y-1.5">
                {!obsData && !obsError ? (
                  <p className="font-mono text-[9.5px] text-muted/70">
                    loading stored detections for this AOI…
                  </p>
                ) : null}
                {obsData && globePoints.length === 0 ? (
                  <p className="rounded border border-line/60 bg-elevated/20 px-2 py-1.5 font-mono text-[9.5px] leading-relaxed text-muted">
                    No detections were recorded in this AOI inside delivered coverage. That is
                    <span className="text-ink/80"> not </span>proof that no fire occurred: a polar
                    sensor samples a few times a day, and cloud, smoke and geometry can hide a fire.
                  </p>
                ) : null}
                {obsData && globePoints.length > 0 ? (
                  <p className="font-mono text-[9.5px] leading-relaxed text-muted/70">
                    {formatInt(globePoints.length)} stored detections plotted at their recorded
                    coordinates (render cap 6,000). Click a point for its metadata.
                  </p>
                ) : null}
                {pickedObs ? (
                  <DetectionCard obs={pickedObs} onClose={() => setPickedObs(null)} />
                ) : null}
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHead
              title="Selection"
              hint="Coordinates, radius, or an explicit bounding box"
              icon={<Target size={14} />}
            />
            <form className="space-y-3 p-4" onSubmit={submit}>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="kicker">Latitude</span>
                  <input
                    value={latDraft}
                    onChange={(e) => setLatDraft(e.target.value)}
                    inputMode="decimal"
                    placeholder="-3.47 or 3.47S"
                    className="mt-1 w-full rounded-md border border-line bg-void/50 px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-cyan/50"
                  />
                </label>
                <label className="block">
                  <span className="kicker">Longitude</span>
                  <input
                    value={lonDraft}
                    onChange={(e) => setLonDraft(e.target.value)}
                    inputMode="decimal"
                    placeholder="-62.36 or 62.36W"
                    className="mt-1 w-full rounded-md border border-line bg-void/50 px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-cyan/50"
                  />
                </label>
              </div>

              <label className="block">
                <span className="kicker flex items-center justify-between">
                  <span>Search radius</span>
                  <span className="text-ink/80">{radiusDraft} km</span>
                </span>
                <input
                  type="range"
                  min={RADIUS_MIN}
                  max={RADIUS_MAX}
                  step={5}
                  value={Number(radiusDraft) || RADIUS_MIN}
                  onChange={(e) => setRadiusDraft(e.target.value)}
                  className="mt-2 w-full accent-cyan"
                  aria-label="Search radius in kilometres"
                />
              </label>

              <button type="submit" className="btn btn-primary w-full">
                <Sparkles size={13} /> Analyse this area
              </button>

              <div className="flex flex-wrap gap-1.5">
                <button type="button" className="btn" onClick={strongest}>
                  <Flame size={12} /> Strongest stored detection
                </button>
                <button type="button" className="btn" onClick={centreRegion}>
                  <LocateFixed size={12} /> Centre of {REGION_MAP[region]?.name ?? "Global"}
                </button>
                <Link href="/map" className="btn">
                  <MapPin size={12} /> Pick on the map
                </Link>
              </div>

              {formError ? (
                <p className="rounded border border-ember/30 bg-ember/[0.06] px-2 py-1.5 text-[10.5px] leading-relaxed text-ember">
                  {formError}
                </p>
              ) : (
                <p className="font-mono text-[9.5px] leading-relaxed text-muted/70">
                  Engine bounds: lat ±89.9°, lon ±180°, radius 1–500 km. A bbox wider than the product
                  extent is answered as delivered, never extrapolated.
                </p>
              )}
            </form>

            <form className="border-t border-line/60 p-4" onSubmit={submitBbox}>
              <span className="kicker">Area of interest · bbox</span>
              <div className="mt-1 flex gap-1.5">
                <input
                  value={bboxDraft}
                  onChange={(e) => setBboxDraft(e.target.value)}
                  placeholder="W,S,E,N  e.g. -64,-5,-62,-3"
                  className="min-w-0 flex-1 rounded-md border border-line bg-void/50 px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-cyan/50"
                  aria-label="Bounding box west,south,east,north"
                />
                <button type="submit" className="btn shrink-0">Apply</button>
              </div>
              {sel.bbox ? (
                <button
                  type="button"
                  className="link-quiet mt-2 inline-flex items-center gap-1 text-[10px]"
                  onClick={() => commit({ ...sel, bbox: null }, { focus: true })}
                >
                  clear bbox · back to radius AOI
                </button>
              ) : null}
            </form>
          </Panel>

          <DataNotice>
            Clicking the globe runs a real engine query for the resulting bbox. A hotspot is not a
            confirmed wildfire, and an empty result inside delivered coverage is a conditional zero —
            never proof that nothing burned.
          </DataNotice>
        </div>

        {/* ---------------------------------------------------------- evidence */}
        {/* Keyed on the selection so a new point replays the slide-in instead of
            mutating a panel the reader is already looking at. */}
        <div key={`${sel.lat},${sel.lon},${sel.radiusKm}`} className="fw-slide-left-in xl:col-span-7"
          style={{ "--fw-delay": "60ms" } as React.CSSProperties}>
          <AoiEvidence
            lat={sel.lat}
            lon={sel.lon}
            radiusKm={sel.radiusKm}
            bbox={effectiveBbox}
            onPick={pickFromList}
          />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function clampRadius(v: number): number {
  return Math.min(RADIUS_MAX, Math.max(1, Math.round(v)));
}

/** Radius that covers a bbox from its centre: centre → corner great-circle. */
function radiusForBox(box: [number, number, number, number]): number {
  const c = bboxCenter(box);
  const corner = { lat: box[1], lon: box[0] };
  return clampRadius(haversineKm(c, corner));
}

function DetectionCard({ obs, onClose }: { obs: GlobeObservation; onClose: () => void }) {
  const sensor = obs.sensor === "viirs" ? "VIIRS 375 m" : "MODIS C6.1";
  return (
    <div className="rounded-lg border border-ember/35 bg-ember/[0.06] p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ember">
            <Flame size={10} /> selected detection
          </p>
          <p className="mt-1 text-[11.5px] text-ink">
            {sensor}
            {obs.satellite ? <span className="text-muted"> · {obs.satellite}</span> : null}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded border border-line/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink"
          aria-label="Close detection details"
        >
          close
        </button>
      </div>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px]">
        <div className="flex justify-between gap-2">
          <dt className="text-muted/70">date</dt>
          <dd className="text-ink/90">{obs.acqDate ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted/70">time UTC</dt>
          <dd className="text-ink/90">{obs.acqTime ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted/70">FRP</dt>
          <dd className="text-ink/90">{obs.frp === null || obs.frp === undefined ? "—" : `${obs.frp} MW`}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted/70">confidence</dt>
          <dd className="text-ink/90">{obs.confidence ?? "—"}</dd>
        </div>
        <div className="col-span-2 flex justify-between gap-2">
          <dt className="text-muted/70">coordinates</dt>
          <dd className="text-ink/90">
            {obs.lat.toFixed(5)}, {obs.lon.toFixed(5)}
          </dd>
        </div>
      </dl>
      <p className="mt-1.5 text-[9.5px] leading-relaxed text-muted/80">
        One stored observation, quoted exactly as recorded. A thermal anomaly is not a confirmed
        wildfire, and FRP is a rate (MW), not burned area.
        {obs.id ? <span className="ml-1 font-mono text-muted/60">id {obs.id}</span> : null}
      </p>
    </div>
  );
}

function MiniStat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className={cn("rounded-lg border border-line/60 bg-elevated/25 px-2.5 py-2")}>
      <p className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-muted/70">{label}</p>
      <p className="mt-1 truncate font-mono text-[11px] text-ink">{value}</p>
      <p className="mt-0.5 truncate font-mono text-[8.5px] text-muted/60">{note}</p>
    </div>
  );
}
