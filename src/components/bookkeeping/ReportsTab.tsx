import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { ModuleDataProps, fmtMoney, todayISO, apiGet, SecondaryButton, inputClass, EmptyState, SectionCard } from './shared';

type ReportKind = 'PL' | 'BS' | 'TB' | 'AR' | 'AP';

const REPORT_LABELS: Record<ReportKind, string> = {
  PL: 'Profit & Loss',
  BS: 'Balance Sheet',
  TB: 'Trial Balance',
  AR: 'AR Aging',
  AP: 'AP Aging',
};

function downloadCSV(filename: string, rows: string[][]) {
  const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export const ReportsTab: React.FC<ModuleDataProps> = ({ triggerToast }) => {
  const [kind, setKind] = useState<ReportKind>('PL');
  const [asOf, setAsOf] = useState(todayISO());
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(todayISO());
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      let url = '';
      if (kind === 'PL') url = `/api/reports/profit-loss?from=${from}&to=${to}`;
      else if (kind === 'BS') url = `/api/reports/balance-sheet?asOf=${asOf}`;
      else if (kind === 'TB') url = `/api/reports/trial-balance?asOf=${asOf}`;
      else if (kind === 'AR') url = `/api/reports/ar-aging?asOf=${asOf}`;
      else if (kind === 'AP') url = `/api/reports/ap-aging?asOf=${asOf}`;
      const result = await apiGet(url);
      setData(result);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load report', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [kind]);

  const exportCurrent = () => {
    if (!data) return;
    if (kind === 'PL') {
      downloadCSV('profit_loss.csv', [
        ['Account', 'Amount'],
        ...data.income.map((r: any) => [`${r.code} ${r.name}`, r.amount]),
        ['Total Income', data.totalIncome],
        ...data.expenses.map((r: any) => [`${r.code} ${r.name}`, r.amount]),
        ['Total Expenses', data.totalExpenses],
        ['Net Profit', data.netProfit],
      ]);
    } else if (kind === 'BS') {
      downloadCSV('balance_sheet.csv', [
        ['Section', 'Account', 'Amount'],
        ...data.assets.map((r: any) => ['Asset', `${r.code} ${r.name}`, r.amount]),
        ['', 'Total Assets', data.totalAssets],
        ...data.liabilities.map((r: any) => ['Liability', `${r.code} ${r.name}`, r.amount]),
        ['', 'Total Liabilities', data.totalLiabilities],
        ...data.equity.map((r: any) => ['Equity', `${r.code} ${r.name}`, r.amount]),
        ['', 'Total Equity', data.totalEquity],
      ]);
    } else if (kind === 'TB') {
      downloadCSV('trial_balance.csv', [
        ['Code', 'Account', 'Debit', 'Credit'],
        ...data.rows.map((r: any) => [r.code, r.name, r.debit, r.credit]),
        ['', 'Total', data.totalDebit, data.totalCredit],
      ]);
    } else {
      downloadCSV(`${kind.toLowerCase()}_aging.csv`, [
        ['Entity', 'Current', '1-30', '31-60', '61-90', '90+', 'Total'],
        ...data.map((r: any) => [r.entityName, r.current, r.d30, r.d60, r.d90, r.d90plus, r.total]),
      ]);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-surface-container-high/40 p-1 rounded-lg">
          {(Object.keys(REPORT_LABELS) as ReportKind[]).map(k => (
            <button key={k} onClick={() => setKind(k)} className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${kind === k ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>{REPORT_LABELS[k]}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {kind === 'PL' ? (
            <>
              <input type="date" className={`${inputClass} py-1.5 text-xs w-36`} value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="text-xs text-outline">to</span>
              <input type="date" className={`${inputClass} py-1.5 text-xs w-36`} value={to} onChange={(e) => setTo(e.target.value)} />
            </>
          ) : (
            <input type="date" className={`${inputClass} py-1.5 text-xs w-36`} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          )}
          <SecondaryButton onClick={load}>Run</SecondaryButton>
          <SecondaryButton icon={<Download className="w-3.5 h-3.5" />} onClick={exportCurrent} disabled={!data}>Export CSV</SecondaryButton>
        </div>
      </div>

      {loading && <div className="text-xs text-outline p-md">Loading report...</div>}
      {!loading && data && kind === 'PL' && <ProfitLossView data={data} />}
      {!loading && data && kind === 'BS' && <BalanceSheetView data={data} />}
      {!loading && data && kind === 'TB' && <TrialBalanceView data={data} />}
      {!loading && data && (kind === 'AR' || kind === 'AP') && <AgingView data={data} label={kind === 'AR' ? 'Customer' : 'Supplier'} />}
    </div>
  );
};

const ProfitLossView: React.FC<{ data: any }> = ({ data }) => (
  <SectionCard title="Profit & Loss" badge={`${data.from} → ${data.to}`}>
    <div className="p-lg space-y-4">
      <div>
        <h5 className="text-xs font-bold text-outline uppercase mb-2">Income</h5>
        {data.income.map((r: any) => (
          <div key={r.accountId} className="flex justify-between text-sm py-1 border-b border-outline-variant/20">
            <span>{r.code} {r.name}</span><span className="font-mono">{fmtMoney(r.amount)}</span>
          </div>
        ))}
        {data.income.length === 0 && <p className="text-xs text-outline italic">No income posted in this period.</p>}
        <div className="flex justify-between text-sm font-bold pt-2"><span>Total Income</span><span className="font-mono text-green-400">{fmtMoney(data.totalIncome)}</span></div>
      </div>
      <div>
        <h5 className="text-xs font-bold text-outline uppercase mb-2">Expenses</h5>
        {data.expenses.map((r: any) => (
          <div key={r.accountId} className="flex justify-between text-sm py-1 border-b border-outline-variant/20">
            <span>{r.code} {r.name}</span><span className="font-mono">{fmtMoney(r.amount)}</span>
          </div>
        ))}
        {data.expenses.length === 0 && <p className="text-xs text-outline italic">No expenses posted in this period.</p>}
        <div className="flex justify-between text-sm font-bold pt-2"><span>Total Expenses</span><span className="font-mono text-error">{fmtMoney(data.totalExpenses)}</span></div>
      </div>
      <div className="flex justify-between text-lg font-black pt-3 border-t-2 border-outline-variant">
        <span>Net Profit</span><span className={`font-mono ${data.netProfit >= 0 ? 'text-green-400' : 'text-error'}`}>{fmtMoney(data.netProfit)}</span>
      </div>
    </div>
  </SectionCard>
);

const BalanceSheetView: React.FC<{ data: any }> = ({ data }) => (
  <SectionCard title="Balance Sheet" badge={`As of ${data.asOf}${data.balanced ? ' · Balanced ✓' : ' · ⚠ Not balanced'}`}>
    <div className="p-lg grid md:grid-cols-2 gap-lg">
      <div>
        <h5 className="text-xs font-bold text-outline uppercase mb-2">Assets</h5>
        {data.assets.map((r: any) => (
          <div key={r.accountId} className="flex justify-between text-sm py-1 border-b border-outline-variant/20"><span>{r.code} {r.name}</span><span className="font-mono">{fmtMoney(r.amount)}</span></div>
        ))}
        <div className="flex justify-between text-sm font-bold pt-2"><span>Total Assets</span><span className="font-mono text-primary">{fmtMoney(data.totalAssets)}</span></div>
      </div>
      <div className="space-y-4">
        <div>
          <h5 className="text-xs font-bold text-outline uppercase mb-2">Liabilities</h5>
          {data.liabilities.map((r: any) => (
            <div key={r.accountId} className="flex justify-between text-sm py-1 border-b border-outline-variant/20"><span>{r.code} {r.name}</span><span className="font-mono">{fmtMoney(r.amount)}</span></div>
          ))}
          <div className="flex justify-between text-sm font-bold pt-2"><span>Total Liabilities</span><span className="font-mono">{fmtMoney(data.totalLiabilities)}</span></div>
        </div>
        <div>
          <h5 className="text-xs font-bold text-outline uppercase mb-2">Equity</h5>
          {data.equity.map((r: any) => (
            <div key={r.accountId} className="flex justify-between text-sm py-1 border-b border-outline-variant/20"><span>{r.code} {r.name}</span><span className="font-mono">{fmtMoney(r.amount)}</span></div>
          ))}
          <div className="flex justify-between text-sm font-bold pt-2"><span>Total Equity</span><span className="font-mono">{fmtMoney(data.totalEquity)}</span></div>
        </div>
      </div>
    </div>
  </SectionCard>
);

const TrialBalanceView: React.FC<{ data: any }> = ({ data }) => (
  <SectionCard title="Trial Balance" badge={`As of ${data.asOf}${data.balanced ? ' · Balanced ✓' : ' · ⚠ Not balanced'}`}>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead><tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant"><th className="px-lg py-sm">Code</th><th className="px-lg py-sm">Account</th><th className="px-lg py-sm text-right">Debit</th><th className="px-lg py-sm text-right">Credit</th></tr></thead>
        <tbody className="divide-y divide-outline-variant/30">
          {data.rows.map((r: any) => (
            <tr key={r.accountId}><td className="px-lg py-sm font-mono text-outline">{r.code}</td><td className="px-lg py-sm">{r.name}</td><td className="px-lg py-sm text-right font-mono">{r.debit > 0 ? fmtMoney(r.debit) : ''}</td><td className="px-lg py-sm text-right font-mono">{r.credit > 0 ? fmtMoney(r.credit) : ''}</td></tr>
          ))}
          {data.rows.length === 0 && <EmptyState message="No posted activity yet." colSpan={4} />}
        </tbody>
        <tfoot><tr className="border-t-2 border-outline-variant font-bold"><td className="px-lg py-sm" colSpan={2}>Total</td><td className="px-lg py-sm text-right font-mono">{fmtMoney(data.totalDebit)}</td><td className="px-lg py-sm text-right font-mono">{fmtMoney(data.totalCredit)}</td></tr></tfoot>
      </table>
    </div>
  </SectionCard>
);

const AgingView: React.FC<{ data: any[]; label: string }> = ({ data, label }) => (
  <SectionCard title={`${label} Aging`} badge={`${data.length} ${label.toLowerCase()}s with balances`}>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead><tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant"><th className="px-lg py-sm">{label}</th><th className="px-lg py-sm text-right">Current</th><th className="px-lg py-sm text-right">1-30</th><th className="px-lg py-sm text-right">31-60</th><th className="px-lg py-sm text-right">61-90</th><th className="px-lg py-sm text-right">90+</th><th className="px-lg py-sm text-right">Total</th></tr></thead>
        <tbody className="divide-y divide-outline-variant/30">
          {data.map((r: any) => (
            <tr key={r.entityId}>
              <td className="px-lg py-sm font-bold">{r.entityName}</td>
              <td className="px-lg py-sm text-right font-mono">{fmtMoney(r.current)}</td>
              <td className="px-lg py-sm text-right font-mono text-tertiary">{fmtMoney(r.d30)}</td>
              <td className="px-lg py-sm text-right font-mono text-secondary">{fmtMoney(r.d60)}</td>
              <td className="px-lg py-sm text-right font-mono text-error">{fmtMoney(r.d90)}</td>
              <td className="px-lg py-sm text-right font-mono text-error font-bold">{fmtMoney(r.d90plus)}</td>
              <td className="px-lg py-sm text-right font-mono font-bold">{fmtMoney(r.total)}</td>
            </tr>
          ))}
          {data.length === 0 && <EmptyState message="Nothing outstanding." colSpan={7} />}
        </tbody>
      </table>
    </div>
  </SectionCard>
);
