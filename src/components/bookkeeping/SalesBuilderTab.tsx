// Bookkeeping > Sales > Sales Builder: packages of lines (inventory items,
// finished products, services, other packages) that "Add package" puts on a
// sales order, quote or invoice in one go. Admins and managers build them;
// everyone can see them. Server: src/lib/salesPackagesRoutes.ts; the
// rules (expanding, discount lines, totals): src/lib/salesPackages.ts.

import React, { useEffect, useMemo, useState } from 'react';
import { Package, Plus, Copy, Edit2, Trash2, Archive, RotateCcw, AlertTriangle, ArrowUp, ArrowDown, Search } from 'lucide-react';
import { ModuleDataProps, Modal, FieldLabel, PrimaryButton, SecondaryButton, CreateButton, inputClass, selectClass, apiGet, apiPost, apiPut, apiDelete } from './shared';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';
import { fmtNumber, fmtZAR } from '../../lib/formatMoney';
import {
  PackageError, expandPackage, markupPrice, packageTotals,
  type ExpandedLine, type PackageLine, type PackageLineKind, type SalesPackage,
} from '../../lib/salesPackages';

interface ListedPackage extends SalesPackage {
  clientName: string | null;
  updatedAt: string;
  updatedBy: string | null;
  totals: ReturnType<typeof packageTotals> | null;
  warnings: string[];
  error: string | null;
}
interface ProductRow { model: string; description: string; price: number; cost: number | null }
interface DraftLine extends PackageLine { key: string }

