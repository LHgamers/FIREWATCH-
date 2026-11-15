import type { Config } from "tailwindcss";

/**
 * Colour tokens are declared as space-separated RGB triples in app/globals.css
 * (`--void: 8 13 24;`) and consumed here through `rgb(var(--token) / <alpha-value>)`.
 *
 * That keeps every existing opacity modifier working (`bg-panel/70`, `text-cyan/70`,
 * `border-line/80`, …) while letting `:root[data-theme="light"]` swap the palette
 * at runtime without shipping a second set of utility classes.
 */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: token("void"),
        base: token("base"),
        surface: token("surface"),
        panel: token("panel"),
        elevated: token("elevated"),
        line: token("line"),
        cyan: { DEFAULT: token("cyan"), dim: token("cyan-dim") },
        ember: { DEFAULT: token("ember"), fire: token("fire") },
        ok: token("ok"),
        ink: token("ink"),
        muted: token("muted"),
        violet: token("violet"),
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        // Theme-aware: dark keeps the restrained teal glow, light gets neutral paper shadows.
        panel: "var(--shadow-panel)",
        glow: "var(--shadow-glow)",
      },
      backgroundImage: {
        grid: "linear-gradient(var(--grid-stroke) 1px, transparent 1px), linear-gradient(90deg, var(--grid-stroke) 1px, transparent 1px)",
      },
      animation: {
        "fade-up": "fadeUp 0.6s cubic-bezier(0.16,1,0.3,1) both",
        shimmer: "shimmer 2.6s linear infinite",
        "pulse-soft": "pulseSoft 3.2s ease-in-out infinite",
      },
      keyframes: {
        fadeUp: { from: { opacity: "0", transform: "translateY(10px)" }, to: { opacity: "1", transform: "none" } },
        shimmer: { from: { backgroundPosition: "200% 0" }, to: { backgroundPosition: "-200% 0" } },
        pulseSoft: { "0%,100%": { opacity: "0.55" }, "50%": { opacity: "1" } },
      },
    },
  },
  plugins: [],
};
export default config;
