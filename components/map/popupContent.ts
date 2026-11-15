import type { DetectionProps } from "@/lib/types";
import { MAP_COLORS } from "@/lib/map-style";

const MONO = 'ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace';

export function datasetLabel(source: string): string {
  if (source === "firms-modis-c61") return "NASA FIRMS · MODIS C6.1 NRT";
  if (source === "firms-viirs-375") return "NASA FIRMS · VIIRS 375 m NRT";
  return source;
}

function fmt(value: number | null | undefined, digits = 1, suffix = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}${suffix}`;
}

function row(label: string, value: string, tone?: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.display = "flex";
  el.style.alignItems = "baseline";
  el.style.justifyContent = "space-between";
  el.style.gap = "12px";
  el.style.padding = "3px 0";

  const k = document.createElement("span");
  k.textContent = label;
  k.style.fontSize = "10.5px";
  k.style.color = "#91A2B9";
  k.style.flex = "0 0 auto";

  const v = document.createElement("span");
  v.textContent = value;
  v.style.fontFamily = MONO;
  v.style.fontSize = "11px";
  v.style.textAlign = "right";
  v.style.color = tone ?? "#F1F5FC";
  v.style.fontVariantNumeric = "tabular-nums";

  el.appendChild(k);
  el.appendChild(v);
  return el;
}

function utcStamp(acqDate: string, acqTime: string | null, ts: number): string {
  if (acqDate && acqTime) {
    const t = acqTime.replace(/\D/g, "").padStart(4, "0");
    return `${acqDate} ${t.slice(0, 2)}:${t.slice(2)} UTC`;
  }
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * MapLibre popup DOM for a single detection. Built with textContent only —
 * no interpolation of engine payloads into HTML.
 */
export function buildDetectionPopup(props: DetectionProps, onAsk?: () => void): HTMLElement {
  const sensorColor = props.sensor === "modis" ? MAP_COLORS.modis : MAP_COLORS.viirs;
  const root = document.createElement("div");
  root.style.width = "268px";
  root.style.padding = "12px 13px 11px";
  root.style.fontFamily = 'Inter, system-ui, sans-serif';

  const head = document.createElement("div");
  head.style.display = "flex";
  head.style.alignItems = "center";
  head.style.justifyContent = "space-between";
  head.style.gap = "8px";
  head.style.paddingBottom = "8px";
  head.style.borderBottom = "1px solid rgba(34,48,74,0.7)";

  const sensor = document.createElement("span");
  sensor.style.display = "inline-flex";
  sensor.style.alignItems = "center";
  sensor.style.gap = "6px";
  sensor.style.fontFamily = MONO;
  sensor.style.fontSize = "10px";
  sensor.style.letterSpacing = "0.12em";
  sensor.style.textTransform = "uppercase";
  sensor.style.color = sensorColor;

  const dot = document.createElement("span");
  dot.style.width = "6px";
  dot.style.height = "6px";
  dot.style.borderRadius = "999px";
  dot.style.background = sensorColor;
  dot.style.boxShadow = `0 0 10px ${sensorColor}`;
  sensor.appendChild(dot);
  sensor.appendChild(document.createTextNode(props.instrument || props.sensor.toUpperCase()));

  const conf = document.createElement("span");
  conf.textContent = props.confidenceClass ? `${props.confidenceClass} · ${props.confidence}` : `raw ${props.confidence}`;
  conf.style.fontFamily = MONO;
  conf.style.fontSize = "9.5px";
  conf.style.textTransform = "uppercase";
  conf.style.letterSpacing = "0.08em";
  conf.style.padding = "2px 5px";
  conf.style.borderRadius = "4px";
  conf.style.border = "1px solid rgba(34,48,74,0.9)";
  conf.style.color = props.confidenceClass === "high" ? "#40D6A0" : props.confidenceClass === "nominal" ? "#FF9D42" : "#91A2B9";

  head.appendChild(sensor);
  head.appendChild(conf);
  root.appendChild(head);

  const frpRow = document.createElement("div");
  frpRow.style.display = "flex";
  frpRow.style.alignItems = "baseline";
  frpRow.style.gap = "5px";
  frpRow.style.padding = "9px 0 6px";
  const frp = document.createElement("span");
  frp.textContent = fmt(props.frp, 1);
  frp.style.fontFamily = MONO;
  frp.style.fontSize = "22px";
  frp.style.lineHeight = "1";
  frp.style.color = props.frp && props.frp >= 100 ? MAP_COLORS.fire : "#F1F5FC";
  const unit = document.createElement("span");
  unit.textContent = "MW FRP";
  unit.style.fontFamily = MONO;
  unit.style.fontSize = "9.5px";
  unit.style.letterSpacing = "0.14em";
  unit.style.color = "#91A2B9";
  frpRow.appendChild(frp);
  frpRow.appendChild(unit);
  root.appendChild(frpRow);

  const rows = document.createElement("div");
  rows.appendChild(row("Satellite", props.satellite));
  rows.appendChild(row("Acquired", utcStamp(props.acqDate, props.acqTime, props.ts)));
  rows.appendChild(row("Confidence", props.confidencePct !== null ? `${props.confidence} (${Math.round(props.confidencePct)}%)` : props.confidence));
  rows.appendChild(row("Brightness", props.brightness !== null ? `${fmt(props.brightness, 1)} K` : "—"));
  rows.appendChild(row("Bright T31", props.brightT31 !== null ? `${fmt(props.brightT31, 1)} K` : "—"));
  rows.appendChild(row("Scan × track", `${fmt(props.scan, 2)} × ${fmt(props.track, 2)} km`));
  rows.appendChild(row("Day / night", props.daynight === "D" ? "Day" : props.daynight === "N" ? "Night" : "—"));
  rows.appendChild(row("Position", `${props.lat.toFixed(3)}, ${props.lon.toFixed(3)}`));
  rows.appendChild(row("Dataset", datasetLabel(props.source)));
  root.appendChild(rows);

  const id = document.createElement("p");
  id.textContent = props.id;
  id.style.margin = "7px 0 0";
  id.style.fontFamily = MONO;
  id.style.fontSize = "9px";
  id.style.color = "rgba(145,162,185,0.55)";
  id.style.wordBreak = "break-all";
  root.appendChild(id);

  if (onAsk) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Ask the Earth about this detection →";
    btn.style.marginTop = "10px";
    btn.style.width = "100%";
    btn.style.border = "1px solid rgba(57,200,242,0.4)";
    btn.style.background = "rgba(57,200,242,0.12)";
    btn.style.color = "#39C8F2";
    btn.style.borderRadius = "7px";
    btn.style.padding = "6px 8px";
    btn.style.fontSize = "11px";
    btn.style.fontFamily = MONO;
    btn.style.cursor = "pointer";
    btn.addEventListener("click", () => onAsk());
    root.appendChild(btn);
  }

  return root;
}
