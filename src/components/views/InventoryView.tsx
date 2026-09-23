import React from 'react';
import { Upload, Plus, Search, Download } from 'lucide-react';
import { Item } from '../../types';
import { fmtUSD, fmtZAR, fmtNumber } from '../../lib/formatMoney';
import { CSV_HEADER, itemToCsvRow } from '../../mockData';

const USD_TO_ZAR_RATE = 18.50;

interface InventoryViewProps {
  items: Item[];
  filteredItems: Item[];
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  selectedItemType: string;
  setSelectedItemType: (type: string) => void;
  selectedStatus: string;
  setSelectedStatus: (status: string) => void;
  selectedStockStatus: string;
  setSelectedStockStatus: (status: any) => void;
  selectedPackaging: string;
  setSelectedPackaging: (mode: string) => void;
  availablePackagingModes: string[];
  availablePrefixes: string[];
  sortBy: 'name' | 'stockLevel' | 'price';
  setSortBy: (sort: 'name' | 'stockLevel' | 'price') => void;
  handleResetFilters: () => void;
  setShowImportModal: (show: boolean) => void;
  setShowAddModal: (show: boolean) => void;
  setSelectedDetailPartNumber: (partNumber: string | null) => void;
  isAdmin?: boolean;
}

export const InventoryView: React.FC<InventoryViewProps> = ({
  items,
  filteredItems,
  searchQuery,
  setSearchQuery,
  selectedItemType,
  setSelectedItemType,
  selectedStatus,
  setSelectedStatus,
  selectedStockStatus,
  setSelectedStockStatus,
  selectedPackaging,
  setSelectedPackaging,
  availablePackagingModes,
  availablePrefixes,
  sortBy,
  setSortBy,
  handleResetFilters,
  setShowImportModal,
  setShowAddModal,
  setSelectedDetailPartNumber,
  isAdmin = false,
}) => {
  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      {/* Header overview content */}
      <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-md mb-lg">
        <div className="min-w-0">
          <h3 className="font-headline-sm text-lg text-on-surface">Inventory items</h3>
          <p className="text-on-surface-variant font-body-sm">
            Check and modify individual product specifications and available stock.
          </p>
        </div>
        <div className="flex items-center gap-sm shrink-0">
          <button
            onClick={() => {
              // Round-trip with Import CSV: same delimiter, same column
              // order, same escaping — an exported file re-imports cleanly.
              // Exports the CURRENT filter view so operators can share a
              // slice (e.g. all critical stock) rather than the whole
              // catalogue every time.
              const rows = filteredItems.map(itemToCsvRow);
              const csv = CSV_HEADER + '\n' + rows.join('\n') + '\n';
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              const stamp = new Date().toISOString().slice(0, 10);
              a.download = `inventory_${stamp}.csv`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }}
            className="bg-surface-container-high hover:bg-surface-container-highest text-primary border border-primary/20 text-xs font-bold px-md py-2 rounded flex items-center gap-1.5 shadow-sm transition-all cursor-pointer"
            title={`Export ${filteredItems.length} rows (current filter) as CSV`}
          >
            <Download className="w-4 h-4" /> Export CSV
          </button>
          <button
            onClick={() => setShowImportModal(true)}
            className="bg-surface-container-high hover:bg-surface-container-highest text-primary border border-primary/20 text-xs font-bold px-md py-2 rounded flex items-center gap-1.5 shadow-sm transition-all cursor-pointer"
          >
            <Upload className="w-4 h-4" /> Import CSV
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="bg-primary text-on-primary text-xs font-bold px-md py-2 rounded flex items-center gap-1 shadow cursor-pointer"
          >
            <Plus className="w-4 h-4" /> Add SKU
          </button>
        </div>
      </div>

      {/* ADVANCED FILTERING TOOLBAR - Exclusive to Items view */}
      <div className="bg-surface-container border border-outline-variant rounded-xl p-3 shadow-sm flex flex-wrap items-center gap-4 text-xs text-on-surface mb-md">
        {/* Text Search Input */}
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-outline" />
          <input
            type="text"
            placeholder="Search SKU, name, mfr..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-surface-container-high border border-outline-variant rounded-lg pl-8 pr-6 py-1.5 text-xs text-on-surface focus:outline-none focus:border-primary placeholder-outline/50 font-mono"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface text-[10px] font-bold"
            >
              ✕
            </button>
          )}
        </div>

        {/* Type Filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-outline text-[11px] font-medium">Stock Code:</span>
          <select aria-label="Filter"
            value={selectedItemType}
            onChange={(e) => setSelectedItemType(e.target.value)}
            className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs cursor-pointer focus:outline-none focus:border-primary text-on-surface font-mono"
          >
            <option value="ALL" className="font-sans">All Codes</option>
            {availablePrefixes.map(prefix => (
              <option key={prefix} value={prefix}>
                {prefix}
              </option>
            ))}
          </select>
        </div>

        {/* Status Filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-outline text-[11px] font-medium">Status:</span>
          <select aria-label="Filter"
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs cursor-pointer focus:outline-none focus:border-primary text-on-surface"
          >
            <option value="ALL">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="BOOKED OUT">Booked Out</option>
          </select>
        </div>

        {/* Stock Health Filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-outline text-[11px] font-medium">Stock Health:</span>
          <select aria-label="Filter"
            value={selectedStockStatus}
            onChange={(e) => setSelectedStockStatus(e.target.value as any)}
            className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs cursor-pointer focus:outline-none focus:border-primary text-on-surface"
          >
            <option value="ALL">All Levels</option>
            <option value="OK">Healthy (≥ 19)</option>
            <option value="LOW">Low Level (&lt; 19)</option>
            <option value="CRITICAL">Out of Stock (0)</option>
          </select>
        </div>

        {/* Packaging / Storage Mode Filter — reads how each SKU is
            physically stored (reel, packet, tray, pallet, …). Options
            are computed from what actually appears in inventory so the
            list can't drift from reality. UNSPECIFIED is deliberately
            present (rather than hidden) so admins can find rows with
            no packaging value and fill them in. */}
        <div className="flex items-center gap-1.5">
          <span className="text-outline text-[11px] font-medium">Packaging:</span>
          <select
            aria-label="Filter by packaging"
            value={selectedPackaging}
            onChange={(e) => setSelectedPackaging(e.target.value)}
            className="bg-surface-container-high border border-outline-variant rounded px-2 py-1 text-xs cursor-pointer focus:outline-none focus:border-primary text-on-surface font-mono"
          >
            <option value="ALL" className="font-sans">All Packaging</option>
            {availablePackagingModes.map(mode => (
              <option key={mode} value={mode}>
                {mode === 'UNSPECIFIED' ? '— Not set —' : mode}
              </option>
            ))}
          </select>
        </div>

        {/* Filter Yield Output Counter */}
        <div className="ml-auto text-outline font-mono text-[11px]">
          Yield: <span className="text-primary font-bold">{filteredItems.length}</span> / {items.length}
        </div>
      </div>

      {/* Grid Item Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {filteredItems.map(item => (
          <div
            key={item.partNumber}
            onClick={() => setSelectedDetailPartNumber(item.partNumber)}
            className="bg-surface-container p-md rounded-xl border border-outline-variant hover:border-primary/50 transition-all duration-200 cursor-pointer flex flex-col justify-between"
          >
            <div>
              <div className="flex justify-between items-start mb-sm">
                <span className="text-[10px] font-mono text-primary font-bold">{item.partNumber}</span>
                <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold border ${item.status === 'ACTIVE' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                  item.status === 'INACTIVE' ? 'bg-red-500/10 text-red-500 border-red-500/20' :
                    item.status === 'BOOKED OUT' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' :
                      'bg-surface-container-highest text-outline border-outline-variant'
                  }`}>{item.status}</span>
              </div>
              <h4 className="font-bold text-sm text-on-surface leading-tight mt-1">{item.name}</h4>
              <p className="text-xs text-on-surface-variant line-clamp-2 mt-1">{item.description}</p>
              <span className="text-[10px] text-outline font-sans block mt-1">Manufacturer: {item.manufacturer}</span>
            </div>
            <div className="mt-md pt-sm border-t border-outline-variant/50 flex justify-between items-center bg-surface-container-high/20 px-1 py-1 rounded">
              <div>
                <span className="text-[9px] text-outline uppercase font-label-caps block">Stock</span>
                <span className={`font-mono text-sm font-bold ${item.stockLevel < 19 ? 'text-tertiary' : 'text-on-surface'}`}>
                  {fmtNumber(item.stockLevel ?? 0)} units
                </span>
              </div>
              <div className="text-right">
                <span className="text-[9px] text-outline uppercase font-label-caps block">Price</span>
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-sm font-bold text-green-400">
                    {fmtUSD(Number(item.price ?? 0))}
                  </span>
                  <span className="font-mono text-xs font-bold text-green-400">
                    {fmtZAR(Number(item.price ?? 0) * USD_TO_ZAR_RATE)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};