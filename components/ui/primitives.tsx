import type { ReactNode } from "react";
import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { cn } from "@/lib/format";

export function Panel({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  // `fw-panel` is the shared transition (border/box-shadow/transform). It does
  // not move anything unless the panel opts in with data-interactive="true".
  return (
    <div className={cn("panel fw-panel", className)} {...rest}>
      {children}
    </div>
  );
}

export function PanelHead({
  title, hint, action, icon,
}: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="panel-head">
      <div className="flex min-w-0 items-center gap-2">
        {icon ? <span className="text-muted">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="panel-title truncate">{title}</h2>
          {hint ? <p className="mt-0.5 truncate text-[11px] text-muted">{hint}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function Stat({
  label, value, unit, delta, tone = "default", icon, footer,
}: {
  label: string; value: ReactNode; unit?: string; delta?: string;
  tone?: "default" | "cyan" | "ember" | "ok"; icon?: ReactNode; footer?: ReactNode;
}) {
  const toneRing = {
    default: "border-line/70",
    cyan: "border-cyan/30",
    ember: "border-ember/30",
    ok: "border-ok/30",
  }[tone];
  const iconTone = {
    default: "text-muted",
    cyan: "text-cyan",
    ember: "text-ember",
    ok: "text-ok",
  }[tone];
  return (
    <div className={cn("panel fw-panel px-4 py-3.5", toneRing)} data-interactive="true">
      <div className="flex items-start justify-between gap-3">
        <p className="kicker">{label}</p>
        {icon ? <span className={cn(iconTone, "opacity-80")}>{icon}</span> : null}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="value text-[26px] font-medium leading-none">{value}</span>
        {unit ? <span className="font-mono text-[11px] text-muted">{unit}</span> : null}
      </div>
      {delta ? <p className="mt-2 text-[11px] text-muted">{delta}</p> : null}
      {footer ? <div className="mt-2">{footer}</div> : null}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-ember/30 bg-ember/10 text-ember",
  fire: "border-ember/40 bg-ember/15 text-ember",
  muted: "border-line bg-elevated/60 text-muted",
  cyan: "border-cyan/30 bg-cyan/10 text-cyan",
  violet: "border-violet/30 bg-violet/10 text-violet",
};

export function Badge({ children, tone = "muted", className }: { children: ReactNode; tone?: keyof typeof BADGE_TONES; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]", BADGE_TONES[tone], className)}>
      {children}
    </span>
  );
}

export function ConfidenceBadge({ value }: { value: "low" | "nominal" | "high" | string | null }) {
  if (!value) return <Badge tone="muted">unclassified</Badge>;
  const tone = value === "high" ? "ok" : value === "nominal" ? "warn" : "muted";
  return <Badge tone={tone as keyof typeof BADGE_TONES}>{value}</Badge>;
}

export function SensorChip({ sensor, count }: { sensor: "modis" | "viirs" | string; count?: number | null }) {
  const isModis = sensor === "modis";
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
      <span className={cn("h-1.5 w-1.5 rounded-full", isModis ? "bg-cyan" : "bg-ember")} />
      {isModis ? "MODIS" : "VIIRS"}
      {count != null ? <span className="text-ink/80">{count.toLocaleString("en-US")}</span> : null}
    </span>
  );
}

export function EmptyState({ title, body, icon, action }: { title: string; body: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-lg border border-line bg-elevated/60 text-muted">
        {icon ?? <Info size={18} />}
      </div>
      <div className="max-w-sm">
        <p className="text-[13px] font-medium text-ink">{title}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{body}</p>
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ error, message, onRetry }: { error?: string; message?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <AlertTriangle size={20} className="text-ember" />
      <div>
        <p className="text-[13px] font-medium text-ink">The engine could not complete this request</p>
        <p className="mt-1 max-w-md font-mono text-[11px] leading-relaxed text-muted">{error}</p>
      </div>
      {onRetry ? <button className="btn" onClick={onRetry}>Retry</button> : null}
    </div>
  );
}

export function Loading({ label = "Querying the engine" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-14 text-[12px] text-muted">
      <Loader2 size={14} className="animate-spin text-cyan" />
      {label}…
    </div>
  );
}

/** A single shimmering placeholder. Used where a number will arrive. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden="true" className={cn("fw-skeleton block", className)} style={style} />;
}

/** Placeholder for a name/value row (title, subtitle, right-hand figure). */
export function SkeletonLine({
  width = "60%",
  className,
}: {
  width?: string;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn("flex items-center gap-2", className)}>
      <Skeleton className="h-3" style={{ width }} />
    </span>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="loading-sweep relative h-8 overflow-hidden rounded-md border border-line/60 bg-elevated/30" />
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options, value, onChange, size = "md", className,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div className={cn("inline-flex rounded-lg border border-line bg-elevated/40 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "fw-btn rounded-md font-medium",
            size === "sm" ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-[12px]",
            value === o.value ? "bg-cyan/15 text-cyan shadow-[0_0_0_1px_rgba(57,200,242,0.25)]" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/40 py-1.5 last:border-0">
      <span className="text-[11.5px] text-muted">{label}</span>
      <span className={cn("text-right text-[12px] text-ink", mono && "font-mono tabular-nums")}>{value}</span>
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="kicker">{children}</h3>
      {right}
    </div>
  );
}

export function DataNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line/70 bg-elevated/30 px-3 py-2 text-[11px] leading-relaxed text-muted">
      <Info size={13} className="mt-0.5 shrink-0 text-cyan/70" />
      <p>{children}</p>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  icon,
  actions,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line/60 pb-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {icon ? <span className="text-cyan">{icon}</span> : null}
          <h1 className="font-display text-[26px] font-semibold tracking-tight text-ink">{title}</h1>
        </div>
        {subtitle ? <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
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
  return <div className={cn("p-4", className)}>{children}</div>;
}


export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return <Loading label={label} />;
}

export { RevealSection } from "@/components/motion/RevealSection";

export function Metric({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-md border border-line/60 bg-void/30 p-3">
      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</p>
      <p className="mt-1 font-mono text-[14px] font-semibold text-ink">{value}</p>
      {note ? <p className="mt-1 text-[10px] text-muted">{note}</p> : null}
    </div>
  );
}

export function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return <Metric label={label} value={value} note={hint} />;
}
