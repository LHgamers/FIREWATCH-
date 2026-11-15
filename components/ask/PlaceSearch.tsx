"use client";

/**
 * PlaceSearch — the prominent country / city / region search for `/ask`.
 *
 * Behavioural contract:
 *  · **Debounced** input (350 ms) and an `AbortController` per request, so typing
 *    "Indo…nesia" issues one lookup and the stale one is cancelled, not raced.
 *  · **Two result groups.** The 12 documented regions from `lib/regions.ts` are
 *    answered locally and always shown first — they work with the network down
 *    and with no geocoding endpoint mounted. Everything else comes from
 *    `GET /api/geocode` on our own engine origin (see `lib/geocode.ts`).
 *  · **Ambiguity is visible.** Each option prints its kind, administrative area,
 *    country and bbox size, so two same-named places cannot be silently swapped.
 *  · **Failures are named.** 404 (endpoint not mounted), 429 (rate limited),
 *    network and malformed payload each render their own sentence; none of them
 *    falls back to an invented coordinate.
 *  · **Keyboard and screen-reader complete**: combobox semantics, arrow keys,
 *    Enter, Escape, `aria-activedescendant`.
 *  · **Motion**: the list enters with a `backwards`-filled opacity/transform
 *    animation that `prefers-reduced-motion` and `html[data-motion="off"]`
 *    neutralise (see components/motion/motion.css).
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AlertTriangle, Globe2, Loader2, MapPin, Search, X } from "lucide-react";
import { cn, formatInt } from "@/lib/format";
import {
  GeocodeError,
  builtinRegionResults,
  coordinatePlaceResult,
  geocodePlaces,
  sortPlaces,
  type PlaceResult,
} from "@/lib/geocode";

const DEBOUNCE_MS = 350;
const MIN_QUERY = 2;

export interface PlaceSearchProps {
  /** A chosen place. The parent owns the AOI, the URL and the engine query. */
  onSelect: (place: PlaceResult) => void;
  /** Name of the AOI currently applied, shown so the box never lies about state. */
  currentName?: string | null;
  className?: string;
}

interface RemoteState {
  results: PlaceResult[];
  provider: string | null;
  attribution: string | null;
  note: string | null;
}

