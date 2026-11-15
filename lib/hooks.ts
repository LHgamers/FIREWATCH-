"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, buildUrl } from "@/lib/api";
import { useFiltersMaybe } from "@/components/shell/FiltersProvider";
import type { Meta } from "@/lib/types";

const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 450;

let cache: Meta | null = null;
let inflight: Promise<Meta> | null = null;
const listeners = new Set<(m: Meta) => void>();

export function useMeta(): {
  meta: Meta | null;
  data: Meta | null;
  loading: boolean;
  error: string | null;
} {
  const [meta, setMeta] = useState<Meta | null>(cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onUpdate = (m: Meta) => setMeta(m);
    listeners.add(onUpdate);
    if (!cache) {
      if (!inflight) {
        inflight = apiGet<Meta>("/api/meta")
          .then((m) => {
            cache = m;
            listeners.forEach((fn) => fn(m));
            return m;
          })
          .catch((e: Error) => {
            setError(e.message);
            throw e;
          })
          .finally(() => {
            inflight = null;
          });
      }
      inflight.then((m) => setMeta(m)).catch(() => undefined);
    }
    return () => {
      listeners.delete(onUpdate);
    };
  }, []);

  return { meta, data: meta, error, loading: meta === null && error === null };
}

/**
 * Wait until FiltersProvider has resolved the region from the URL/localStorage.
 *
 * Returning false on the first render (including SSR) is deliberate: it is what
 * stops the dashboard from fetching Global and then refetching the real region.
 * Outside a provider (a standalone widget) the gate is open.
 */
function useFiltersReady(): boolean {
  const ctx = useFiltersMaybe();
  return ctx ? ctx.ready : true;
}

interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Epoch ms of the last successful response, 0 before the first one. */
  updatedAt: number;
  retry: () => void;
}

/**
 * Abortable, timed, retrying GET.
 *
 * Before this, `useApi` had no timeout, no abort and no retry: a stalled engine
 * left six of nine routes spinning forever, and a slow query could resolve after
 * the user had already changed the region. It now shares the contract of
 * `useEngineQuery` on the map (30 s per attempt, AbortController on unmount and
 * param change, bounded retries on network/5xx failures) and keeps the previous
 * payload visible while the next one is in flight.
 */
export function useApi<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
  deps: unknown[] = [],
  enabled = true,
): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [nonce, setNonce] = useState(0);
  const filtersReady = useFiltersReady();

  const key = JSON.stringify(params);
  const active = enabled && filtersReady;

  useEffect(() => {
    if (!active) {
      setLoading(false);
      return;
    }
    let alive = true;
    let controller: AbortController | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let attempt = 0;
    let retryHandle: ReturnType<typeof setTimeout> | null = null;

    setLoading(true);
    setError(null);

    const run = () => {
      attempt += 1;
      controller = new AbortController();
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller?.abort();
      }, REQUEST_TIMEOUT_MS);

      apiGet<T>(path, params, { signal: controller.signal })
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
          setLoading(false);
          setUpdatedAt(Date.now());
        })
        .catch((err: unknown) => {
          if (!alive) return;
          const aborted = err instanceof DOMException && err.name === "AbortError";
          if (aborted && !timedOut) return; // superseded by a newer request
          if (timedOut) {
            setError(
              `The engine did not answer within ${REQUEST_TIMEOUT_MS / 1000} s. The query may be too broad for this filter, or the engine may be restarting.`,
            );
            setLoading(false);
            return;
          }
          // A transport failure or a 5xx is worth retrying once or twice; a 4xx
          // is a contract answer (bad region, bad bbox) and must not be retried.
          const message = err instanceof Error ? err.message : String(err);
          const retriable = isRetriable(err);
          if (retriable && attempt < MAX_ATTEMPTS) {
            retryHandle = setTimeout(run, RETRY_BASE_MS * attempt);
            return;
          }
          setError(message);
          setLoading(false);
        })
        .finally(() => {
          if (timeoutHandle !== null) clearTimeout(timeoutHandle);
          timeoutHandle = null;
        });
    };

    run();

    return () => {
      alive = false;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (retryHandle !== null) clearTimeout(retryHandle);
      controller?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, active, nonce, ...deps]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, updatedAt, retry };
}

function isRetriable(err: unknown): boolean {
  if (err instanceof TypeError) return true; // network/DNS failure surfaces as TypeError
  const message = err instanceof Error ? err.message : String(err);
  const status = Number.parseInt(message.slice(0, 3), 10);
  return Number.isFinite(status) && status >= 500;
}

export { buildUrl };
