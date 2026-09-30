// "Needs attention today" strip — the dashboard's action-oriented header.
//
// Rationale: the dashboard previously showed passive counts (Total items,
// Low stock, Critical shortages). Useful for a status glance, but it
// never told the user WHAT TO DO NEXT. This strip fills that gap by
// surfacing five concrete, click-through actions:
//
//   • Quotations awaiting reply
//   • Sales orders with backorders
//   • Overdue invoices (past dueDate, still owing)
//   • Bills due this week (AWAITING_PAYMENT with dueDate ≤ +7 days)
//   • Critical low-stock parts (already computed by App)
//
// Each card is a button that navigates directly to the filtered view.
// A card with zero actionable items still renders (as a muted "clear"
// card) so the layout doesn't shift as data changes.
//
// Data sourcing: fetches its own inputs (client_orders, invoices, bills,
// reservation summary) rather than requiring App to plumb them through
// as new props. Refreshed every 60s so an admin's bank rec or a new
// quotation propagates without a manual reload.

import React, { useEffect, useState } from 'react';
import { FileText, AlertTriangle, Receipt, PackageX, CalendarClock, CheckCircle2, ArrowRight } from 'lucide-react';
import { apiGet } from '../bookkeeping/shared';
import { fmtCurrency } from '../../lib/formatMoney';

export type NavigateTarget =
  | { view: 'bookkeeping'; section?: string; subSection?: string; statusFilter?: string }
  | { view: 'inventory' | 'search'; focusQuery?: string };

interface NeedsAttentionStripProps {
  criticalCount: number;
  onNavigate: (t: NavigateTarget) => void;
}

type Signals = {
  loading: boolean;
  quotationsOpen: number;
  quotationsValue: number;
  backorderCount: number;
  overdueCount: number;
  overdueValue: number;
  billsDueSoon: number;
  billsDueValue: number;
};

const EMPTY: Signals = {
  loading: true,
  quotationsOpen: 0,
  quotationsValue: 0,
  backorderCount: 0,
  overdueCount: 0,
  overdueValue: 0,
  billsDueSoon: 0,
  billsDueValue: 0,
};

