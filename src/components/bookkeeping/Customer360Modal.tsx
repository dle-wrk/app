// Customer 360 — a wide drawer that pulls together every piece of a
// customer's relationship with the business into one place: open AR
// balance, aging, orders (incl. quotations), invoices, payments,
// credit notes, deliveries, and a downloadable statement.
//
// Rationale: before this drawer, answering "what's happening with
// Lumax Energy right now?" meant hopping between four sub-tabs
// (Orders, Invoices, Payments, Dispatch) and eyeballing lists filtered
// nowhere. The drawer replaces the old "Statement" mini-modal on the
// Customers tab so every row already has an Eye button that opens it —
// no new navigation to learn.
//
// Data sourcing: orders, invoices, and payments come straight from the
// props the tab already receives (ModuleDataProps). Credit notes and
// dispatch notes aren't in the bookkeeping bootstrap yet, so we fetch
// them once on mount. All filtering to the current client happens
// client-side.

import React, { useEffect, useMemo, useState } from 'react';
import { X, Mail, Phone, MapPin, Hash, FileText, Package, DollarSign, TrendingUp, Truck, Receipt, Download, Loader2 } from 'lucide-react';
import { Client, ClientOrder, Invoice, PaymentReceived } from '../../types';
import { StatusPill, fmtMoney, fmtDate, apiGet } from './shared';
import { buildAndSaveDocPdf } from '../../lib/pdfDocs';

type TabKey = 'OVERVIEW' | 'ORDERS' | 'INVOICES' | 'PAYMENTS' | 'CREDITS' | 'DELIVERIES' | 'STATEMENT';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'OVERVIEW', label: 'Overview', icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { key: 'ORDERS', label: 'Orders & Quotes', icon: <Package className="w-3.5 h-3.5" /> },
  { key: 'INVOICES', label: 'Invoices', icon: <FileText className="w-3.5 h-3.5" /> },
  { key: 'PAYMENTS', label: 'Payments', icon: <DollarSign className="w-3.5 h-3.5" /> },
  { key: 'CREDITS', label: 'Credit Notes', icon: <Receipt className="w-3.5 h-3.5" /> },
  { key: 'DELIVERIES', label: 'Deliveries', icon: <Truck className="w-3.5 h-3.5" /> },
  { key: 'STATEMENT', label: 'Statement', icon: <FileText className="w-3.5 h-3.5" /> },
];

// A single row's shape for the Recent Activity feed on Overview.
// Union of every doc kind we can render as "something happened on
// date X for amount Y". Sorted desc.
type ActivityRow = {
  when: string;
  kind: 'ORDER' | 'INVOICE' | 'PAYMENT' | 'CREDIT' | 'DELIVERY';
  docNumber: string;
  amount?: number;
  status?: string;
};

