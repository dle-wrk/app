// Vendor 360 — purchases-side mirror of Customer 360.
//
// Rationale: same "everything about one entity in one place" argument
// that motivated the Customer drawer applies to vendors. Answering
// "what's happening with Digi-Key right now?" required jumping
// between Purchases > POs, Purchases > Bills, Purchases > Payments,
// and Purchases > Expenses. This drawer collapses that into one view.
//
// Data sourcing: POs, bills, payments-made, expenses all come from
// props (already in ModuleDataProps). Landed cost lives in its own
// tab and isn't in the bootstrap — worth a follow-up if that becomes
// a frequent question, but skipped here to keep the drawer instant.

import React, { useMemo, useState } from 'react';
import { X, Mail, Globe, Clock, FileText, TrendingUp, Receipt, Wallet, CreditCard, Package } from 'lucide-react';
import { Supplier, PurchaseOrder, Bill, PaymentMade, Expense } from '../../types';
import { fmtMoney, fmtDate } from './shared';
import { Metric, Count, Panel, TabList, DocRow } from './Customer360Modal';

type TabKey = 'OVERVIEW' | 'POS' | 'BILLS' | 'PAYMENTS' | 'EXPENSES';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'OVERVIEW', label: 'Overview', icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { key: 'POS', label: 'Purchase Orders', icon: <FileText className="w-3.5 h-3.5" /> },
  { key: 'BILLS', label: 'Bills', icon: <Receipt className="w-3.5 h-3.5" /> },
  { key: 'PAYMENTS', label: 'Payments', icon: <CreditCard className="w-3.5 h-3.5" /> },
  { key: 'EXPENSES', label: 'Expenses', icon: <Wallet className="w-3.5 h-3.5" /> },
];

type ActivityRow = {
  when: string;
  kind: 'PO' | 'BILL' | 'PAYMENT' | 'EXPENSE';
  docNumber: string;
  amount?: number;
  status?: string;
};

