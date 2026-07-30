import React, { useState, useMemo } from 'react';
import {
  Database,
  Plus,
  Download,
  Edit3,
  Search,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Package,
  DollarSign,
  Banknote,
  Activity,
  Boxes,
  Table2,
  Link2,
  ChevronRight,
  ArrowRight,
  CircleDot,
  Layers,
  Wallet,
  Zap,
  Filter,
} from 'lucide-react';
import { ProductionKit, Project, Item, Transaction } from '../../types';

interface StockTablesViewProps {
  setIsKitModalOpen: (open: boolean) => void;
  selectedTableTab: 'Production_Kits' | 'users' | 'Item_Pricing';
  setSelectedTableTab: (tab: 'Production_Kits' | 'users' | 'Item_Pricing') => void;
  handleExportCSV: (name: string) => void;
  productionKits: ProductionKit[];
  projects: Project[];
  onEditKit: (kit: ProductionKit) => void;
  items: Item[];
  transactions: Transaction[];
  /** Same USD→ZAR rate the dashboard uses, so the two pages agree. */
  fxRate?: { usdToZar: number | null; lastUpdated: string | null; ageDays: number | null; stale: boolean } | null;
}

// ── Schema definition for the visual explorer ──────────────────────────────
interface SchemaTable {
  name: string;
  label: string;
  icon: React.ElementType;
  columns: string[];
  rowSource: () => number;
  relations: string[];
  accent: string;
}