export function PlaceSearch({ onSelect, currentName, className }: PlaceSearchProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<GeocodeError | null>(null);
  /** True while the debounce timer is pending: shown as "waiting to query". */
  const [pending, setPending] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listId = useId();

  const coordinate = useMemo(() => coordinatePlaceResult(query), [query]);
  const builtins = useMemo(() => builtinRegionResults(query, 6), [query]);

  // A geocoder hit that repeats a built-in name is the same AOI twice; the
  // built-in row is the offline one, so it stays and the remote duplicate goes.
  const remoteResults = useMemo(() => {
    if (!remote) return [];
    const seen = new Set(builtins.map((b) => b.name.trim().toLowerCase()));
    return sortPlaces(remote.results.filter((r) => !seen.has(r.name.trim().toLowerCase())));
  }, [remote, builtins]);

  const options = useMemo(
    () => (coordinate ? [coordinate] : [...builtins, ...remoteResults]),
    [coordinate, builtins, remoteResults],
  );

  const runLookup = useCallback(async (raw: string) => {
    abortRef.current?.abort();
    const text = raw.trim();
    if (text.length < MIN_QUERY) {
      setRemote(null);
      setError(null);
      setLoading(false);
      setPending(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const payload = await geocodePlaces(text, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRemote({
        results: payload.results,
        provider: payload.provider,
        attribution: payload.attribution,
        note: payload.note,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setRemote(null);
      setError(
        err instanceof GeocodeError
          ? err
          : new GeocodeError("network", (err as Error)?.message ?? "Unknown geocoding failure"),
      );
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setPending(false);
      }
    }
  }, []);

  /* ---------------------------------------------------- debounced lookup */
  useEffect(() => {
    const text = query.trim();
    if (coordinatePlaceResult(text)) {
      abortRef.current?.abort();
      setRemote(null);
      setError(null);
      setLoading(false);
      setPending(false);
      return;
    }
    if (text.length < MIN_QUERY) {
      abortRef.current?.abort();
      setRemote(null);
      setError(null);
      setLoading(false);
      setPending(false);
      return;
    }
    setPending(true);
    const timer = window.setTimeout(() => {
      void runLookup(text);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, runLookup]);

  // Cancel any in-flight request when the component unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Keep the active row inside the list as the arrow keys move it.
  useEffect(() => {
    if (!open) return;
    const node = document.getElementById(`${listId}-opt-${active}`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active, open, listId]);

  const choose = useCallback(
    (place: PlaceResult) => {
      onSelect(place);
      setQuery(place.name);
      setOpen(false);
      setActive(0);
      inputRef.current?.blur();
    },
    [onSelect],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (options.length ? (i + 1) % options.length : 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (options.length ? (i - 1 + options.length) % options.length : 0));
      return;
    }
    if (event.key === "Enter") {
      const pick = options[active] ?? options[0];
      if (pick) {
        event.preventDefault();
        choose(pick);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Home") setActive(0);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const pick = options[active] ?? options[0];
    if (pick) {
      choose(pick);
      return;
    }
    setOpen(true);
    void runLookup(query);
  };

  const clear = () => {
    abortRef.current?.abort();
    setQuery("");
    setRemote(null);
    setError(null);
    setActive(0);
    setOpen(false);
    inputRef.current?.focus();
  };

  const showEmptyResult =
    open &&
    !loading &&
    !pending &&
    !error &&
    query.trim().length >= MIN_QUERY &&
    remote !== null &&
    remoteResults.length === 0 &&
    builtins.length === 0;

  const accepted = Boolean(currentName);

  return (
    <div className={cn("relative", className)}>
      <form onSubmit={submit} role="search">
        <label htmlFor={`${listId}-input`} className="kicker">
          Search a place · country, city or region
        </label>
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2 rounded-lg border bg-void/50 px-3 py-2 transition-colors",
            open ? "border-cyan/50" : "border-line",
            "focus-within:border-cyan/60",
          )}
        >
          <Search size={15} className="shrink-0 text-cyan/80" aria-hidden="true" />
          <input
            id={`${listId}-input`}
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // Let a click on an option land before the list closes.
              window.setTimeout(() => setOpen(false), 120);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && options.length ? `${listId}-opt-${active}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            placeholder="Brazil · Nepal · Amazon · 27.7172, 85.3240"
            className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-muted/60"
          />
          {pending || loading ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-cyan" aria-hidden="true" />
          ) : null}
          {query ? (
            <button
              type="button"
              onClick={clear}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted transition-colors hover:text-ink"
              aria-label="Clear the place search"
            >
              <X size={12} />
            </button>
          ) : null}
          <button type="submit" className="btn shrink-0 px-2 py-1 text-[11px]">
            Search
          </button>
        </div>
      </form>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9.5px] leading-relaxed text-muted/70">
        <span className="inline-flex items-center gap-1">
          <Globe2 size={10} /> 12 built-in regions offline
        </span>
        <span aria-hidden="true">·</span>
        <span>{attributionLine(remote, error)}</span>
      </p>

      {accepted && !open ? (
        <p className="mt-1 inline-flex items-center gap-1 font-mono text-[9.5px] text-cyan/80">
          <MapPin size={10} /> current AOI · {currentName}
        </p>
      ) : null}

      {open ? (
        <div
          className="fw-rise-in-sm absolute inset-x-0 z-30 mt-1.5 max-h-[min(58vh,420px)] overflow-y-auto rounded-lg border border-line bg-panel shadow-panel"
          onMouseDown={(e) => e.preventDefault()}
        >
          <ul role="listbox" id={listId} aria-label="Place search results" className="py-1">
            {coordinate ? (
              <li role="group" aria-label="Coordinates">
                <p
                  aria-hidden="true"
                  className="px-2.5 pb-1 pt-1.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-muted/60"
                >
                  Coordinates · latitude, longitude
                </p>
                <ul role="none">
                  <Option
                    place={coordinate}
                    index={0}
                    active={active === 0}
                    listId={listId}
                    onChoose={choose}
                    onHover={setActive}
                    badge="input"
                  />
                </ul>
              </li>
            ) : null}

            {!coordinate && builtins.length ? (
              <li role="group" aria-label="Built-in regions">
                <p
                  aria-hidden="true"
                  className="px-2.5 pb-1 pt-1.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-muted/60"
                >
                  Built-in regions · offline · documented bbox
                </p>
                <ul role="none">
                  {builtins.map((place, i) => (
                    <Option
                      key={place.key}
                      place={place}
                      index={i}
                      active={active === i}
                      listId={listId}
                      onChoose={choose}
                      onHover={setActive}
                      badge="built-in"
                    />
                  ))}
                </ul>
              </li>
            ) : null}

            {!coordinate ? <li role="group" aria-label="Geocoder results">
              <p
                aria-hidden="true"
                className="px-2.5 pb-1 pt-2 font-mono text-[8.5px] uppercase tracking-[0.14em] text-muted/60"
              >
                Geocoded places
                {remote?.provider ? ` · ${remote.provider}` : ""}
              </p>
              {loading || pending ? (
                <p className="px-2.5 py-2 font-mono text-[10px] text-muted">
                  {pending ? "waiting for input to settle…" : `looking up “${query.trim()}”…`}
                </p>
              ) : null}
              {error ? (
                <div className="mx-2 mb-2 rounded border border-ember/30 bg-ember/[0.06] px-2 py-1.5">
                  <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-ember">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    <span>
                      {error.message}
                      {error.status ? (
                        <span className="ml-1 font-mono text-[9px] opacity-80">
                          (HTTP {error.status})
                        </span>
                      ) : null}
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() => void runLookup(query)}
                    className="mt-1 rounded border border-line bg-elevated/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-muted hover:text-ink"
                  >
                    Retry lookup
                  </button>
                </div>
              ) : null}
              {!loading && !pending && !error && remoteResults.length === 0 && remote !== null ? (
                <p className="px-2.5 py-2 text-[10.5px] leading-relaxed text-muted">
                  The geocoder returned no place for “{query.trim()}”.
                </p>
              ) : null}
              {!loading && !error && remote === null && query.trim().length < MIN_QUERY ? (
                <p className="px-2.5 py-2 text-[10.5px] leading-relaxed text-muted">
                  Type at least {MIN_QUERY} characters to search the geocoder.
                </p>
              ) : null}
              <ul role="none">
                {remoteResults.map((place, i) => (
                  <Option
                    key={place.key}
                    place={place}
                    index={builtins.length + i}
                    active={active === builtins.length + i}
                    listId={listId}
                    onChoose={choose}
                    onHover={setActive}
                    badge={place.source}
                  />
                ))}
              </ul>
            </li> : null}
          </ul>

          {showEmptyResult ? (
            <p className="border-t border-line/60 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted">
              No place matched “{query.trim()}” in the geocoder or in the 12 built-in regions.
            </p>
          ) : null}

          <div className="border-t border-line/60 px-2.5 py-1.5">
            <p className="font-mono text-[9px] leading-relaxed text-muted/70">
              {coordinate
                ? "No third-party lookup was used for these coordinates."
                : remote?.attribution
                ? `Attribution · ${remote.attribution}`
                : remote?.provider
                  ? `The engine named its provider (${remote.provider}) but sent no attribution string.`
                  : "No third-party geocoder was called for the built-in rows."}
            </p>
            {remote?.note ? (
              <p className="mt-0.5 font-mono text-[9px] leading-relaxed text-muted/60">{remote.note}</p>
            ) : null}
            <p className="mt-0.5 text-[9.5px] leading-relaxed text-muted/60">
              A place resolves to its published bounding box — an administrative or
              natural extent, not a fire perimeter. The box becomes the engine AOI.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function attributionLine(remote: RemoteState | null, error: GeocodeError | null): string {
  if (error?.code === "unavailable") {
    return "no geocoding endpoint mounted · built-in regions only";
  }
  if (error) return "geocoder unavailable · built-in regions still work";
  if (remote?.provider) {
    return `geocoder · ${remote.provider}`;
  }
  return "geocoder · /api/geocode (this engine)";
}

function Option({
  place,
  index,
  active,
  listId,
  onChoose,
  onHover,
  badge,
}: {
  place: PlaceResult;
  index: number;
  active: boolean;
  listId: string;
  onChoose: (place: PlaceResult) => void;
  onHover: (index: number) => void;
  badge: string;
}) {
  return (
    <li
      id={`${listId}-opt-${index}`}
      role="option"
      aria-selected={active}
      onMouseEnter={() => onHover(index)}
      onClick={() => onChoose(place)}
      className={cn(
        "cursor-pointer px-2.5 py-1.5 transition-colors",
        active ? "bg-cyan/10" : "hover:bg-elevated/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[12px] text-ink">{place.name}</span>
        <span className="shrink-0 font-mono text-[8.5px] uppercase tracking-[0.1em] text-muted/60">
          {badge}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[9.5px] text-muted/85">
          {place.context}
        </span>
        <span className="shrink-0 font-mono text-[9px] text-muted/60">
          {place.lat.toFixed(2)}, {place.lon.toFixed(2)} · {formatInt(place.areaKm2)} km²
        </span>
      </div>
      {place.country && place.admin && place.admin !== place.country ? (
        <p className="mt-0.5 truncate font-mono text-[9px] text-muted/50">
          {place.kindLabel} in {place.admin}, {place.country}
        </p>
      ) : null}
    </li>
  );
}

