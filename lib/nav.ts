import {
  CalendarDays, FileText, LayoutDashboard, Map, Settings, Sparkles, TrendingUp, GitCompareArrows, Crosshair, Activity, BookOpen,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof Map;
  group: string;
  description: string;
  keywords: string[];
}

export const NAV: NavItem[] = [
  {
    href: "/",
    label: "Dashboard",
    icon: LayoutDashboard,
    group: "Primary",
    description: "Operational overview and current signal",
    keywords: ["home", "overview", "kpi", "live", "dashboard"],
  },
  {
    href: "/map",
    label: "Fire Map",
    icon: Map,
    group: "Primary",
    description: "Satellite detections over the AOI",
    keywords: ["geographic", "map", "detections", "hotspot", "location"],
  },
  {
    href: "/report",
    label: "Report",
    icon: FileText,
    group: "Primary",
    description: "Use Case 1 scientific report and evidence",
    keywords: ["report", "scientific", "use case", "findings", "export", "print", "citation"],
  },
  {
    href: "/status",
    label: "Status",
    icon: Activity,
    group: "Primary",
    description: "Platform, engine, and data health",
    keywords: ["status", "health", "engine", "freshness", "coverage", "system"],
  },
  {
    href: "/methodology",
    label: "Methodology",
    icon: BookOpen,
    group: "Primary",
    description: "Data sources, formulas, and limits",
    keywords: ["methodology", "science", "frp", "modis", "viirs", "uncertainty", "limitations"],
  },
  {
    href: "/calendar",
    label: "Burning Calendar",
    icon: CalendarDays,
    group: "Analysis",
    description: "Historical daily activity pattern",
    keywords: ["calendar", "daily", "burning", "days", "month"],
  },
  {
    href: "/history",
    label: "Historical Explorer",
    icon: TrendingUp,
    group: "Analysis",
    description: "Trend, baseline, and anomaly context",
    keywords: ["trend", "history", "anomaly", "baseline", "timeseries"],
  },
  {
    href: "/ask",
    label: "Ask the Earth",
    icon: Crosshair,
    group: "Intelligence",
    description: "Select a place and inspect evidence",
    keywords: ["ask", "earth", "place", "aoi", "globe", "click", "region"],
  },
  {
    href: "/intelligence",
    label: "Intelligence",
    icon: Sparkles,
    group: "Intelligence",
    description: "Grounded assistant and evidence views",
    keywords: ["intelligence", "analyst", "explain", "assistant", "chat", "ai"],
  },
  {
    href: "/harmonization",
    label: "Harmonization",
    icon: GitCompareArrows,
    group: "Intelligence",
    description: "Cross-sensor FRP comparison",
    keywords: ["harmonization", "modis", "viirs", "frp", "sensor", "pair"],
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    group: "System",
    description: "About, credits, and preferences",
    keywords: ["settings", "about", "credits", "sources", "theme"],
  },
];

export const NAV_GROUPS = ["Primary", "Analysis", "Intelligence", "System"];

export function navForPath(pathname: string): NavItem {
  if (pathname === "/") return NAV[0];
  if (pathname === "/reports") return NAV.find((n) => n.href === "/report") ?? NAV[0];
  return NAV.find((n) => n.href !== "/" && pathname.startsWith(n.href)) ?? NAV[0];
}
