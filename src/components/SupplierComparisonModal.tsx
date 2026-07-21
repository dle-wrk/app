import React, { useState, useEffect } from 'react';
import { AlertTriangle, X, Loader2, TrendingDown, Package, Clock, RefreshCw } from 'lucide-react';

interface Shortage {
  component_id: string;
  resolved_part_number: string;
  description: string;
  qty_required: number;
  qty_on_hand: number;
  shortage_qty: number;
}

interface PriceComparison {
  partNumber: string;
  digikey: PriceData | null;
  mouser: PriceData | null;
  lcsc: PriceData | null;
  bestPrice: number | null;
  bestSupplier: string | null;
}

interface PriceData {
  price: number;
  currency: string;
  stock: number;
  moq: number;
  leadTime: number;
  cached: boolean;
  updatedAt: string;
}

interface SupplierComparisonModalProps {
  shortages: Shortage[];
  onClose: () => void;
  onSelectSupplier: (supplier: string) => void;
  triggerToast: (msg: string, type?: string) => void;
}

export default function SupplierComparisonModal({
  shortages,
  onClose,
  onSelectSupplier,
  triggerToast
}: SupplierComparisonModalProps) {
  const [comparisons, setComparisons] = useState<PriceComparison[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState<string>('');

  useEffect(() => {
    fetchComparisons();
  }, [shortages]);

  const fetchComparisons = async (forceRefresh = false) => {
    const partNumbers = shortages
      .filter(s => s.shortage_qty > 0 && !s.component_id.toUpperCase().includes('DNF'))
      .map(s => s.resolved_part_number);

    if (partNumbers.length === 0) {
      triggerToast('No parts to compare', 'WARNING');
      onClose();
      return;
    }

    if (forceRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const res = await fetch('/api/suppliers/compare-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partNumbers, forceRefresh }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to compare prices');
      setComparisons(data.comparisons || []);

      // Auto-select best supplier if available
      const bestSuppliers = data.comparisons
        .filter((c: PriceComparison) => c.bestSupplier)
        .map((c: PriceComparison) => c.bestSupplier);

      if (bestSuppliers.length > 0) {
        const mostCommon = bestSuppliers.reduce((acc: any, val: string) => {
          acc[val] = (acc[val] || 0) + 1;
          return acc;
        }, {});
        const preferred = Object.entries(mostCommon).sort((a, b) => (b[1] as number) - (a[1] as number))[0][0];
        setSelectedSupplier(preferred);
      }

      if (forceRefresh) {
        triggerToast('Prices refreshed from live suppliers', 'SUCCESS');
      }
    } catch (err: any) {
      triggerToast(err.message || 'Failed to compare prices', 'ERROR');
      if (!forceRefresh) onClose();
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleContinue = () => {
    if (!selectedSupplier) {
      triggerToast('Please select a supplier', 'ERROR');
      return;
    }
    onSelectSupplier(selectedSupplier);
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
        <div className="bg-surface-container rounded-xl border border-outline-variant p-lg flex flex-col items-center gap-md">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
          <p className="text-sm text-on-surface">Comparing supplier prices...</p>
        </div>
      </div>
    );
  }

  const shortageCount = shortages.filter(s => s.shortage_qty > 0 && !s.component_id.toUpperCase().includes('DNF')).length;

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
      <div className="bg-surface-container rounded-xl border border-outline-variant w-full max-w-6xl p-lg shadow-2xl max-h-[90vh] overflow-y-auto relative">
        <button
          onClick={onClose}
          className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface p-1.5 rounded transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center justify-between mb-md">
          <div className="flex items-center gap-2">
            <TrendingDown className="w-5 h-5 text-primary" />
            <h3 className="text-lg font-bold">Compare Supplier Prices</h3>
          </div>
          <button
            onClick={() => fetchComparisons(true)}
            disabled={refreshing}
            className="p-2 rounded hover:bg-surface-container-high transition-colors disabled:opacity-50"
            title="Fetch live prices from suppliers"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <p className="text-sm text-on-surface-variant mb-lg">
          Pricing comparison for {shortageCount} component{shortageCount !== 1 ? 's' : ''} across DigiKey, Mouser, and LCSC
        </p>

        {/* Price comparison table */}
        <div className="overflow-x-auto mb-lg border border-outline-variant rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-container-high border-b border-outline-variant">
                <th className="px-md py-2 text-left font-bold text-xs uppercase text-outline">Part Number</th>
                <th className="px-md py-2 text-center font-bold text-xs uppercase text-outline">DigiKey</th>
                <th className="px-md py-2 text-center font-bold text-xs uppercase text-outline">Mouser</th>
                <th className="px-md py-2 text-center font-bold text-xs uppercase text-outline">LCSC</th>
                <th className="px-md py-2 text-center font-bold text-xs uppercase text-primary">Best Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {comparisons.map(comp => (
                <tr key={comp.partNumber} className="hover:bg-surface-variant/20 transition">
                  <td className="px-md py-3 font-mono text-xs font-bold text-primary">{comp.partNumber}</td>
                  <td className="px-md py-3 text-center">
                    {comp.digikey ? (
                      <div className="space-y-1">
                        <div className="font-bold text-sm">${comp.digikey.price.toFixed(2)}</div>
                        {!comp.digikey.cached && <div className="text-[8px] bg-green-500/20 text-green-400 px-1 py-0.5 rounded uppercase font-bold">Live</div>}
                        {comp.digikey.cached && <div className="text-[8px] bg-surface-container text-outline px-1 py-0.5 rounded uppercase font-bold">Cached</div>}
                        <div className="text-[10px] text-on-surface-variant flex items-center justify-center gap-0.5">
                          <Package className="w-3 h-3" /> {comp.digikey.stock}
                        </div>
                        <div className="text-[10px] text-on-surface-variant flex items-center justify-center gap-0.5">
                          <Clock className="w-3 h-3" /> {comp.digikey.leadTime}d
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-outline italic">—</span>
                    )}
                  </td>
                  <td className="px-md py-3 text-center">
                    {comp.mouser ? (
                      <div className="space-y-1">
                        <div className="font-bold text-sm">${comp.mouser.price.toFixed(2)}</div>
                        {!comp.mouser.cached && <div className="text-[8px] bg-green-500/20 text-green-400 px-1 py-0.5 rounded uppercase font-bold">Live</div>}
                        {comp.mouser.cached && <div className="text-[8px] bg-surface-container text-outline px-1 py-0.5 rounded uppercase font-bold">Cached</div>}
                        <div className="text-[10px] text-on-surface-variant flex items-center justify-center gap-0.5">
                          <Package className="w-3 h-3" /> {comp.mouser.stock}
                        </div>
                        <div className="text-[10px] text-on-surface-variant flex items-center justify-center gap-0.5">
                          <Clock className="w-3 h-3" /> {comp.mouser.leadTime}d
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-outline italic">—</span>
                    )}
                  </td>
                  <td className="px-md py-3 text-center">
                    {comp.lcsc ? (
                      <div className="space-y-1">
                        <div className="font-bold text-sm">${comp.lcsc.price.toFixed(2)}</div>
                        {!comp.lcsc.cached && <div className="text-[8px] bg-green-500/20 text-green-400 px-1 py-0.5 rounded uppercase font-bold">Live</div>}
                        {comp.lcsc.cached && <div className="text-[8px] bg-surface-container text-outline px-1 py-0.5 rounded uppercase font-bold">Cached</div>}
                        <div className="text-[10px] text-on-surface-variant flex items-center justify-center gap-0.5">
                          <Package className="w-3 h-3" /> {comp.lcsc.stock}
                        </div>
                        <div className="text-[10px] text-on-surface-variant flex items-center justify-center gap-0.5">
                          <Clock className="w-3 h-3" /> {comp.lcsc.leadTime}d
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-outline italic">—</span>
                    )}
                  </td>
                  <td className="px-md py-3 text-center">
                    {comp.bestSupplier && comp.bestPrice ? (
                      <div className="bg-green-500/10 border border-green-500/20 rounded px-2 py-1 inline-block">
                        <div className="font-bold text-sm text-green-400">${comp.bestPrice.toFixed(2)}</div>
                        <div className="text-[10px] text-green-400 font-bold uppercase">{comp.bestSupplier}</div>
                      </div>
                    ) : (
                      <span className="text-xs text-outline italic">N/A</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Supplier selection */}
        <div className="bg-surface-container-high/50 rounded-lg p-md mb-lg">
          <label className="text-xs font-bold uppercase text-outline block mb-3">Select Preferred Supplier</label>
          <div className="flex gap-2 flex-wrap">
            {['digikey', 'mouser', 'lcsc'].map(supplier => (
              <button
                key={supplier}
                onClick={() => setSelectedSupplier(supplier)}
                className={`px-4 py-2 rounded-lg text-sm font-bold uppercase transition-all ${
                  selectedSupplier === supplier
                    ? 'bg-primary text-on-primary border border-primary'
                    : 'bg-surface-container border border-outline-variant text-on-surface hover:border-primary'
                }`}
              >
                {supplier === 'digikey' ? 'DigiKey' : supplier === 'mouser' ? 'Mouser' : 'LCSC'}
              </button>
            ))}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-surface-container-high text-on-surface text-sm font-bold hover:bg-surface-container-highest transition"
          >
            Cancel
          </button>
          <button
            onClick={handleContinue}
            disabled={!selectedSupplier}
            className="px-4 py-2 rounded-lg bg-primary text-on-primary text-sm font-bold hover:brightness-110 disabled:opacity-50 transition"
          >
            Continue to Create PO
          </button>
        </div>
      </div>
    </div>
  );
}
