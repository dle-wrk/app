import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceDataChanged, bundleOf, changedKeys, needsFullReload, useDataChanged, useNewVersion, type NewVersionOptions } from './liveUpdates';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('which data changed', () => {
  it('lists the keys that moved, including new ones', () => {
    expect(changedKeys({ inventory: 3, clients: 1 }, { inventory: 4, clients: 1, bulk_pricing: 1 })).toEqual(['inventory', 'bulk_pricing']);
    expect(changedKeys({ inventory: 3 }, { inventory: 3 })).toEqual([]);
  });

  it("reloads everything unless only a section's own data changed", () => {
    expect(needsFullReload(['bulk_pricing'])).toBe(false);
    expect(needsFullReload(['bulk_pricing', 'inventory'])).toBe(true);
    expect(needsFullReload(['clients'])).toBe(true);
  });

  it("finds the app bundle in the server's page", () => {
    expect(bundleOf('<script type="module" crossorigin src="/assets/index-2mSgcA-O.js"></script>')).toBe('/assets/index-2mSgcA-O.js');
    expect(bundleOf('<html><body>no scripts</body></html>')).toBeNull();
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('useDataChanged', () => {
  it('calls back only for the keys asked for', async () => {
    const seen = vi.fn();
    const Probe = () => { useDataChanged(['bulk_pricing'], seen); return null; };
    await act(async () => { root.render(<Probe />); });

    await act(async () => { announceDataChanged(['clients']); });
    expect(seen).not.toHaveBeenCalled();
    await act(async () => { announceDataChanged(['inventory', 'bulk_pricing']); });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('useNewVersion', () => {
  let visibility: DocumentVisibilityState;
  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });
  const setVisibility = async (v: DocumentVisibilityState) => {
    visibility = v;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
  };

  function mount(options: NewVersionOptions) {
    const state = { ready: false };
    const Probe = () => { state.ready = useNewVersion(options).ready; return null; };
    return { state, render: () => act(async () => { root.render(<Probe />); }) };
  }

  it('notices a new deploy and reloads when the tab is hidden, not while someone is looking', async () => {
    vi.useFakeTimers();
    let latest = '/assets/index-old.js';
    const reload = vi.fn();
    const probe = mount({ intervalMs: 1000, loaded: '/assets/index-old.js', fetchLatest: async () => latest, reload });
    await probe.render();

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(probe.state.ready).toBe(false);

    latest = '/assets/index-new.js';
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(probe.state.ready).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    await setVisibility('hidden');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('checks as soon as the tab comes back into view', async () => {
    const fetchLatest = vi.fn(async () => '/assets/index-new.js');
    const reload = vi.fn();
    const probe = mount({ intervalMs: 3_600_000, loaded: '/assets/index-old.js', fetchLatest, reload });
    await probe.render();

    await setVisibility('visible');
    await act(async () => { await Promise.resolve(); });

    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(probe.state.ready).toBe(true);
  });

  it('does nothing under the dev server, where there is no bundle to compare', async () => {
    const fetchLatest = vi.fn(async () => '/assets/index-new.js');
    const probe = mount({ intervalMs: 10, loaded: null, fetchLatest });
    await probe.render();

    await setVisibility('visible');

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(probe.state.ready).toBe(false);
  });
});
