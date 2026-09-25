import React, { useState } from 'react';
import { Item } from '../types';
import { fmtNumber } from '../lib/formatMoney';
import { detectLedSwatch, ledSwatchBackground } from '../lib/ledColor';
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
  // Simulation-map dialog state. Holds the alternates-group the operator
  // clicked so the modal can render its own radial map without having to
  // re-derive from the group list.
  const [mapGroup, setMapGroup] = useState<{
    commonName: string;
    commonValue: string;
    commonFootprint: string;
    alternates: Item[];
  } | null>(null);

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

  // Dynamic extract prefix filters (trimmed + uppercased so stray whitespace in
  // part numbers doesn't produce duplicate entries like "LED" and "LED ")
  const uniquePrefixes = Array.from(new Set(items.map(i => (i.partNumber || '').split('-')[0].trim().toUpperCase()))).filter(Boolean).sort();

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
                    {(() => {
                      // All alternates in a group share name/value/footprint,
                      // so a single detection on the first row is enough for
                      // the group banner. Individual rows still run their own
                      // detection below in case one row's description drifts.
                      const rep = group.alternates[0];
                      const led = rep ? detectLedSwatch(rep) : null;
                      if (!led) {
                        return (
                          <h4 className="text-sm font-bold text-on-surface tracking-tight">
                            {group.commonName}
                          </h4>
                        );
                      }
                      return (
                        <h4 className="text-sm font-bold text-on-surface tracking-tight flex items-center gap-1.5">
                          <span
                            className="inline-block w-3.5 h-3.5 rounded-full border border-outline-variant/60 shadow-inner shrink-0"
                            style={{ background: ledSwatchBackground(led) }}
                            title={`LED colour: ${led.label}`}
                          />
                          <span>{group.commonName}</span>
                          <span className="text-[10px] font-bold text-outline uppercase tracking-wider">· {led.label}</span>
                        </h4>
                      );
                    })()}
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
                            <span className="font-mono text-xs font-bold text-on-surface tracking-tight group-hover/item:text-primary transition-colors flex items-center gap-1.5 truncate">
                              {(() => {
                                const led = detectLedSwatch(altItem);
                                if (!led) return null;
                                return (
                                  <span
                                    className="inline-block w-3 h-3 rounded-full border border-outline-variant/60 shadow-inner shrink-0"
                                    style={{ background: ledSwatchBackground(led) }}
                                    title={`LED colour: ${led.label}`}
                                  />
                                );
                              })()}
                              <span className="truncate">{altItem.partNumber}</span>
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
                            {fmtNumber(altItem.stockLevel)} units
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
                <button
                  type="button"
                  onClick={() => setMapGroup({
                    commonName: group.commonName,
                    commonValue: group.commonValue,
                    commonFootprint: group.commonFootprint,
                    alternates: group.alternates,
                  })}
                  className="flex items-center gap-0.5 text-primary font-bold hover:underline cursor-pointer"
                  title="Open the simulation map — a radial view of this group's alternates around the primary spec, sized by available stock."
                >
                  Open simulation map <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="col-span-full p-8 text-center bg-surface-container rounded-xl border border-outline-variant font-mono text-xs text-on-surface-variant/80">
            No duplicated equivalents or alternate component groups found matching filter.
          </div>
        )}
      </div>

      {mapGroup && (
        <SimulationMapModal
          group={mapGroup}
          onClose={() => setMapGroup(null)}
          onItemClick={(pn) => {
            setMapGroup(null);
            onItemClick?.(pn);
          }}
        />
      )}

    </div>
  );
}