const KIND_LABEL: Record<PackageLineKind, string> = { item: 'Inventory item', product: 'Finished product', service: 'Service', package: 'Package' };
const newKey = () => `P${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

export const SalesBuilderTab: React.FC<ModuleDataProps> = ({ clients, items, taxRates, triggerToast }) => {
  const [list, setList] = useState<ListedPackage[] | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [usdToZar, setUsdToZar] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('ALL');
  const [showRetired, setShowRetired] = useState(false);
  const [editing, setEditing] = useState<ListedPackage | 'new' | null>(null);
  const mayChange = canChange('/api/sales-packages', 'POST');
  const mayDelete = canChange('/api/sales-packages/1', 'DELETE');

  const load = async () => {
    try { setList(await apiGet('/api/sales-packages')); } catch (e: any) { triggerToast(e?.message || 'Could not load the packages.', 'ERROR'); setList([]); }
  };
  useEffect(() => {
    void load();
    apiGet('/api/production-products').then((rows: any[]) => setProducts((rows || []).map((r) => ({
      model: r.model_number ?? r.modelNumber, description: r.description || '', price: Number(r.selling_price ?? r.sellingPrice) || 0,
      cost: Number(r.production_cost ?? r.productionCost) > 0 ? Number(r.production_cost ?? r.productionCost) : null,
    })))).catch(() => {});
    apiGet('/api/exchange-rate').then((r: any) => setUsdToZar(Number(r?.usdToZar) || null)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const categories = useMemo(() => [...new Set((list ?? []).map((p) => p.category).filter(Boolean) as string[])].sort(), [list]);
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (list ?? []).filter((p) => (showRetired || p.active) && (category === 'ALL' || p.category === category))
      .filter((p) => words.every((w) => [p.name, p.category, p.clientName, ...(p.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(w)));
  }, [list, q, category, showRetired]);

  const retire = async (p: ListedPackage, active: boolean) => {
    try {
      await apiPut(`/api/sales-packages/${p.id}`, toPayload(p, active));
      triggerToast(active ? `${p.name} is offered again.` : `${p.name} retired: it's no longer offered, and past orders are unchanged.`, 'SUCCESS');
      await load();
    } catch (e: any) { triggerToast(e?.message || 'Could not change it.', 'ERROR'); }
  };
  const duplicate = async (p: ListedPackage) => {
    try {
      const r = await apiPost(`/api/sales-packages/${p.id}/duplicate`);
      triggerToast(`Copied as "${r.name}".`, 'SUCCESS');
      await load();
    } catch (e: any) { triggerToast(e?.message || 'Could not copy it.', 'ERROR'); }
  };
  const remove = async (p: ListedPackage) => {
    if (!(await confirmDialog({ title: 'Delete package', message: `Delete "${p.name}"? Orders it was already added to keep their lines. To stop offering it but keep it, retire it instead.`, confirmLabel: 'Delete', destructive: true }))) return;
    try { await apiDelete(`/api/sales-packages/${p.id}`); triggerToast(`${p.name} deleted.`, 'SUCCESS'); await load(); }
    catch (e: any) { triggerToast(e?.message || 'Could not delete it.', 'ERROR'); }
  };

  return (
    <div className="space-y-md" data-testid="sales-builder">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
        <div className="max-w-[720px]">
          <h3 className="text-lg font-bold text-on-surface flex items-center gap-2"><Package className="w-5 h-5 text-primary" /> Sales Builder</h3>
          <p className="text-xs text-on-surface-variant mt-1">
            Packages of items, products and services to add to a sales order, quote or invoice in one go ("Add package" under the lines).
            They go on as normal lines you can still edit; a discount becomes its own line. Changing a package later doesn't change orders it was already added to.
          </p>
        </div>
        <CreateButton path="/api/sales-packages" type="button" onClick={() => setEditing('new')} icon={<Plus className="w-4 h-4" />}>New package</CreateButton>
      </div>

      <div className="flex flex-wrap items-center gap-sm">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-outline absolute left-2 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, tag or client…" aria-label="Search packages" className={`${inputClass} pl-7 py-1.5 text-xs w-64`} />
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className={`${selectClass} py-1.5 text-xs w-48`}>
          <option value="ALL">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-on-surface-variant">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired
        </label>
      </div>

      {!list ? <p className="text-xs text-outline">Loading…</p> : shown.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-outline-variant/40 p-lg text-center text-sm text-on-surface-variant">
          {list.length ? 'No package matches.' : mayChange ? 'No packages yet. Make one with "New package".' : 'No packages yet: an admin or manager makes them here.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-md">
          {shown.map((p) => (
            <div key={p.id} className={`rounded-xl border p-md space-y-2 ${p.active ? 'border-outline-variant bg-surface-container' : 'border-outline-variant/50 bg-surface-container/50 opacity-75'}`} data-testid={`package-${p.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-bold text-on-surface truncate">{p.name}{!p.active && <span className="ml-2 text-[10px] uppercase text-outline">Retired</span>}</div>
                  <div className="text-[11px] text-outline">{[p.category, p.clientName ? `For ${p.clientName}` : null, `${p.lines.length} line${p.lines.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</div>
                </div>
                {p.totals && <div className="text-right shrink-0">
                  <div className="text-sm font-bold font-mono text-primary">{fmtZAR(p.totals.total)}</div>
                  <div className="text-[10px] text-outline">excl. VAT{p.totals.marginPct !== null && p.totals.costKnown ? ` · ${p.totals.marginPct}% margin` : ''}</div>
                </div>}
              </div>
              {p.tags.length > 0 && <div className="flex flex-wrap gap-1">{p.tags.map((t) => <span key={t} className="text-[10px] rounded bg-surface-container-high px-1.5 py-0.5 text-on-surface-variant">{t}</span>)}</div>}
              {p.discountPct > 0 && p.totals && <div className="text-[11px] text-green-500">{p.discountPct}% discount: {fmtZAR(-p.totals.discount)} off {fmtZAR(p.totals.gross)}</div>}
              {p.error && <div className="text-[11px] text-error">{p.error}</div>}
              {p.warnings.map((w) => <div key={w} className="text-[11px] text-amber-500 flex items-center gap-1"><AlertTriangle className="w-3 h-3 shrink-0" /> {w}</div>)}
              <div className="flex flex-wrap gap-1 pt-1">
                {mayChange && <SecondaryButton type="button" onClick={() => setEditing(p)} icon={<Edit2 className="w-3.5 h-3.5" />}>Edit</SecondaryButton>}
                {mayChange && <SecondaryButton type="button" onClick={() => void duplicate(p)} icon={<Copy className="w-3.5 h-3.5" />}>Duplicate</SecondaryButton>}
                {mayChange && <SecondaryButton type="button" onClick={() => void retire(p, !p.active)} icon={p.active ? <Archive className="w-3.5 h-3.5" /> : <RotateCcw className="w-3.5 h-3.5" />}>{p.active ? 'Retire' : 'Offer again'}</SecondaryButton>}
                {mayDelete && <SecondaryButton type="button" onClick={() => void remove(p)} icon={<Trash2 className="w-3.5 h-3.5" />}>Delete</SecondaryButton>}
              </div>
              <div className="text-[10px] text-outline">Changed {new Date(p.updatedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}{p.updatedBy ? ` by ${p.updatedBy}` : ''}</div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <PackageEditor
          initial={editing === 'new' ? null : editing}
          all={list ?? []}
          clients={clients}
          items={items}
          products={products}
          taxRates={taxRates}
          usdToZar={usdToZar}
          onClose={() => setEditing(null)}
          onSaved={async (name) => { setEditing(null); triggerToast(`${name} saved.`, 'SUCCESS'); await load(); }}
        />
      )}
    </div>
  );
};

function toPayload(p: Pick<SalesPackage, 'name' | 'category' | 'tags' | 'clientId' | 'discountPct' | 'notes' | 'lines'>, active: boolean) {
  return {
    name: p.name, category: p.category || null, tags: p.tags, clientId: p.clientId, discountPct: p.discountPct, notes: p.notes || null, active,
    lines: p.lines.map((l) => ({ kind: l.kind, ref: l.kind === 'service' ? null : l.ref, description: l.description, quantity: l.quantity, unitPrice: l.kind === 'package' ? 0 : l.unitPrice, taxRateId: l.taxRateId })),
  };
}

const PackageEditor: React.FC<{
  initial: ListedPackage | null;
  all: ListedPackage[];
  clients: ModuleDataProps['clients'];
  items: ModuleDataProps['items'];
  products: ProductRow[];
  taxRates: ModuleDataProps['taxRates'];
  usdToZar: number | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}> = ({ initial, all, clients, items, products, taxRates, usdToZar, onClose, onSaved }) => {
  const defaultTax = taxRates.find((t: any) => t.isDefault || t.is_default)?.id ?? taxRates.find((t) => (t.rate ?? 0) > 0)?.id ?? null;
  const [name, setName] = useState(initial?.name ?? '');
  const [categoryName, setCategoryName] = useState(initial?.category ?? '');
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [clientId, setClientId] = useState<string>(initial?.clientId != null ? String(initial.clientId) : '');
  const [discountPct, setDiscountPct] = useState(initial?.discountPct ?? 0);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [active, setActive] = useState(initial?.active ?? true);
  const [lines, setLines] = useState<DraftLine[]>(() => (initial?.lines.length ? initial.lines : [{ kind: 'item' as PackageLineKind, ref: '', description: '', quantity: 1, unitPrice: 0, taxRateId: defaultTax }])
    .map((l) => ({ ...l, key: newKey() })));
  const [markup, setMarkup] = useState(35);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const itemBySku = useMemo(() => new Map(items.map((i) => [i.partNumber.toUpperCase(), i])), [items]);
  const productByModel = useMemo(() => new Map(products.map((p) => [String(p.model).toUpperCase(), p])), [products]);
  const itemCost = (sku: string | null): number | null => {
    const i = sku ? itemBySku.get(sku.toUpperCase()) : undefined;
    if (!i) return null;
    if ((i.bulkPriceZar ?? 0) > 0) return i.bulkPriceZar!;
    return i.price > 0 && usdToZar ? i.price * usdToZar : null;
  };
  const unitCost = (l: { kind: string; partNumber?: string | null; ref?: string | null }): number | null => {
    const ref = (l.partNumber ?? l.ref ?? '') as string;
    if (l.kind === 'item') return itemCost(ref);
    if (l.kind === 'product') return productByModel.get(ref.toUpperCase())?.cost ?? null;
    return null;
  };

  const draft: SalesPackage = {
    id: initial?.id ?? 0, name: name || 'This package', category: categoryName || null, tags: [], clientId: null,
    discountPct: Number(discountPct) || 0, notes: null, active, lines,
  };
  const preview = useMemo(() => {
    const byId = new Map<number, SalesPackage>(all.map((p) => [p.id, p]));
    byId.set(draft.id, draft);
    try { return { lines: expandPackage(draft.id, byId), error: null as string | null }; }
    catch (e: any) { return { lines: [] as ExpandedLine[], error: e instanceof PackageError ? e.message : String(e?.message || e) }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, lines, discountPct, name]);
  const totals = packageTotals(preview.lines, unitCost);

  const update = (key: string, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const move = (i: number, by: number) => setLines((ls) => { const n = [...ls]; const j = i + by; if (j < 0 || j >= n.length) return ls; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const pickRef = (l: DraftLine, ref: string) => {
    const patch: Partial<DraftLine> = { ref };
    if (l.kind === 'item') {
      const i = itemBySku.get(ref.toUpperCase());
      if (i) { patch.ref = i.partNumber; if (!l.description.trim()) patch.description = i.name || i.description || i.partNumber; }
    } else if (l.kind === 'product') {
      const p = productByModel.get(ref.toUpperCase());
      if (p) { patch.ref = p.model; if (!l.description.trim()) patch.description = p.description || p.model; if (!(l.unitPrice > 0) && p.price > 0) patch.unitPrice = p.price; }
    } else if (l.kind === 'package') {
      const p = all.find((x) => String(x.id) === ref);
      if (p) patch.description = p.name;
    }
    update(l.key, patch);
  };
  const priceAtMarkup = () => {
    let n = 0;
    setLines((ls) => ls.map((l) => {
      if ((l.kind !== 'item' && l.kind !== 'product') || l.unitPrice > 0) return l;
      const c = unitCost(l);
      if (c === null) return l;
      n += 1;
      return { ...l, unitPrice: markupPrice(c, markup) };
    }));
    setTimeout(() => setError(n ? null : 'No item without a price has a known cost.'), 0);
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) { setError('Give the package a name.'); return; }
    if (preview.error) { setError(preview.error); return; }
    const payload = toPayload({
      name: name.trim(), category: categoryName.trim() || null,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      clientId: clientId ? Number(clientId) : null, discountPct: Number(discountPct) || 0, notes: notes.trim() || null,
      lines: lines.map(({ key, ...l }) => ({ ...l, quantity: Number(l.quantity) || 0, unitPrice: Number(l.unitPrice) || 0 })),
    }, active);
    setSaving(true);
    try {
      if (initial) await apiPut(`/api/sales-packages/${initial.id}`, payload); else await apiPost('/api/sales-packages', payload);
      onSaved(payload.name);
    } catch (e: any) {
      setError(e?.message || 'Could not save it.');
    } finally {
      setSaving(false);
    }
  };

  const otherPackages = all.filter((p) => p.id !== initial?.id);

  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'New package'} subtitle="Prices in rand, before VAT. Changing a package doesn't change orders it was already added to." onClose={onClose} maxWidth="max-w-5xl">
      <datalist id="pkg-items">{items.map((i) => <option key={i.partNumber} value={i.partNumber}>{i.name}</option>)}</datalist>
      <datalist id="pkg-products">{products.map((p) => <option key={p.model} value={p.model}>{p.description}</option>)}</datalist>
      <datalist id="pkg-categories">{[...new Set(all.map((p) => p.category).filter(Boolean) as string[])].map((c) => <option key={c} value={c} />)}</datalist>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
        <div className="md:col-span-2"><FieldLabel>Name</FieldLabel><input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Solar Kit A" aria-label="Package name" /></div>
        <div><FieldLabel>Category</FieldLabel><input className={inputClass} list="pkg-categories" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder="e.g. Solar" aria-label="Category" /></div>
        <div><FieldLabel hint="comma separated">Tags</FieldLabel><input className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. 5kW, residential" aria-label="Tags" /></div>
        <div><FieldLabel hint="optional">Only for client</FieldLabel>
          <select className={selectClass} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
            <option value="">Any client</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.clientName}</option>)}
          </select>
        </div>
        <div><FieldLabel>Discount %</FieldLabel><input type="number" min={0} max={100} step="any" className={inputClass} value={discountPct} onChange={(e) => setDiscountPct(Number(e.target.value))} aria-label="Discount percent" /></div>
        <div className="md:col-span-3"><FieldLabel hint="copied into the order's notes">Notes</FieldLabel><input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Includes 5-year warranty" aria-label="Notes" /></div>
      </div>

      <div className="mt-md flex flex-wrap items-center justify-between gap-sm">
        <FieldLabel>Lines</FieldLabel>
        <div className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
          Price items without a price at cost +
          <input type="number" min={0} step="any" value={markup} onChange={(e) => setMarkup(Number(e.target.value) || 0)} aria-label="Markup percent" className={`${inputClass} w-16 py-1 text-xs`} />%
          <SecondaryButton type="button" onClick={priceAtMarkup}>Apply</SecondaryButton>
        </div>
      </div>
      <div className="space-y-2 mt-1">
        {lines.map((l, i) => {
          const cost = unitCost(l);
          const margin = cost !== null && l.unitPrice > 0 ? Math.round(((l.unitPrice - cost) / l.unitPrice) * 1000) / 10 : null;
          const status = l.kind === 'item' && l.ref ? String(itemBySku.get(l.ref.toUpperCase())?.status ?? '') : '';
          return (
            <div key={l.key} className="rounded-lg border border-outline-variant/60 p-2 grid grid-cols-12 gap-2 items-end" data-testid={`pkg-line-${i}`}>
              <div className="col-span-6 md:col-span-2">
                <label className="text-[10px] text-outline uppercase">Type</label>
                <select className={`${selectClass} py-1.5 text-xs`} value={l.kind} aria-label={`Line ${i + 1} type`}
                  onChange={(e) => update(l.key, { kind: e.target.value as PackageLineKind, ref: '', ...(e.target.value === 'package' ? { unitPrice: 0 } : {}) })}>
                  {(Object.keys(KIND_LABEL) as PackageLineKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
              </div>
              <div className="col-span-6 md:col-span-2">
                <label className="text-[10px] text-outline uppercase">{l.kind === 'item' ? 'SKU' : l.kind === 'product' ? 'Model #' : l.kind === 'package' ? 'Package' : '—'}</label>
                {l.kind === 'package' ? (
                  <select className={`${selectClass} py-1.5 text-xs`} value={l.ref ?? ''} onChange={(e) => pickRef(l, e.target.value)} aria-label={`Line ${i + 1} package`}>
                    <option value="">Choose…</option>
                    {otherPackages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                ) : l.kind === 'service' ? <div className="text-[11px] text-outline py-2">No stock</div> : (
                  <input className={`${inputClass} py-1.5 text-xs font-mono`} list={l.kind === 'item' ? 'pkg-items' : 'pkg-products'} value={l.ref ?? ''}
                    onChange={(e) => update(l.key, { ref: e.target.value })} onBlur={(e) => pickRef(l, e.target.value.trim())} aria-label={`Line ${i + 1} ${l.kind === 'item' ? 'SKU' : 'model'}`} />
                )}
              </div>
              <div className="col-span-12 md:col-span-3">
                <label className="text-[10px] text-outline uppercase">Description</label>
                <input className={`${inputClass} py-1.5 text-xs`} value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} disabled={l.kind === 'package'}
                  placeholder={l.kind === 'service' ? 'e.g. Installation' : ''} aria-label={`Line ${i + 1} description`} />
              </div>
              <div className="col-span-4 md:col-span-1">
                <label className="text-[10px] text-outline uppercase">Qty</label>
                <input type="number" min={0.0001} step="any" className={`${inputClass} py-1.5 text-xs text-right`} value={l.quantity} onChange={(e) => update(l.key, { quantity: Number(e.target.value) })} aria-label={`Line ${i + 1} quantity`} />
              </div>
              <div className="col-span-4 md:col-span-1">
                <label className="text-[10px] text-outline uppercase">Price R</label>
                {l.kind === 'package' ? <div className="text-[11px] text-outline py-2 text-right">its lines</div> : (
                  <input type="number" min={0} step="any" className={`${inputClass} py-1.5 text-xs text-right`} value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: Number(e.target.value) })} aria-label={`Line ${i + 1} price`} />
                )}
              </div>
              <div className="col-span-4 md:col-span-2">
                <label className="text-[10px] text-outline uppercase">Tax</label>
                {l.kind === 'package' ? <div className="text-[11px] text-outline py-2">its lines</div> : (
                  <select className={`${selectClass} py-1.5 text-xs`} value={l.taxRateId ?? ''} onChange={(e) => update(l.key, { taxRateId: e.target.value ? Number(e.target.value) : null })} aria-label={`Line ${i + 1} tax`}>
                    {taxRates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                )}
              </div>
              <div className="col-span-12 md:col-span-1 flex md:flex-col items-center justify-end gap-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move line ${i + 1} up`} className="p-1 text-outline hover:text-on-surface disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === lines.length - 1} aria-label={`Move line ${i + 1} down`} className="p-1 text-outline hover:text-on-surface disabled:opacity-30"><ArrowDown className="w-3.5 h-3.5" /></button>
                <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} disabled={lines.length === 1} aria-label={`Remove line ${i + 1}`} className="p-1 text-error/70 hover:text-error disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              {(l.kind === 'item' || l.kind === 'product') && (
                <div className="col-span-12 text-[10px] text-outline">
                  {cost !== null ? `Cost ${fmtZAR(cost)} each${margin !== null ? ` · margin ${margin}%` : ''}` : l.ref ? 'Cost unknown' : ''}
                  {['INACTIVE', 'DO NOT USE', 'DISCONTINUED'].includes(status.toUpperCase()) && <span className="text-amber-500"> · marked {status}</span>}
                </div>
              )}
            </div>
          );
        })}
        <button type="button" onClick={() => setLines((ls) => [...ls, { key: newKey(), kind: 'item', ref: '', description: '', quantity: 1, unitPrice: 0, taxRateId: defaultTax }])}
          className="w-full py-2 rounded-lg border-2 border-dashed border-outline-variant/40 hover:border-primary/60 text-primary text-xs font-semibold flex items-center justify-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Add line
        </button>
      </div>

      <div className="mt-md grid grid-cols-1 md:grid-cols-2 gap-md items-end">
        <label className="flex items-center gap-2 text-xs text-on-surface-variant">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Offered on orders (untick to retire it)
        </label>
        <div className="rounded-lg bg-surface-container-high p-3 text-xs space-y-1" data-testid="pkg-totals">
          <div className="flex justify-between"><span>Lines</span><span className="font-mono">{fmtZAR(totals.gross)}</span></div>
          {totals.discount < 0 && <div className="flex justify-between text-green-500"><span>Discount ({fmtNumber(Number(discountPct) || 0, 1)}%)</span><span className="font-mono">{fmtZAR(totals.discount)}</span></div>}
          <div className="flex justify-between font-bold text-sm border-t border-outline-variant/40 pt-1"><span>Package price excl. VAT</span><span className="font-mono text-primary">{fmtZAR(totals.total)}</span></div>
          <div className="flex justify-between text-outline"><span>Cost{totals.costKnown ? '' : ' (some unknown)'}</span><span className="font-mono">{fmtZAR(totals.cost)}{totals.marginPct !== null ? ` · ${totals.marginPct}% margin` : ''}</span></div>
        </div>
      </div>

      {(error || preview.error) && <p className="mt-sm text-xs text-error">{error || preview.error}</p>}
      <div className="flex justify-end gap-2 mt-md">
        <SecondaryButton type="button" onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton type="button" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save package'}</PrimaryButton>
      </div>
    </Modal>
  );
};
