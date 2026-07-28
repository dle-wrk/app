import React from 'react';
import { Download, Lightbulb } from 'lucide-react';
import { Transaction } from '../../types';
import { formatTrxDateTime, isInboundType, isOutboundType } from '../../lib/mapDbTransaction';

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
  // Header metrics computed from the live ledger (these were previously
  // hard-coded placeholders: 1,284 / +452 / 48 / 14ms).
  const stats = React.useMemo(() => {
    const today = new Date().toDateString();
    let trxToday = 0;
    let netChange = 0;
    let inbound = 0;
    let outbound = 0;
    const contributors = new Set<string>();
    const consumed = new Map<string, { name: string; qty: number }>();

    for (const t of transactions) {
      const d = new Date(t.dateTime);
      if (!isNaN(d.getTime()) && d.toDateString() === today) trxToday++;
      const qty = Number(t.qtyChange) || 0;
      netChange += qty;
      if (isInboundType(t.type)) inbound++;
      else if (isOutboundType(t.type)) outbound++;
      if (t.performedBy) contributors.add(t.performedBy);

      if (qty < 0 && t.itemPartNumber) {
        const prev = consumed.get(t.itemPartNumber);
        consumed.set(t.itemPartNumber, {
          name: t.itemName || t.itemPartNumber,
          qty: (prev?.qty || 0) + Math.abs(qty),
        });
      }
    }

    let topConsumed: { partNumber: string; name: string; qty: number } | null = null;
    for (const [partNumber, v] of consumed) {
      if (!topConsumed || v.qty > topConsumed.qty) topConsumed = { partNumber, ...v };
    }

    return { trxToday, netChange, inbound, outbound, contributors: contributors.size, topConsumed };
  }, [transactions]);

  const visibleTransactions = React.useMemo(() => {
    const filtered = transactions.filter(t => {
      if (ledgerFilter === 'INBOUND') return isInboundType(t.type);
      if (ledgerFilter === 'OUTBOUND') return isOutboundType(t.type);
      return true;
    });
    // Sort by timestamp; entries with unparseable dates sink to the bottom.
    return [...filtered].sort((a, b) => {
      const ta = new Date(a.dateTime).getTime();
      const tb = new Date(b.dateTime).getTime();
      if (isNaN(ta) && isNaN(tb)) return 0;
      if (isNaN(ta)) return 1;
      if (isNaN(tb)) return -1;
      return ledgerSort === 'NEWEST' ? tb - ta : ta - tb;
    });
  }, [transactions, ledgerFilter, ledgerSort]);

  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      {/* Statistics Cards header */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-md">
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[9px] text-outline font-label-caps block mb-1">TRX TODAY</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-black text-primary">{stats.trxToday.toLocaleString()}</span>
            <span className="text-outline text-[11px] font-mono">of {transactions.length.toLocaleString()} total</span>
          </div>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[9px] text-outline font-label-caps block mb-1">NET STOCK CHANGE</span>
          <div className="flex items-baseline gap-2">
            <span className={`text-xl font-black ${stats.netChange >= 0 ? 'text-tertiary' : 'text-red-400'}`}>
              {stats.netChange > 0 ? `+${stats.netChange.toLocaleString()}` : stats.netChange.toLocaleString()}
            </span>
            <span className="text-outline text-[11px] font-mono">units</span>
          </div>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[9px] text-outline font-label-caps block mb-1">IN / OUT MOVEMENTS</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-black text-green-400">{stats.inbound}</span>
            <span className="text-outline text-[11px] font-mono">in</span>
            <span className="text-xl font-black text-red-400">{stats.outbound}</span>
            <span className="text-outline text-[11px] font-mono">out</span>
          </div>
        </div>
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
          <span className="text-[9px] text-outline font-label-caps block mb-1">CONTRIBUTORS</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-black text-on-surface">{stats.contributors}</span>
            <span className="text-outline text-[11px] font-sans">logged operators</span>
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
              {visibleTransactions.map(trx => (
                  <tr key={trx.id} className="hover:bg-surface-variant/20 transition-all">
                    <td className="px-lg py-sm font-mono text-primary font-bold">
                      {/* Trx references can be long (TRX-KIT-<part>-<epoch>); keep the
                          column narrow and expose the full value on hover. */}
                      <span className="block max-w-[160px] truncate" title={trx.id}>{trx.id}</span>
                    </td>
                    <td className="px-lg py-sm font-semibold">
                      {trx.itemName || <span className="text-outline font-normal italic">Unknown item</span>}
                      <span className="text-[10px] text-outline font-normal block">{trx.itemPartNumber || '—'}</span>
                    </td>
                    <td className="px-lg py-sm">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-bold border ${isInboundType(trx.type)
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
                    <td className="px-lg py-sm font-medium">
                      <div className="flex items-center gap-2">
                        {trx.performedByAvatar && (
                          <div className="w-4 h-4 rounded-full overflow-hidden border border-outline-variant shrink-0">
                            <img referrerPolicy="no-referrer" src={trx.performedByAvatar} className="w-full h-full object-cover" />
                          </div>
                        )}
                        <span className="text-on-surface-variant">{trx.performedBy || 'System'}</span>
                      </div>
                    </td>
                    <td className="px-lg py-sm text-outline text-right font-mono whitespace-nowrap">{formatTrxDateTime(trx.dateTime)}</td>
                  </tr>
                ))}
              {visibleTransactions.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-lg py-12 text-center text-outline italic font-mono">
                    {transactions.length === 0
                      ? 'No ledger entries recorded yet.'
                      : `No ${ledgerFilter.toLowerCase()} movements in the ledger.`}
                  </td>
                </tr>
              )}
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
            <p className="text-on-surface-variant text-xs mt-1 leading-relaxed pr-2">
              {stats.topConsumed ? (
                <>
                  <span className="font-mono font-bold text-primary">{stats.topConsumed.partNumber}</span>
                  {' '}({stats.topConsumed.name}) is the most consumed part in the ledger, with{' '}
                  <span className="font-bold text-on-surface">{stats.topConsumed.qty.toLocaleString()} units</span>
                  {' '}booked out across {stats.outbound} outbound movement{stats.outbound === 1 ? '' : 's'}.
                </>
              ) : (
                <span className="italic">No outbound movements recorded yet — book out a kit to see consumption trends here.</span>
              )}
            </p>
          </div>
          <button
            onClick={() => {
              if (!stats.topConsumed) {
                triggerToast('No consumption data to base a reorder on yet.');
                return;
              }
              triggerToast(`Reorder action noted for ${stats.topConsumed.partNumber}. Raise the PO from Suppliers or the shortage workflow.`);
            }}
            disabled={!stats.topConsumed}
            className="mt-lg w-full border border-primary text-primary hover:bg-primary hover:text-on-primary transition-all duration-150 py-2 rounded font-bold text-xs capitalize text-center shadow-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-primary"
          >
            Create Reorder Action
          </button>
        </div>
      </div>
    </div>
  );
};