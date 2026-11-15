export type QueryValue = string | number | boolean | undefined | null;

export interface ApiGetOptions {
  /** Cancel the request (unmount, param change, timeout). */
  signal?: AbortSignal;
}

/** Same-origin fetch helper. Next rewrites /api/* to the FastAPI engine. */
export async function apiGet<T>(
  path: string,
  params: Record<string, QueryValue> = {},
  options: ApiGetOptions = {},
): Promise<T> {
  const url = buildUrl(path, params);
  const res = await fetch(url.toString(), { cache: "no-store", signal: options.signal });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export function buildUrl(path: string, params: Record<string, QueryValue> = {}): URL {
  const url = new URL(path, typeof window === "undefined" ? "http://127.0.0.1:3000" : window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  });
  return url;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const parsed = await res.json();
      detail = parsed.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const REGION_STORAGE_KEY = "firewatch.region";
