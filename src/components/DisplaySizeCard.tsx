// Profile > Display size: how big the whole app is drawn, saved to the
// signed-in person's account so it's the same on every PC (../lib/displaySize).

import React, { useEffect, useState } from 'react';
import { Monitor, Check } from 'lucide-react';
import { DISPLAY_SIZES, applyDisplaySize, autoZoom, isDisplaySize, rememberedDisplaySize, type DisplaySize } from '../lib/displaySize';

export default function DisplaySizeCard({ onShowNotification }: { onShowNotification?: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void }) {
  const [size, setSize] = useState<DisplaySize>(() => rememberedDisplaySize());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me/preferences').then((r) => (r.ok ? r.json() : null)).then((p) => {
      if (!cancelled && p && isDisplaySize(p.displaySize)) setSize(p.displaySize);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const choose = async (next: DisplaySize) => {
    setSize(next);
    applyDisplaySize(next);
    setSaving(true);
    try {
      const res = await fetch('/api/me/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displaySize: next }) });
      if (!res.ok) throw new Error();
      onShowNotification?.('Display size saved to your account: it applies on any PC you sign in on.', 'SUCCESS');
    } catch {
      onShowNotification?.('Display size changed here, but it could not be saved to your account.', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  const autoPct = Math.round(autoZoom(typeof window !== 'undefined' ? window.screen?.width ?? 0 : 0) * 100);

  return (
    <div className="bg-surface-container border border-outline-variant/70 p-5 rounded-xl shadow-sm space-y-3" data-testid="display-size">
      <div>
        <h4 className="text-sm text-on-surface font-bold flex items-center gap-2"><Monitor className="w-4 h-4 text-primary" /> Display size</h4>
        <p className="text-on-surface-variant text-[11px] mt-0.5">
          How big the whole app is drawn: text, tables and buttons together. Saved to your account, so it's the same on every PC and browser you sign in on.
          Set the browser's own zoom back to 100% (Ctrl+0) so the two don't add up.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2" role="radiogroup" aria-label="Display size">
        {DISPLAY_SIZES.map((s) => {
          const on = size === s.key;
          return (
            <button key={s.key} type="button" role="radio" aria-checked={on} disabled={saving} onClick={() => void choose(s.key)}
              className={`text-left rounded-lg border p-2 transition-colors ${on ? 'border-primary bg-primary/10' : 'border-outline-variant hover:border-primary/50'}`}>
              <span className="flex items-center justify-between text-xs font-bold text-on-surface">
                {s.label}{s.key === 'auto' ? ` (${autoPct}% here)` : ''}
                {on && <Check className="w-3.5 h-3.5 text-primary" />}
              </span>
              <span className="block text-[10px] text-outline mt-0.5">{s.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
