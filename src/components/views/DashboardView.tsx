import React from 'react';
import {
  Boxes,
  AlertTriangle,
  TrendingUp,
  PlusCircle,
  RefreshCw,
  FileDown,
  ChevronRight,
  Check,
  AlertCircle,
  Lightbulb
} from 'lucide-react';
import { Item, Transaction, ViewType } from '../../types';

interface DashboardViewProps {
  items: Item[];
  dateTimeStr: string;
  totalItemsCount: number;
  lowStockCount: number;
  criticalCount: number;
  totalValuation: number;
  sparklineCoords: string;
  categoryCounts: { cat: string; count: number }[];
  maxCategoryCount: number;
  okPercent: number;
  lowPercent: number;
  criticalPercent: number;
  transactions: Transaction[];
  setView: (view: ViewType) => void;
  handleStockSync: () => void;
  setShowAddModal: (show: boolean) => void;
  handleExportCSV: (name: string) => void;
  syncRotated: boolean;
  triggerToast: (msg: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  items,
  dateTimeStr,
  totalItemsCount,
  lowStockCount,
  criticalCount,
  totalValuation,
  sparklineCoords,
  categoryCounts,
  maxCategoryCount,
  okPercent,
  lowPercent,
  criticalPercent,
  transactions,
  setView,
  handleStockSync,
  setShowAddModal,
  handleExportCSV,
  syncRotated,
  triggerToast
}) => {
  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      {/* Welcome Header */}
      <div className="flex justify-between items-end">
        <div>
          <h3 className="font-headline-sm text-2xl font-black text-on-surface tracking-tighter leading-none mb-1">Inventory Insights</h3>
          <p className="text-on-surface-variant font-body-sm/80" id="current-datetime">
            {dateTimeStr}
          </p>
        </div>
      </div>

      {/* Stats Row: Bento Style */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-md">
        {/* Total Items */}
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant hover:border-primary/50 transition-colors group relative overflow-hidden">
          <div className="absolute -right-2 -top-2 opacity-5 group-hover:opacity-10 transition-opacity">
            <Boxes className="w-20 h-20 text-primary" />
          </div>
          <div className="flex flex-col gap-unit">
            <span className="text-on-surface-variant text-[11px] font-bold">Total items</span>
            <div className="flex items-baseline gap-sm">
              <span className="text-xl font-black text-primary">{totalItemsCount.toLocaleString()}</span>
              <span className="text-green-400 text-[10px] font-bold">+2.4%</span>
            </div>
            <div className="w-full bg-outline-variant h-1 mt-sm rounded-full overflow-hidden">
              <div className="bg-primary h-full w-3/4"></div>
            </div>
          </div>
        </div>

        {/* Active Projects */}
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant hover:border-secondary/50 transition-colors group">
          <div className="flex flex-col gap-unit">
            <span className="text-on-surface-variant text-[11px] font-bold">Active projects</span>
            <div className="flex items-baseline gap-sm">
              <span className="text-xl font-black text-secondary">12</span>
              <span className="text-on-surface-variant text-[10px] font-bold">Stable</span>
            </div>
            <div className="flex gap-1 mt-sm">
              <div className="w-4 h-4 rounded-full bg-secondary-container"></div>
              <div className="w-4 h-4 rounded-full bg-secondary"></div>
              <div className="w-4 h-4 rounded-full bg-outline-variant"></div>
            </div>
          </div>
        </div>

        {/* Low Stock Alerts */}
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant hover:border-tertiary/50 transition-colors">
          <div className="flex flex-col gap-unit">
            <span className="text-on-surface-variant text-[11px] font-bold">Low stock alerts</span>
            <div className="flex items-baseline gap-sm">
              <span className="text-xl font-black text-tertiary">{lowStockCount}</span>
              <AlertTriangle className="text-tertiary w-4 h-4" />
            </div>
            <p className="text-[10px] text-outline mt-sm italic">Immediate attention needed</p>
          </div>
        </div>

        {/* Critical Shortages */}
        <div className="bg-surface-container p-md rounded-xl border border-outline-variant hover:border-error transition-colors">
          <div className="flex flex-col gap-unit">
            <span className="text-on-surface-variant text-[11px] font-bold">Critical shortages</span>
            <div className="flex items-baseline gap-sm">
              <span className="text-xl font-black text-error">{criticalCount}</span>
              <span className="text-error text-[10px] font-bold">Urgently Required</span>
            </div>
            <div className="mt-sm flex gap-xs">
              <span className="h-1 flex-1 bg-error rounded-full"></span>
              <span className="h-1 flex-1 bg-error rounded-full"></span>
              <span className="h-1 flex-1 bg-error rounded-full"></span>
              <span className="h-1 flex-1 bg-outline-variant rounded-full"></span>
              <span className="h-1 flex-1 bg-outline-variant rounded-full"></span>
            </div>
          </div>
        </div>

        {/* Total Inventory Value */}
        <div className="bg-surface-container p-5 rounded-xl border border-outline-variant hover:border-green-400/50 transition-all duration-300 group relative overflow-hidden shadow-sm hover:shadow-green-400/5">
          <div className="absolute -right-4 -top-4 opacity-5 group-hover:opacity-10 transition-all duration-500 transform group-hover:rotate-12 group-hover:scale-110">
            <TrendingUp className="w-24 h-24 text-green-400" />
          </div>
          <div className="flex flex-col">
            <span className="text-on-surface-variant text-[11px] font-bold mb-2">Asset Valuation</span>
            <div className="flex items-baseline gap-sm">
              <span className="text-3xl font-black text-green-400 tracking-tighter">
                ${Math.round(totalValuation).toLocaleString()}
              </span>
            </div>
            <div className="mt-4">
              <svg className="w-full h-8 opacity-40 text-green-400 group-hover:opacity-80 transition-opacity" viewBox="0 0 60 20" preserveAspectRatio="none">
                <path d={sparklineCoords} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Main Dashboard Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-md items-start">

        {/* Category interactive Chart widget */}
        <div className="col-span-12 lg:col-span-8 bg-surface-container p-lg rounded-xl border border-outline-variant flex flex-col justify-between">
          <div className="flex items-center mb-xl h-8">
            <h4 className="font-headline-sm text-lg font-black tracking-tighter leading-none">Items by Category</h4>
          </div>

          <div className="overflow-x-auto pb-sm custom-scrollbar">
            <div className="h-64 flex items-end justify-between px-md gap-md min-w-[500px]">
              {categoryCounts.map(({ cat, count }, idx) => {
                const pctHeight = `${(count / maxCategoryCount) * 100}%`;
                // Cyan-tinted monochromatic palette
                const barColors = [
                  '#00e5ff', // Primary Cyan
                  '#00d4eb',
                  '#00c2d6',
                  '#00b1c2',
                  '#009fad',
                  '#008d99',
                  '#007c85',
                  '#006a70'
                ];
                const uniqueBarColor = barColors[idx % barColors.length];

                return (
                  <div key={cat} className="flex-1 flex flex-col items-center gap-sm group cursor-pointer min-w-[60px]">
                    <div className="w-full bg-outline-variant/10 rounded-t h-48 flex items-end relative overflow-hidden">
                      <div
                        className="w-full rounded-t transition-all duration-500 group-hover:brightness-110 group-hover:saturate-120"
                        style={{
                          height: pctHeight,
                          backgroundColor: uniqueBarColor
                        }}
                      ></div>
                      <span className="absolute top-2 left-1/2 -translate-x-1/2 bg-surface-container-lowest/90 backdrop-blur px-2 py-0.5 rounded text-[10px] font-mono font-bold text-on-surface shadow opacity-100 lg:opacity-0 group-hover:opacity-100 transition-opacity z-10 whitespace-nowrap border border-outline-variant/30">
                        {count} {count === 1 ? 'SKU' : 'SKUs'}
                      </span>
                    </div>
                    <span
                      className="text-[11px] font-mono text-outline w-full text-center transition-all group-hover:font-bold leading-tight wrap-break-words"
                      style={{ color: 'inherit' }}
                      title={cat}
                    >
                      {cat}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-md grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-6 gap-y-1.5 select-none">
            {categoryCounts.map(({ cat, count }) => {
              const idx = categoryCounts.findIndex(c => c.cat === cat);
              const barColors = ['#00e5ff', '#00d4eb', '#00c2d6', '#00b1c2', '#009fad', '#008d99', '#007c85', '#006a70'];
              const dotColor = barColors[idx % barColors.length];
              return (
                <div key={cat} className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
                  <span className="text-on-surface-variant truncate flex-1">{cat}</span>
                  <span className="font-mono font-bold text-on-surface">{count}</span>
                  <span className="text-outline text-[10px]">SKUs</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Stock status circular indicator ring breakdown */}
        <div className="col-span-12 lg:col-span-4 bg-surface-container p-lg rounded-xl border border-outline-variant min-h-88.5">
          <h4 className="font-headline-sm text-lg font-black tracking-tighter leading-none mb-lg">Stock Status</h4>
          <div className="relative flex justify-center items-center h-48">
            <div className="w-32 h-32 relative flex items-center justify-center">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="50" fill="transparent" stroke="currentColor" strokeWidth="10" className="text-primary-container/20" />
                {okPercent > 0 && (
                  <circle cx="60" cy="60" r="50" fill="transparent" stroke="var(--primary)" strokeWidth="10" strokeDasharray="314.159" strokeDashoffset={314.159 - (314.159 * okPercent) / 100} className="transition-all duration-1000 ease-out" />
                )}
                {lowPercent > 0 && (
                  <circle cx="60" cy="60" r="50" fill="transparent" stroke="var(--tertiary)" strokeWidth="10" strokeDasharray="314.159" strokeDashoffset={314.159 - (314.159 * lowPercent) / 100} transform={`rotate(${(okPercent * 3.6)}, 60, 60)`} className="transition-all duration-1000 ease-out" />
                )}
                {criticalPercent > 0 && (
                  <circle cx="60" cy="60" r="50" fill="transparent" stroke="var(--error)" strokeWidth="10" strokeDasharray="314.159" strokeDashoffset={314.159 - (314.159 * criticalPercent) / 100} transform={`rotate(${((okPercent + lowPercent) * 3.6)}, 60, 60)`} className="transition-all duration-1000 ease-out" />
                )}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-lg font-bold">
                  {totalItemsCount >= 1000 ? `${(totalItemsCount / 1000).toFixed(1)}k` : totalItemsCount}
                </span>
                <span className="text-[10px] text-outline font-bold">Total SKUs</span>
              </div>
            </div>
          </div>

          <div className="mt-md space-y-sm text-xs select-none">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-primary"></span>
                <span className="text-on-surface-variant">Status: OK</span>
              </div>
              <span className="font-mono font-bold text-on-surface">{okPercent}%</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-tertiary"></span>
                <span className="text-on-surface-variant">Status: Low</span>
              </div>
              <span className="font-mono font-bold text-on-surface">{lowPercent}%</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-error"></span>
                <span className="text-on-surface-variant">Status: Critical</span>
              </div>
              <span className="font-mono font-bold text-on-surface">{criticalPercent}%</span>
            </div>
          </div>
        </div>

        {/* Recent Transactions List widget */}
        <div className="col-span-12 lg:col-span-9 bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant flex justify-between items-center bg-surface-container-high/30">
            <h4 className="font-headline-sm text-lg font-black tracking-tighter leading-none">Recent Ledger Activity</h4>
            <button onClick={() => setView('reports_ledger')} className="text-primary text-xs font-bold hover:underline">View Full Ledger</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-surface-container-high/50 text-[11px] font-bold text-outline border-b border-outline-variant">
                  <th className="px-lg py-sm">ID</th>
                  <th className="px-lg py-sm">Item & description</th>
                  <th className="px-lg py-sm">Type</th>
                  <th className="px-lg py-sm text-right">Qty</th>
                  <th className="px-lg py-sm text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30 text-xs">
                {transactions.slice(0, 5).map(trx => (
                  <tr key={trx.id} className="hover:bg-surface-variant/20 transition-all cursor-pointer">
                    <td className="px-lg py-sm font-mono text-primary font-bold">{trx.id}</td>
                    <td className="px-lg py-sm font-semibold text-on-surface">
                      {trx.itemName}
                      <span className="text-[10px] text-outline font-normal block">{trx.itemPartNumber}</span>
                    </td>
                    <td className="px-lg py-sm">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-bold border ${trx.type === 'INBOUND' || trx.type === 'BOOK-IN' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>{trx.type}</span>
                    </td>
                    <td className={`px-lg py-sm font-mono text-right font-bold ${trx.qtyChange > 0 ? 'text-green-400' : 'text-red-400'}`}>{trx.qtyChange > 0 ? `+${trx.qtyChange}` : trx.qtyChange}</td>
                    <td className="px-lg py-sm text-outline text-right">{trx.dateTime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Quick operations panel widgets */}
        <div className="col-span-12 lg:col-span-3 space-y-4">
          <div className="bg-surface-container p-lg rounded-xl border border-outline-variant min-h-76 flex flex-col justify-between">
            <div>
              <h4 className="text-outline text-[11px] font-bold mb-md">Quick Operations</h4>
              <div className="space-y-sm">
                <button onClick={() => setShowAddModal(true)} className="w-full flex items-center justify-between p-sm rounded-lg bg-surface-container-high hover:bg-surface-variant border border-outline-variant transition-all duration-150 group">
                  <span className="flex items-center gap-sm font-bold text-xs select-none text-primary"><PlusCircle className="w-4 h-4" />Add New Component</span>
                  <ChevronRight className="w-4 h-4 text-outline group-hover:translate-x-1 transition-transform" />
                </button>
                <button onClick={handleStockSync} className="w-full flex items-center justify-between p-sm rounded-lg bg-surface-container-high hover:bg-surface-variant border border-outline-variant transition-all duration-150 group">
                  <span className="flex items-center gap-sm font-bold text-xs select-none text-secondary"><RefreshCw className="w-4 h-4" />Run Stock Sync</span>
                  <ChevronRight className="w-4 h-4 text-outline group-hover:translate-x-1 transition-transform" />
                </button>
                <button onClick={() => handleExportCSV('BOM_Export')} className="w-full flex items-center justify-between p-sm rounded-lg bg-surface-container-high hover:bg-surface-variant border border-outline-variant transition-all duration-150 group">
                  <span className="flex items-center gap-sm font-bold text-xs select-none text-tertiary"><FileDown className="w-4 h-4" />Export BOM</span>
                  <ChevronRight className="w-4 h-4 text-outline group-hover:translate-x-1 transition-transform" />
                </button>
              </div>
            </div>
            <div className="mt-xl p-3 rounded-lg bg-primary-container/5 border border-primary/20 text-[11px] font-mono select-none">
              <span className="text-[10px] text-outline font-bold block mb-1">SYSTEM HEALTH</span>
              <div className="flex items-center gap-1.5 text-on-surface">
                <span className="w-2 h-2 rounded-full bg-green-500"></span>
                <span>Database in Sync</span>
              </div>
              <p className="text-[9px] text-outline mt-1 font-normal block">Last backup backup: 14 mins ago</p>
            </div>
          </div>
        </div>

      </div>

      {/* Heatmap and Advice contextual cards */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-lg mt-xl">
        <div className="col-span-12 bg-surface-container-high border border-primary-container/20 p-lg rounded-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-xs text-primary mb-sm"><Lightbulb className="w-4 h-4" /><span className="text-[10px] font-bold">AI INSIGHT ACTION</span></div>
            <h5 className="font-headline-sm text-lg font-black tracking-tighter leading-none text-on-surface">Restock recommendation</h5>
            <p className="text-on-surface-variant text-xs mt-2 leading-relaxed italic pr-2">"Titanium Fastener M8 usage logs have increased dynamically by 400% on floor this week. Suggest raising safety reorder by 5,000 units."</p>
          </div>
          <button onClick={() => triggerToast('Reorder workflow successfully triggered.')} className="mt-lg w-full border border-primary text-primary hover:bg-primary hover:text-on-primary transition-all duration-150 py-2 rounded font-bold text-xs capitalize text-center shadow-sm">Create Reorder Action</button>
        </div>
      </div>
    </div>
  );
};