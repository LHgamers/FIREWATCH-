import type { ReactNode } from "react";
import { Panel as BasePanel } from "./primitives";

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <BasePanel className={className}>{children}</BasePanel>;
}

export function PanelHeader({ title, icon, meta }: { title: string; icon?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line/60 px-4 py-3">
      <div className="flex items-center gap-2">
        {icon ? <span className="text-cyan">{icon}</span> : null}
        <h2 className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">{title}</h2>
      </div>
      {meta ? <div className="text-[11px] text-muted">{meta}</div> : null}
    </div>
  );
}

export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["p-4", className].filter(Boolean).join(" ")}>{children}</div>;
}

export function Metric({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-md border border-line/60 bg-void/30 p-3">
      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</p>
      <p className="mt-1 font-mono text-[14px] font-semibold text-ink">{value}</p>
      {note ? <p className="mt-1 text-[10px] text-muted">{note}</p> : null}
    </div>
  );
}

export default Panel;
