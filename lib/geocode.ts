/**
 * Place-name → area-of-interest resolution.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * `/ask` used to accept only latitude, longitude, radius and a raw bbox. The
 * brief requires a search bar that understands `Nepal`, `Kathmandu`, `Brazil`,
 * `Amazon Basin`, `Australia`, `California`, `Indonesia`, `Canada`.
 *
 * ── The contract this module consumes (server side) ──────────────────────────
 * The browser never calls a third party directly: the request goes to **our own
 * engine origin** (`/api/geocode`, rewritten by `next.config.mjs` to the FastAPI
 * engine). That keeps the API key, the user agent, the rate limit and the
 * attribution story on the server, which is where a geocoder's usage policy
 * expects them.
 *
 *   GET /api/geocode?q=<text>&limit=<n>
 *
 *   200 application/json — either envelope is accepted:
 *     A. { query?, provider?, attribution?, note?, results: [ <result>, … ] }
 *     B. [ <result>, … ]                     (bare result list)
 *
 *   A <result> may use our field names or Nominatim's:
 *     name | display_name            required
 *     lat / lon                      optional if a bbox is present
 *     bbox: [w, s, e, n]             our convention
 *     extent: [w, s, e, n]           GeoJSON convention
 *     boundingbox: [s, n, w, e]      Nominatim convention (strings allowed)
 *     admin?  country?  kind? | type?  source?  id?
 *
 *   404  the engine has no /api/geocode mounted (it is not deployed yet)
 *   429  the upstream geocoder rate-limited the engine
 *   5xx  the engine or the upstream geocoder failed
 *
 * ── Rules this module obeys ──────────────────────────────────────────────────
 * 1. **No invented places.** There is no hardcoded gazetteer of latitudes here.
 *    If the endpoint is missing or fails, the only results are the 12 documented
 *    bboxes in `lib/regions.ts`, which ship with the engine's own catalogue.
 * 2. **No invented attribution.** The provider string shown in the UI comes from
 *    the payload. When the payload does not name a provider, the UI says so
 *    instead of guessing "OpenStreetMap".
 * 3. **Ambiguity is exposed, not hidden.** Every result carries its kind, admin
 *    area, country and bbox size, so "Springfield" cannot silently mean one town.
 */

import { buildUrl } from "@/lib/api";
import { bboxAreaKm2, bboxCenter, clampLat, wrapLon } from "@/lib/globe";
import { REGIONS } from "@/lib/regions";

export type PlaceKind = "country" | "state" | "region" | "city" | "area" | "coordinates" | "unknown";

const KIND_LABEL: Record<PlaceKind, string> = {
  country: "country",
  state: "state / province",
  region: "region",
  city: "city",
  area: "area",
  coordinates: "coordinates",
  unknown: "place",
};

export interface PlaceResult {
  /** Stable React key; also de-duplicates the same hit across refreshes. */
  key: string;
  name: string;
  /** Disambiguating administrative area ("Bagmati"), or "" when not reported. */
  admin: string;
  country: string;
  kind: PlaceKind;
  kindLabel: string;
  /** W,S,E,N — exactly what the engine's `bbox` parameter takes. */
  bbox: [number, number, number, number];
  lat: number;
  lon: number;
  /** Spherical bbox area, same formula as the engine, for the disambiguation line. */
  areaKm2: number;
  /** "builtin-region" for the offline catalogue, otherwise what the engine sent. */
  source: string;
  /** One-line disambiguation string: "city · Bagmati · Nepal · 1,234 km²". */
  context: string;
}

export type GeocodeFailureCode =
  | "empty_query"
  | "unavailable"
  | "rate_limited"
  | "server"
  | "network"
  | "bad_response";

export class GeocodeError extends Error {
  code: GeocodeFailureCode;
  status: number | null;

  constructor(code: GeocodeFailureCode, message: string, status: number | null = null) {
    super(message);
    this.name = "GeocodeError";
    this.code = code;
    this.status = status;
  }
}

export interface GeocodePayload {
  /** Null when the engine did not name its provider. */
  provider: string | null;
  /** Null when the engine did not send an attribution string. */
  attribution: string | null;
  note: string | null;
  results: PlaceResult[];
}

export const GEOCODE_LIMIT = 8;

/** Build a local result only for an explicit, valid `latitude, longitude` input. */
export function coordinatePlaceResult(query: string): PlaceResult | null {
  const match = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(query);
  if (!match) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }

  const bbox: [number, number, number, number] = [
    Math.max(-180, lon - 0.05),
    Math.max(-90, lat - 0.05),
    Math.min(180, lon + 0.05),
    Math.min(90, lat + 0.05),
  ];
  const name = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const areaKm2 = bboxAreaKm2(bbox);

  return {
    key: `coordinates:${name}`,
    name,
    admin: "",
    country: "",
    kind: "coordinates",
    kindLabel: "coordinates",
    bbox,
    lat,
    lon,
    areaKm2,
    source: "user-coordinate",
    context: `coordinates supplied · point focus · ${Math.round(areaKm2).toLocaleString("en-US")} km² query extent`,
  };
}

