"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown, Database, Sparkles } from "lucide-react";
import { navForPath } from "@/lib/nav";
import { REGIONS } from "@/lib/regions";
import { cn } from "@/lib/format";

interface MetaLite {
  engine?: { observations?: number };
  coverage?: { first?: string | null; last?: string | null };
  freshness?: { lastSuccessAt?: string | null };
  archive?: { note?: string | null };
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function Topbar() {
  const pathname = usePathname();
  const item = navForPath(pathname);
  const [region, setRegion] = useState("all");
  const [menu, setMenu] = useState(false);
  const [meta, setMeta] = useState<MetaLite | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("firewatch.region");
      if (stored && REGIONS.some((r) => r.id === stored)) setRegion(stored);
    } catch {}
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/meta", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setMeta(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const current = REGIONS.find((r) => r.id === region) ?? REGIONS[0];
  const last = meta?.freshness?.lastSuccessAt ?? null;
  const count = meta?.engine?.observations;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line/70 bg-void/75 px-4 backdrop-blur-xl md:px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.2em] text-muted/60">
          <span>Firewatch</span>
          <span className="text-line">/</span>
          <span className="text-cyan/70">{item.group}</span>
        </div>
        <h1 className="truncate font-display text-[18px] font-semibold leading-tight tracking-tight text-ink md:text-[22px]">
          {item.label}
        </h1>
      </div>

      <div className="flex items-center gap-2">
        <div
          className="hidden items-center gap-1.5 rounded-md border border-line/70 bg-raised/40 px-2.5 py-1.5 font-mono text-[10px] text-muted sm:flex"
          title={meta?.archive?.note ?? undefined}
        >
          <Database size={12} className="text-cyan/70" />
          <span className="text-ink/90">{typeof count === "number" ? count.toLocaleString("en-US") : "—"}</span>
          <span>detections</span>
          {last ? <span className="text-muted/70">· {relativeAge(last)}</span> : null}
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            className="fw-btn fw-btn-secondary h-8 gap-1.5 px-2.5 text-[10px]"
          >
            <Sparkles size={12} className="text-cyan" />
            <span className="max-w-[120px] truncate">{current.name}</span>
            <ChevronDown size={12} className={cn("transition-transform", menu && "rotate-180")} />
          </button>
          {menu ? (
            <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-56 rounded-lg border border-line/70 bg-raised/95 p-1 shadow-xl backdrop-blur">
              {REGIONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    setRegion(r.id);
                    setMenu(false);
                    try { localStorage.setItem("firewatch.region", r.id); } catch {}
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[11px] hover:bg-void/40",
                    r.id === region ? "text-cyan" : "text-muted"
                  )}
                >
                  <span>{r.name}</span>
                  {r.id === region ? <span className="font-mono text-[9px]">active</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
