// Display size: the whole app scaled by one factor (CSS `zoom` on <html>,
// through the --app-zoom variable; see index.css, where screen-height sizes
// are divided by it so full-height layouts still fill the window). Chosen per
// person and saved to their account (GET/PUT /api/me/preferences), so it is
// the same on every PC; the last choice is also kept in this browser so the
// app opens at the right size before the account is read.

export const DISPLAY_SIZE_KEYS = ['auto', 'compact', 'standard', 'large', 'xlarge'] as const;
export type DisplaySize = typeof DISPLAY_SIZE_KEYS[number];

export const DISPLAY_SIZES: Array<{ key: DisplaySize; label: string; zoom: number | null; hint: string }> = [
  { key: 'auto', label: 'Auto', zoom: null, hint: 'Fits this screen: smaller on laptops with Windows scaling, 100% on large monitors' },
  { key: 'compact', label: 'Compact', zoom: 0.85, hint: '85%: more on screen' },
  { key: 'standard', label: 'Standard', zoom: 1, hint: '100%' },
  { key: 'large', label: 'Large', zoom: 1.15, hint: '115%: easier to read' },
  { key: 'xlarge', label: 'Extra large', zoom: 1.3, hint: '130%' },
];

export const DEFAULT_DISPLAY_SIZE: DisplaySize = 'standard';
const STORAGE_KEY = 'displaySize';

/**
 * Auto: the app is laid out for a screen about 1,600 points wide. A laptop
 * at 150% Windows scaling is 1,280 points wide (1920 / 1.5), so everything is
 * shrunk to fit as it would on a 100% monitor; never enlarged, never below 80%.
 */
export function autoZoom(screenWidth: number): number {
  if (!(screenWidth > 0)) return 1;
  const z = Math.round((screenWidth / 1600) * 20) / 20; // to the nearest 5%
  return Math.min(1, Math.max(0.8, z));
}

export const isDisplaySize = (v: unknown): v is DisplaySize => typeof v === 'string' && (DISPLAY_SIZE_KEYS as readonly string[]).includes(v);

export function zoomFor(size: DisplaySize, screenWidth: number): number {
  return DISPLAY_SIZES.find((s) => s.key === size)?.zoom ?? autoZoom(screenWidth);
}

/** Scales the app now, and remembers the choice in this browser. */
export function applyDisplaySize(size: DisplaySize, win: Window = window): number {
  const zoom = zoomFor(size, win.screen?.width ?? 0);
  win.document.documentElement.style.setProperty('--app-zoom', String(zoom));
  try { win.localStorage.setItem(STORAGE_KEY, size); } catch { /* private window */ }
  return zoom;
}

/** The size last used in this browser, for opening at the right size. */
export function rememberedDisplaySize(win: Window = window): DisplaySize {
  try {
    const v = win.localStorage.getItem(STORAGE_KEY);
    return isDisplaySize(v) ? v : DEFAULT_DISPLAY_SIZE;
  } catch {
    return DEFAULT_DISPLAY_SIZE;
  }
}
