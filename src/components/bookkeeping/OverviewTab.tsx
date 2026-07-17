import React, { useEffect, useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Wallet, AlertCircle } from 'lucide-react';
import { ModuleDataProps, StatusPill, fmtMoney, fmtDate, apiGet, StatCard, SectionCard, EmptyState } from './shared';

export const OverviewTab: React.FC<ModuleDataProps> = ({ invoices, bills, expenses, paymentsReceived, accounts, triggerToast }) => {
  const [plData, setPlData] = useState<any>(null);

  useEffect(() => {
    const now = new Date();
    const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const to = now.toISOString().slice(0, 10);
    apiGet(`/api/reports/profit-loss?from=${from}&to=${to}`).then(setPlData).catch(() => {});
  }, [invoices, bills, expenses]);

  const kpis = useMemo(() => {
    const arOutstanding = invoices.filter(i => ['SENT', 'PARTIAL', 'OVERDUE'].includes(i.status)).reduce((s, i) => s + i.balanceDue, 0);
    const apOutstanding = bills.filter(b => ['AWAITING_PAYMENT', 'PARTIAL', 'OVERDUE'].includes(b.status)).reduce((s, b) => s + b.balanceDue, 0);
    const arOverdue = invoices.filter(i => i.status === 'OVERDUE').reduce((s, i) => s + i.balanceDue, 0);
    const apOverdue = bills.filter(b => b.status === 'OVERDUE').reduce((s, b) => s + b.balanceDue, 0);
    return { arOutstanding, apOutstanding, arOverdue, apOverdue };
  }, [invoices, bills]);

  const recentInvoices = useMemo(() => [...invoices].sort((a, b) => b.id - a.id).slice(0, 6), [invoices]);
  const recentBills = useMemo(() => [...bills].sort((a, b) => b.id - a.id).slice(0, 6), [bills]);

  const maxBar = Math.max(plData?.totalIncome || 0, plData?.totalExpenses || 0, 1);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-md">
        <StatCard label="Revenue (MTD)" value={fmtMoney(plData?.totalIncome || 0)} accent="green" icon={<TrendingUp className="w-4 h-4" />} />
        <StatCard label="Expenses (MTD)" value={fmtMoney(plData?.totalExpenses || 0)} accent="error" icon={<TrendingDown className="w-4 h-4" />} />
        <StatCard label="Net Profit (MTD)" value={fmtMoney(plData?.netProfit || 0)} accent={plData?.netProfit >= 0 ? 'green' : 'error'} icon={<Wallet className="w-4 h-4" />} />
        <StatCard label="AR Overdue" value={fmtMoney(kpis.arOverdue)} accent="error" icon={<AlertCircle className="w-4 h-4" />} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        <StatCard label="Outstanding Receivables (AR)" value={fmtMoney(kpis.arOutstanding)} accent="primary" sub={`${invoices.filter(i => ['SENT', 'PARTIAL', 'OVERDUE'].includes(i.status)).length} open invoices`} />
        <StatCard label="Outstanding Payables (AP)" value={fmtMoney(kpis.apOutstanding)} accent="secondary" sub={`${bills.filter(b => ['AWAITING_PAYMENT', 'PARTIAL', 'OVERDUE'].includes(b.status)).length} open bills`} />
      </div>

      {plData && (
        <SectionCard title="This Month at a Glance" badge={`${plData.from} → ${plData.to}`}>
          <div className="p-lg space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1"><span className="text-on-surface-variant">Income</span><span className="font-mono font-bold text-green-400">{fmtMoney(plData.totalIncome)}</span></div>
              <div className="h-2 bg-surface-container-high rounded-full overflow-hidden"><div className="h-full bg-green-500" style={{ width: `${(plData.totalIncome / maxBar) * 100}%` }} /></div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1"><span className="text-on-surface-variant">Expenses</span><span className="font-mono font-bold text-error">{fmtMoney(plData.totalExpenses)}</span></div>
              <div className="h-2 bg-surface-container-high rounded-full overflow-hidden"><div className="h-full bg-error" style={{ width: `${(plData.totalExpenses / maxBar) * 100}%` }} /></div>
            </div>
          </div>
        </SectionCard>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        <SectionCard title="Recent Invoices">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <tbody className="divide-y divide-outline-variant/30">
                {recentInvoices.map(inv => (
                  <tr key={inv.id} className="hover:bg-surface-variant/20">
                    <td className="px-lg py-sm font-mono text-primary font-bold">{inv.invoiceNumber}</td>
                    <td className="px-lg py-sm">{inv.clientName || 'Unassigned'}</td>
                    <td className="px-lg py-sm text-right font-mono">{fmtMoney(inv.total, inv.currency)}</td>
                    <td className="px-lg py-sm"><StatusPill status={inv.status} /></td>
                  </tr>
                ))}
                {recentInvoices.length === 0 && <EmptyState message="No invoices yet." colSpan={4} />}
              </tbody>
            </table>
          </div>
        </SectionCard>
        <SectionCard title="Recent Bills">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <tbody className="divide-y divide-outline-variant/30">
                {recentBills.map(b => (
                  <tr key={b.id} className="hover:bg-surface-variant/20">
                    <td className="px-lg py-sm font-mono text-primary font-bold">{b.billNumber}</td>
                    <td className="px-lg py-sm">{b.supplierName || b.supplierId || '—'}</td>
                    <td className="px-lg py-sm text-right font-mono">{fmtMoney(b.total, b.currency)}</td>
                    <td className="px-lg py-sm"><StatusPill status={b.status} /></td>
                  </tr>
                ))}
                {recentBills.length === 0 && <EmptyState message="No bills yet." colSpan={4} />}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>
    </div>
  );
};