export const StockTablesView: React.FC<StockTablesViewProps> = ({
  setIsKitModalOpen,
  selectedTableTab,
  setSelectedTableTab,
  handleExportCSV,
  productionKits,
  projects,
  onEditKit,
  items,
  transactions,
  fxRate,
}) => {
  const [tableSearch, setTableSearch] = useState('');
  const [showSchema, setShowSchema] = useState(false);

  // ── Computed analytics from real data ─────────────────────────────────────
  const analytics = useMemo(() => {
    const totalInventoryValue = items.reduce(
      (sum, item) => sum + (item.price || 0) * (item.stockLevel || 0),
      0
    );
    const totalSkus = items.length;
    const lowStockItems = items.filter(
      (item) => (item.lowStockLvl ?? 50) > 0 && (item.stockLevel || 0) <= (item.lowStockLvl ?? 50)
    );
    const criticalStock = lowStockItems.filter(
      (item) => (item.stockLevel || 0) <= (item.lowStockLvl ?? 50) * 0.5
    );
    const activeKits = productionKits.filter(
      (k) => k.status === 'READY' || k.status === 'ACTIVE'
    ).length;
    const stagingKits = productionKits.filter((k) => k.status === 'STAGING').length;
    const blockedKits = productionKits.filter((k) => k.status === 'BLOCKED').length;

    const now = new Date();
    const last24h = transactions.filter((tx) => {
      const txDate = new Date(tx.dateTime);
      const diff = now.getTime() - txDate.getTime();
      return diff < 24 * 60 * 60 * 1000;
    });
    const inboundToday = last24h
      .filter((tx) => tx.qtyChange > 0)
      .reduce((sum, tx) => sum + tx.qtyChange, 0);
    const outboundToday = last24h
      .filter((tx) => tx.qtyChange < 0)
      .reduce((sum, tx) => sum + Math.abs(tx.qtyChange), 0);

    const zarValue = items.reduce(
      (sum, item) => sum + (item.bulkPriceZar || 0) * (item.stockLevel || 0),
      0
    );

    // Coverage for the bulk-pricing figure: it only sums items that actually
    // carry a bulk_price_zar, so the card states how much of the stock it spans.
    const stockedCount = items.filter(i => (i.stockLevel || 0) > 0).length;
    const bulkPricedCount = items.filter(
      i => (i.stockLevel || 0) > 0 && (i.bulkPriceZar || 0) > 0
    ).length;

    return {
      totalInventoryValue,
      zarValue,
      stockedCount,
      bulkPricedCount,
      totalSkus,
      lowStockCount: lowStockItems.length,
      criticalCount: criticalStock.length,
      activeKits,
      stagingKits,
      blockedKits,
      inboundToday,
      outboundToday,
      movementCount: last24h.length,
    };
  }, [items, transactions, productionKits]);

  // ── Schema tables for the visual explorer ─────────────────────────────────
  const schemaTables: SchemaTable[] = useMemo(
    () => [
      {
        name: 'Production_Kits',
        label: 'Production Kits',
        icon: Boxes,
        columns: ['kitId', 'skuReference', 'status', 'qtyAvailable', 'assemblyLine', 'lastUpdated', 'projectId'],
        rowSource: () => productionKits.length,
        relations: ['Projects'],
        accent: 'text-blue-400',
      },
      {
        name: 'Item_Pricing',
        label: 'Item Pricing',
        icon: DollarSign,
        columns: ['partNumber', 'name', 'price', 'bulkPriceUsd', 'bulkPriceZar', 'supplier', 'status'],
        rowSource: () => items.length,
        relations: ['Items'],
        accent: 'text-green-400',
      },
      {
        name: 'users',
        label: 'Users Ledger',
        icon: Activity,
        columns: ['id', 'email', 'role', 'status', 'lastLogin'],
        rowSource: () => 4209,
        relations: [],
        accent: 'text-purple-400',
      },
      {
        name: 'Transactions',
        label: 'Stock Movements',
        icon: ArrowRight,
        columns: ['id', 'itemPartNumber', 'type', 'qtyChange', 'reference', 'performedBy', 'dateTime'],
        rowSource: () => transactions.length,
        relations: ['Items'],
        accent: 'text-orange-400',
      },
      {
        name: 'Projects',
        label: 'Projects',
        icon: Layers,
        columns: ['id', 'projectName', 'status', 'createdDate', 'assignedTeam'],
        rowSource: () => projects.length,
        relations: ['Production_Kits', 'BOM_Items'],
        accent: 'text-cyan-400',
      },
    ],
    [productionKits, items, transactions, projects]
  );

  // ── Filtered table data based on search ───────────────────────────────────
  const filteredKits = useMemo(() => {
    if (!tableSearch) return productionKits;
    const q = tableSearch.toLowerCase();
    return productionKits.filter(
      (kit) =>
        kit.kitId.toLowerCase().includes(q) ||
        kit.skuReference.toLowerCase().includes(q) ||
        kit.assemblyLine.toLowerCase().includes(q) ||
        kit.status.toLowerCase().includes(q)
    );
  }, [productionKits, tableSearch]);

  const filteredPricingItems = useMemo(() => {
    if (!tableSearch) return items;
    const q = tableSearch.toLowerCase();
    return items.filter(
      (item) =>
        item.partNumber.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        (item.supplier || '').toLowerCase().includes(q) ||
        (item.manufacturer || '').toLowerCase().includes(q)
    );
  }, [items, tableSearch]);

  const formatCurrency = (val: number) =>
    val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="p-container-margin space-y-5 max-w-7xl mx-auto w-full">
      {/* ════════════════════════════════════════════════════════════════════════
          SECTION 1: STOCK HEALTH ANALYTICS DASHBOARD
          ════════════════════════════════════════════════════════════════════════ */}
      <div className="rounded-2xl border border-outline-variant bg-gradient-to-br from-surface-container to-surface-container-high/30 overflow-hidden shadow-xl">
        <div className="px-5 py-4 border-b border-outline-variant/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/15 border border-primary/20 flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="font-black text-sm text-on-surface tracking-tight">Stock Health Analytics</h2>
              <p className="text-[10px] text-on-surface-variant/60 font-mono">Real-time computed from live transactional data</p>
            </div>
          </div>
          <button
            onClick={() => setShowSchema((s) => !s)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 ${
              showSchema
                ? 'bg-primary text-on-primary shadow-md'
                : 'bg-surface-container-high text-on-surface-variant border border-outline-variant hover:border-primary/40'
            }`}
          >
            <Link2 className="w-3.5 h-3.5" />
            {showSchema ? 'Hide' : 'Show'} Schema
          </button>
        </div>

        {/* Analytics metric cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-px bg-outline-variant/20">
          {/* Total Inventory Value */}
          <div className="bg-surface-container p-4 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Wallet className="w-4 h-4 text-green-400" />
              <span className="text-[9px] font-mono text-on-surface-variant/50 uppercase">USD</span>
            </div>
            <span className="text-lg font-black text-on-surface tracking-tight">
              ${formatCurrency(analytics.totalInventoryValue)}
            </span>
            <span className="text-[10px] text-on-surface-variant/60">Total Inventory Value (at cost)</span>
            {/* Same conversion the dashboard's Asset Valuation card shows, so the
                two pages report the same rand figure for stock at cost. This is
                distinct from Bulk Pricing Value, which is a resale measure. */}
            {fxRate?.usdToZar ? (
              <span className="text-[9px] text-on-surface-variant/50">
                ≈ R{formatCurrency(analytics.totalInventoryValue * fxRate.usdToZar)} @ {fxRate.usdToZar.toFixed(2)}/USD
              </span>
            ) : null}
          </div>

          {/* ZAR Value */}
          <div className="bg-surface-container p-4 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              {/* Not DollarSign — this card is rand. */}
              <Banknote className="w-4 h-4 text-amber-400" />
              <span className="text-[9px] font-mono text-on-surface-variant/50 uppercase">ZAR</span>
            </div>
            <span className="text-lg font-black text-on-surface tracking-tight">
              R{formatCurrency(analytics.zarValue)}
            </span>
            <span className="text-[10px] text-on-surface-variant/60">Bulk Pricing Value (resale)</span>
            {/* This sums bulk_price_zar, which most items do not have. Without
                stating coverage it reads as a whole-inventory figure sitting
                next to one, and looks wrong for being far smaller. */}
            {analytics.bulkPricedCount < analytics.stockedCount && (
              <span
                className="text-[9px] text-amber-400/80"
                title={`${analytics.stockedCount - analytics.bulkPricedCount} stocked items have no bulk price and contribute R0`}
              >
                {analytics.bulkPricedCount} of {analytics.stockedCount} stocked items priced
              </span>
            )}
          </div>

          {/* Total SKUs */}
          <div className="bg-surface-container p-4 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Package className="w-4 h-4 text-blue-400" />
              <span className="text-[9px] font-mono text-on-surface-variant/50 uppercase">SKUs</span>
            </div>
            <span className="text-lg font-black text-on-surface tracking-tight">
              {analytics.totalSkus.toLocaleString()}
            </span>
            <span className="text-[10px] text-on-surface-variant/60">Active Stock Codes</span>
          </div>

          {/* Low Stock Alerts */}
          <div className="bg-surface-container p-4 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <AlertTriangle className={`w-4 h-4 ${analytics.criticalCount > 0 ? 'text-red-400' : 'text-yellow-400'}`} />
              <span className="text-[9px] font-mono text-on-surface-variant/50 uppercase">Alerts</span>
            </div>
            <span className={`text-lg font-black tracking-tight ${analytics.criticalCount > 0 ? 'text-red-400' : 'text-on-surface'}`}>
              {analytics.lowStockCount}
              {analytics.criticalCount > 0 && (
                <span className="text-[10px] text-red-400/80 ml-1">({analytics.criticalCount} critical)</span>
              )}
            </span>
            <span className="text-[10px] text-on-surface-variant/60">Low Stock Items</span>
          </div>

          {/* Active Kits */}
          <div className="bg-surface-container p-4 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Boxes className="w-4 h-4 text-cyan-400" />
              <span className="text-[9px] font-mono text-on-surface-variant/50 uppercase">Kits</span>
            </div>
            <span className="text-lg font-black text-on-surface tracking-tight">
              {analytics.activeKits}
              <span className="text-[10px] text-on-surface-variant/50 ml-1">/ {productionKits.length}</span>
            </span>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-yellow-400">{analytics.stagingKits} staging</span>
              <span className="text-red-400">{analytics.blockedKits} blocked</span>
            </div>
          </div>

          {/* Movements 24h */}
          <div className="bg-surface-container p-4 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Activity className="w-4 h-4 text-orange-400" />
              <span className="text-[9px] font-mono text-on-surface-variant/50 uppercase">24h</span>
            </div>
            <span className="text-lg font-black text-on-surface tracking-tight">
              {analytics.movementCount}
            </span>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-green-400 flex items-center gap-0.5">
                <TrendingUp className="w-3 h-3" />+{analytics.inboundToday.toLocaleString()}
              </span>
              <span className="text-red-400 flex items-center gap-0.5">
                <TrendingDown className="w-3 h-3" />-{analytics.outboundToday.toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          SECTION 2: DATABASE SCHEMA EXPLORER (toggleable)
          ════════════════════════════════════════════════════════════════════════ */}
      {showSchema && (
        <div className="rounded-2xl border border-outline-variant bg-surface-container/50 overflow-hidden shadow-lg animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="px-5 py-3 border-b border-outline-variant/50 flex items-center gap-2">
            <Table2 className="w-4 h-4 text-primary" />
            <h3 className="font-black text-xs text-on-surface uppercase tracking-wider">Database Schema Explorer</h3>
            <span className="text-[10px] text-on-surface-variant/50 font-mono ml-auto">{schemaTables.length} tables mapped</span>
          </div>
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {schemaTables.map((table) => (
              <div
                key={table.name}
                className="rounded-xl border border-outline-variant/60 bg-surface-container p-3.5 hover:border-primary/30 transition-all group cursor-pointer"
                onClick={() => {
                  if (table.name === 'Production_Kits' || table.name === 'users' || table.name === 'Item_Pricing') {
                    setSelectedTableTab(table.name as any);
                    setShowSchema(false);
                  }
                }}
              >
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-2">
                    <table.icon className={`w-4 h-4 ${table.accent}`} />
                    <span className="font-mono text-[11px] font-bold text-on-surface">{table.name}</span>
                  </div>
                  <span className="text-[9px] font-mono font-black bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
                    {table.rowSource().toLocaleString()} rows
                  </span>
                </div>
                <div className="space-y-0.5 mb-2.5">
                  {table.columns.slice(0, 5).map((col) => (
                    <div key={col} className="flex items-center gap-1.5 text-[10px] font-mono text-on-surface-variant/70">
                      <CircleDot className="w-2 h-2 text-outline-variant" />
                      {col}
                    </div>
                  ))}
                  {table.columns.length > 5 && (
                    <div className="text-[10px] font-mono text-on-surface-variant/40 pl-3.5">
                      +{table.columns.length - 5} more columns
                    </div>
                  )}
                </div>
                {table.relations.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-outline-variant/30">
                    <Link2 className="w-3 h-3 text-on-surface-variant/40" />
                    {table.relations.map((rel) => (
                      <span
                        key={rel}
                        className="text-[9px] font-mono bg-surface-container-high px-1.5 py-0.5 rounded text-on-surface-variant/80 border border-outline-variant/40"
                      >
                        {rel}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          SECTION 3: HEADER + TABLE SELECTOR
          ════════════════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-12 gap-4 items-center">
        <div className="col-span-12 md:col-span-6">
          <div className="bg-primary-container/10 border border-primary/20 text-primary px-3 py-1.5 rounded-full inline-flex items-center gap-2 text-xs font-mono">
            <Database className="w-3.5 h-3.5" />
            <span>DB: Neon Postgres (Connected)</span>
          </div>
          <p className="text-on-surface-variant/80 text-xs mt-1.5">
            Direct view on transactional systems tables and entity parameters.
          </p>
        </div>
        <div className="col-span-12 md:col-span-6 flex justify-end">
          <button
            onClick={() => setIsKitModalOpen(true)}
            className="bg-primary text-white px-4 py-2 rounded-lg font-bold text-xs shadow-md shadow-primary/10 hover:brightness-110 active:scale-95 transition-all flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Provision New Kit
          </button>
        </div>
      </div>

      {/* High Density Selection cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 select-none mt-5">
        {/* Users */}
        <div
          onClick={() => setSelectedTableTab('users')}
          className={`p-4 rounded-xl border flex flex-col gap-2.5 cursor-pointer transition-all duration-150 ${selectedTableTab === 'users'
            ? 'border-primary bg-primary/5 shadow-md'
            : 'border-outline-variant bg-surface-container hover:border-primary/40'
            }`}
        >
          <div className="flex justify-between items-center text-on-surface-variant/70 text-[11px] font-mono">
            <span>users</span>
            <span className="font-bold">4,209 Rows</span>
          </div>
          <h5 className="font-bold text-sm text-on-surface">users_ledger</h5>
          <p className="text-[11px] text-on-surface-variant/80">System access and security tokens.</p>
        </div>

        {/* Production kits */}
        <div
          onClick={() => setSelectedTableTab('Production_Kits')}
          className={`p-4 rounded-xl border flex flex-col gap-2.5 cursor-pointer transition-all duration-150 relative ${selectedTableTab === 'Production_Kits'
            ? 'border-primary bg-primary/5 shadow-md'
            : 'border-outline-variant bg-surface-container hover:border-primary/40'
            }`}
        >
          <span className="absolute top-2 right-2 bg-primary text-on-primary text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider">
            active
          </span>
          <div className="flex justify-between items-center text-on-surface-variant/70 text-[11px] font-mono">
            <span>Production_Kits</span>
            <span className="font-bold">{productionKits.length.toLocaleString()} Rows</span>
          </div>
          <h5 className={`font-bold text-sm ${selectedTableTab === 'Production_Kits' ? 'text-primary' : 'text-on-surface'}`}>
            Production_Kits
          </h5>
          <p className="text-[11px] text-on-surface-variant/80">BOM mapping and hardware logs.</p>
        </div>

        {/* Item pricing */}
        <div
          onClick={() => setSelectedTableTab('Item_Pricing')}
          className={`p-4 rounded-xl border flex flex-col gap-2.5 cursor-pointer transition-all duration-150 ${selectedTableTab === 'Item_Pricing'
            ? 'border-primary bg-primary/5 shadow-md'
            : 'border-outline-variant bg-surface-container hover:border-primary/40'
            }`}
        >
          <div className="flex justify-between items-center text-on-surface-variant/70 text-[11px] font-mono">
            <span>Item_Pricing</span>
            <span className="font-bold">{items.length.toLocaleString()} Rows</span>
          </div>
          <h5 className="font-bold text-sm text-on-surface">Item_Pricing</h5>
          <p className="text-[11px] text-on-surface-variant/80">Standard vendor rates directory.</p>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════════════════
          SECTION 4: RAW DATABASE DISPLAY TABLE
          ════════════════════════════════════════════════════════════════════════ */}
      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-xl mt-4">
        <div className="px-4 py-3 border-b border-outline-variant bg-surface-container-high/40 flex justify-between items-center gap-3">
          <span className="font-mono text-xs uppercase tracking-wider font-black text-on-surface-variant">
            VIEWING TABLE: {selectedTableTab.toUpperCase()}
          </span>
          <div className="flex items-center gap-2">
            {/* In-table search */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-on-surface-variant/40" />
              <input
                type="text"
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
                placeholder="Filter rows..."
                className="pl-7 pr-3 py-1.5 text-[11px] font-mono bg-surface-container border border-outline-variant rounded-lg text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary/40 w-40 transition-all focus:w-56"
              />
            </div>
            {tableSearch && (
              <button
                onClick={() => setTableSearch('')}
                className="text-[10px] text-on-surface-variant/60 hover:text-on-surface font-mono"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => handleExportCSV(selectedTableTab)}
              className="bg-surface-container-high text-on-surface-variant border border-outline-variant p-1.5 rounded-lg hover:bg-surface-container-highest hover:text-on-surface transition-colors"
              title="Export CSV"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* ── Production_Kits Table ── */}
        {selectedTableTab === 'Production_Kits' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[900px]">
              <thead>
                <tr className="bg-surface-container-high/30 text-[10px] uppercase font-mono text-on-surface-variant/80 tracking-wider border-b border-outline-variant">
                  <th className="px-4 py-3">Kit ID</th>
                  <th className="px-4 py-3">SKU Reference</th>
                  <th className="px-4 py-3">Associated Project</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Available qty</th>
                  <th className="px-4 py-3">Assembly Line</th>
                  <th className="px-4 py-3 text-right">Last Updated</th>
                  <th className="px-4 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30 text-xs font-mono">
                {filteredKits.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-on-surface-variant/50">
                      No kits match "{tableSearch}"
                    </td>
                  </tr>
                ) : (
                  filteredKits.map((kit) => {
                    const project = projects.find((p) => p.id === kit.projectId);
                    return (
                      <tr key={kit.kitId} className="hover:bg-surface-variant/10 transition-colors">
                        <td className="px-4 py-3 text-primary font-bold">{kit.kitId}</td>
                        <td className="px-4 py-3 text-on-surface-variant">{kit.skuReference}</td>
                        <td className="px-4 py-3">
                          {project ? (
                            <span className="text-on-surface font-semibold">{project.projectName}</span>
                          ) : (
                            <span className="text-on-surface-variant/50 italic">None</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold border ${kit.status === 'READY'
                              ? 'bg-green-500/10 text-green-400 border-green-500/20'
                              : kit.status === 'STAGING'
                                ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'
                                : kit.status === 'BLOCKED'
                                  ? 'bg-red-500/10 text-red-400 border-red-500/20'
                                  : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                              }`}
                          >
                            {kit.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-on-surface font-semibold">
                          {(kit.qtyAvailable ?? 0).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-on-surface">{kit.assemblyLine}</td>
                        <td className="px-4 py-3 text-on-surface-variant/70 text-right">{kit.lastUpdated}</td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => onEditKit(kit)}
                            className="p-1.5 text-primary hover:bg-primary/10 rounded-lg transition-colors"
                            title="Edit Kit"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Item_Pricing Table (NEW: shows real data) ── */}
        {selectedTableTab === 'Item_Pricing' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="bg-surface-container-high/30 text-[10px] uppercase font-mono text-on-surface-variant/80 tracking-wider border-b border-outline-variant">
                  <th className="px-4 py-3">Part Number</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Manufacturer</th>
                  <th className="px-4 py-3 text-right">Cost (USD)</th>
                  <th className="px-4 py-3 text-right">Bulk (ZAR)</th>
                  <th className="px-4 py-3 text-right">Stock</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30 text-xs font-mono">
                {filteredPricingItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-on-surface-variant/50">
                      No items match "{tableSearch}"
                    </td>
                  </tr>
                ) : (
                  filteredPricingItems.slice(0, 100).map((item) => (
                    <tr key={item.partNumber} className="hover:bg-surface-variant/10 transition-colors">
                      <td className="px-4 py-3 text-primary font-bold">{item.partNumber}</td>
                      <td className="px-4 py-3 text-on-surface max-w-[200px] truncate">{item.name}</td>
                      <td className="px-4 py-3 text-on-surface-variant">{item.manufacturer || '—'}</td>
                      <td className="px-4 py-3 text-right text-on-surface font-semibold">
                        ${formatCurrency(item.price || 0)}
                      </td>
                      <td className="px-4 py-3 text-right text-amber-400/80">
                        R{formatCurrency(item.bulkPriceZar || 0)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={
                            (item.stockLevel || 0) <= (item.lowStockLvl ?? 50)
                              ? 'text-red-400 font-bold'
                              : 'text-on-surface'
                          }
                        >
                          {(item.stockLevel || 0).toLocaleString()}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold border ${item.status === 'ACTIVE'
                            ? 'bg-green-500/10 text-green-400 border-green-500/20'
                            : item.status === 'DISCONTINUED'
                              ? 'bg-red-500/10 text-red-400 border-red-500/20'
                              : item.status === 'BOOKED OUT'
                                ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20'
                                : 'bg-gray-500/10 text-gray-400 border-gray-500/20'
                            }`}
                        >
                          {item.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {filteredPricingItems.length > 100 && (
              <div className="px-4 py-2.5 border-t border-outline-variant/30 text-center text-[10px] font-mono text-on-surface-variant/50">
                Showing 100 of {filteredPricingItems.length.toLocaleString()} rows — use search to filter
              </div>
            )}
          </div>
        )}

        {/* ── Users Table (placeholder) ── */}
        {selectedTableTab === 'users' && (
          <div className="p-8 text-center text-xs text-on-surface-variant/80 font-mono">
            Database table <span className="text-secondary font-bold">"users"</span> is loaded from SQLite. Total rows tracked in backend.
          </div>
        )}
      </div>
    </div>
  );
};