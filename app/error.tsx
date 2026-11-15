"use client";

import { AlertTriangle } from "lucide-react";

export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="panel mx-auto mt-10 max-w-xl p-8 text-center">
      <AlertTriangle className="mx-auto text-ember" size={22} />
      <h1 className="mt-3 text-[18px] font-semibold text-ink">The view failed to render</h1>
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted">{error.message}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        The scientific engine may be restarting. Data is read from the local store, so a retry
        should recover without losing anything.
      </p>
      <button className="btn btn-primary mt-4" onClick={reset}>Retry</button>
    </div>
  );
}
