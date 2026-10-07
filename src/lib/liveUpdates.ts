// Keeping an open page up to date without anyone pressing refresh.
//
// 1. Data. App polls GET /api/data-versions every 25 seconds (and as soon as
//    the tab comes back into view). When a counter moved, it announces the
//    changed keys with announceDataChanged; App reloads its shared data, and
//    a section with its own lists (Bulk Pricing, Part Numbers) reloads them
//    through useDataChanged. Keys that only such sections show (VIEW_ONLY_KEYS)
//    don't make App reload everything.
//
// 2. New versions. After a deploy, an open tab keeps running the old code
//    until it is reloaded. useNewVersion compares the app bundle the page
//    loaded with the one the server now serves, every minute and whenever the
//    tab comes back into view. When they differ it reports `ready`, and
//    reloads the page by itself the next time the tab is hidden (the person
//    isn't looking, so nothing they are typing is lost). App also shows a
//    "Reload now" banner, and reloads straight away on the sign-in screen.

import { useEffect, useRef, useState } from 'react';

export const DATA_CHANGED_EVENT = 'tracklab:data-changed';

/** Data-version keys that only sections with their own lists show. */
export const VIEW_ONLY_KEYS = ['bulk_pricing'];

/** Whether changed keys need App's full reload, or only the sections listening for them. */
export function needsFullReload(changedKeys: string[]): boolean {
  return changedKeys.some((k) => !VIEW_ONLY_KEYS.includes(k));
}

/** Which keys moved between two snapshots of /api/data-versions. */
export function changedKeys(prev: Record<string, number>, next: Record<string, number>): string[] {
  return [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((k) => (next[k] ?? 0) !== (prev[k] ?? 0));
}

export function announceDataChanged(keys: string[]): void {
  if (keys.length) window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT, { detail: { keys } }));
}

/** Calls `onChange` when any of `keys` changed (someone else saved something). */
export function useDataChanged(keys: string[], onChange: () => void): void {
  const callback = useRef(onChange);
  callback.current = onChange;
  const keyList = keys.join(',');
  useEffect(() => {
    const wanted = keyList.split(',');
    const handler = (e: Event) => {
      const changed: string[] = (e as CustomEvent).detail?.keys ?? [];
      if (changed.some((k) => wanted.includes(k))) callback.current();
    };
    window.addEventListener(DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, handler);
  }, [keyList]);
}

/** The app bundle a page of HTML loads (Vite's /assets/index-<hash>.js), or null. */
export function bundleOf(html: string): string | null {
  const m = html.match(/<script\b[^>]*\bsrc="([^"]*\/assets\/[^"]+\.js)"/i);
  return m ? m[1] : null;
}

/** The bundle this page is running; null under the dev server, which has none. */
export function loadedBundle(): string | null {
  const script = document.querySelector('script[type="module"][src*="/assets/"]');
  return script?.getAttribute('src') ?? null;
}

export interface NewVersionOptions {
  intervalMs?: number;
  /** For tests; reloads the page. */
  reload?: () => void;
  /** For tests; what the server serves now. */
  fetchLatest?: () => Promise<string | null>;
  /** For tests; the bundle this page runs. */
  loaded?: string | null;
}

const fetchLatestBundle = async (): Promise<string | null> => {
  const res = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } });
  return res.ok ? bundleOf(await res.text()) : null;
};

/** Whether a newer version of the app is deployed; reloads by itself when the tab is hidden. */
export function useNewVersion(options: NewVersionOptions = {}): { ready: boolean; reload: () => void } {
  const { intervalMs = 60_000, reload = () => window.location.reload(), fetchLatest = fetchLatestBundle } = options;
  const [ready, setReady] = useState(false);
  const loaded = useRef<string | null | undefined>(options.loaded);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const fetchRef = useRef(fetchLatest);
  fetchRef.current = fetchLatest;

  useEffect(() => {
    if (loaded.current === undefined) loaded.current = loadedBundle();
    if (!loaded.current) return; // the dev server: nothing to compare
    let stopped = false;
    const check = async () => {
      try {
        const latest = await fetchRef.current();
        if (!stopped && latest && latest !== loaded.current) setReady(true);
      } catch { /* offline or restarting: try again next time */ }
    };
    const id = window.setInterval(check, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; window.clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [intervalMs]);

  useEffect(() => {
    if (!ready) return;
    const reloadIfHidden = () => { if (document.visibilityState === 'hidden') reloadRef.current(); };
    reloadIfHidden();
    document.addEventListener('visibilitychange', reloadIfHidden);
    return () => document.removeEventListener('visibilitychange', reloadIfHidden);
  }, [ready]);

  return { ready, reload: () => reloadRef.current() };
}
