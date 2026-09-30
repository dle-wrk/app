import React, { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { ModuleDataProps, fmtMoney, todayISO, apiGet, SecondaryButton, inputClass, EmptyState, SectionCard } from './shared';
import { buildAndSaveDocPdf } from '../../lib/pdfDocs';

type ReportKind = 'PL' | 'BS' | 'TB' | 'AR' | 'AP' | 'VAT';

const REPORT_LABELS: Record<ReportKind, string> = {
  PL: 'Profit & Loss',
  BS: 'Balance Sheet',
  TB: 'Trial Balance',
  AR: 'AR Aging',
  AP: 'AP Aging',
  VAT: 'VAT201',
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
    setData(null);
    setLoading(true);
    try {
      let url = '';
      if (kind === 'PL') url = `/api/reports/profit-loss?from=${from}&to=${to}`;
      else if (kind === 'BS') url = `/api/reports/balance-sheet?asOf=${asOf}`;
      else if (kind === 'TB') url = `/api/reports/trial-balance?asOf=${asOf}`;
      else if (kind === 'AR') url = `/api/reports/ar-aging?asOf=${asOf}`;
      else if (kind === 'AP') url = `/api/reports/ap-aging?asOf=${asOf}`;
      else if (kind === 'VAT') url = `/api/reports/vat201?from=${from}&to=${to}`;
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
    } else if (kind === 'VAT') {
      downloadCSV(`vat201_${data.period.from}_${data.period.to}.csv`, [
        ['Section', 'Doc #', 'Date', 'Party', 'Taxable', 'VAT'],
        ...data.invoices.map((r: any) => ['Output tax', r.number, r.date, r.client, r.taxable, r.vat]),
        ...data.bills.map((r: any) => ['Input tax', r.number, r.date, r.supplier, r.taxable, r.vat]),
        ['', '', '', 'Total Output Tax', data.standardRateSales.taxable, data.totalOutputTax],
        ['', '', '', 'Total Input Tax', data.standardRatePurchases.taxable, data.totalInputTax],
        ['', '', '', 'Net VAT Due', '', data.netVatDue],
      ]);
    } else {
      downloadCSV(`${kind.toLowerCase()}_aging.csv`, [
        ['Entity', 'Current', '1-30', '31-60', '61-90', '90+', 'Total'],
        ...data.map((r: any) => [r.entityName, r.current, r.d30, r.d60, r.d90, r.d90plus, r.total]),
      ]);
    }
  };

  const savePdf = async () => {
    if (!data) return;
    try {
      // Every financial report can be saved as PDF now. Each branch
      // shapes the doc lines to fit the reused buildAndSaveDocPdf
      // helper — headline description as "code · name" so the reader
      // scans by account rather than by amount.
      if (kind === 'PL') {
        await buildAndSaveDocPdf({
          docType: 'Profit & Loss',
          docNumber: `${data.from}_${data.to}`,
          meta: [
            { label: 'From', value: data.from },
            { label: 'To', value: data.to },
            { label: 'Net Profit', value: fmtMoney(data.netProfit) },
            { label: 'Direction', value: data.netProfit >= 0 ? 'Profit' : 'Loss' },
          ],
          lines: [
            ...data.income.map((r: any) => ({ description: `Income · ${r.code} ${r.name}`, quantity: '', lineTotal: r.amount })),
            { description: 'Total income', quantity: '', lineTotal: data.totalIncome },
            ...data.expenses.map((r: any) => ({ description: `Expense · ${r.code} ${r.name}`, quantity: '', lineTotal: r.amount })),
            { description: 'Total expenses', quantity: '', lineTotal: data.totalExpenses },
            { description: 'Net profit / (loss)', quantity: '', lineTotal: data.netProfit },
          ],
          totals: { subtotal: data.totalIncome, tax: -data.totalExpenses, total: data.netProfit },
          notes: 'Sourced from POSTED journal entries in the period. VOID and DRAFT entries are excluded.',
        });
        return;
      }
      if (kind === 'BS') {
        await buildAndSaveDocPdf({
          docType: 'Balance Sheet',
          docNumber: `as_of_${data.asOf}`,
          meta: [
            { label: 'As of', value: data.asOf },
            { label: 'Total Assets', value: fmtMoney(data.totalAssets) },
            { label: 'Total Liab. + Equity', value: fmtMoney(data.totalLiabilities + data.totalEquity) },
            { label: 'Balanced', value: data.balanced ? 'Yes ✓' : 'No — check journals' },
          ],
          lines: [
            ...data.assets.map((r: any) => ({ description: `Asset · ${r.code} ${r.name}`, quantity: '', lineTotal: r.amount })),
            { description: 'Total assets', quantity: '', lineTotal: data.totalAssets },
            ...data.liabilities.map((r: any) => ({ description: `Liability · ${r.code} ${r.name}`, quantity: '', lineTotal: r.amount })),
            { description: 'Total liabilities', quantity: '', lineTotal: data.totalLiabilities },
            ...data.equity.map((r: any) => ({ description: `Equity · ${r.code} ${r.name}`, quantity: '', lineTotal: r.amount })),
            { description: 'Total equity', quantity: '', lineTotal: data.totalEquity },
          ],
          totals: { subtotal: data.totalAssets, tax: 0, total: data.totalLiabilities + data.totalEquity },
          notes: 'Assets should equal Liabilities + Equity. Current-year earnings are folded into Equity as line 3999 so the sheet balances without a formal period-close entry.',
        });
        return;
      }
      if (kind === 'TB') {
        await buildAndSaveDocPdf({
          docType: 'Trial Balance',
          docNumber: `as_of_${data.asOf}`,
          meta: [
            { label: 'As of', value: data.asOf },
            { label: 'Total Debits', value: fmtMoney(data.totalDebit) },
            { label: 'Total Credits', value: fmtMoney(data.totalCredit) },
            { label: 'Balanced', value: data.balanced ? 'Yes ✓' : 'No — check journals' },
          ],
          // Trial balance uses two amount cells (debit / credit) but the
          // PDF helper only shows one. Encode both into the description
          // and put the net side into lineTotal so at-a-glance skimming
          // still works.
          lines: data.rows.map((r: any) => ({
            description: `${r.code} · ${r.name}${r.debit > 0 ? ` · DR ${fmtMoney(r.debit)}` : ''}${r.credit > 0 ? ` · CR ${fmtMoney(r.credit)}` : ''}`,
            quantity: '',
            lineTotal: r.debit > 0 ? r.debit : -r.credit,
          })),
          totals: { subtotal: data.totalDebit, tax: -data.totalCredit, total: data.totalDebit - data.totalCredit },
          notes: 'Trial balance sums every POSTED journal line per account. Debits and credits should net to zero. If not, a journal entry is unbalanced — check Accounting > Journal.',
        });
        return;
      }
      if (kind !== 'VAT') return;
      await buildAndSaveDocPdf({
        docType: 'VAT201 Return',
        docNumber: `${data.period.from}_${data.period.to}`,
        meta: [
          { label: 'Period From', value: data.period.from },
          { label: 'Period To', value: data.period.to },
          { label: 'Net VAT Due', value: fmtMoney(data.netVatDue) },
          { label: 'Direction', value: data.netVatDue >= 0 ? 'Payable to SARS' : 'Refund due' },
        ],
        lines: [
          { description: 'Box 1 · Standard-rated sales (taxable)',   quantity: '', lineTotal: data.standardRateSales.taxable },
          { description: 'Box 4 · Output VAT on standard sales',      quantity: '', lineTotal: data.standardRateSales.vat },
          { description: 'Box 2 · Zero-rated sales',                  quantity: '', lineTotal: data.zeroRatedSales },
          { description: 'Box 14 · Standard-rated purchases (taxable)', quantity: '', lineTotal: data.standardRatePurchases.taxable },
          { description: 'Box 15 · Input VAT on standard purchases',  quantity: '', lineTotal: data.standardRatePurchases.vat },
          { description: 'Net VAT (Output − Input)',                  quantity: '', lineTotal: data.netVatDue },
          // Memo rows — flagged so the reader understands they aren't
          // part of the SARS boxes above. Kept in the same table for
          // audit continuity rather than a separate page.
          ...(data.exemptSupplies > 0 ? [{ description: 'Memo · Exempt supplies (sales) — not on VAT201', quantity: '', lineTotal: data.exemptSupplies }] : []),
          ...(data.exemptPurchases > 0 ? [{ description: 'Memo · Exempt purchases — not on VAT201', quantity: '', lineTotal: data.exemptPurchases }] : []),
        ],
        totals: {
          subtotal: data.totalOutputTax,
          tax: -data.totalInputTax,
          total: data.netVatDue,
        },
        notes: 'This report is a computation aid — verify each box against SARS eFiling before submission. Only invoices and bills with a live ledger status (SENT/PARTIAL/PAID/OVERDUE for invoices, AWAITING_PAYMENT and onward for bills) contribute. DRAFT and VOID are excluded. Exempt supplies (SARS treatment: not a taxable supply) are listed as informational memos and never contribute to Box 1, 2, 4, 14 or 15.',
      });
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to generate PDF', 'ERROR');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-surface-container-high/40 p-1 rounded-lg">
          {(Object.keys(REPORT_LABELS) as ReportKind[]).map(k => (
            <button key={k} onClick={() => { setData(null); setKind(k); }} className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${kind === k ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>{REPORT_LABELS[k]}</button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {(kind === 'PL' || kind === 'VAT') ? (
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
          {['PL', 'BS', 'TB', 'VAT'].includes(kind) && (
            <SecondaryButton icon={<FileText className="w-3.5 h-3.5" />} onClick={savePdf} disabled={!data}>Save PDF</SecondaryButton>
          )}
        </div>
      </div>

      {loading && <div className="text-xs text-outline p-md">Loading report...</div>}
      {!loading && data && kind === 'PL' && <ProfitLossView data={data} />}
      {!loading && data && kind === 'BS' && <BalanceSheetView data={data} />}
      {!loading && data && kind === 'TB' && <TrialBalanceView data={data} />}
      {!loading && data && (kind === 'AR' || kind === 'AP') && <AgingView data={data} label={kind === 'AR' ? 'Customer' : 'Supplier'} />}
      {!loading && data && kind === 'VAT' && <Vat201View data={data} />}
    </div>
  );
};

const Vat201View: React.FC<{ data: any }> = ({ data }) => (
  <SectionCard title="VAT201 — Return Computation" badge={`${data.period.from} → ${data.period.to}`}>
    <div className="p-lg space-y-lg">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-md">
        <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low">
          <div className="text-[10px] uppercase text-outline">Output tax (Box 4)</div>
          <div className="font-mono font-bold text-green-400">{fmtMoney(data.totalOutputTax)}</div>
        </div>
        <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low">
          <div className="text-[10px] uppercase text-outline">Input tax (Box 15)</div>
          <div className="font-mono font-bold text-secondary">{fmtMoney(data.totalInputTax)}</div>
        </div>
        <div className={`p-3 rounded-lg border ${data.netVatDue >= 0 ? 'border-error/40 bg-error/10' : 'border-green-500/40 bg-green-500/10'}`}>
          <div className="text-[10px] uppercase text-outline">Net VAT</div>
          <div className={`font-mono font-bold ${data.netVatDue >= 0 ? 'text-error' : 'text-green-400'}`}>{fmtMoney(data.netVatDue)}</div>
          <div className="text-[9px] text-outline">{data.netVatDue >= 0 ? 'Payable to SARS' : 'Refund due'}</div>
        </div>
        <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low">
          <div className="text-[10px] uppercase text-outline">Zero-rated sales</div>
          <div className="font-mono font-bold">{fmtMoney(data.zeroRatedSales)}</div>
        </div>
      </div>

      <div className="rounded-lg border border-outline-variant/40 p-md text-xs space-y-1">
        <div className="flex justify-between"><span>Box 1 — Standard-rated sales (taxable)</span><span className="font-mono font-bold">{fmtMoney(data.standardRateSales.taxable)}</span></div>
        <div className="flex justify-between"><span>Box 2 — Zero-rated sales</span><span className="font-mono">{fmtMoney(data.zeroRatedSales)}</span></div>
        <div className="flex justify-between border-t border-outline-variant/40 pt-1"><span className="font-bold">Box 4 — Output VAT</span><span className="font-mono font-bold text-green-400">{fmtMoney(data.standardRateSales.vat)}</span></div>
        <div className="flex justify-between pt-2"><span>Box 14 — Standard-rated purchases (taxable)</span><span className="font-mono font-bold">{fmtMoney(data.standardRatePurchases.taxable)}</span></div>
        <div className="flex justify-between border-t border-outline-variant/40 pt-1"><span className="font-bold">Box 15 — Input VAT</span><span className="font-mono font-bold text-secondary">{fmtMoney(data.standardRatePurchases.vat)}</span></div>
        <div className="flex justify-between border-t-2 border-outline-variant pt-2 text-sm"><span className="font-black">Net VAT (Output − Input)</span><span className={`font-mono font-black ${data.netVatDue >= 0 ? 'text-error' : 'text-green-400'}`}>{fmtMoney(data.netVatDue)}</span></div>

        {/* Exempt supplies are NOT part of any SARS box on VAT201 — an
            exempt supply is not a taxable supply. Shown here as an
            informational memo only so the user can see they're being
            handled separately from Box 2 zero-rated sales. */}
        {(data.exemptSupplies > 0 || data.exemptPurchases > 0) && (
          <div className="mt-3 pt-2 border-t border-dashed border-outline-variant/40 space-y-1 text-outline">
            <div className="text-[10px] uppercase font-bold tracking-wider text-outline">Informational — not on VAT201</div>
            {data.exemptSupplies > 0 && (
              <div className="flex justify-between"><span>Exempt supplies (sales)</span><span className="font-mono">{fmtMoney(data.exemptSupplies)}</span></div>
            )}
            {data.exemptPurchases > 0 && (
              <div className="flex justify-between"><span>Exempt purchases</span><span className="font-mono">{fmtMoney(data.exemptPurchases)}</span></div>
            )}
          </div>
        )}
      </div>

      <details className="rounded-lg border border-outline-variant/40 bg-surface-container-low">
        <summary className="cursor-pointer px-3 py-2 text-xs font-bold uppercase tracking-wider">Supporting invoices ({data.invoices.length})</summary>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-container-high/60 text-outline text-[10px] uppercase sticky top-0">
              <tr><th className="px-md py-1.5">Number</th><th className="px-md py-1.5">Date</th><th className="px-md py-1.5">Client</th><th className="px-md py-1.5 text-right">Taxable</th><th className="px-md py-1.5 text-right">VAT</th></tr>
            </thead>
            <tbody>
              {data.invoices.map((r: any) => (
                <tr key={r.number} className="border-t border-outline-variant/20">
                  <td className="px-md py-1 font-mono text-primary">{r.number}</td>
                  <td className="px-md py-1 font-mono">{r.date}</td>
                  <td className="px-md py-1">{r.client}</td>
                  <td className="px-md py-1 text-right font-mono">{fmtMoney(r.taxable)}</td>
                  <td className="px-md py-1 text-right font-mono">{fmtMoney(r.vat)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="rounded-lg border border-outline-variant/40 bg-surface-container-low">
        <summary className="cursor-pointer px-3 py-2 text-xs font-bold uppercase tracking-wider">Supporting bills ({data.bills.length})</summary>
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-container-high/60 text-outline text-[10px] uppercase sticky top-0">
              <tr><th className="px-md py-1.5">Number</th><th className="px-md py-1.5">Date</th><th className="px-md py-1.5">Supplier</th><th className="px-md py-1.5 text-right">Taxable</th><th className="px-md py-1.5 text-right">VAT</th></tr>
            </thead>
            <tbody>
              {data.bills.map((r: any) => (
                <tr key={r.number} className="border-t border-outline-variant/20">
                  <td className="px-md py-1 font-mono text-primary">{r.number}</td>
                  <td className="px-md py-1 font-mono">{r.date}</td>
                  <td className="px-md py-1">{r.supplier}</td>
                  <td className="px-md py-1 text-right font-mono">{fmtMoney(r.taxable)}</td>
                  <td className="px-md py-1 text-right font-mono">{fmtMoney(r.vat)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  </SectionCard>
);

const ProfitLossView: React.FC<{ data: any }> = ({ data }) => (
  <SectionCard title="Profit & Loss" badge={`${data.from} → ${data.to}`}>
    <div className="p-lg space-y-4">
      {/* Headline metrics up top so the reader sees the net number
          before scrolling through the account breakdown. Margin % is
          rendered against total income and helps benchmark month-to-
          month even when raw revenue changes. */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-md">
        <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low">
          <div className="text-[10px] uppercase text-outline">Total income</div>
          <div className="font-mono font-bold text-green-400">{fmtMoney(data.totalIncome)}</div>
        </div>
        <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low">
          <div className="text-[10px] uppercase text-outline">Total expenses</div>
          <div className="font-mono font-bold text-error">{fmtMoney(data.totalExpenses)}</div>
        </div>
        <div className={`p-3 rounded-lg border ${data.netProfit >= 0 ? 'border-green-500/40 bg-green-500/10' : 'border-error/40 bg-error/10'}`}>
          <div className="text-[10px] uppercase text-outline">Net profit</div>
          <div className={`font-mono font-bold ${data.netProfit >= 0 ? 'text-green-400' : 'text-error'}`}>{fmtMoney(data.netProfit)}</div>
          <div className="text-[9px] text-outline">
            {data.totalIncome > 0 ? `${Math.round((data.netProfit / data.totalIncome) * 1000) / 10}% margin` : '—'}
          </div>
        </div>
      </div>
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
    {/* Metric strip mirrors the P&L one: total assets vs total
        liab+equity should match, and the "Balanced" pill in the badge
        catches unbalanced ledgers early. Current-year earnings surface
        here so the reader sees them without hunting through equity. */}
    <div className="p-lg pb-0 grid grid-cols-2 md:grid-cols-4 gap-md">
      <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low">
        <div className="text-[10px] uppercase text-outline">Total assets</div>
        <div className="font-mono font-bold text-primary">{fmtMoney(data.totalAssets)}</div>
      </div>
      <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low">
        <div className="text-[10px] uppercase text-outline">Total liabilities</div>
        <div className="font-mono font-bold">{fmtMoney(data.totalLiabilities)}</div>
      </div>
      <div className="p-3 rounded-lg border border-outline-variant/40 bg-surface-container-low">
        <div className="text-[10px] uppercase text-outline">Total equity</div>
        <div className="font-mono font-bold">{fmtMoney(data.totalEquity)}</div>
        {typeof data.currentEarnings === 'number' && Math.abs(data.currentEarnings) > 0.005 && (
          <div className="text-[9px] text-outline">incl. {fmtMoney(data.currentEarnings)} current-year</div>
        )}
      </div>
      <div className={`p-3 rounded-lg border ${data.balanced ? 'border-green-500/40 bg-green-500/10' : 'border-error/40 bg-error/10'}`}>
        <div className="text-[10px] uppercase text-outline">A = L + E</div>
        <div className={`font-mono font-bold ${data.balanced ? 'text-green-400' : 'text-error'}`}>
          {data.balanced ? 'Balanced' : `Δ ${fmtMoney(Math.abs(data.totalAssets - (data.totalLiabilities + data.totalEquity)))}`}
        </div>
      </div>
    </div>
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