export const Vendor360Modal: React.FC<{
  vendor: Supplier;
  purchaseOrders: PurchaseOrder[];
  bills: Bill[];
  paymentsMade: PaymentMade[];
  expenses: Expense[];
  onClose: () => void;
}> = ({ vendor, purchaseOrders, bills, paymentsMade, expenses, onClose }) => {
  const [tab, setTab] = useState<TabKey>('OVERVIEW');

  const pos = useMemo(() => purchaseOrders.filter(p => p.supplierId === vendor.id), [purchaseOrders, vendor.id]);
  const vBills = useMemo(() => bills.filter(b => b.supplierId === vendor.id), [bills, vendor.id]);
  const pays = useMemo(() => paymentsMade.filter(p => p.supplierId === vendor.id), [paymentsMade, vendor.id]);
  const exps = useMemo(() => expenses.filter(e => e.supplierId === vendor.id), [expenses, vendor.id]);

  const openAP = useMemo(() => vBills
    .filter(b => b.status !== 'DRAFT' && b.status !== 'VOID')
    .reduce((sum, b) => sum + (b.balanceDue || 0), 0), [vBills]);

  const overdue = useMemo(() => vBills.filter(b => {
    if (['DRAFT', 'VOID', 'PAID'].includes(b.status)) return false;
    if (!(b.balanceDue > 0)) return false;
    if (!b.dueDate) return false;
    return new Date(b.dueDate) < new Date();
  }), [vBills]);

  // PurchaseOrderStatus = DRAFT | SENT | PARTIAL | RECEIVED | CANCELLED.
  // "Open" means anything still awaiting more goods: everything except
  // fully received or cancelled.
  const openPOs = useMemo(() => pos.filter(p => p.status !== 'RECEIVED' && p.status !== 'CANCELLED'), [pos]);

  // YTD spend = every posted bill this calendar year at its total. Not
  // net of credits — vendor-side credit notes aren't a first-class
  // concept in the app yet, so gross is the honest number.
  const ytdSpend = useMemo(() => {
    const yearStart = `${new Date().getFullYear()}-01-01`;
    return vBills
      .filter(b => b.status !== 'DRAFT' && b.status !== 'VOID' && (b.billDate || '') >= yearStart)
      .reduce((sum, b) => sum + (b.total || 0), 0);
  }, [vBills]);

  const activity = useMemo<ActivityRow[]>(() => {
    const rows: ActivityRow[] = [
      ...pos.map(p => ({ when: p.orderDate, kind: 'PO' as const, docNumber: p.poNumber, amount: p.total, status: p.status })),
      ...vBills.map(b => ({ when: b.billDate, kind: 'BILL' as const, docNumber: b.billNumber, amount: b.total, status: b.status })),
      ...pays.map(p => ({ when: p.paymentDate, kind: 'PAYMENT' as const, docNumber: p.paymentNumber, amount: p.amount })),
      ...exps.map(e => ({ when: e.expenseDate, kind: 'EXPENSE' as const, docNumber: e.expenseNumber, amount: e.total, status: e.status })),
    ];
    rows.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
    return rows.slice(0, 12);
  }, [pos, vBills, pays, exps]);

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-stretch justify-end z-[110]" onClick={onClose}>
      <div
        className="w-full md:w-[90vw] max-w-6xl bg-surface-container border-l border-outline-variant/40 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-outline-variant/40 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-xl font-bold text-on-surface truncate">{vendor.name}</h2>
              <span className="font-mono text-[10px] text-outline">#{vendor.id}</span>
            </div>
            <div className="flex items-center gap-4 text-xs text-outline flex-wrap">
              {vendor.contact_email && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />{vendor.contact_email}</span>}
              {vendor.website && (
                <a href={vendor.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  <Globe className="w-3 h-3" />{vendor.website.replace(/^https?:\/\//, '')}
                </a>
              )}
              {vendor.leadTime != null && <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />Lead {vendor.leadTime}d</span>}
              {vendor.responseTime != null && <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />Response {vendor.responseTime}h</span>}
            </div>
            {vendor.notes && <p className="text-[11px] text-on-surface-variant italic mt-1">"{vendor.notes}"</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant flex-shrink-0" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-3 border-b border-outline-variant/30 grid grid-cols-2 md:grid-cols-4 gap-3 flex-shrink-0 bg-surface-container-low/40">
          <Metric label="Open AP" value={fmtMoney(openAP)} tone={openAP > 0 ? 'warning' : 'muted'} />
          <Metric label="Overdue bills" value={`${overdue.length}`} sub={overdue.length ? fmtMoney(overdue.reduce((s, b) => s + (b.balanceDue || 0), 0)) : undefined} tone={overdue.length ? 'error' : 'muted'} />
          <Metric label="Open POs" value={`${openPOs.length}`} tone={openPOs.length ? 'primary' : 'muted'} />
          <Metric label="YTD spend" value={fmtMoney(ytdSpend)} tone="success" />
        </div>

        <div className="px-6 pt-3 border-b border-outline-variant/30 flex gap-1 flex-shrink-0 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold whitespace-nowrap transition-all border-b-2 ${tab === t.key ? 'text-primary border-primary' : 'text-on-surface-variant border-transparent hover:text-on-surface'}`}
            >
              {t.icon}{t.label}
              {t.key === 'POS' && pos.length > 0 && <Count n={pos.length} />}
              {t.key === 'BILLS' && vBills.length > 0 && <Count n={vBills.length} />}
              {t.key === 'PAYMENTS' && pays.length > 0 && <Count n={pays.length} />}
              {t.key === 'EXPENSES' && exps.length > 0 && <Count n={exps.length} />}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'OVERVIEW' && (
            <div className="space-y-4">
              <Panel title="Recent activity">
                {activity.length === 0 ? (
                  <p className="text-xs text-outline italic">No activity yet.</p>
                ) : (
                  <div className="space-y-1">
                    {activity.map((a, i) => (
                      <div key={`${a.kind}-${a.docNumber}-${i}`} className="flex items-center justify-between text-xs bg-surface-container-low rounded px-3 py-2 border border-outline-variant/20">
                        <div className="flex items-center gap-2 min-w-0">
                          <ActivityIcon kind={a.kind} />
                          <span className="font-mono text-primary font-bold">{a.docNumber}</span>
                          {a.status && <span className="text-[9px] font-bold text-on-surface-variant uppercase">{a.status}</span>}
                          <span className="text-outline">{fmtDate(a.when)}</span>
                        </div>
                        {a.amount != null && (
                          <span className={`font-mono ${a.kind === 'PAYMENT' ? 'text-red-400' : ''}`}>
                            {a.kind === 'PAYMENT' ? '-' : ''}{fmtMoney(a.amount)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
              {overdue.length > 0 && (
                <Panel title="Overdue bills" tone="error">
                  <div className="space-y-1">
                    {overdue.map(b => (
                      <DocRow key={b.id} number={b.billNumber} date={b.billDate} status={b.status} amount={b.balanceDue} currency={b.currency}
                        extra={b.dueDate ? `due ${fmtDate(b.dueDate)}` : undefined} />
                    ))}
                  </div>
                </Panel>
              )}
            </div>
          )}

          {tab === 'POS' && (
            <TabList
              empty="No purchase orders for this vendor yet."
              rows={pos.map(p => (
                <DocRow key={p.id} number={p.poNumber} date={p.orderDate} status={p.status} amount={p.total} currency={p.currency}
                  extra={p.expectedDate ? `expected ${fmtDate(p.expectedDate)}` : undefined} />
              ))}
            />
          )}

          {tab === 'BILLS' && (
            <TabList
              empty="No bills for this vendor yet."
              rows={vBills.map(b => (
                <DocRow key={b.id} number={b.billNumber} date={b.billDate} status={b.status} amount={b.total} currency={b.currency}
                  extra={b.balanceDue > 0 ? `bal ${fmtMoney(b.balanceDue, b.currency)}` : 'paid'} />
              ))}
            />
          )}

          {tab === 'PAYMENTS' && (
            <TabList
              empty="No payments recorded yet."
              rows={pays.map(p => (
                <DocRow key={p.id} number={p.paymentNumber} date={p.paymentDate} amount={p.amount} tone="warning"
                  extra={p.method || undefined} />
              ))}
            />
          )}

          {tab === 'EXPENSES' && (
            <TabList
              empty="No expenses recorded for this vendor."
              rows={exps.map(e => (
                <DocRow key={e.id} number={e.expenseNumber} date={e.expenseDate} status={e.status} amount={e.total}
                  extra={e.categoryAccountName || e.payee || undefined} />
              ))}
            />
          )}
        </div>
      </div>
    </div>
  );
};

const ActivityIcon: React.FC<{ kind: ActivityRow['kind'] }> = ({ kind }) => {
  const Cmp = { PO: FileText, BILL: Receipt, PAYMENT: CreditCard, EXPENSE: Wallet }[kind] || Package;
  return <Cmp className="w-3 h-3 text-outline flex-shrink-0" />;
};
