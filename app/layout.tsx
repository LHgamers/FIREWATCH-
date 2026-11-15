import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./map.css";
import { AppShell } from "@/components/shell/AppShell";
import { FiltersProvider } from "@/components/shell/FiltersProvider";
import { IntroGate } from "@/components/intro/IntroGate";
import { ThemeProvider } from "@/components/shell/ThemeProvider";
import { MotionRoot, PageTransition } from "@/components/motion";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "FIREWATCH AI — Satellite Fire Intelligence", template: "%s · FIREWATCH AI" },
  description:
    "Satellite fire intelligence: harmonized MODIS and VIIRS observations, burning-activity calendars and evidence-grounded analysis. By LH Studios.",
  applicationName: "FIREWATCH AI",
  authors: [{ name: "LH Studios" }],
  openGraph: {
    title: "FIREWATCH AI",
    description: "See the patterns. Understand the fires. Protect the future.",
    type: "website",
  },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#080D18" },
    { media: "(prefers-color-scheme: light)", color: "#F5F7FA" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${mono.variable}`}
      data-theme="light"
      data-theme-pref="light"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <MotionRoot />
          <FiltersProvider>
            <IntroGate />
            <AppShell>
              <PageTransition>{children}</PageTransition>
            </AppShell>
          </FiltersProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
