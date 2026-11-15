"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronLeft, Menu, PlayCircle, X } from "lucide-react";
import { NAV, NAV_GROUPS } from "@/lib/nav";
import { cn } from "@/lib/format";
import { useMeta } from "@/lib/hooks";
import { BrandMark } from "./BrandMark";

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { meta } = useMeta();
  const last = meta?.coverage?.last;

  const content = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-4 pt-5">
        <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <BrandMark />
          <div>
            <p className="text-[14px] font-semibold tracking-[0.14em] text-ink">FIREWATCH</p>
            <p className="font-mono text-[9px] uppercase tracking-[0.24em] text-cyan/70">LH Studios · AI</p>
          </div>
        </Link>
        <button className="text-muted lg:hidden" onClick={() => setOpen(false)} aria-label="Close navigation">
          <X size={18} />
        </button>
      </div>

      <nav className="scroll-thin flex-1 overflow-y-auto px-2.5 pb-4">
        {NAV_GROUPS.map((group) => {
          const items = NAV.filter((n) => n.group === group);
          return (
            <div key={group} className="mb-4">
              <p className="px-2 pb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted/60">{group}</p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "group relative flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px]",
                          "transition-[background-color,color,transform] duration-200 ease-out",
                          "hover:translate-x-[2px] motion-reduce:hover:translate-x-0",
                          active
                            ? "bg-cyan/10 text-ink"
                            : "text-muted hover:bg-elevated/50 hover:text-ink",
                        )}
                      >
                        {active ? (
                          <span className="fw-scale-in absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-cyan" />
                        ) : null}
                        <Icon size={15} className={cn("transition-colors duration-200", active ? "text-cyan" : "text-muted/80 group-hover:text-ink/80")} />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-line/70 px-3 py-3">
        <div className="flex items-center gap-2">
          <span className={cn("fw-live h-1.5 w-1.5 rounded-full", meta ? "bg-ok text-ok" : "bg-ember text-ember")} />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            {meta ? "Engine online" : "Connecting…"}
          </span>
        </div>
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted/70">
          NRT window {last ?? "—"}
          <br />
          NASA FIRMS · GIBS imagery
        </p>
        <Link
          href="/?intro=1"
          className="mt-2.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-cyan/80 hover:text-cyan"
        >
          <PlayCircle size={12} /> Replay introduction
        </Link>
      </div>
    </div>
  );

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed left-3 top-3 z-40 grid h-9 w-9 place-items-center rounded-lg border border-line bg-panel/90 text-muted backdrop-blur lg:hidden"
        aria-label="Open navigation"
      >
        <Menu size={16} />
      </button>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] border-r border-line/70 bg-void/85 backdrop-blur-xl lg:block">
        {content}
      </aside>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="fw-backdrop-in absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <aside className="fw-drawer-in absolute inset-y-0 left-0 w-[262px] border-r border-line bg-void shadow-2xl">
            {content}
          </aside>
        </div>
      ) : null}
    </>
  );
}
