import React from 'react';
import {
  Boxes,
  AlertTriangle,
  TrendingUp
} from 'lucide-react';
import { Item, ViewType } from '../../types';

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
  setView: (view: ViewType) => void;
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
  setView
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
        <div className="bg-surface-container p-5 rounded-xl border border-outline-variant hover:border-primary/50 transition-all duration-300 group relative overflow-hidden shadow-sm hover:shadow-primary/5">
          <div className="absolute -right-4 -top-4 opacity-5 group-hover:opacity-10 transition-all duration-500 transform group-hover:rotate-12 group-hover:scale-110">
            <TrendingUp className="w-24 h-24 text-primary" />
          </div>
          <div className="flex flex-col">
            <span className="text-on-surface-variant text-[11px] font-bold mb-2">Asset Valuation (USD)</span>
            <div className="flex items-baseline gap-sm">
              <span className="text-3xl font-black text-primary tracking-tighter">
                ${Math.round(totalValuation).toLocaleString()}
              </span>
            </div>
            <div className="mt-4">
              <svg className="w-full h-8 opacity-40 text-primary group-hover:opacity-80 transition-opacity" viewBox="0 0 60 20" preserveAspectRatio="none">
                <path d={sparklineCoords} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Main Dashboard Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-md items-start">

        {/* Stock Status - Left */}
        <div className="col-span-12 lg:col-span-4 bg-surface-container p-lg rounded-xl border border-outline-variant">
          <h4 className="font-headline-sm text-lg font-black tracking-tighter leading-none mb-lg">Stock Status</h4>
          <div className="relative flex justify-center items-center h-48">
            <div className="w-32 h-32 relative flex items-center justify-center">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="50" fill="transparent" stroke="currentColor" strokeWidth="10" className="text-primary/10" />
                {okPercent > 0 && (
                  <circle cx="60" cy="60" r="50" fill="transparent" stroke="var(--primary)" strokeWidth="10" strokeDasharray="314.159" strokeDashoffset={314.159 - (314.159 * okPercent) / 100} className="transition-all duration-1000 ease-out" />
                )}
                {lowPercent > 0 && (
                  <circle cx="60" cy="60" r="50" fill="transparent" stroke="#ffc107" strokeWidth="10" strokeDasharray="314.159" strokeDashoffset={314.159 - (314.159 * lowPercent) / 100} transform={`rotate(${(okPercent * 3.6)}, 60, 60)`} className="transition-all duration-1000 ease-out" />
                )}
                {criticalPercent > 0 && (
                  <circle cx="60" cy="60" r="50" fill="transparent" stroke="var(--error)" strokeWidth="10" strokeDasharray="314.159" strokeDashoffset={314.159 - (314.159 * criticalPercent) / 100} transform={`rotate(${((okPercent + lowPercent) * 3.6)}, 60, 60)`} className="transition-all duration-1000 ease-out" />
                )}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-lg font-bold text-primary">
                  {totalItemsCount >= 1000 ? `${(totalItemsCount / 1000).toFixed(1)}k` : totalItemsCount}
                </span>
                <span className="text-[10px] text-on-surface-variant font-bold">Total SKUs</span>
              </div>
            </div>
          </div>

          <div className="mt-lg space-y-sm text-xs select-none">
            <div className="flex items-center justify-between p-sm bg-surface-container-high/50 rounded-lg">
              <div className="flex items-center gap-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-primary"></span>
                <span className="text-on-surface-variant">In Stock</span>
              </div>
              <span className="font-mono font-bold text-primary">{okPercent}%</span>
            </div>
            <div className="flex items-center justify-between p-sm bg-surface-container-high/50 rounded-lg">
              <div className="flex items-center gap-sm">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#ffc107' }}></span>
                <span className="text-on-surface-variant">Low Stock</span>
              </div>
              <span className="font-mono font-bold" style={{ color: '#ffc107' }}>{lowPercent}%</span>
            </div>
            <div className="flex items-center justify-between p-sm bg-surface-container-high/50 rounded-lg">
              <div className="flex items-center gap-sm">
                <span className="w-2.5 h-2.5 rounded-full bg-error"></span>
                <span className="text-on-surface-variant">Critical</span>
              </div>
              <span className="font-mono font-bold text-error">{criticalPercent}%</span>
            </div>
          </div>
        </div>

        {/* Category Breakdown Table - Right */}
        <div className="col-span-12 lg:col-span-8 bg-surface-container p-lg rounded-xl border border-outline-variant">
          <h4 className="font-headline-sm text-lg font-black tracking-tighter leading-none mb-lg">Inventory by Category</h4>

          <div className="space-y-2 max-h-96 overflow-y-auto custom-scrollbar">
            {categoryCounts.map(({ cat, count }, idx) => {
              const percentage = Math.round((count / totalItemsCount) * 100);
              const themeColors = [
                'var(--primary)',
                '#7c3aed', // violet
                '#2563eb', // blue
                '#16a34a', // green
                '#ea580c', // orange
                '#dc2626', // red
                '#0891b2', // cyan
                '#8b5cf6'  // purple
              ];
              const barColor = themeColors[idx % themeColors.length];

              return (
                <div key={cat} className="group">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-bold text-on-surface flex-1 truncate">{cat}</span>
                    <span className="text-xs font-mono text-on-surface-variant">{count} SKUs</span>
                    <span className="text-xs font-bold text-primary ml-2 w-8 text-right">{percentage}%</span>
                  </div>
                  <div className="w-full bg-surface-container-high rounded-lg h-2 overflow-hidden">
                    <div
                      className="h-full rounded-lg transition-all duration-500 group-hover:brightness-110"
                      style={{ width: `${percentage}%`, backgroundColor: barColor }}
                    ></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

    </div>
  );
};