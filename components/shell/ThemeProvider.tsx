"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  THEME_ATTRIBUTE,
  THEME_EVENT,
  THEME_PREF_ATTRIBUTE,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeMode,
} from "@/lib/theme";

const MEDIA_DARK = "(prefers-color-scheme: dark)";

export type { ThemeMode, ResolvedTheme };

export type ThemeContextValue = {
  /** The stored preference. */
  theme: ThemeMode;
  /** The palette actually applied to <html data-theme>. */
  resolved: ResolvedTheme;
  /** Persist + apply a new preference. */
  setTheme: (theme: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredTheme(): ThemeMode | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

function resolveTheme(theme: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === "system") return systemPrefersDark ? "dark" : "light";
  return theme;
}

function applyTheme(resolved: ResolvedTheme, theme: ThemeMode) {
  const root = document.documentElement;
  root.setAttribute(THEME_ATTRIBUTE, resolved);
  root.setAttribute(THEME_PREF_ATTRIBUTE, theme);
  // Keeps native widgets (scrollbars, form controls, selects) in the right mode.
  root.style.colorScheme = resolved;
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme, resolved } }));
}

/**
 * Mount high in the tree (e.g. inside `<body>` in app/layout.tsx, above AppShell).
 *
 * Default is light (white-first product); `system` and `dark` are opt-in.
 *
 * SSR safety: the initial state is always `"light"` — localStorage and
 * matchMedia are only read inside effects — so server and first client render agree.
 * The first paint is already correct because `THEME_INIT_SCRIPT` (lib/theme.ts) sets
 * `data-theme` in <head> before hydration; the provider then re-applies the same values
 * and keeps them in sync.
 */
export function ThemeProvider({
  children,
  defaultTheme = "light",
}: {
  children: ReactNode;
  defaultTheme?: ThemeMode;
}) {
  const [theme, setThemeState] = useState<ThemeMode>(defaultTheme);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);
  // Gate the write-back until the stored preference has been read, otherwise the
  // first commit would clobber a stored "light" with the SSR default.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(MEDIA_DARK);
    setSystemPrefersDark(media.matches);

    const stored = readStoredTheme();
    if (stored) setThemeState(stored);
    setHydrated(true);

    const onMediaChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setThemeState(isThemeMode(event.newValue) ? event.newValue : "light");
    };

    media.addEventListener?.("change", onMediaChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener?.("change", onMediaChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const resolved = resolveTheme(theme, systemPrefersDark);

  useEffect(() => {
    if (!hydrated) return;
    applyTheme(resolved, theme);
  }, [hydrated, resolved, theme]);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode / storage disabled — theme still applies for this session */
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme() must be used inside <ThemeProvider>.");
  return context;
}
