import React from 'react';
import { Download, Lightbulb } from 'lucide-react';
import { Transaction } from '../../types';

interface LedgerViewProps {
  transactions: Transaction[];
  ledgerFilter: string;
  setLedgerFilter: (filter: string) => void;
  ledgerSort: 'NEWEST' | 'OLDEST';
  setLedgerSort: (sort: 'NEWEST' | 'OLDEST') => void;
  handleExportCSV: (name: string) => void;
  triggerToast: (msg: string) => void;
}

export const LedgerView: React.FC<LedgerViewProps> = ({
  transactions,
  ledgerFilter,
  setLedgerFilter,
  ledgerSort,
  setLedgerSort,
  handleExportCSV,
  triggerToast
}) => {
  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      {/* Statistics Cards header */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-md">
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[9px] text-outline font-label-caps block mb-1">TOTAL TRX TODAY</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-black text-primary">1,284</span>
            <span className="text-green-400 text-xs font-bold font-mono">↑ 12%</span>
          </div>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[9px] text-outline font-label-caps block mb-1">NET STOCK CHANGE</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-black text-tertiary">+452</span>
            <span className="text-outline text-[11px] font-mono">units</span>
          </div>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[9px] text-outline font-label-caps block mb-1">ACTIVE USERS</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-black text-on-surface">48</span>
            <span className="text-outline text-[11px] font-sans">on floor</span>
          </div>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[9px] text-outline font-label-caps block mb-1">SYSTEM LATENCY</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-black text-green-400">14ms</span>
            <span className="text-outline text-[11px] font-mono">nominal</span>
          </div>
        </div>
      </div>

      {/* Ledger dynamic table filter tools bar */}
      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
        <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex justify-between items-center">
          <div className="flex items-center gap-md">
            <span className="font-bold text-sm">Transaction Ledger</span>
            <div className="hidden sm:flex gap-xs select-none">
              <button
                onClick={() => setLedgerFilter('ALL')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${ledgerFilter === 'ALL' ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-high text-on-surface-variant border-outline-variant'
                  }`}
              >
                FILTER: ALL
              </button>
              <button
                onClick={() => setLedgerFilter('INBOUND')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${ledgerFilter === 'INBOUND' ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-surface-container-high text-on-surface-variant border-outline-variant'
                  }`}
              >
                INBOUND ONLY
              </button>
              <button
                onClick={() => setLedgerFilter('OUTBOUND')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${ledgerFilter === 'OUTBOUND' ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-surface-container-high text-on-surface-variant border-outline-variant'
                  }`}
              >
                OUTBOUND ONLY
              </button>
            </div>
          </div>

          <div className="flex gap-sm">
            <button
              onClick={() => setLedgerSort(ledgerSort === 'NEWEST' ? 'OLDEST' : 'NEWEST')}
              className="bg-surface-container-high hover:bg-outline-variant text-[11px] font-bold px-sm py-1 rounded select-none border border-outline-variant"
            >
              SORT: {ledgerSort}
            </button>
            <button
              onClick={() => handleExportCSV('transaction_ledger_ledger')}
              className="bg-primary hover:bg-primary/90 text-on-primary text-[11px] font-extrabold px-sm py-1 rounded select-none flex items-center gap-1 shadow"
            >
              <Download className="w-3 h-3" /> Export CSV
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface-container-high text-[10px] uppercase font-mono text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">TRX ID</th>
                <th className="px-lg py-sm">Item specifications</th>
                <th className="px-lg py-sm">Type</th>
                <th className="px-lg py-sm text-right">Adjustment qty</th>
                <th className="px-lg py-sm">Reference</th>
                <th className="px-lg py-sm">Performed by</th>
                <th className="px-lg py-sm text-right">Date & time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-xs">
              {transactions
                .filter(t => ledgerFilter === 'ALL' || t.type === ledgerFilter)
                .map(trx => (
                  <tr key={trx.id} className="hover:bg-surface-variant/20 transition-all">
                    <td className="px-lg py-sm font-mono text-primary font-bold">{trx.id}</td>
                    <td className="px-lg py-sm font-semibold">
                      {trx.itemName}
                      <span className="text-[10px] text-outline font-normal block">{trx.itemPartNumber}</span>
                    </td>
                    <td className="px-lg py-sm">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-bold border ${trx.type === 'INBOUND' || trx.type === 'BOOK-IN'
                        ? 'bg-green-500/10 text-green-400 border-green-500/20'
                        : 'bg-red-500/10 text-red-400 border-red-500/20'
                        }`}>
                        {trx.type}
                      </span>
                    </td>
                    <td className={`px-lg py-sm font-mono text-right font-bold ${trx.qtyChange > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {trx.qtyChange > 0 ? `+${trx.qtyChange}` : trx.qtyChange}
                    </td>
                    <td className="px-lg py-sm font-mono text-outline">{trx.reference || 'N/A'}</td>
                    <td className="px-lg py-sm font-medium flex items-center gap-2 mt-1">
                      <div className="w-4 h-4 rounded-full overflow-hidden border border-outline-variant">
                        <img referrerPolicy="no-referrer" src={trx.performedByAvatar || 'https://lh3.googleusercontent.com/aida-public/AB6AXuOB_EY...'} className="w-full h-full object-cover" />
                      </div>
                      <span className="text-on-surface-variant">{trx.performedBy}</span>
                    </td>
                    <td className="px-lg py-sm text-outline text-right font-mono">{trx.dateTime}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Heatmap and Advice contextual cards layout */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-lg mt-xl">
        <div className="col-span-12 bg-surface-container-high border border-primary-container/20 p-lg rounded-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-xs text-primary mb-sm">
              <Lightbulb className="w-4 h-4" />
              <span className="font-label-caps text-[9px] uppercase font-bold tracking-wider">AI INSIGHT ACTION</span>
            </div>
            <h5 className="font-bold text-sm text-on-surface">Restock recommendation</h5>
            <p className="text-on-surface-variant text-xs mt-1 leading-relaxed italic pr-2">
              "Titanium Fastener M8 usage logs have increased dynamically by 400% on floor this week. Suggest raising safety reorder by 5,000 units."
            </p>
          </div>
          <button
            onClick={() => {
              triggerToast('Reorder workflow successfully triggered.');
            }}
            className="mt-lg w-full border border-primary text-primary hover:bg-primary hover:text-on-primary transition-all duration-150 py-2 rounded font-bold text-xs capitalize text-center shadow-sm"
          >
            Create Reorder Action
          </button>
        </div>
      </div>
    </div>
  );
};