import React, { useState } from 'react';
import { Item } from '../types';
import {
  ArrowRightLeft,
  Search,
  SlidersHorizontal,
  Tags,
  Building2,
  Percent,
  HelpCircle,
  Boxes,
  TrendingUp,
  Award,
  AlertTriangle,
  Lightbulb,
  ExternalLink,
  ChevronRight,
  Sparkles
} from 'lucide-react';

interface AlternatesManagerProps {
  items: Item[];
  triggerToast: (msg: string) => void;
  onItemClick?: (partNumber: string) => void;
}

export default function AlternatesManager({
  items,
  triggerToast,
  onItemClick
}: AlternatesManagerProps) {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedPrefix, setSelectedPrefix] = useState<string>('ALL');

  // Helper to standardise comparison strings
  const cleanString = (str: string | undefined): string => {
    if (!str) return '';
    return str.trim().toLowerCase().replace(/\s+/g, '');
  };

  // Algorithm configuration:
  // 1. Group items by strict (name + value + footprint + description) signature
  const rawGroups: Record<string, Item[]> = {};
  items.forEach(item => {
    const nameKey = cleanString(item.name);
    const valKey = cleanString(item.value);
    const footKey = cleanString(item.footprint);
    const descKey = cleanString(item.description);

    const key = `${nameKey}|${valKey}|${footKey}|${descKey}`;

    if (!rawGroups[key]) {
      rawGroups[key] = [];
    }
    rawGroups[key].push(item);
  });

  // 2. Filter down to groups that actually contain more than 1 item (has alternates)
  const structuralGroups = Object.entries(rawGroups)
    .filter(([_, groupItems]) => groupItems.length > 1)
    .map(([key, groupItems]) => {
      const parts = key.split('|');
      return {
        signatureKey: key,
        commonName: groupItems[0].name,
        commonValue: groupItems[0].value || 'N/A',
        commonFootprint: groupItems[0].footprint || 'Generic',
        commonCategory: groupItems[0].category || 'Component',
        alternates: groupItems.sort((a, b) => b.stockLevel - a.stockLevel) // Primary Spec has higher stock
      };
    });

  // 3. Apply operational search matching filter layouts
  const filteredGroups = structuralGroups.filter(g => {
    const matchesSearch =
      g.commonName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      g.commonValue.toLowerCase().includes(searchQuery.toLowerCase()) ||
      g.alternates.some(a => a.partNumber.toLowerCase().includes(searchQuery.toLowerCase()));

    if (selectedPrefix === 'ALL') return matchesSearch;
    return matchesSearch && g.alternates.some(a => a.partNumber.startsWith(selectedPrefix));
  });

  // Dynamic extract prefix filters
  const uniquePrefixes = Array.from(new Set(items.map(i => i.partNumber.split('-')[0]))).filter(Boolean);

  return (
    <div className="space-y-4 animate-fade-in text-on-surface">

      {/* Search Header Action Dashboard Panel */}
      <div className="bg-surface-container p-4 rounded-xl border border-outline-variant shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-secondary/10 text-secondary rounded-lg border border-secondary/20">
            <ArrowRightLeft className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-primary tracking-tight">Component Cross-Reference Map</h3>
            <p className="text-xs text-on-surface-variant/80">Identify, group, and match compatible inventory hardware drop-in alternatives automatically.</p>
          </div>
        </div>

        {/* Filters Panel Deck Block */}
        <div className="flex items-center gap-2.5 self-end md:self-auto w-full md:w-auto">

          {/* Search Input Box */}
          <div className="relative flex-1 md:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60" />
            <input
              type="text"
              placeholder="Search by part, specs..."
              className="w-full bg-surface-container-low text-xs text-on-surface pl-9 pr-4 py-2 rounded-lg border border-outline-variant outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all placeholder:text-on-surface-variant/40"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Select Family Dropdown Container */}
          <div className="flex items-center gap-1.5 bg-surface-container-low border border-outline-variant rounded-lg px-2.5 py-2 shrink-0 text-xs text-on-surface-variant focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20 transition-all duration-150">
            <SlidersHorizontal className="w-3.5 h-3.5 text-on-surface-variant/70" />
            <select aria-label="Selection"
              className="bg-transparent text-on-surface font-semibold cursor-pointer text-xs outline-none pr-1"
              value={selectedPrefix}
              onChange={(e) => setSelectedPrefix(e.target.value)}
            >
              {/* Explicitly styled option components to guarantee background contrast in dropdown overlay lists */}
              <option value="ALL" className="bg-surface-container-high text-on-surface">All Codes</option>
              {uniquePrefixes.map(p => (
                <option key={p} value={p} className="bg-surface-container-high text-on-surface">
                  {p} Code
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Cross Match Cross Matrix Result Grid Layout */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {filteredGroups.length > 0 ? (
          filteredGroups.map(group => (
            <div
              key={group.signatureKey}
              className="bg-surface-container rounded-xl border border-outline-variant flex flex-col justify-between overflow-hidden shadow-sm hover:border-outline-variant/80 transition-all duration-200"
            >
              {/* Header group definition banner */}
              <div className="p-4 bg-surface-container-low/60 border-b border-outline-variant/60 flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase font-extrabold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 tracking-wide">
                      {group.commonCategory}
                    </span>
                    <h4 className="text-sm font-bold text-on-surface tracking-tight">
                      {group.commonName}
                    </h4>
                  </div>
                  <p className="text-[11px] font-mono text-on-surface-variant/90 leading-relaxed">
                    Spec-Match: <span className="text-on-surface font-bold">{group.commonValue}</span> &bull; Footprint: <span className="text-on-surface font-bold">{group.commonFootprint}</span>
                  </p>
                </div>

                <div className="text-right shrink-0">
                  <span className="text-[10px] font-mono text-on-surface-variant/70 block uppercase tracking-wider">Equivalent Pool</span>
                  <span className="text-base font-black text-secondary font-mono leading-none">
                    {group.alternates.length} <span className="text-xs font-bold text-on-surface-variant/80">SKUs</span>
                  </span>
                </div>
              </div>

              {/* Items Table Body Loop List Panel */}
              <div className="p-4 flex-1">
                <div className="space-y-2">
                  {group.alternates.map((altItem, idx) => {
                    const isOutOfStock = altItem.stockLevel <= 0;
                    const isLowStock = altItem.stockLevel > 0 && altItem.stockLevel <= (altItem.lowStockLvl || 10);

                    return (
                      <div
                        key={altItem.partNumber}
                        onClick={() => onItemClick?.(altItem.partNumber)}
                        className="group/item flex items-center justify-between p-3 rounded-lg bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant/50 hover:border-outline-variant transition-all duration-150 cursor-pointer"
                      >
                        {/* Left column descriptor data items */}
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <div className="w-2 h-2 rounded-full mt-1.5 shrink-0 bg-outline-variant group-hover/item:bg-primary transition-colors"></div>
                          <div className="min-w-0">
                            <span className="font-mono text-xs font-bold text-on-surface tracking-tight group-hover/item:text-primary transition-colors block truncate">
                              {altItem.partNumber}
                            </span>
                            <span className="text-[11px] text-on-surface-variant/70 line-clamp-1 mt-0.5">
                              {altItem.description}
                            </span>
                          </div>
                        </div>

                        {/* Right column status quantities metric blocks */}
                        <div className="flex flex-col items-end pl-3 shrink-0 text-right">
                          <span className="text-[10px] font-mono text-on-surface-variant/60 uppercase tracking-wide">Available</span>
                          <span className={`text-xs font-mono font-bold ${isOutOfStock
                              ? 'text-error'
                              : isLowStock
                                ? 'text-tertiary'
                                : 'text-success font-black'
                            }`}>
                            {altItem.stockLevel.toLocaleString()} units
                          </span>

                          {/* First position top preference marker layout indicator code banner */}
                          {idx === 0 && (
                            <span className="mt-1 inline-flex items-center gap-0.5 text-[8px] font-black font-mono uppercase bg-primary/10 text-primary px-1.5 py-0.5 rounded border border-primary/20 tracking-wider">
                              <Award className="w-2.5 h-2.5" />
                              Primary Spec
                            </span>
                          )}
                        </div>

                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Action indicator footer */}
              <div className="px-4 py-2.5 border-t border-outline-variant/40 bg-surface-container-low/40 text-[10px] font-mono text-on-surface-variant/60 flex justify-between items-center">
                <span>Inter-compatible hardware specifications</span>
                <span className="flex items-center gap-0.5 text-primary font-bold hover:underline cursor-pointer">
                  Simulation map active <ChevronRight className="w-3 h-3" />
                </span>
              </div>
            </div>
          ))
        ) : (
          <div className="col-span-full p-8 text-center bg-surface-container rounded-xl border border-outline-variant font-mono text-xs text-on-surface-variant/80">
            No duplicated equivalents or alternate component groups found matching filter.
          </div>
        )}
      </div>

    </div>
  );
}