// Live prefix picker for stock codes. Renders a small <select> that
// lists every 3-letter prefix already used in inventory (ENC, LED,
// RES, etc.) with each option showing the next-available number for
// that family (e.g. "ENC → ENC-004 (127)"). Picking one calls
// onPick(nextCode) so the parent input can fill itself in.
//
// The list is fed by /api/items/code-prefixes and refreshed either on
// mount or whenever `refreshKey` changes — parents typically pass the
// modal's `open` boolean or their `items.length` here so the list
// re-fetches when a colleague adds a new prefix.
//
// Shared with Add SKU, BOM line add, and any other flow where a fresh
// internal stock code needs to be minted next-available. Manual entry
// still works — the picker never blocks typing.

import React, { useEffect, useState } from 'react';

export interface CodePrefix {
  prefix: string;
  count: number;
  nextNumber: number;
  nextCode: string;
}

interface Props {
  onPick: (nextCode: string, prefix: CodePrefix) => void;
  /** Any value the parent wants to trigger a re-fetch on. Modal open
   * flag or inventory length both work well here. */
  refreshKey?: unknown;
  /** Passed straight to the underlying <select> so callers can size /
   * theme the picker to fit their form. */
  className?: string;
  /** Placeholder shown as the first (disabled) option. */
  placeholder?: string;
  /** When true, the picker fetches once on mount and then only on
   * refreshKey change (default). When false, it never fetches — used
   * when the parent has already fetched the list itself. */
  autoFetch?: boolean;
  /** Externally supplied list — skips the internal fetch entirely. */
  prefixes?: CodePrefix[];
}

export function StockCodePrefixPicker({
  onPick,
  refreshKey,
  className = 'bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none font-mono text-xs',
  placeholder = '— Prefix… —',
  autoFetch = true,
  prefixes: prefixesProp,
}: Props) {
  const [prefixes, setPrefixes] = useState<CodePrefix[]>(prefixesProp || []);

  useEffect(() => {
    if (!autoFetch || prefixesProp) return;
    let cancelled = false;
    fetch('/api/items/code-prefixes')
      .then(r => r.ok ? r.json() : [])
      .then(rows => { if (!cancelled && Array.isArray(rows)) setPrefixes(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [autoFetch, prefixesProp, refreshKey]);

  useEffect(() => {
    if (prefixesProp) setPrefixes(prefixesProp);
  }, [prefixesProp]);

  return (
    <select
      value=""
      onChange={(e) => {
        const chosen = prefixes.find(p => p.prefix === e.target.value);
        if (chosen) onPick(chosen.nextCode, chosen);
      }}
      title={`Pick a family prefix — the next available number for that family fills the input. ${prefixes.length} prefixes in use.`}
      className={className}
    >
      <option value="">{placeholder}</option>
      {prefixes.map(p => (
        <option key={p.prefix} value={p.prefix}>
          {p.prefix} → {p.nextCode} ({p.count})
        </option>
      ))}
    </select>
  );
}
