/** Client-safe region catalogue (mirrors the engine's /api/meta payload). */
export interface RegionDef {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  kind: string;
  note: string;
}

export const REGIONS: RegionDef[] = [
  { id: "global", name: "Global", bbox: [-180, -60, 180, 75], kind: "global", note: "All land between 60°S and 75°N." },
  { id: "amazon", name: "Amazon Basin", bbox: [-74, -14, -44, 5], kind: "region", note: "Humid tropical deforestation frontier." },
  { id: "cerrado", name: "Cerrado", bbox: [-60, -24, -42, -5], kind: "region", note: "Brazilian savanna, strongly seasonal." },
  { id: "congo", name: "Congo Basin", bbox: [10, -8, 32, 5], kind: "region", note: "Central African forest–savanna mosaic." },
  { id: "west-africa", name: "West African Savanna", bbox: [-18, 4, 12, 17], kind: "region", note: "Sudano-Sahelian dry-season fires." },
  { id: "southeast-asia", name: "Maritime SE Asia", bbox: [95, -10, 141, 12], kind: "region", note: "Peatland and slash-and-burn regimes." },
  { id: "boreal-na", name: "Boreal North America", bbox: [-170, 50, -55, 72], kind: "region", note: "Boreal crown-fire regime." },
  { id: "siberia", name: "Siberia", bbox: [60, 50, 180, 75], kind: "region", note: "Remote boreal and tundra fires." },
  { id: "mediterranean", name: "Mediterranean", bbox: [-10, 30, 40, 46], kind: "region", note: "Summer-dry shrubland and pine." },
  { id: "australia", name: "Australia", bbox: [112, -45, 154, -10], kind: "region", note: "Tropical north, temperate south-east." },
  { id: "california", name: "California", bbox: [-125, 32, -114, 42], kind: "region", note: "Autumn wind-driven fire regime." },
  { id: "chile", name: "Central Chile", bbox: [-76, -42, -69, -28], kind: "region", note: "Andean Mediterranean zone." },
];

export const REGION_MAP: Record<string, RegionDef> = Object.fromEntries(REGIONS.map((r) => [r.id, r]));