// ─── Simulation Map modal ──────────────────────────────────────────────
// A radial view of one alternates group: the highest-stock item sits at
// the centre as the "primary spec", every other alternate arranged
// around it. Node size scales with stock (so an out-of-stock alternate
// shrinks and a well-stocked one bulges), fill colour reports stock
// health, and clicking a node opens that SKU in Item Detail. LED groups
// keep their swatch on each node so the operator can still eyeball the
// colour even in this abstract view.
const SimulationMapModal: React.FC<{
  group: { commonName: string; commonValue: string; commonFootprint: string; alternates: Item[] };
  onClose: () => void;
  onItemClick?: (partNumber: string) => void;
}> = ({ group, onClose, onItemClick }) => {
  const primary = group.alternates[0];
  const others = group.alternates.slice(1);

  const W = 640;
  const H = 460;
  const cx = W / 2;
  const cy = H / 2;
  const outerRadius = 165;
  const centreRadius = 44;

  const maxStock = Math.max(1, ...group.alternates.map(a => a.stockLevel || 0));
  const nodeRadius = (stock: number) => {
    // Clamp so a zero-stock node still shows and a well-stocked node
    // doesn't overrun the layout.
    const scale = Math.min(1, Math.max(0.15, (stock || 0) / maxStock));
    return 18 + scale * 18;
  };
  const stockClass = (a: Item) => {
    const low = a.lowStockLvl ?? 10;
    if ((a.stockLevel || 0) <= 0) return { fill: 'rgba(239,68,68,0.18)', stroke: '#ef4444', label: 'out' };
    if ((a.stockLevel || 0) <= low) return { fill: 'rgba(245,158,11,0.18)', stroke: '#f59e0b', label: 'low' };
    return { fill: 'rgba(34,197,94,0.18)', stroke: '#22c55e', label: 'ok' };
  };

  return (
    <div
      className="fixed inset-0 z-[220] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md"
      onClick={onClose}
    >
      <div
        className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-lg py-md border-b border-outline-variant flex items-start gap-sm">
          <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <h4 className="font-bold text-sm text-on-surface">Simulation map — {group.commonName}</h4>
            <p className="text-[10px] text-outline mt-0.5">
              Radial view of every alternate around the primary-spec SKU. Node size ∝ stock level, fill colour reports stock health. Click any node to open that SKU in Item Detail.
            </p>
            <div className="text-[10px] text-outline font-mono mt-1">
              Spec-match: <span className="text-on-surface font-bold">{group.commonValue}</span> · Footprint: <span className="text-on-surface font-bold">{group.commonFootprint}</span> · Pool: <span className="text-on-surface font-bold">{group.alternates.length} SKUs</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-surface-variant/40 text-outline hover:text-on-surface" aria-label="Close">
            <ExternalLink className="w-4 h-4 rotate-45" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-md">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto max-h-[60vh]" role="img" aria-label={`Simulation map for ${group.commonName}`}>
            {/* Guide circle */}
            <circle cx={cx} cy={cy} r={outerRadius} fill="none" stroke="var(--md-sys-color-outline-variant, #444)" strokeDasharray="3 4" opacity={0.4} />

            {/* Edges from centre to each alternate */}
            {others.map((_, idx) => {
              const angle = (idx / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
              const x = cx + Math.cos(angle) * outerRadius;
              const y = cy + Math.sin(angle) * outerRadius;
              return (
                <line
                  key={`edge-${idx}`}
                  x1={cx}
                  y1={cy}
                  x2={x}
                  y2={y}
                  stroke="var(--md-sys-color-primary, #f7912b)"
                  strokeWidth={1}
                  opacity={0.35}
                />
              );
            })}

            {/* Primary node at centre */}
            {primary && (() => {
              const led = detectLedSwatch(primary);
              return (
                <g
                  transform={`translate(${cx}, ${cy})`}
                  className="cursor-pointer"
                  onClick={() => onItemClick?.(primary.partNumber)}
                >
                  <title>{`${primary.partNumber} — PRIMARY SPEC · ${fmtNumber(primary.stockLevel)} units`}</title>
                  <circle r={centreRadius} fill="var(--md-sys-color-primary, #f7912b)" fillOpacity={0.15} stroke="var(--md-sys-color-primary, #f7912b)" strokeWidth={2} />
                  {led && led.colors[0] && (
                    <circle r={7} cx={0} cy={-16} fill={led.colors[0]} stroke="rgba(255,255,255,0.4)" strokeWidth={1} />
                  )}
                  <text textAnchor="middle" y={-1} fontSize={10} fontFamily="ui-monospace, monospace" fontWeight="bold" fill="var(--md-sys-color-primary, #f7912b)">{primary.partNumber}</text>
                  <text textAnchor="middle" y={12} fontSize={9} fill="currentColor" opacity={0.7}>{fmtNumber(primary.stockLevel)} u</text>
                  <text textAnchor="middle" y={24} fontSize={7} fill="currentColor" opacity={0.5}>PRIMARY</text>
                </g>
              );
            })()}

            {/* Alternate nodes */}
            {others.map((a, idx) => {
              const angle = (idx / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
              const x = cx + Math.cos(angle) * outerRadius;
              const y = cy + Math.sin(angle) * outerRadius;
              const r = nodeRadius(a.stockLevel);
              const { fill, stroke, label } = stockClass(a);
              const led = detectLedSwatch(a);
              return (
                <g
                  key={a.partNumber}
                  transform={`translate(${x}, ${y})`}
                  className="cursor-pointer"
                  onClick={() => onItemClick?.(a.partNumber)}
                >
                  <title>{`${a.partNumber} · ${fmtNumber(a.stockLevel)} units · ${label}`}</title>
                  <circle r={r} fill={fill} stroke={stroke} strokeWidth={1.5} />
                  {led && led.colors[0] && (
                    <circle r={4.5} cx={0} cy={-r + 3} fill={led.colors[0]} stroke="rgba(255,255,255,0.4)" strokeWidth={0.8} />
                  )}
                  <text textAnchor="middle" y={0} fontSize={9} fontFamily="ui-monospace, monospace" fontWeight="bold" fill="currentColor">{a.partNumber}</text>
                  <text textAnchor="middle" y={11} fontSize={8} fill="currentColor" opacity={0.65}>{fmtNumber(a.stockLevel)}</text>
                </g>
              );
            })}
          </svg>
        </div>

        <div className="px-lg py-sm border-t border-outline-variant/60 bg-surface-container-low/40 flex items-center justify-between text-[10px] font-mono text-on-surface-variant/70">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500/40 border border-green-500" /> In stock</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-500/40 border border-amber-500" /> Low</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500/40 border border-red-500" /> Out</span>
          </div>
          <span>Node radius ∝ stock level · click any node to open Item Detail</span>
        </div>
      </div>
    </div>
  );
};