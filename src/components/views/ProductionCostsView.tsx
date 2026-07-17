import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Loader2, TrendingUp, Package, Wallet, AlertTriangle } from 'lucide-react';
import { ProductionProduct } from '../../types';
import {
  Modal, fmtMoney, apiGet, apiPost, apiPut, apiDelete,
  PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass,
} from '../bookkeeping/shared';

interface ProductionCostsViewProps {
  triggerToast: (msg: string, type?: any) => void;
}

const CATEGORY_OPTIONS = ['TCU', 'NCU', 'NCU System', 'Dongle', 'Programming', 'Power', 'Accessory', 'Other'];

function marginClass(pct: number | null): string {
  if (pct === null) return 'text-outline';
  if (pct < 0) return 'text-error';
  if (pct < 20) return 'text-tertiary';
  return 'text-green-400';
}

export const ProductionCostsView: React.FC<ProductionCostsViewProps> = ({ triggerToast }) => {
  const [products, setProducts] = useState<ProductionProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [editing, setEditing] = useState<ProductionProduct | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiGet('/api/production-products');
      setProducts(Array.isArray(data) ? data : []);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load production costs', 'ERROR');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const categories = useMemo(() => ['ALL', ...Array.from(new Set(products.map(p => p.category).filter(Boolean) as string[]))], [products]);
  const filtered = useMemo(() => products.filter(p => categoryFilter === 'ALL' || p.category === categoryFilter), [products, categoryFilter]);

  const stats = useMemo(() => {
    const withPrice = products.filter(p => p.sellingPrice !== null);
    const withBoth = products.filter(p => p.sellingPrice !== null && p.productionCost !== null);
    const catalogValue = withPrice.reduce((s, p) => s + (p.sellingPrice || 0), 0);
    const totalCost = withBoth.reduce((s, p) => s + (p.productionCost || 0), 0);
    const totalPriceForBoth = withBoth.reduce((s, p) => s + (p.sellingPrice || 0), 0);
    const blendedMarginPct = totalPriceForBoth > 0 ? Math.round(((totalPriceForBoth - totalCost) / totalPriceForBoth) * 1000) / 10 : null;
    const missingCost = products.filter(p => p.productionCost === null).length;
    return { count: products.length, catalogValue, blendedMarginPct, missingCost };
  }, [products]);

  const handleDelete = async (p: ProductionProduct) => {
    if (!confirm(`Delete ${p.modelNumber} from the catalog?`)) return;
    setBusy(true);
    try {
      await apiDelete(`/api/production-products/${p.id}`);
      triggerToast('Product removed.');
      await load();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to delete', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-headline-sm text-xl font-black text-on-surface tracking-tighter mb-1">Production Costs</h3>
          <p className="text-xs text-on-surface-variant">Finished-product catalog — build cost, selling price and margin. Model numbers align with invoice line items in Bookkeeping. Prices exclude VAT.</p>
        </div>
        <PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => { setEditing(null); setShowEditor(true); }}>New Product</PrimaryButton>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-md">
        <StatTile icon={<Package className="w-4 h-4" />} label="Products" value={String(stats.count)} />
        <StatTile icon={<Wallet className="w-4 h-4" />} label="Catalog value (excl VAT)" value={fmtMoney(stats.catalogValue)} />
        <StatTile icon={<TrendingUp className="w-4 h-4" />} label="Blended margin" value={stats.blendedMarginPct === null ? '—' : `${stats.blendedMarginPct}%`} accent={marginClass(stats.blendedMarginPct)} />
        <StatTile icon={<AlertTriangle className="w-4 h-4" />} label="Missing cost data" value={String(stats.missingCost)} accent={stats.missingCost ? 'text-tertiary' : 'text-on-surface'} />
      </div>

      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
        <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex justify-between items-center flex-wrap gap-2">
          <span className="font-bold text-sm">Product Catalog</span>
          <div className="flex gap-1 flex-wrap">
            {categories.map(c => (
              <button key={c} onClick={() => setCategoryFilter(c)} className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${categoryFilter === c ? 'bg-primary text-white border-primary' : 'bg-surface-container-high text-on-surface-variant border-outline-variant'}`}>{c}</button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-on-surface-variant text-xs"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading catalog...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                  <th className="px-lg py-sm">Model #</th>
                  <th className="px-lg py-sm">Description</th>
                  <th className="px-lg py-sm">Category</th>
                  <th className="px-lg py-sm text-right">Prod. cost</th>
                  <th className="px-lg py-sm text-right">Selling price</th>
                  <th className="px-lg py-sm text-right">Margin</th>
                  <th className="px-lg py-sm text-right">Margin %</th>
                  <th className="px-lg py-sm text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30">
                {filtered.map(p => (
                  <tr key={p.id} className="hover:bg-surface-variant/20 transition-all">
                    <td className="px-lg py-sm font-mono text-primary font-bold">{p.modelNumber}</td>
                    <td className="px-lg py-sm">{p.description || '—'}</td>
                    <td className="px-lg py-sm"><span className="text-[10px] bg-surface-container-high border border-outline-variant px-1.5 py-0.5 rounded">{p.category || '—'}</span></td>
                    <td className="px-lg py-sm text-right font-mono">{p.productionCost === null ? <span className="text-outline italic">not set</span> : fmtMoney(p.productionCost, p.currency)}</td>
                    <td className="px-lg py-sm text-right font-mono">{p.sellingPrice === null ? <span className="text-outline italic">not set</span> : fmtMoney(p.sellingPrice, p.currency)}</td>
                    <td className={`px-lg py-sm text-right font-mono font-bold ${marginClass(p.marginPct)}`}>{p.margin === null ? '—' : fmtMoney(p.margin, p.currency)}</td>
                    <td className={`px-lg py-sm text-right font-mono font-bold ${marginClass(p.marginPct)}`}>{p.marginPct === null ? '—' : `${p.marginPct}%`}</td>
                    <td className="px-lg py-sm text-right">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => { setEditing(p); setShowEditor(true); }} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => handleDelete(p)} disabled={busy} className="p-1.5 rounded hover:bg-surface-container-high text-error disabled:opacity-40" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={8} className="py-8 text-center text-outline text-xs italic">No products in this category.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showEditor && (
        <ProductEditorModal
          initial={editing}
          onClose={() => { setShowEditor(false); setEditing(null); }}
          onSaved={async () => { setShowEditor(false); setEditing(null); await load(); }}
          triggerToast={triggerToast}
        />
      )}
    </div>
  );
};

const StatTile: React.FC<{ icon: React.ReactNode; label: string; value: string; accent?: string }> = ({ icon, label, value, accent = 'text-on-surface' }) => (
  <div className="bg-surface-container p-md rounded-xl border border-outline-variant">
    <div className="flex items-center justify-between mb-1">
      <span className="text-[11px] text-on-surface-variant font-bold">{label}</span>
      <span className="text-outline">{icon}</span>
    </div>
    <div className={`text-xl font-black ${accent}`}>{value}</div>
  </div>
);

const ProductEditorModal: React.FC<{ initial: ProductionProduct | null; onClose: () => void; onSaved: () => void; triggerToast: (m: string, t?: any) => void }> = ({ initial, onClose, onSaved, triggerToast }) => {
  const [modelNumber, setModelNumber] = useState(initial?.modelNumber || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [category, setCategory] = useState(initial?.category || 'TCU');
  const [productionCost, setProductionCost] = useState<string>(initial?.productionCost != null ? String(initial.productionCost) : '');
  const [sellingPrice, setSellingPrice] = useState<string>(initial?.sellingPrice != null ? String(initial.sellingPrice) : '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [saving, setSaving] = useState(false);

  const parseNum = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  const cost = parseNum(productionCost);
  const price = parseNum(sellingPrice);
  const previewMargin = cost !== null && price !== null ? price - cost : null;
  const previewPct = previewMargin !== null && price ? Math.round((previewMargin / price) * 1000) / 10 : null;

  const submit = async () => {
    if (!modelNumber.trim()) { triggerToast('Model number is required.', 'ERROR'); return; }
    setSaving(true);
    try {
      const payload = {
        modelNumber: modelNumber.trim(),
        description: description.trim() || undefined,
        category,
        productionCost: cost,
        sellingPrice: price,
        notes: notes.trim() || undefined,
      };
      if (initial) await apiPut(`/api/production-products/${initial.id}`, payload);
      else await apiPost('/api/production-products', payload);
      triggerToast(initial ? 'Product updated.' : 'Product added.');
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? `Edit ${initial.modelNumber}` : 'New Product'} subtitle="Costs and prices exclude VAT, in ZAR." onClose={onClose} maxWidth="max-w-lg">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Model number</FieldLabel>
          <input className={inputClass} value={modelNumber} onChange={(e) => setModelNumber(e.target.value)} placeholder="e.g. TCU-001-SAT" />
        </div>
        <div>
          <FieldLabel>Category</FieldLabel>
          <select className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <FieldLabel>Description</FieldLabel>
          <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <FieldLabel hint="Leave blank if unknown">Production cost (R)</FieldLabel>
          <input type="number" min={0} step="0.01" className={inputClass} value={productionCost} onChange={(e) => setProductionCost(e.target.value)} />
        </div>
        <div>
          <FieldLabel hint="Leave blank if unknown">Selling price (R)</FieldLabel>
          <input type="number" min={0} step="0.01" className={inputClass} value={sellingPrice} onChange={(e) => setSellingPrice(e.target.value)} />
        </div>
        <div className="col-span-2">
          <FieldLabel>Notes</FieldLabel>
          <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>

      <div className="mt-md rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 flex items-center justify-between text-xs">
        <span className="text-on-surface-variant font-bold">Unit margin</span>
        <span className={`font-mono font-bold ${marginClass(previewPct)}`}>
          {previewMargin === null ? 'Set both cost & price' : `${fmtMoney(previewMargin)}  (${previewPct}%)`}
        </span>
      </div>

      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving}>{saving ? 'Saving...' : initial ? 'Save Changes' : 'Add Product'}</PrimaryButton>
      </div>
    </Modal>
  );
};
