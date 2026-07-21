import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import SupplierComparisonModal from './SupplierComparisonModal';

interface Shortage {
  component_id: string;
  resolved_part_number: string;
  description: string;
  comment: string;
  qty_required: number;
  qty_on_hand: number;
  shortage_qty: number;
}

interface ShortageToPOModalProps {
  shortages: Shortage[];
  onClose: () => void;
  onSuccess: (po: any) => void;
  triggerToast: (msg: string, type?: string) => void;
}

export default function ShortageToPOModal({ shortages, onClose, onSuccess, triggerToast }: ShortageToPOModalProps) {
  const [selectedSupplier, setSelectedSupplier] = useState<string>('');
  const [customSupplier, setCustomSupplier] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [showComparison, setShowComparison] = useState(false);

  const shortageList = shortages.filter(s => s.shortage_qty > 0);
  const poItems = shortageList.filter(s => !s.component_id.toUpperCase().includes('DNF'));
  const dnfItems = shortageList.filter(s => s.component_id.toUpperCase().includes('DNF'));
  const useCustom = selectedSupplier === 'custom';

  const handleSubmit = async () => {
    if (!useCustom && !selectedSupplier) {
      triggerToast('Please select a supplier', 'ERROR');
      return;
    }
    if (useCustom && !customSupplier.trim()) {
      triggerToast('Please enter a supplier name', 'ERROR');
      return;
    }

    setSaving(true);
    try {
      if (poItems.length === 0) {
        triggerToast('No items to order (all are DNF)', 'ERROR');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/shortages/convert-to-po', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shortages: poItems,
          supplierId: useCustom ? null : selectedSupplier || null,
          supplierName: useCustom ? customSupplier : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create PO');
      triggerToast(`PO ${data.po.poNumber} created with ${data.items.length} items`, 'SUCCESS');
      onSuccess(data.po);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to create PO', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
      <div className="bg-surface-container rounded-xl border border-outline-variant w-full max-w-2xl p-lg shadow-2xl max-h-[90vh] overflow-y-auto relative">
        <button
          onClick={onClose}
          className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface p-1.5 rounded transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-2 mb-md">
          <AlertTriangle className="w-5 h-5 text-error" />
          <h3 className="text-lg font-bold">Convert Shortages to Purchase Order</h3>
        </div>

        <p className="text-sm text-on-surface-variant mb-lg">
          {poItems.length} component{poItems.length !== 1 ? 's' : ''} will be added to a new PO. {dnfItems.length > 0 && `(${dnfItems.length} DNF items excluded)`}
        </p>

        {/* Items to order */}
        {poItems.length > 0 && (
          <div className="bg-primary/10 border border-primary/20 rounded-lg p-md mb-lg">
            <div className="text-xs font-bold text-primary uppercase mb-2">Items to order:</div>
            <div className="space-y-1">
              {poItems.map(s => (
                <div key={s.component_id} className="text-xs text-on-surface-variant flex justify-between">
                  <span>{s.component_id} - {s.description}</span>
                  <span className="font-mono font-bold text-primary">-{s.shortage_qty}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* DNF items (excluded) */}
        {dnfItems.length > 0 && (
          <div className="bg-surface-container-high/50 border border-outline-variant rounded-lg p-md mb-lg">
            <div className="text-xs font-bold text-outline uppercase mb-2">Do Not Fit (excluded from PO):</div>
            <div className="space-y-1">
              {dnfItems.map(s => (
                <div key={s.component_id} className="text-xs text-outline/60 flex justify-between line-through">
                  <span>{s.component_id}</span>
                  <span className="font-mono text-outline/60">-{s.shortage_qty}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Supplier selection */}
        <div className="space-y-3 mb-lg">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-bold uppercase text-outline">Select Supplier</label>
            <button
              onClick={() => setShowComparison(true)}
              className="text-xs font-bold text-primary hover:text-primary/80 transition uppercase tracking-wider"
            >
              Compare Prices →
            </button>
          </div>
          <select
            value={selectedSupplier}
            onChange={(e) => setSelectedSupplier(e.target.value)}
            className="w-full bg-surface-container-high border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface"
          >
            <option value="">— Choose supplier —</option>
            <option value="digikey">DigiKey</option>
            <option value="mouser">Mouser</option>
            <option value="lcsc">LCSC</option>
            <option value="custom">Other / Custom</option>
          </select>

          {useCustom && (
            <input
              type="text"
              value={customSupplier}
              onChange={(e) => setCustomSupplier(e.target.value)}
              placeholder="Enter supplier name"
              className="w-full bg-surface-container-high border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface"
            />
          )}
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
            onClick={handleSubmit}
            disabled={saving || poItems.length === 0}
            className="px-4 py-2 rounded-lg bg-primary text-on-primary text-sm font-bold hover:brightness-110 disabled:opacity-50 transition"
          >
            {saving ? 'Creating PO...' : `Create Purchase Order (${poItems.length} items)`}
          </button>
        </div>
      </div>

      {showComparison && (
        <SupplierComparisonModal
          shortages={shortageList}
          onClose={() => setShowComparison(false)}
          onSelectSupplier={(supplier) => {
            setSelectedSupplier(supplier);
            setShowComparison(false);
            triggerToast(`Selected ${supplier.toUpperCase()}`, 'SUCCESS');
          }}
          triggerToast={triggerToast}
        />
      )}
    </div>
  );
}
