// Type-to-search combobox for Item.category. Suggestions come from the
// canonical ITEM_CATEGORIES list plus any extras the parent passes in
// (typically distinct categories already used on live inventory rows,
// so a legacy category like "Micro-ctrl" that never made it into the
// canonical list still shows up as a suggestion).
//
// If the operator types text that doesn't match anything, the top
// row of the dropdown becomes an "Add ..." action — picking it just
// sets value to the typed string. The parent's save path is what
// materialises that as a new category (either by writing it to the
// row directly or, in Edit mode, adding it to a local categories
// list first). This component intentionally doesn't own persistence:
// categories aren't a real entity, they're just strings on items.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ChevronDown } from 'lucide-react';
import { ITEM_CATEGORIES } from '../lib/itemCategories';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Extra categories to show alongside the canonical list — typically
   * distinct categories from the current inventory so legacy values
   * remain pickable. Deduped case-insensitively. */
  extraOptions?: string[];
  /** Style override for the input. Default matches the Add SKU form's
   * dark-container look. */
  className?: string;
  placeholder?: string;
  /** Render inside a form? Set false to opt out of the required attr
   * for use cases like inline filters. Default true. */
  required?: boolean;
  id?: string;
}

export const CategoryCombobox: React.FC<Props> = ({
  value,
  onChange,
  extraOptions,
  className = 'bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs',
  placeholder = 'Type a category or pick from the list',
  required = false,
  id,
}) => {
  const [query, setQuery] = useState<string>(value);
  const [open, setOpen] = useState<boolean>(false);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep the input in sync when parent updates value (e.g. reset).
  useEffect(() => { setQuery(value); }, [value]);

  const options = useMemo(() => {
    // De-duplicate case-insensitively but keep the canonical casing.
    const seen = new Map<string, string>();
    for (const c of ITEM_CATEGORIES) seen.set(c.toLowerCase(), c);
    for (const c of (extraOptions || [])) {
      const key = String(c || '').trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, c);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [extraOptions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(c => c.toLowerCase().includes(q));
  }, [options, query]);

  const trimmedQ = query.trim();
  const exactMatch = options.some(c => c.toLowerCase() === trimmedQ.toLowerCase());
  const showAdd = !!trimmedQ && !exactMatch;

  // Reset the active row when the filter changes so keyboard nav
  // doesn't point off the end of the list.
  useEffect(() => { setActiveIdx(0); }, [query, open]);

  // Close on outside click. Keep pointer-down handling out of blur so
  // clicking an option doesn't lose it to the input's blur first.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const commit = (next: string) => {
    onChange(next);
    setQuery(next);
    setOpen(false);
  };

  // Flat list of interactive rows so keyboard nav treats "Add ..." and
  // the filtered categories uniformly.
  const rows: Array<{ kind: 'add' | 'option'; value: string }> = [
    ...(showAdd ? [{ kind: 'add' as const, value: trimmedQ }] : []),
    ...filtered.map(c => ({ kind: 'option' as const, value: c })),
  ];

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIdx(i => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && rows[activeIdx]) {
        e.preventDefault();
        commit(rows[activeIdx].value);
      } else if (trimmedQ) {
        // Enter with no dropdown open (or empty rows): commit typed text.
        e.preventDefault();
        commit(trimmedQ);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex items-center gap-1">
        <input
          id={id}
          type="text"
          className={`flex-1 ${className}`}
          value={query}
          placeholder={placeholder}
          required={required}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          autoComplete="off"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen(o => !o)}
          className="px-1.5 py-2 rounded text-outline hover:text-on-surface hover:bg-surface-container-high transition-colors"
          aria-label={open ? 'Close suggestions' : 'Open suggestions'}
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && rows.length > 0 && (
        <div
          className="absolute z-50 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-outline-variant/60 bg-surface-container-high shadow-lg"
          role="listbox"
        >
          {rows.map((r, idx) => {
            const active = idx === activeIdx;
            const cls = `w-full text-left px-3 py-1.5 text-xs cursor-pointer flex items-center gap-1.5 ${
              active ? 'bg-primary/15 text-primary' : 'hover:bg-surface-container-highest text-on-surface'
            }`;
            if (r.kind === 'add') {
              return (
                <button
                  key="add"
                  type="button"
                  className={cls}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onMouseDown={(e) => { e.preventDefault(); commit(r.value); }}
                >
                  <Plus className="w-3 h-3 shrink-0" />
                  <span className="text-outline">Add</span>
                  <span className="font-mono font-bold">"{r.value}"</span>
                  <span className="text-outline">as new category</span>
                </button>
              );
            }
            return (
              <button
                key={r.value}
                type="button"
                className={cls}
                onMouseEnter={() => setActiveIdx(idx)}
                onMouseDown={(e) => { e.preventDefault(); commit(r.value); }}
              >
                {r.value}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
