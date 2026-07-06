/**
 * F056 — Centralized cat & co-creator fallback colors (single source of truth).
 *
 * These hex values are JS-level fallbacks for when cat/co-creator config hasn't
 * loaded yet. They feed JS color computation (hexToOklch, inline style derivation)
 * — CSS tokens can't serve this role because the values must be manipulable in JS.
 *
 * Cat persona CSS tokens (--color-{catId}-*) are injected dynamically by
 * CatHueInjector from the live cat catalog. These fallbacks are the safety net
 * for pre-load, SSR, and edge cases where the catalog hasn't arrived.
 *
 * Truth source: cat-persona-tokens.css (cocreator hue/chroma) + cat-template.json.
 */

export interface CatColorPair {
  primary: string;
  secondary: string;
}

/** Cat persona fallback colors keyed by catId.
 * Values mirror cat-template.json defaults — update both when adding a new cat. */
export const CAT_COLORS: Record<string, CatColorPair> = {
  opus: { primary: '#9B7EBD', secondary: '#E8DFF5' },
  codex: { primary: '#5B8C5A', secondary: '#D4E6D3' },
  gemini: { primary: '#5B9BD5', secondary: '#D6E9F8' },
  kimi: { primary: '#4B5563', secondary: '#E5E7EB' },
  // Genshin-named catIds (catalog uses these names; mirror their color values
  // so story-data / SSR can resolve CAT_COLORS.nahida etc. without crashing).
  nahida: { primary: '#a5c83b', secondary: '#E8F5D8' },
  zhongli: { primary: '#cfa726', secondary: '#FAF0D8' },
  mavuika: { primary: '#ef4035', secondary: '#FDE0DC' },
  venti: { primary: '#7ec8c8', secondary: '#E0F5F5' },
  raiden: { primary: '#a855f7', secondary: '#EDE0F9' },
  furina: { primary: '#1f9cdb', secondary: '#D6EEF8' },
  tighnari: { primary: '#4ECDC4', secondary: '#E8FFF9' },
  qiqi: { primary: '#7C5CFC', secondary: '#EDE8FF' },
};

/** Fallback when catId is unknown or color data is missing entirely. */
export const UNKNOWN_CAT_COLOR: CatColorPair = { primary: '#9B7EBD', secondary: '#E8DFF5' };

/** Neutral gray for status dots when no cat color is available (PlanBoard, etc.). */
export const NEUTRAL_DOT_COLOR = '#9CA3AF';

/** Co-creator (co-creator) default colors — matches cat-persona-tokens.css hue=40 chroma=0.13. */
export const CO_CREATOR_COLOR: CatColorPair = { primary: '#D4A76A', secondary: '#FFF8F0' };

/** Co-creator @mention highlight (warm gold, visually distinct from bubble primary). */
export const CO_CREATOR_MENTION_COLOR = '#F5A623';

/** HTML <meta name="theme-color"> — brand accent for mobile browser chrome. */
export const META_THEME_COLOR = '#E29578';

/** Default new-label color for ThreadLabelPicker initial state. */
export const DEFAULT_LABEL_COLOR = '#5B8C5A';

/** Group mention accent (used by @thread / @all input options). */
export const GROUP_MENTION_COLOR = '#6B7280';

/* ── Helpers ── */

/** Get cat primary color by catId, falling back to UNKNOWN_CAT_COLOR. */
export function catPrimary(catId: string): string {
  return CAT_COLORS[catId]?.primary ?? UNKNOWN_CAT_COLOR.primary;
}

/** Get full cat color pair by catId, falling back to UNKNOWN_CAT_COLOR. */
export function catColor(catId: string): CatColorPair {
  return CAT_COLORS[catId] ?? UNKNOWN_CAT_COLOR;
}
