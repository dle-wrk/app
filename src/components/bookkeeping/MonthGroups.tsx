import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { groupByMonth, MonthGroup } from '../../lib/groupByMonth';

// Collapsible month sections for document tables (bills, purchase orders).
// The newest month, and any month holding a row that still needs action
// (`needsAction`), start open; clicking a month's header overrides that.
export function useMonthGroups<T>(rows: T[], dateOf: (row: T) => string | null | undefined, needsAction: (row: T) => boolean) {
  const months = useMemo(() => groupByMonth(rows, dateOf), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const isOpen = (g: MonthGroup<T>, i: number) => override[g.key] ?? (i === 0 || g.items.some(needsAction));
  const toggle = (g: MonthGroup<T>, i: number) => setOverride(m => ({ ...m, [g.key]: !isOpen(g, i) }));
  const setAll = (open: boolean) => setOverride(Object.fromEntries(months.map(g => [g.key, open])));
  return { months, isOpen, toggle, setAll };
}

interface MonthHeaderRowProps {
  label: string;
  count: number;
  noun: [string, string];       // ['bill', 'bills']
  open: boolean;
  onToggle: () => void;
  labelCols: number;            // columns the month name spans
  amounts: React.ReactNode[];   // one right-aligned cell each, under the money columns
  trailingCols: number;         // columns after the amounts
  bulk?: { expand: () => void; collapse: () => void }; // Expand all / Collapse all, on the first header
}

export const MonthHeaderRow: React.FC<MonthHeaderRowProps> = ({ label, count, noun, open, onToggle, labelCols, amounts, trailingCols, bulk }) => (
  <tr className="bg-surface-container-high/40 hover:bg-surface-container-high cursor-pointer select-none" onClick={onToggle} aria-expanded={open}>
    <td colSpan={labelCols} className="px-lg py-2 font-bold text-[11px] uppercase tracking-wide">
      <span className="inline-flex items-center gap-1.5">
        {open ? <ChevronDown className="w-3.5 h-3.5 text-primary" /> : <ChevronRight className="w-3.5 h-3.5 text-outline" />}
        {label}
        <span className="ml-1 px-1.5 py-0.5 rounded bg-surface-container text-[10px] font-mono text-on-surface-variant normal-case">{count} {count === 1 ? noun[0] : noun[1]}</span>
      </span>
    </td>
    {amounts.map((a, i) => (
      <td key={i} className={`px-lg py-2 text-right font-mono text-[11px] ${i === 0 ? 'text-on-surface-variant' : 'font-bold'}`}>{a}</td>
    ))}
    <td colSpan={trailingCols} className="px-lg py-2 text-right">
      {bulk && (
        <span className="text-[10px] text-outline font-normal">
          <button className="hover:text-primary" onClick={(e) => { e.stopPropagation(); bulk.expand(); }}>Expand all</button>
          {' · '}
          <button className="hover:text-primary" onClick={(e) => { e.stopPropagation(); bulk.collapse(); }}>Collapse all</button>
        </span>
      )}
    </td>
  </tr>
);

/** Sum of a money field when every row shares one currency; null when they mix (no meaningful total). */
export function monthSum<T extends { currency?: string | null }>(rows: T[], amount: (row: T) => number): { sum: number; currency: string } | null {
  const currencies = new Set(rows.map(r => r.currency || 'ZAR'));
  if (currencies.size !== 1) return null;
  return { sum: rows.reduce((s, r) => s + (Number(amount(r)) || 0), 0), currency: [...currencies][0] };
}
