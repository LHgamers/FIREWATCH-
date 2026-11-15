/** Log-scaled heat ramp shared by the daily and monthly activity calendars. */
export function heatColor(value: number, max: number): string {
  if (value <= 0) return "transparent";
  const t = Math.log1p(value) / Math.log1p(Math.max(1, max));
  const stops: [number, [number, number, number]][] = [
    [0.0, [30, 58, 95]],
    [0.3, [30, 124, 155]],
    [0.55, [57, 200, 242]],
    [0.78, [255, 157, 66]],
    [1.0, [255, 99, 61]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const k = (t - lo[0]) / span;
  const rgb = lo[1].map((c, i) => Math.round(c + (hi[1][i] - c) * k));
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
}