export const NeedsAttentionStrip: React.FC<NeedsAttentionStripProps> = ({ criticalCount, onNavigate }) => {
  const [s, setS] = useState<Signals>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // Everything below is best-effort: a failing endpoint zeroes just
      // its own signal, so a partial outage doesn't blank the whole strip.
      const [orders, invoices, bills, resSummary] = await Promise.all([
        apiGet('/api/client-orders').catch(() => []),
        apiGet('/api/invoices').catch(() => []),
        apiGet('/api/bills').catch(() => []),
        apiGet('/api/client-order-reservations/summary').catch(() => []),
      ]);
      if (cancelled) return;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const in7days = new Date(today);
      in7days.setDate(in7days.getDate() + 7);

      const quotations = (orders || []).filter((o: any) => o.status === 'QUOTATION');

      const overdue = (invoices || []).filter((i: any) => {
        if (['DRAFT', 'VOID', 'PAID'].includes(i.status)) return false;
        if (!(i.balanceDue > 0)) return false;
        if (!i.dueDate) return false;
        return new Date(i.dueDate) < today;
      });

      const billsDue = (bills || []).filter((b: any) => {
        // AWAITING_PAYMENT / OVERDUE / PARTIAL — anything still owing that
        // hasn't been fully settled. Void/paid/draft are excluded.
        if (['DRAFT', 'VOID', 'PAID'].includes(b.status)) return false;
        if (!(b.balanceDue > 0)) return false;
        if (!b.dueDate) return false;
        const d = new Date(b.dueDate);
        return d <= in7days;
      });

      const backorderCount = (resSummary || []).filter((r: any) => Number(r.shortage) > 0 || Number(r.backorder) > 0 || Number(r.short) > 0).length;

      setS({
        loading: false,
        quotationsOpen: quotations.length,
        quotationsValue: quotations.reduce((sum: number, q: any) => sum + (Number(q.total) || 0), 0),
        backorderCount,
        overdueCount: overdue.length,
        overdueValue: overdue.reduce((sum: number, i: any) => sum + (Number(i.balanceDue) || 0), 0),
        billsDueSoon: billsDue.length,
        billsDueValue: billsDue.reduce((sum: number, b: any) => sum + (Number(b.balanceDue) || 0), 0),
      });
    };

    load();
    // Poll every 60s so the strip stays current without a page reload.
    // Cheap: four small GETs against endpoints the app already hits.
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const totalActionable = s.quotationsOpen + s.backorderCount + s.overdueCount + s.billsDueSoon + criticalCount;

  return (
    <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
      <div className="flex items-center justify-between mb-md">
        <div>
          <h4 className="font-headline-sm text-lg font-black tracking-tighter leading-none">Needs attention today</h4>
          <p className="text-[11px] text-outline mt-1">
            {s.loading ? 'Checking your queue…' :
              totalActionable === 0
                ? 'You are clear — nothing overdue and no open quotes or backorders.'
                : `${totalActionable} item${totalActionable === 1 ? '' : 's'} across your queues. Click any card to jump straight to it.`}
          </p>
        </div>
        {!s.loading && totalActionable === 0 && (
          <CheckCircle2 className="w-6 h-6 text-green-400" />
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-sm">
        <ActionCard
          icon={<FileText className="w-4 h-4" />}
          label="Quotations awaiting reply"
          count={s.quotationsOpen}
          subtext={s.quotationsOpen > 0 ? fmtCurrency(s.quotationsValue) : undefined}
          tone={s.quotationsOpen > 0 ? 'primary' : 'muted'}
          onClick={() => onNavigate({ view: 'bookkeeping', section: 'SALES', subSection: 'ORDERS', statusFilter: 'QUOTATION' })}
        />
        <ActionCard
          icon={<PackageX className="w-4 h-4" />}
          label="Sales orders with backorders"
          count={s.backorderCount}
          tone={s.backorderCount > 0 ? 'warning' : 'muted'}
          onClick={() => onNavigate({ view: 'bookkeeping', section: 'SALES', subSection: 'ORDERS' })}
        />
        <ActionCard
          icon={<Receipt className="w-4 h-4" />}
          label="Overdue invoices"
          count={s.overdueCount}
          subtext={s.overdueCount > 0 ? fmtCurrency(s.overdueValue) : undefined}
          tone={s.overdueCount > 0 ? 'error' : 'muted'}
          onClick={() => onNavigate({ view: 'bookkeeping', section: 'SALES', subSection: 'INVOICES' })}
        />
        <ActionCard
          icon={<CalendarClock className="w-4 h-4" />}
          label="Bills due this week"
          count={s.billsDueSoon}
          subtext={s.billsDueSoon > 0 ? fmtCurrency(s.billsDueValue) : undefined}
          tone={s.billsDueSoon > 0 ? 'warning' : 'muted'}
          onClick={() => onNavigate({ view: 'bookkeeping', section: 'PURCHASES', subSection: 'BILLS' })}
        />
        <ActionCard
          icon={<AlertTriangle className="w-4 h-4" />}
          label="Critical low stock"
          count={criticalCount}
          tone={criticalCount > 0 ? 'error' : 'muted'}
          onClick={() => onNavigate({ view: 'inventory' })}
        />
      </div>
    </div>
  );
};

// ── Card primitive ────────────────────────────────────────────────────
// Uses `button` so keyboard tab-order and focus rings come for free.
// tone drives the accent colour; muted (count === 0) still renders so
// the strip stays a stable 5-column grid.

const ActionCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  count: number;
  subtext?: string;
  tone: 'primary' | 'warning' | 'error' | 'muted';
  onClick: () => void;
}> = ({ icon, label, count, subtext, tone, onClick }) => {
  const isActionable = count > 0;
  const toneClasses = {
    primary: 'border-primary/40 hover:border-primary bg-primary/5 text-primary',
    warning: 'border-amber-500/40 hover:border-amber-400 bg-amber-500/5 text-amber-400',
    error: 'border-error/40 hover:border-error bg-error/5 text-error',
    muted: 'border-outline-variant/40 hover:border-outline-variant text-on-surface-variant',
  }[tone];

  return (
    <button
      onClick={onClick}
      className={`text-left rounded-lg border p-sm transition-all group ${toneClasses} ${isActionable ? 'cursor-pointer' : 'cursor-default opacity-70'}`}
    >
      <div className="flex items-start justify-between mb-1">
        <div className="opacity-80">{icon}</div>
        {isActionable && <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />}
      </div>
      <div className="text-[10px] font-bold uppercase tracking-tight leading-tight opacity-80">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-xl font-black font-mono">{count}</span>
        {subtext && <span className="text-[10px] font-mono opacity-70">{subtext}</span>}
      </div>
    </button>
  );
};
