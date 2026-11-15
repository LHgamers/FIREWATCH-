"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryValue } from "@/lib/api";

const REQUEST_TIMEOUT_MS = 30000;

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Epoch ms of the last successful response. */
  updatedAt: number;
}

interface EngineQuery<T> extends QueryState<T> {
  retry: () => void;
}

/**
 * Abortable, debounced GET against the same-origin /api/* proxy.
 *
 * `apiGet` from lib/api.ts is the canonical helper but does not accept an
 * AbortSignal, so this local hook reimplements the same contract (same-origin
 * URL, no-store, `detail` error surface) with cancellation. The previous
 * payload is kept while a new one is in flight so the map never flashes empty.
 */
export function useEngineQuery<T>(
  path: string,
  params: Record<string, QueryValue>,
  enabled: boolean,
  debounceMs = 250,
): EngineQuery<T> {
  const key = JSON.stringify(params);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const [state, setState] = useState<QueryState<T>>({ data: null, error: null, loading: enabled, updatedAt: 0 });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return;
    }
    let alive = true;
    let controller: AbortController | null = null;
    let timedOut = false;
    let timeoutHandle: number | null = null;

    const timer = window.setTimeout(() => {
      controller = new AbortController();
      timeoutHandle = window.setTimeout(() => {
        timedOut = true;
        controller?.abort();
      }, REQUEST_TIMEOUT_MS);
      const url = new URL(path, window.location.origin);
      Object.entries(paramsRef.current).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      });

      setState((s) => ({ ...s, loading: true, error: null }));

      fetch(url.toString(), { cache: "no-store", signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) {
            let detail = `${res.status} ${res.statusText}`;
            try {
              const body: unknown = await res.json();
              if (body && typeof body === "object" && "detail" in body) {
                const d = (body as { detail?: unknown }).detail;
                if (typeof d === "string") detail = d;
              }
            } catch {
              /* non-JSON error body */
            }
            throw new Error(detail);
          }
          return (await res.json()) as T;
        })
        .then((data) => {
          if (!alive) return;
          setState({ data, error: null, loading: false, updatedAt: Date.now() });
        })
        .catch((err: unknown) => {
          if (!alive) return;
          if (err instanceof DOMException && err.name === "AbortError") {
            if (timedOut) {
              setState((s) => ({
                ...s,
                loading: false,
                error: `The engine did not answer within ${REQUEST_TIMEOUT_MS / 1000} s — the query may be too broad for the current filter.`,
              }));
            }
            return;
          }
          setState((s) => ({
            ...s,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        })
        .finally(() => {
          if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
        });
    }, debounceMs);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      controller?.abort();
    };
  }, [path, key, enabled, debounceMs, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, retry };
}