/* -------------------------------------------------------------------------- */
/* Offline first group — the 12 built-in regions                              */
/* -------------------------------------------------------------------------- */

const KIND_ORDER: Record<PlaceKind, number> = {
  country: 0,
  state: 1,
  region: 2,
  city: 3,
  area: 4,
  coordinates: 5,
  unknown: 5,
};

/**
 * The built-in catalogue, filtered by the query. Real, documented bboxes from
 * `lib/regions.ts` (mirrored from the engine's `/api/meta`), never geocoded and
 * never synthesised — so this group works with the network down and with the
 * geocoding endpoint absent.
 */
export function builtinRegionResults(query: string, limit = 6): PlaceResult[] {
  const q = query.trim().toLowerCase();
  const scored = REGIONS.map((region) => {
    const name = region.name.toLowerCase();
    let score = 0;
    if (!q) score = 1;
    else if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (region.id.includes(q)) score = 50;
    else if (region.kind.includes(q)) score = 20;
    else if (region.note.toLowerCase().includes(q)) score = 10;
    return { region, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.region.name.localeCompare(b.region.name));

  return scored.slice(0, limit).map(({ region }) => {
    const center = bboxCenter(region.bbox);
    const areaKm2 = bboxAreaKm2(region.bbox);
    const kind: PlaceKind = region.kind === "global" ? "region" : "region";
    return {
      key: `builtin:${region.id}`,
      name: region.name,
      admin: "",
      country: "",
      kind,
      kindLabel: "built-in region",
      bbox: region.bbox,
      lat: center.lat,
      lon: center.lon,
      areaKm2,
      source: "builtin-region",
      context: `built-in region · ${areaKm2.toLocaleString("en-US", { maximumFractionDigits: 0 })} km² · ${region.note}`,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Remote geocoder                                                            */
/* -------------------------------------------------------------------------- */

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Parse a 4-number extent. `wsen` is our/GeoJSON order, `snwe` is Nominatim's.
 * Values may arrive as strings (Nominatim sends `["27.6","30.4","80.0","88.2"]`).
 */
function toBox(raw: unknown, order: "wsen" | "snwe"): [number, number, number, number] | null {
  let values: number[] = [];
  if (Array.isArray(raw)) values = raw.map(asNumber).filter((v): v is number => v !== null);
  else if (typeof raw === "string") values = raw.split(",").map((p) => Number(p.trim()));
  if (values.length !== 4 || values.some((v) => !Number.isFinite(v))) return null;

  const [a, b, c, d] = values;
  const box: [number, number, number, number] = order === "snwe" ? [c, a, d, b] : [a, b, c, d];
  const [w, s, e, n] = box;
  if (Math.abs(w) > 180 || Math.abs(e) > 180) return null;
  if (s >= n || Math.abs(s) > 90 || Math.abs(n) > 90) return null;
  if (w === e) return null;
  return [w, s, e, n];
}

function parseBox(raw: Record<string, unknown>): [number, number, number, number] | null {
  const engineOrder = toBox(raw.bbox, "wsen") ?? toBox(raw.extent, "wsen");
  if (engineOrder) return engineOrder;
  return toBox(raw.boundingbox, "snwe");
}

const KIND_MAP: Record<string, PlaceKind> = {
  country: "country",
  nation: "country",
  state: "state",
  province: "state",
  region: "region",
  state_district: "state",
  city: "city",
  town: "city",
  village: "city",
  municipality: "city",
  hamlet: "city",
  locality: "city",
  suburb: "city",
  administrative: "area",
  county: "area",
  district: "area",
  island: "area",
  national_park: "area",
  protected_area: "area",
};

function normaliseKind(raw: unknown): { kind: PlaceKind; label: string } {
  const value = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (value) {
    // Nominatim returns both `type` and `addresstype`; a type wins over a broad class.
    const mapped = KIND_MAP[value];
    if (mapped) return { kind: mapped, label: KIND_LABEL[mapped] };
    if (value.includes("country")) return { kind: "country", label: KIND_LABEL.country };
    if (value.includes("state") || value.includes("province")) {
      return { kind: "state", label: KIND_LABEL.state };
    }
    if (value.includes("city") || value.includes("town") || value.includes("village")) {
      return { kind: "city", label: KIND_LABEL.city };
    }
  }
  return { kind: "unknown", label: KIND_LABEL.unknown };
}

interface RawAddress {
  country?: unknown;
  state?: unknown;
  region?: unknown;
  county?: unknown;
  state_district?: unknown;
  city?: unknown;
  town?: unknown;
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/** Turn one raw result into a `PlaceResult`, or null when it is unusable. */
function normaliseResult(
  item: unknown,
  provider: string | null,
  index: number,
): PlaceResult | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const name = pickString(raw.name, raw.displayName, raw.display_name, raw.label);
  if (!name) return null;

  const bbox = parseBox(raw);
  const address = (raw.address && typeof raw.address === "object" ? raw.address : {}) as RawAddress;

  const center = bbox
    ? bboxCenter(bbox)
    : (() => {
        const lat = asNumber(raw.lat);
        const lon = asNumber(raw.lon ?? raw.lng);
        if (lat === null || lon === null) return null;
        return { lat: clampLat(lat), lon: wrapLon(lon) };
      })();
  if (!center) return null;

  // A point without a bbox is still a place, but it is not an AOI: give it the
  // smallest honest box the engine can query (a 10 km square around the point)
  // ONLY when the geocoder did not publish an extent. That is stated in `context`.
  const box: [number, number, number, number] = bbox ?? [
    wrapLon(center.lon - 0.05),
    Math.max(-90, center.lat - 0.05),
    wrapLon(center.lon + 0.05),
    Math.min(90, center.lat + 0.05),
  ];
  const areaKm2 = bboxAreaKm2(box);

  const { kind, label } = normaliseKind(
    pickString(raw.kind, raw.type, raw.addresstype, raw.class) || undefined,
  );
  const admin = pickString(raw.admin, raw.state, address.state, address.region, address.state_district, address.county);
  const country = pickString(raw.country, address.country);
  const source = pickString(raw.source, provider) || "geocoder";

  const contextParts = [
    bbox ? label : `${label} · point extent (no published bbox)`,
    admin,
    country,
    `${Math.round(areaKm2).toLocaleString("en-US")} km²`,
  ].filter(Boolean);

  const id = pickString(raw.id, raw.place_id, raw.osm_id);
  return {
    key: `${source}:${id || name}:${box.join(",")}:${index}`,
    name,
    admin,
    country,
    kind,
    kindLabel: label,
    bbox: box,
    lat: center.lat,
    lon: center.lon,
    areaKm2,
    source,
    context: contextParts.join(" · "),
  };
}

function messageFor(status: number): { code: GeocodeFailureCode; message: string } {
  if (status === 404) {
    return {
      code: "unavailable",
      message:
        "This engine does not expose /api/geocode (HTTP 404), so only the 12 built-in regions can be searched.",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message:
        "The place-lookup service rate-limited this request (HTTP 429). Wait a few seconds and try again, or pick a built-in region.",
    };
  }
  if (status >= 500) {
    return {
      code: "server",
      message: `The geocoding service failed upstream (HTTP ${status}). Built-in regions are unaffected.`,
    };
  }
  return {
    code: "bad_response",
    message: `The geocoding request was refused (HTTP ${status}). Built-in regions are unaffected.`,
  };
}

/**
 * Resolve free text to a set of AOI candidates through the engine.
 *
 * Throws `GeocodeError` (never returns invented rows) so the caller can render
 * the exact failure: unavailable endpoint, rate limit, network, bad payload.
 */
export async function geocodePlaces(
  query: string,
  options: { signal?: AbortSignal; limit?: number } = {},
): Promise<GeocodePayload> {
  const q = query.trim();
  if (q.length === 0) {
    throw new GeocodeError("empty_query", "Type a place name first.");
  }

  const url = buildUrl("/api/geocode", { q, limit: options.limit ?? GEOCODE_LIMIT });

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new GeocodeError(
      "network",
      "The geocoding request did not reach the engine (network error or offline).",
    );
  }

  if (!res.ok) {
    const m = messageFor(res.status);
    throw new GeocodeError(m.code, m.message, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new GeocodeError(
      "bad_response",
      "The geocoding endpoint answered with something that is not JSON.",
      res.status,
    );
  }

  const envelope = !Array.isArray(body) && body && typeof body === "object"
    ? (body as Record<string, unknown>)
    : null;
  const list = Array.isArray(body) ? body : envelope?.results;

  if (!Array.isArray(list)) {
    throw new GeocodeError(
      "bad_response",
      "The geocoding endpoint returned no result list. Expected { results: [...] } or a bare array.",
      res.status,
    );
  }

  const provider = envelope ? pickString(envelope.provider, envelope.source) || null : null;
  const attribution = envelope ? pickString(envelope.attribution) || null : null;
  const note = envelope ? pickString(envelope.note, envelope.hint) || null : null;

  const results = list
    .map((item, i) => normaliseResult(item, provider, i))
    .filter((r): r is PlaceResult => r !== null)
    .slice(0, options.limit ?? GEOCODE_LIMIT);

  return { provider, attribution, note, results };
}

/** Sort a mixed group so countries/regions precede cities, then by name. */
export function sortPlaces(list: PlaceResult[]): PlaceResult[] {
  return [...list].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
}
