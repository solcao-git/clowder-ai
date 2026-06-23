/*
 * F056 ThemeApplier — bridges the theme store to next-themes + CSS injection
 *
 * Subscribes to the theme store and:
 * 1. Sets `data-theme` via next-themes when the active theme's base changes
 * 2. Injects CSS overrides from the active theme's params
 *
 * Must live inside <ThemeProvider> (next-themes context).
 */
'use client';

import { useEffect, useRef } from 'react';
import { useCafeTheme } from '@/hooks/useCafeTheme';
import { applyThemeCSS, getActiveTheme, restoreFromServer, useThemeStore } from '@/stores/themeStore';

export function ThemeApplier() {
  const { theme, setTheme } = useCafeTheme();
  const active = useThemeStore((s) => getActiveTheme(s));
  const recoveryAttempted = useRef(false);

  /* On mount: if localStorage was empty, try recovering from server */
  useEffect(() => {
    if (recoveryAttempted.current) return;
    recoveryAttempted.current = true;
    let hasLocal = false;
    try {
      hasLocal = typeof window !== 'undefined' && !!localStorage.getItem('cat-cafe:themes');
    } catch {
      /* localStorage denied (sandboxed / private context) — treat as empty */
    }
    if (hasLocal) return;
    restoreFromServer().then((restored) => {
      if (restored) window.location.reload(); // reload to re-initialize store from recovered data
    });
  }, []);

  /* Sync base mode to next-themes (manages data-theme attribute on <html>) */
  useEffect(() => {
    if (theme === active.base) return;
    setTheme(active.base);
  }, [active.base, setTheme, theme]);

  /* Sync preset id → data-preset attribute (decor layer hook for welkin-moon etc.) */
  useEffect(() => {
    const root = document.documentElement;
    if (active.id === 'welkin-moon') {
      root.dataset.preset = 'welkin-moon';
    } else {
      delete root.dataset.preset;
    }
  }, [active.id]);

  /* Inject CSS overrides for the active theme's OKLCH params */
  useEffect(() => {
    applyThemeCSS(active.params);
  }, [active.params]);

  return null;
}