export const Customer360Modal: React.FC<{
  client: Client;
  clientOrders: ClientOrder[];
  invoices: Invoice[];
  paymentsReceived: PaymentReceived[];
  triggerToast: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  onClose: () => void;
}> = ({ client, clientOrders, invoices, paymentsReceived, triggerToast, onClose }) => {
  const [tab, setTab] = useState<TabKey>('OVERVIEW');
  const [creditNotes, setCreditNotes] = useState<any[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [loadingExtras, setLoadingExtras] = useState(true);
  const [downloadingStatement, setDownloadingStatement] = useState(false);

  // One-shot fetch on mount for the two entity lists the bookkeeping
  // bootstrap doesn't include. Failing quietly here beats blocking the
  // whole drawer on a slow /credit-notes response — the tabs still
  // render, they just show "none" until data arrives.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cn, dn] = await Promise.all([
          apiGet('/api/credit-notes').catch(() => []),
          apiGet('/api/dispatch-notes').catch(() => []),
        ]);
        if (cancelled) return;
        setCreditNotes(Array.isArray(cn) ? cn.filter((c: any) => c.clientId === client.id) : []);
        setDeliveries(Array.isArray(dn) ? dn.filter((d: any) => d.clientId === client.id) : []);
      } finally {
        if (!cancelled) setLoadingExtras(false);
      }
    })();
    return () => { cancelled = true; };
  }, [client.id]);

  // Filter the prop lists once — the tabs each pick from these.
  const orders = useMemo(() => clientOrders.filter(o => o.clientId === client.id), [clientOrders, client.id]);
  const invs = useMemo(() => invoices.filter(i => i.clientId === client.id), [invoices, client.id]);
  const pays = useMemo(() => paymentsReceived.filter(p => p.clientId === client.id), [paymentsReceived, client.id]);

  const openBalance = useMemo(() => invs
    .filter(i => i.status !== 'DRAFT' && i.status !== 'VOID')
    .reduce((sum, i) => sum + (i.balanceDue || 0), 0), [invs]);

  const overdue = useMemo(() => invs.filter(i => {
    if (i.status === 'PAID' || i.status === 'VOID' || i.status === 'DRAFT') return false;
    if (!i.dueDate) return false;
    return new Date(i.dueDate) < new Date() && (i.balanceDue || 0) > 0;
  }), [invs]);

  const quotations = useMemo(() => orders.filter(o => o.status === 'QUOTATION'), [orders]);
  const openOrders = useMemo(() => orders.filter(o => o.status !== 'FULFILLED' && o.status !== 'CANCELLED' && o.status !== 'QUOTATION'), [orders]);
  const lifetimeRevenue = useMemo(() =>
    invs.filter(i => i.status !== 'DRAFT' && i.status !== 'VOID').reduce((s, i) => s + (i.total || 0), 0)
  , [invs]);

  const activity = useMemo<ActivityRow[]>(() => {
    const rows: ActivityRow[] = [
      ...orders.map(o => ({ when: o.orderDate, kind: 'ORDER' as const, docNumber: o.orderNumber, amount: o.total, status: o.status })),
      ...invs.map(i => ({ when: i.invoiceDate, kind: 'INVOICE' as const, docNumber: i.invoiceNumber, amount: i.total, status: i.status })),
      ...pays.map(p => ({ when: p.paymentDate, kind: 'PAYMENT' as const, docNumber: p.paymentNumber, amount: p.amount })),
      ...creditNotes.map((c: any) => ({ when: c.creditNoteDate || c.createdAt, kind: 'CREDIT' as const, docNumber: c.creditNoteNumber, amount: c.total, status: c.status })),
      ...deliveries.map((d: any) => ({ when: d.noteDate || d.createdAt, kind: 'DELIVERY' as const, docNumber: d.noteNumber, status: d.status })),
    ];
    rows.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
    return rows.slice(0, 12);
  }, [orders, invs, pays, creditNotes, deliveries]);

  const downloadStatement = async () => {
    setDownloadingStatement(true);
    try {
      const asOf = new Date().toISOString().slice(0, 10);
      const s: any = await apiGet(`/api/reports/customer-statement?clientId=${client.id}&asOf=${asOf}`);
      const lines = s.transactions.map((t: any) => ({
        description: `${t.docNumber || ''}  ${t.description}${t.type === 'INVOICE' && t.dueDate ? ` · due ${t.dueDate}` : ''}`.trim(),
        quantity: t.type === 'INVOICE' ? 'Invoice' : 'Payment',
        unitPrice: t.debit > 0 ? t.debit : (t.credit > 0 ? -t.credit : 0),
        lineTotal: t.runningBalance,
      }));
      const agingBlurb = `Current ${fmtMoney(s.aging.current)}  ·  1-30 ${fmtMoney(s.aging.d30)}  ·  31-60 ${fmtMoney(s.aging.d60)}  ·  90+ ${fmtMoney(s.aging.d90plus)}`;
      await buildAndSaveDocPdf({
        docType: 'Customer Statement',
        docNumber: `${client.clientName.replace(/[^a-zA-Z0-9]+/g, '-')}-${asOf}`,
        meta: [
          { label: 'Client', value: s.client.name },
          { label: 'As of', value: s.period.asOf },
          { label: 'Opening', value: fmtMoney(s.openingBalance) },
          { label: 'Closing', value: fmtMoney(s.closingBalance) },
          { label: 'Contact', value: s.client.email || s.client.phone || '—' },
          { label: 'Total open', value: fmtMoney(s.aging.total) },
        ],
        lines,
        totals: { subtotal: s.openingBalance, total: s.closingBalance },
        notes: `Aging on open items — ${agingBlurb}.${s.overdueInvoices.length > 0 ? `  ${s.overdueInvoices.length} invoice(s) overdue — oldest ${s.overdueInvoices[0]?.daysOverdue} days.` : ''}`,
      });
      triggerToast(`Statement downloaded — ${fmtMoney(s.aging.total)} open.`);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to generate statement', 'ERROR');
    } finally {
      setDownloadingStatement(false);
    }
  };

  return (
    // Full-height slide-over: 90vw at desktop, edge-to-edge below.
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-stretch justify-end z-[110]" onClick={onClose}>
      <div
        className="w-full md:w-[90vw] max-w-6xl bg-surface-container border-l border-outline-variant/40 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: client identity + close */}
        <div className="px-6 py-4 border-b border-outline-variant/40 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-xl font-bold text-on-surface truncate">{client.clientName}</h2>
              <StatusPill status={client.status || 'ACTIVE'} />
            </div>
            <div className="flex items-center gap-4 text-xs text-outline flex-wrap">
              {client.contactName && <span>{client.contactName}</span>}
              {client.email && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />{client.email}</span>}
              {client.phone && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{client.phone}</span>}
              {client.vatNumber && <span className="inline-flex items-center gap-1"><Hash className="w-3 h-3" />VAT {client.vatNumber}</span>}
              {client.address && <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{client.address}</span>}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant flex-shrink-0" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Headline metrics: one glance, four numbers */}
        <div className="px-6 py-3 border-b border-outline-variant/30 grid grid-cols-2 md:grid-cols-4 gap-3 flex-shrink-0 bg-surface-container-low/40">
          <Metric label="Open AR" value={fmtMoney(openBalance)} tone={openBalance > 0 ? 'warning' : 'muted'} />
          <Metric label="Overdue" value={`${overdue.length}`} sub={overdue.length ? fmtMoney(overdue.reduce((s, i) => s + (i.balanceDue || 0), 0)) : undefined} tone={overdue.length ? 'error' : 'muted'} />
          <Metric label="Open orders" value={`${openOrders.length}`} sub={quotations.length ? `+ ${quotations.length} quote${quotations.length === 1 ? '' : 's'}` : undefined} tone="primary" />
          <Metric label="Lifetime revenue" value={fmtMoney(lifetimeRevenue)} tone="success" />
        </div>

        {/* Tab strip */}
        <div className="px-6 pt-3 border-b border-outline-variant/30 flex gap-1 flex-shrink-0 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold whitespace-nowrap transition-all border-b-2 ${tab === t.key ? 'text-primary border-primary' : 'text-on-surface-variant border-transparent hover:text-on-surface'}`}
            >
              {t.icon}{t.label}
              {t.key === 'ORDERS' && orders.length > 0 && <Count n={orders.length} />}
              {t.key === 'INVOICES' && invs.length > 0 && <Count n={invs.length} />}
              {t.key === 'PAYMENTS' && pays.length > 0 && <Count n={pays.length} />}
              {t.key === 'CREDITS' && creditNotes.length > 0 && <Count n={creditNotes.length} />}
              {t.key === 'DELIVERIES' && deliveries.length > 0 && <Count n={deliveries.length} />}
            </button>
          ))}
        </div>

        {/* Body — scrollable per tab */}
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
                          {a.status && <StatusPill status={a.status} />}
                          <span className="text-outline">{fmtDate(a.when)}</span>
                        </div>
                        {a.amount != null && (
                          <span className={`font-mono ${a.kind === 'PAYMENT' ? 'text-green-400' : a.kind === 'CREDIT' ? 'text-orange-400' : ''}`}>
                            {a.kind === 'PAYMENT' ? '+' : ''}{fmtMoney(a.amount)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
              {overdue.length > 0 && (
                <Panel title="Overdue invoices" tone="error">
                  <div className="space-y-1">
                    {overdue.map(i => (
                      <DocRow key={i.id} number={i.invoiceNumber} date={i.invoiceDate} status={i.status} amount={i.balanceDue} currency={i.currency}
                        extra={i.dueDate ? `due ${fmtDate(i.dueDate)}` : undefined} />
                    ))}
                  </div>
                </Panel>
              )}
            </div>
          )}

          {tab === 'ORDERS' && (
            <TabList
              empty="No sales orders or quotations for this customer yet."
              rows={orders.map(o => (
                <DocRow key={o.id} number={o.orderNumber} date={o.orderDate} status={o.status} amount={o.total} currency={o.currency}
                  extra={o.requiredDate ? `req ${fmtDate(o.requiredDate)}` : undefined} />
              ))}
            />
          )}

          {tab === 'INVOICES' && (
            <TabList
              empty="No invoices for this customer yet."
              rows={invs.map(i => (
                <DocRow key={i.id} number={i.invoiceNumber} date={i.invoiceDate} status={i.status} amount={i.total} currency={i.currency}
                  extra={i.balanceDue > 0 ? `bal ${fmtMoney(i.balanceDue, i.currency)}` : 'paid'} />
              ))}
            />
          )}

          {tab === 'PAYMENTS' && (
            <TabList
              empty="No payments recorded yet."
              rows={pays.map(p => (
                <DocRow key={p.id} number={p.paymentNumber} date={p.paymentDate} amount={p.amount} tone="success" />
              ))}
            />
          )}

          {tab === 'CREDITS' && (
            <TabList
              loading={loadingExtras}
              empty="No credit notes for this customer."
              rows={creditNotes.map((c: any) => (
                <DocRow key={c.id} number={c.creditNoteNumber} date={c.creditNoteDate} status={c.status} amount={c.total} currency={c.currency} tone="warning"
                  extra={c.invoiceNumber ? `re ${c.invoiceNumber}` : undefined} />
              ))}
            />
          )}

          {tab === 'DELIVERIES' && (
            <TabList
              loading={loadingExtras}
              empty="No delivery or collection notes yet."
              rows={deliveries.map((d: any) => (
                <DocRow key={d.id} number={d.noteNumber} date={d.noteDate} status={d.status}
                  extra={`${d.noteType || 'DELIVERY'}${d.orderNumber ? ` · ${d.orderNumber}` : ''}`} />
              ))}
            />
          )}

          {tab === 'STATEMENT' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-xs text-outline">
                  Full statement combines every invoice (debit) and payment (credit) into a running balance PDF with an aging matrix.
                </div>
                <button
                  onClick={downloadStatement}
                  disabled={downloadingStatement}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-primary text-on-primary text-xs font-bold hover:opacity-90 transition disabled:opacity-50"
                >
                  {downloadingStatement ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  Download PDF statement
                </button>
              </div>
              <Panel title="Invoices">
                {invs.length === 0 ? <p className="text-xs text-outline italic">None.</p> : (
                  <div className="space-y-1">{invs.map(i => (
                    <DocRow key={i.id} number={i.invoiceNumber} date={i.invoiceDate} status={i.status} amount={i.total} currency={i.currency} />
                  ))}</div>
                )}
              </Panel>
              <Panel title="Payments">
                {pays.length === 0 ? <p className="text-xs text-outline italic">None.</p> : (
                  <div className="space-y-1">{pays.map(p => (
                    <DocRow key={p.id} number={p.paymentNumber} date={p.paymentDate} amount={p.amount} tone="success" />
                  ))}</div>
                )}
              </Panel>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Small presentational helpers ──────────────────────────────────────
// Kept in this file because none of them are reused elsewhere yet;
// promote to shared.tsx if that changes.

const Metric: React.FC<{ label: string; value: string; sub?: string; tone?: 'muted' | 'primary' | 'success' | 'warning' | 'error' }> = ({ label, value, sub, tone = 'muted' }) => {
  const toneClass = {
    muted: 'text-on-surface',
    primary: 'text-primary',
    success: 'text-green-400',
    warning: 'text-amber-400',
    error: 'text-error',
  }[tone];
  return (
    <div>
      <div className="text-[10px] uppercase font-bold text-outline tracking-wider">{label}</div>
      <div className={`text-lg font-bold font-mono ${toneClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-outline">{sub}</div>}
    </div>
  );
};

const Count: React.FC<{ n: number }> = ({ n }) => (
  <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-surface-container-highest text-[9px] text-on-surface-variant font-bold">{n}</span>
);

const Panel: React.FC<{ title: string; tone?: 'default' | 'error'; children: React.ReactNode }> = ({ title, tone = 'default', children }) => (
  <div className={`rounded-lg border p-4 ${tone === 'error' ? 'border-error/40 bg-error/5' : 'border-outline-variant/40 bg-surface-container-low/40'}`}>
    <h5 className="text-xs font-bold uppercase text-outline mb-2 tracking-wider">{title}</h5>
    {children}
  </div>
);

const TabList: React.FC<{ rows: React.ReactNode[]; empty: string; loading?: boolean }> = ({ rows, empty, loading }) => {
  if (loading) return <div className="flex items-center justify-center py-12 text-outline"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (rows.length === 0) return <div className="p-8 text-center text-xs text-outline italic">{empty}</div>;
  return <div className="space-y-1">{rows}</div>;
};

const DocRow: React.FC<{
  number: string; date: string; status?: string; amount?: number; currency?: string; extra?: string; tone?: 'success' | 'warning';
}> = ({ number, date, status, amount, currency, extra, tone }) => {
  const amountClass = tone === 'success' ? 'text-green-400' : tone === 'warning' ? 'text-orange-400' : '';
  return (
    <div className="flex items-center justify-between text-xs bg-surface-container-low rounded px-3 py-2 border border-outline-variant/20 hover:bg-surface-container-high/40 transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-primary font-bold whitespace-nowrap">{number}</span>
        {status && <StatusPill status={status} />}
        <span className="text-outline whitespace-nowrap">{fmtDate(date)}</span>
        {extra && <span className="text-outline text-[10px] truncate">· {extra}</span>}
      </div>
      {amount != null && (
        <span className={`font-mono font-bold ${amountClass} whitespace-nowrap`}>
          {tone === 'success' ? '+' : ''}{fmtMoney(amount, currency)}
        </span>
      )}
    </div>
  );
};

const ActivityIcon: React.FC<{ kind: ActivityRow['kind'] }> = ({ kind }) => {
  const Cmp = { ORDER: Package, INVOICE: FileText, PAYMENT: DollarSign, CREDIT: Receipt, DELIVERY: Truck }[kind];
  return <Cmp className="w-3 h-3 text-outline flex-shrink-0" />;
};
